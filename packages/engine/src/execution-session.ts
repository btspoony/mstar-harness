import { randomUUID } from "node:crypto";
import { isNonEmptyString } from "./coordination-write.js";
import { ExecutionError, readExecutionSession, readOwnExecutionSession, serializeExecutionValue, type ExecutionCaller, type ExecutionContext, type ExecutionRead, type ExecutionSessionRef } from "./execution-store.js";
import { withExecutionReadGuard, type StoreContext } from "./store-db.js";
import { assertSafeSessionId, validateExecutionIdentity, type ExecutionIdentity, type ExecutionIdentityOptions, type ExecutionIdentityScope } from "./session-identity.js";

const SESSION_WIRE_PREFIX = "exec-session-v1:";
const SESSION_DECODER = new TextDecoder("utf-8", { fatal: true });
const SESSION_KEYS = ["storeId", "epoch", "workflowId", "role", "sessionId"] as const;

type SessionScope = Omit<ExecutionCaller, "sessionId">;

/**
 * Canonical §3.1 host-side binding of an adopted execution session: the
 * adapter's durable selection record. It is a value shape only — persisting it
 * grants no authority, and an epoch mismatch invalidates the reference it
 * carries, never the user's selection.
 */
export type ExecutionBinding = Readonly<{
  version: 1;
  harnessRoot: string;
  session: ExecutionSessionRef;
}>;

function scopeOf(scope: SessionScope): ExecutionIdentityScope {
  return { workflowId: scope.workflowId, role: scope.role };
}

function assertRefShape(value: unknown): asserts value is ExecutionSessionRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionError("execution.canonical-value", "an execution session reference must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== SESSION_KEYS.length || keys.some((key, index) => key !== [...SESSION_KEYS].sort()[index])) {
    throw new ExecutionError("execution.canonical-value", "an execution session reference has unknown or missing fields");
  }
  if (typeof record.storeId !== "string" || record.storeId.length === 0 || typeof record.workflowId !== "string" || record.workflowId.length === 0) {
    throw new ExecutionError("execution.canonical-value", "an execution session reference has empty identity fields");
  }
  if (typeof record.epoch !== "number" || !Number.isSafeInteger(record.epoch) || record.epoch <= 0) {
    throw new ExecutionError("execution.canonical-value", "an execution session reference has an invalid epoch");
  }
  if (record.role !== "coordinator") {
    throw new ExecutionError("execution.canonical-value", "an execution session reference has an unknown role");
  }
  assertSafeSessionId(record.sessionId, "execution session reference session id");
}

/** Mint one independent local identity; callers must retain it for the launch lifetime. */
export function createLocalExecutionIdentity(scope: SessionScope): ExecutionIdentity {
  const identity: ExecutionIdentity = { source: "local", sessionId: randomUUID(), ...scope };
  validateExecutionIdentity(identity, scopeOf(scope));
  assertSafeSessionId(identity.sessionId);
  return identity;
}

/** Convert an acquired adapter identity into the trusted domain caller context. */
export function executionContextFor(
  context: StoreContext,
  identity: ExecutionIdentity,
  options: ExecutionIdentityOptions = {},
): ExecutionContext {
  const caller = {
    sessionId: isNonEmptyString(identity.sessionId) ? identity.sessionId : "",
    workflowId: identity.workflowId,
    role: identity.role,
  };
  validateExecutionIdentity({ ...identity, sessionId: caller.sessionId }, scopeOf(identity), options);
  if (caller.sessionId !== "") assertSafeSessionId(caller.sessionId);
  return {
    ...context,
    caller,
  };
}

/** Canonical, non-encrypted session reference transport. */
export function encodeExecutionSessionRef(ref: ExecutionSessionRef): string {
  assertRefShape(ref);
  const bytes = serializeExecutionValue(ref);
  return `${SESSION_WIRE_PREFIX}${Buffer.from(bytes, "utf8").toString("base64url")}`;
}

/** Decode a session reference transport and validate its declared identity fields. */
export function decodeExecutionSessionRef(wire: string): ExecutionSessionRef {
  if (typeof wire !== "string" || !wire.startsWith(SESSION_WIRE_PREFIX)) {
    throw new ExecutionError("execution.canonical-value", "an execution session reference has an invalid wire prefix");
  }
  let text: string;
  try {
    const encoded = wire.slice(SESSION_WIRE_PREFIX.length);
    if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw new Error("invalid base64url");
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);
    const bytes = Buffer.from(padded, "base64");
    text = SESSION_DECODER.decode(bytes);
  } catch {
    throw new ExecutionError("execution.canonical-value", "an execution session reference is not valid UTF-8 base64url");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ExecutionError("execution.canonical-value", "an execution session reference is not valid JSON");
  }
  assertRefShape(value);
  return value;
}

/**
 * Resume an independently acquired active session without binding or revision
 * changes (R8, A09/A15).
 *
 * The reference is a PROJECTION of the binding the store already holds, so it is
 * an OPTIONAL input: a caller whose host lost the envelope passes none, and the
 * engine reconstructs its OWN current binding from the durable session row
 * (`readOwnExecutionSession`). The supplied reference stays a strict constraint
 * when there is one — a stale, copied or foreign projection is refused, never
 * silently replaced — and neither form writes: a repeat after a lost response
 * returns the same binding.
 */
export async function resumeExecutionSession(
  context: ExecutionContext,
  ref?: ExecutionSessionRef | null,
): Promise<ExecutionRead<ExecutionSessionRef>> {
  if (ref === undefined || ref === null) return readOwnExecutionSession(context);
  assertRefShape(ref);
  if (
    context.caller.sessionId !== ref.sessionId ||
    context.caller.workflowId !== ref.workflowId ||
    context.caller.role !== ref.role
  ) {
    throw new ExecutionError("execution.scope-mismatch", "the independently acquired caller does not match the session reference");
  }
  return readExecutionSession(context, ref);
}

/** Synchronous final guard immediately before a file-native commit. */
export function assertExecutionSessionCurrent(context: ExecutionContext, session: ExecutionSessionRef): void {
  assertRefShape(session);
  if (
    context.caller.sessionId !== session.sessionId ||
    context.caller.workflowId !== session.workflowId ||
    context.caller.role !== session.role
  ) {
    throw new ExecutionError("execution.scope-mismatch", "the current caller does not match the execution session");
  }
  withExecutionReadGuard(context, (db, authority) => {
    if (authority.storeId !== session.storeId || authority.epoch !== session.epoch) {
      throw new ExecutionError("store.stale-epoch", "the execution session reference is not current");
    }
    const row = db.prepare("select epoch, state from execution_sessions where workflow_id = ? and role = ? and session_id = ?").get(
      session.workflowId,
      session.role,
      session.sessionId,
    ) as { epoch?: unknown; state?: unknown } | undefined;
    if (row?.state !== "active" || row.epoch !== session.epoch) {
      throw new ExecutionError("execution.session-unavailable", "the execution session is not the active current binding");
    }
  });
}
