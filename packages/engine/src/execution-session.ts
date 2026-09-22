import { randomUUID } from "node:crypto";
import { ExecutionError, readExecutionSession, serializeExecutionValue, type ExecutionCaller, type ExecutionContext, type ExecutionRead, type ExecutionSessionRef } from "./execution-store.js";
import { withExecutionReadGuard, type StoreContext } from "./store-db.js";
import { assertSafeSessionId, validateExecutionIdentity, type ExecutionIdentity, type ExecutionIdentityScope } from "./session-identity.js";

const SESSION_WIRE_PREFIX = "exec-session-v1:";
const SESSION_KEYS = ["storeId", "epoch", "workflowId", "role", "sessionId", "planId"] as const;

type SessionScope = Omit<ExecutionCaller, "sessionId">;

function scopeOf(scope: SessionScope): ExecutionIdentityScope {
  return { workflowId: scope.workflowId, role: scope.role, planId: scope.planId };
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
  if (record.role !== "coordinator" && record.role !== "plan-pm") {
    throw new ExecutionError("execution.canonical-value", "an execution session reference has an unknown role");
  }
  assertSafeSessionId(record.sessionId, "execution session reference session id");
  if (record.role === "coordinator" && record.planId !== null) {
    throw new ExecutionError("execution.canonical-value", "a coordinator session reference must carry a null plan id");
  }
  if (record.role === "plan-pm" && (typeof record.planId !== "string" || record.planId.length === 0)) {
    throw new ExecutionError("execution.canonical-value", "a plan-pm session reference needs a plan id");
  }
}

/** Mint one independent local identity; callers must retain it for the launch lifetime. */
export function createLocalExecutionIdentity(scope: SessionScope): ExecutionIdentity {
  const identity: ExecutionIdentity = { source: "local", sessionId: randomUUID(), ...scope };
  validateExecutionIdentity(identity, scopeOf(scope));
  assertSafeSessionId(identity.sessionId);
  return identity;
}

/** Convert an acquired adapter identity into the trusted domain caller context. */
export function executionContextFor(context: StoreContext, identity: ExecutionIdentity): ExecutionContext {
  validateExecutionIdentity(identity, scopeOf(identity));
  assertSafeSessionId(identity.sessionId);
  return {
    ...context,
    caller: {
      sessionId: identity.sessionId,
      workflowId: identity.workflowId,
      role: identity.role,
      planId: identity.planId,
    },
  };
}

/** Canonical, non-encrypted session reference transport. */
export function encodeExecutionSessionRef(ref: ExecutionSessionRef): string {
  assertRefShape(ref);
  const bytes = serializeExecutionValue(ref);
  return `${SESSION_WIRE_PREFIX}${Buffer.from(bytes, "utf8").toString("base64url")}`;
}

/** Decode and strictly validate a canonical session reference transport. */
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
    const canonicalWire = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    if (canonicalWire !== encoded) throw new Error("non-canonical base64url");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const roundTrip = Buffer.from(text, "utf8");
    if (!roundTrip.equals(bytes)) throw new Error("invalid utf8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ExecutionError("execution.canonical-value", "an execution session reference is not valid canonical JSON");
  }
  assertRefShape(value);
  if (serializeExecutionValue(value) !== text) {
    throw new ExecutionError("execution.canonical-value", "an execution session reference is not canonical JSON");
  }
  return value;
}

/** Resume an independently acquired active session without binding or revision changes. */
export async function resumeExecutionSession(context: ExecutionContext, ref: ExecutionSessionRef): Promise<ExecutionRead<ExecutionSessionRef>> {
  assertRefShape(ref);
  if (
    context.caller.sessionId !== ref.sessionId ||
    context.caller.workflowId !== ref.workflowId ||
    context.caller.role !== ref.role ||
    context.caller.planId !== ref.planId
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
    context.caller.role !== session.role ||
    context.caller.planId !== session.planId
  ) {
    throw new ExecutionError("execution.scope-mismatch", "the current caller does not match the execution session");
  }
  withExecutionReadGuard(context, (db, authority) => {
    if (authority.storeId !== session.storeId || authority.epoch !== session.epoch) {
      throw new ExecutionError("store.stale-epoch", "the execution session reference is not current");
    }
    const row = db.prepare("select epoch, state, plan_id from execution_sessions where workflow_id = ? and role = ? and session_id = ?").get(
      session.workflowId,
      session.role,
      session.sessionId,
    ) as { epoch?: unknown; state?: unknown; plan_id?: unknown } | undefined;
    if (row?.state !== "active" || row.epoch !== session.epoch || row.plan_id !== session.planId) {
      throw new ExecutionError("execution.session-unavailable", "the execution session is not the active current binding");
    }
  });
}
