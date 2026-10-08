/**
 * execution-store.ts — the execution authority's canonical value form, version
 * token grammar, one-transaction ownership boundary, its read/initialize verbs
 * and the workflow-creation verb (primary spec §3, §3.1, §4.1; authority
 * states §2.1).
 *
 * Task ownership: C1 owns the migration-4 schema in `store-db.ts`; C2 owns the
 * canonicalizer, the `exec-v1` token grammar, the internal transaction
 * primitive and the real create-only empty-execution initializer. C3 owns
 * `createExecutionWorkflow`: it writes the registry/workflow/plan/sealed-input
 * records of ONE new, unbound, unleased lifecycle against an exact root CAS
 * token, and it seals each plan's frozen execution input with the unchanged
 * `executionInputHash` selection (`coordination.ts`). C4 owns the session
 * surface — `bindExecutionSession` (trusted-caller coordinator binding) and the
 * session-authorized `readExecutionPlan`. The coordination-mutation verbs and
 * the public
 * prepare transition (W2), historical import (R1) and coordinator recovery are
 * NOT defined or stubbed here: an unprepared plan is refused, never admitted.
 *
 * Token/key machinery (`executionToken`, `parseExecutionToken`,
 * `assertExecutionToken`) and the transaction primitive are module-level
 * exports for those domain modules and for the ownership proofs in
 * `execution-store.test.ts`; they are deliberately NOT re-exported from the
 * package index, so no consumer of `@mstar-harness/engine` reaches them and the
 * transaction body never becomes a public arbitrary writer (§4.1).
 *
 * The `node:sqlite` driver is acquired lazily inside `store-db.ts`: importing
 * this module neither loads the driver nor opens a database.
 *
 * Types: `PlanCoordination` in §3 is the existing row-level coordination block
 * `RowCoordination` (coordination-write.ts); its `session` member is the file
 * envelope binding, which the DB authority never stores (§2.3), so the DTO
 * carries the block minus `session` while the stored column carries it minus
 * `revision` (projected back from the row column, §2.2).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ExecutionPinConflictError,
  executionInputHash,
  executionInputSelection,
  type CatalogExecutionPin,
} from "./coordination.js";
import {
  CoordinationError,
  isNonEmptyString,
  isPlainObject,
  type CoordinationErrorCode,
  type RowCoordination,
} from "./coordination-write.js";
import { storedCoordinationViolations } from "./coordination-transitions.js";
import {
  validateIntegrationMergeLease,
  withStatusWriteLock,
  type IntegrationMergeLease,
} from "./lease.js";
import { resolveWorkflowDir } from "./path.js";
import {
  unresolvedRecovery,
  type RecoveryDetails,
  type RecoveryProblem,
  type ResolutionSource,
} from "./recovery-intent.js";
import {
  rowPlanId,
  validatePlanRow,
  validateWorkflowEntry,
  type PlanRow,
  type StatusV2Doc,
  type WorkflowEntry,
} from "./status.js";
import {
  openStore,
  StoreError,
  storeDbPath,
  type ExecutionMeta,
  type StoreContext,
  type StoreDb,
} from "./store-db.js";
import {
  isTerminalSnapshot,
  rowValidationRoute,
  validateWorkflowSnapshot,
  type WorkflowSnapshot,
} from "./workflow.js";

// ---------------------------------------------------------------------------
// Refusals (§5)
// ---------------------------------------------------------------------------

/**
 * Stable refusal codes of the execution authority. `store.not-active` and
 * `store.stale-epoch` are the shared store-level codes (§5 assigns them to the
 * wrong-authority-store and stale-epoch cases); the `execution.*` codes are this
 * domain's own namespace.
 */
export type ExecutionErrorCode =
  | "execution.not-active"
  | "execution.not-empty"
  | "execution.reentrant"
  | "execution.token-invalid"
  | "execution.token-kind"
  | "execution.scope-mismatch"
  | "execution.stale-token"
  | "execution.session-unavailable"
  | "execution.canonical-value"
  | "execution.operation-conflict"
  | "execution.lease-held"
  | "execution.partial-effect"
  | "execution.migration-conflict"
  | "execution.adoption-refused"
  | "execution.header-revision-conflict"
  | "execution.adoption-invalid"
  | "store.not-active"
  | "store.stale-epoch";

/**
 * Typed refusal with an actionable, stable code. `details` is the
 * machine-readable half: the field facts the refusal names plus the contract's
 * `recovery` sidecar (`RecoveryDetails`), so a consumer never has to parse the
 * prose to learn what was withheld and which decision is still open.
 */
export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ExecutionErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = "ExecutionError";
    this.code = code;
    this.details = details;
  }
}

/** Versioned coordinator-owned execution records. */
export type ExecutionKind = "root" | "workflow" | "plan" | "session" | "integration-lease" | "input";
export type ExecutionToken = string & { readonly __executionToken: unique symbol };
export type ExecutionSessionRef = {
  storeId: string;
  epoch: number;
  workflowId: string;
  role: "coordinator";
  sessionId: string;
};

/** Recovery outcome and commit boundary carried by an execution action. */
export type ExecutionReceiptRecovery = RecoveryDetails;

/** §3: one consistent authority read, optionally carrying a committed action's sidecar. */
export type ExecutionRead<T> = {
  data: T;
  token: ExecutionToken;
  storeId: string;
  epoch: number;
  operationRecovery?: ExecutionReceiptRecovery;
};

/** One coordinator view of an explicitly addressed plan. */
export type ExecutionPlanView = {
  workflow: Omit<WorkflowSnapshot, "plans" | "coordinator_session" | "integration_merge_lease">;
  plan: Omit<PlanRow, "coordination" | "execution_lease">;
  coordination: RowCoordination | null;
  integrationLease: IntegrationMergeLease | null;
  frozenInput: CatalogExecutionPin | null;
};

/** §3: the authoritative execution state — root register plus its active lifecycles. */
export type ExecutionState = {
  root: StatusV2Doc;
  workflows: Array<{
    workflowToken: ExecutionToken;
    planTokens: Record<string, ExecutionToken>;
    state: Omit<WorkflowSnapshot, "plans" | "coordinator_session" | "integration_merge_lease">;
    plans: ExecutionPlanView[];
    coordinator: ExecutionSessionRef | null;
    integrationLease: IntegrationMergeLease | null;
  }>;
  /** Terminal headers outside ACTIVE registry membership, including their CAS revision. */
  terminalUnregistered?: Array<{ id: string; status: "completed" | "stopped" | "failed"; revision: number }>;
  terminalAdoptions?: Array<{ id: string; status: "completed" | "stopped" | "failed"; revision: number; lifecycle_adopted_at: string; adopt_reason: string; actor_session_id: string; operation_id: string }>;
};

/**
 * §3: the trusted caller a domain verb authorizes against. It comes only from
 * the adapter's trusted host identity (or the engine-owned local CLI identity
 * acquisition), NEVER from model request JSON — a caller-written role string
 * authorizes nothing.
 */
export type ExecutionCaller = {
  sessionId: string;
  role: "coordinator";
  workflowId: string;
};

/** §3: a domain call's context — the addressed store plus the trusted caller. */
export type ExecutionContext = StoreContext & { caller: ExecutionCaller };

/**
 * §3 the per-call envelope of ONE domain mutation: the operation id that makes
 * an identical retry a replay, the session reference the caller claims (an
 * identity the store revalidates, never a bearer credential) and the CAS token
 * the caller read. The addressed record is added by the verb that takes it.
 */
export type ExecutionMutation = {
  operationId: string;
  session: ExecutionSessionRef;
  expected: ExecutionToken;
};

/**
 * §3: the committed result of a domain operation. `data`/`token` describe the
 * state the operation produced (a replay returns the RECORDED receipt, not a
 * re-read), and `replayed` distinguishes the idempotent retry from the commit.
 */
export type ExecutionReceipt<T> = ExecutionRead<T> & {
  operationId: string;
  replayed: boolean;
  /**
   * §4.1 the sidecar of this call's outcome: what was applied, what was
   * already satisfied, the provenance it was resolved from, scoped warnings and
   * the known commit boundary (`RecoveryDetails`). Present on every frame
   * result; a refusal carries the same object under `error.details.recovery`.
   */
  recovery?: ExecutionReceiptRecovery;
};

// ---------------------------------------------------------------------------
// Canonical value form (§3.1)
// ---------------------------------------------------------------------------

function canonicalRefusal(detail: string): ExecutionError {
  return new ExecutionError("execution.canonical-value", `${detail} is not a canonical execution value`);
}

/** Unpaired UTF-16 surrogates are not canonical JSON text and are never normalized away. */
function canonicalString(value: string): string {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw canonicalRefusal("a string carrying an unpaired high surrogate");
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw canonicalRefusal("a string carrying an unpaired low surrogate");
    }
  }
  return JSON.stringify(value);
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw canonicalRefusal(`the non-finite number ${String(value)}`);
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw canonicalRefusal(`the unsafe integer ${value}`);
  // `String` is already the shortest round-tripping form JSON allows; -0 is "0".
  return String(value);
}

function canonicalArray(value: readonly unknown[], ancestors: Set<object>): string {
  if (ancestors.has(value)) throw canonicalRefusal("a cyclic structure");
  ancestors.add(value);
  const parts: string[] = [];
  // Indexed, not `map`: a hole is `undefined` and must refuse rather than
  // serialize into invalid JSON.
  for (let index = 0; index < value.length; index++) parts.push(canonical(value[index], ancestors));
  ancestors.delete(value);
  return `[${parts.join(",")}]`;
}

function canonicalObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw canonicalRefusal("a cyclic structure");
  ancestors.add(value);
  const record = value as Record<string, unknown>;
  // Default `Array#sort` compares UTF-16 code units — ECMAScript code-unit order.
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key], ancestors)}`);
  ancestors.delete(value);
  return `{${parts.join(",")}}`;
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return canonicalString(value);
    case "number":
      return canonicalNumber(value);
    case "object":
      break;
    default:
      throw canonicalRefusal(`an unsupported ${typeof value} value`);
  }
  if (Array.isArray(value)) return canonicalArray(value, ancestors);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw canonicalRefusal("an object whose prototype is neither Object.prototype nor null");
  }
  return canonicalObject(value as object, ancestors);
}

/**
 * §3.1 canonical form: object keys recursively sorted by ECMAScript code-unit
 * order, array order preserved, UTF-8 JSON without whitespace and one terminal
 * LF. Plain JSON objects/arrays/null/booleans/strings and finite safe numbers
 * only — undefined, non-finite values, unsafe integers, cycles, foreign
 * prototypes and unpaired surrogates refuse. Nothing is normalized: Unicode and
 * path strings are serialized as given. This form defines operation request
 * hashes and diagnostic export hashes; it is not the DB CAS token.
 */
export function serializeExecutionValue(value: unknown): string {
  return `${canonical(value, new Set())}\n`;
}

// ---------------------------------------------------------------------------
// Version tokens (§3.1)
// ---------------------------------------------------------------------------

/** §3.1 key part count per address kind. */
const KIND_KEY_LENGTHS: Record<ExecutionKind, number> = {
  root: 0,
  workflow: 1,
  plan: 2,
  session: 3,
  "integration-lease": 1,
  input: 2,
};

/** §3.1: a closed address-kind set — unknown kinds are never guessed. */
function isExecutionKind(value: unknown): value is ExecutionKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(KIND_KEY_LENGTHS, value);
}

const TOKEN_PREFIX = "exec-v1";
const STORE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const TOKEN_KEY_DECODER = new TextDecoder("utf-8", { fatal: true });

/** §3.1: the grammar-checked contents of an `exec-v1` token. */
export type ParsedExecutionToken = {
  kind: ExecutionKind;
  storeId: string;
  epoch: number;
  key: readonly string[];
  revision: number;
};

/** The address a caller believes a token carries; every part is compared exactly. */
export type ExecutionTokenExpectation = {
  kind: ExecutionKind;
  storeId: string;
  epoch: number;
  key: readonly string[];
  revision?: number;
};

function tokenRefusal(detail: string): ExecutionError {
  return new ExecutionError("execution.token-invalid", detail);
}

function canonicalIntegerText(value: number, what: string): string {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value <= 0) {
    throw tokenRefusal(`${what} must be a positive safe integer \u2014 got ${String(value)}`);
  }
  return String(value);
}

function positiveDecimal(text: string, what: string): number {
  if (!DECIMAL_RE.test(text)) {
    throw tokenRefusal(
      `${what} must be a plain decimal without sign, whitespace or leading zeros \u2014 got ${JSON.stringify(text)}`,
    );
  }
  const value = Number(text);
  if (value === 0) throw tokenRefusal(`${what} must be greater than 0 \u2014 got ${JSON.stringify(text)}`);
  if (value > Number.MAX_SAFE_INTEGER) {
    throw tokenRefusal(`${what} exceeds Number.MAX_SAFE_INTEGER \u2014 got ${JSON.stringify(text)}`);
  }
  return value;
}

function assertKeyShape(kind: ExecutionKind, key: readonly string[]): void {
  const expected = KIND_KEY_LENGTHS[kind];
  if (key.length !== expected) {
    throw tokenRefusal(`a ${kind} token key carries ${expected} part(s) \u2014 got ${key.length}`);
  }
  for (const part of key) {
    if (!isNonEmptyString(part)) throw tokenRefusal(`every ${kind} token key part must be a non-empty string`);
  }
  if (kind === "session" && key[1] !== "coordinator") {
    throw tokenRefusal(`a session token key carries role coordinator as its second part \u2014 got ${JSON.stringify(key[1])}`);
  }
}

/** `key64`: unpadded base64url over `serializeExecutionValue(key)` (§3.1). */
function encodeTokenKey(key: readonly string[]): string {
  return Buffer.from(serializeExecutionValue(key), "utf8").toString("base64url");
}

function decodeTokenKey(key64: string, kind: ExecutionKind): readonly string[] {
  if (!BASE64URL_RE.test(key64)) throw tokenRefusal("a token key must be unpadded base64url");
  let decoded: unknown;
  try {
    decoded = JSON.parse(TOKEN_KEY_DECODER.decode(Buffer.from(key64, "base64url")));
  } catch {
    throw tokenRefusal("a token key must be base64url-wrapped UTF-8 JSON");
  }
  if (!Array.isArray(decoded) || decoded.some((part) => typeof part !== "string")) {
    throw tokenRefusal("a token key must decode to a JSON array of strings");
  }
  const key = decoded as string[];
  assertKeyShape(kind, key);
  return key;
}

/** Build the `exec-v1:<kind>:<store UUID>:<epoch>:<key64>:<revision>` token (§3.1). */
export function executionToken(
  kind: ExecutionKind,
  storeId: string,
  epoch: number,
  key: readonly string[],
  revision: number,
): ExecutionToken {
  if (!isExecutionKind(kind)) throw tokenRefusal(`unknown execution kind ${JSON.stringify(kind)}`);
  if (!STORE_UUID_RE.test(storeId)) throw tokenRefusal(`a store identity must be a lowercase UUID \u2014 got ${JSON.stringify(storeId)}`);
  assertKeyShape(kind, key);
  const epochText = canonicalIntegerText(epoch, "the epoch");
  const revisionText = canonicalIntegerText(revision, "the revision");
  return `${TOKEN_PREFIX}:${kind}:${storeId}:${epochText}:${encodeTokenKey(key)}:${revisionText}` as ExecutionToken;
}

/**
 * §3.1 parse: exact arity, known kind, store UUID, canonical decimals and the
 * canonical key encoding. Anything else is `execution.token-invalid` — a
 * malformed token is never coerced, trimmed or reinterpreted.
 */
export function parseExecutionToken(value: unknown): ParsedExecutionToken {
  if (typeof value !== "string") throw tokenRefusal(`an execution token must be a string \u2014 got ${typeof value}`);
  const parts = value.split(":");
  if (parts.length !== 6) throw tokenRefusal(`an execution token has 6 colon-separated parts \u2014 got ${parts.length}`);
  const [prefix, kindText, storeId, epochText, key64, revisionText] = parts;
  if (prefix !== TOKEN_PREFIX) throw tokenRefusal(`an execution token starts with ${TOKEN_PREFIX} \u2014 got ${JSON.stringify(prefix)}`);
  if (!isExecutionKind(kindText)) throw tokenRefusal(`unknown execution kind ${JSON.stringify(kindText)}`);
  const kind = kindText;
  if (!STORE_UUID_RE.test(storeId)) throw tokenRefusal(`a store identity must be a lowercase UUID \u2014 got ${JSON.stringify(storeId)}`);
  const epoch = positiveDecimal(epochText, "the epoch");
  const revision = positiveDecimal(revisionText, "the revision");
  return { kind, storeId, epoch, key: decodeTokenKey(key64, kind), revision };
}

/**
 * §3.1 CAS check: parse, then compare the current store identity, epoch, kind
 * and key, and (when given) the expected revision. A wrong kind, a foreign
 * store or another address is `execution.token-kind` / `execution.scope-mismatch`,
 * a superseded epoch is the shared `store.stale-epoch` and a superseded revision
 * is `execution.stale-token` — never silently coerced.
 */
export function assertExecutionToken(value: unknown, expected: ExecutionTokenExpectation): ParsedExecutionToken {
  const parsed = parseTokenForAddress(value, expected);
  if (parsed.epoch !== expected.epoch) {
    throw authorityEpochRefusal({
      source: "the token",
      presentedEpoch: parsed.epoch,
      currentEpoch: expected.epoch,
      detail: `the token carries epoch ${parsed.epoch}; the current epoch is ${expected.epoch}. Reopen the store and re-read before retrying.`,
    });
  }
  if (expected.revision !== undefined && parsed.revision !== expected.revision) {
    throw new ExecutionError(
      "execution.stale-token",
      `the token carries revision ${parsed.revision}; the current revision is ${expected.revision}. Re-read and retry with the current token.`,
      {
        component: "revision",
        path: "expected",
        current_revision: expected.revision,
        presented_revision: parsed.revision,
      },
    );
  }
  return parsed;
}

/**
 * §3.1 the address half of one token comparison: exact kind, store and key. A
 * wrong kind, a foreign store or another address is `execution.token-kind` /
 * `execution.scope-mismatch` — the address a supplied token names is never
 * inferred, normalized or guessed. Epoch and revision stay with the caller,
 * so the two comparisons below share exactly this gate.
 *
 * The wrong-kind refusal names where the EXPECTED kind is read from (`mstar
 * status validate` and its JSON path, the CLI emitter of these tokens) for the
 * three kinds a CLI `--expect` carries; internal kinds have no CLI read path
 * and stay pointer-free.
 */
function tokenKindReadPointer(expected: Omit<ExecutionTokenExpectation, "revision">): string {
  if (expected.kind === "root") {
    return " Read the current root token with `mstar status validate` (output field data.token).";
  }
  if (expected.kind === "workflow") {
    return ` Read the current workflow token with \`mstar status validate\` (the data.workflows[] entry for workflow ${JSON.stringify(expected.key[0] ?? "")} \u2192 token).`;
  }
  if (expected.kind === "plan") {
    return ` Read the current plan token with \`mstar status validate\` (the data.authority.workflows[] entry for workflow ${JSON.stringify(expected.key[0] ?? "")} \u2192 planTokens[${JSON.stringify(expected.key[1] ?? "")}]).`;
  }
  return "";
}

function parseTokenForAddress(
  value: unknown,
  expected: Omit<ExecutionTokenExpectation, "revision">,
): ParsedExecutionToken {
  const parsed = parseExecutionToken(value);
  if (parsed.kind !== expected.kind) {
    throw new ExecutionError(
      "execution.token-kind",
      `expected a ${expected.kind} token \u2014 got a ${parsed.kind} token. The address kind is never inferred from a supplied token.${tokenKindReadPointer(expected)}`,
    );
  }
  const sameKey =
    parsed.key.length === expected.key.length && parsed.key.every((part, index) => part === expected.key[index]);
  if (parsed.storeId !== expected.storeId || !sameKey) {
    throw new ExecutionError(
      "execution.scope-mismatch",
      parsed.storeId !== expected.storeId
        ? `the token belongs to store ${parsed.storeId}, not to ${expected.storeId}`
        : `the token addresses ${JSON.stringify(parsed.key)}, not ${JSON.stringify(expected.key)}`,
      { expected: expected.key, actual: parsed.key },
    );
  }
  return parsed;
}

/**
 * §2.1/§4.1 (A26) the refusal of a superseded authority GENERATION, shared by
 * every fence that compares a caller-supplied epoch: a session reference and a
 * comparison token carry the same fact, so they get the same report. The
 * contract's recovery sidecar names what re-resolution the caller must perform
 * and that nothing was written or replayed from the old generation — a caller
 * that only saw the code would otherwise retry blindly against a store that
 * renumbered itself.
 */
function authorityEpochRefusal(input: {
  source: string;
  presentedEpoch: number;
  currentEpoch: number;
  detail: string;
  target?: RecoveryDetails["target"];
}): ExecutionError {
  const problem: RecoveryProblem = {
    component: "authority",
    path: "epoch",
    code: "store.stale-epoch",
    sourcesTried: [input.source, "store_meta.authority_epoch, read in this transaction"],
    currentFacts: [
      `${input.source} carries epoch ${input.presentedEpoch}`,
      `the store's current authority epoch is ${input.currentEpoch}`,
    ],
    needed:
      `re-resolve the current authority generation and re-acquire your own identity at epoch ${input.currentEpoch} ` +
      `(resume or rebind the session row of that epoch), then retry against the current token`,
    withheldEffect:
      `only the addressed effect: nothing was written, no revision advanced and no receipt was replayed from epoch ` +
      `${input.presentedEpoch}`,
    availableWork: [
      `read the current state at epoch ${input.currentEpoch}`,
      `resume or rebind your own execution session at epoch ${input.currentEpoch}`,
      "retry the operation with the token and reference of the current epoch",
    ],
  };
  return new ExecutionError("store.stale-epoch", input.detail, {
    component: problem.component,
    path: problem.path,
    current_epoch: input.currentEpoch,
    presented_epoch: input.presentedEpoch,
    sources_tried: problem.sourcesTried,
    current_facts: problem.currentFacts,
    needed: problem.needed,
    available_work: problem.availableWork,
    recovery: unresolvedRecovery({
      target: input.target ?? {},
      unresolved: [problem],
      resolvedFrom: [{ path: "epoch", source: input.source }],
    }),
  });
}

/**
 * §2.1/§4.1 (A26) the authority-generation fence of one frame: the reference a
 * caller presents must belong to THIS store and THIS epoch. A store mismatch is
 * a scope mismatch; a superseded epoch is the typed re-resolution report above,
 * so an authority that reactivated mid-call is re-resolved instead of being
 * written to (or replayed) under a generation that no longer exists.
 */
export function assertAuthorityGeneration(
  tx: ExecutionTransaction,
  input: { referenceStoreId: string; referenceEpoch: number; target?: RecoveryDetails["target"] },
): void {
  if (input.referenceStoreId !== tx.storeId) {
    throw new ExecutionError(
      "execution.scope-mismatch",
      `the session reference belongs to store ${input.referenceStoreId}, not to ${tx.storeId}`,
    );
  }
  if (input.referenceEpoch !== tx.epoch) {
    throw authorityEpochRefusal({
      source: "the session reference",
      presentedEpoch: input.referenceEpoch,
      currentEpoch: tx.epoch,
      target: input.target,
      detail: `the session reference carries epoch ${input.referenceEpoch}; the current epoch is ${tx.epoch}. Rebind the session and retry.`,
    });
  }
}

/**
 * §4.2 (R6/R7) the freshness verdict of one supplied comparison token for a
 * state intent. The token's ADDRESS (kind, store, key) and the authority
 * generation it was read under are strict: a token of another record, another
 * store or a superseded epoch authorizes nothing. Its REVISION is not a
 * constraint — it is the state the caller had read, and a revision that moved
 * says nothing about whether the requested effect is still valid. The frame
 * therefore recomputes the intent against the state it holds now and decides
 * semantically (already satisfied, genuinely conflicting, or applicable)
 * instead of refusing a stale number.
 *
 * `current` is the addressed record as this transaction reads it, so the
 * revision it carries is the one a caller must have read to be exactly current.
 */
export function resolveTokenFreshness(
  value: unknown,
  current: ExecutionTokenExpectation & { revision: number },
  options: { target?: RecoveryDetails["target"] } = {},
): TokenFreshness {
  const parsed = parseTokenForAddress(value, current);
  if (parsed.epoch !== current.epoch) {
    throw authorityEpochRefusal({
      source: "the comparison token",
      presentedEpoch: parsed.epoch,
      currentEpoch: current.epoch,
      target: options.target,
      detail: `the token carries epoch ${parsed.epoch}; the current epoch is ${current.epoch}. Reopen the store and re-read before retrying.`,
    });
  }
  return {
    readRevision: parsed.revision,
    currentRevision: current.revision,
    current: parsed.revision === current.revision,
  };
}

/**
 * §3.1/§4.2 the request fingerprint of one state intent: the operation kind, the
 * record it addresses, the caller identity the receipt is bound to and the
 * operation's own SEMANTIC SELECTION — never the transport freshness (`expected`
 * revision, `session` reference, `operationId`) the caller happened to present.
 *
 * A repeat after a lost response is the same intent even when the caller
 * re-read the state and re-presented a fresh token (design R6/R7: "reuse receipt
 * provenance without demanding its historical revision still equal the current
 * revision"), so the fingerprint must not move with that token; a different
 * business payload still moves it and stays an operation conflict (A13).
 */
export function semanticRequestHash(input: {
  operation: string;
  address: Readonly<Record<string, string>>;
  caller: ExecutionCaller;
  intent: Readonly<Record<string, unknown>>;
}): string {
  return createHash("sha256")
    .update(
      serializeExecutionValue({
        operation: input.operation,
        address: input.address,
        caller: {
          session_id: input.caller.sessionId,
          role: input.caller.role,
          workflow_id: input.caller.workflowId,
        },
        intent: input.intent,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * §4.1 the typed cause of one refusal a frame produced: the SAME error — code,
 * class and message unchanged — with the contract's `recovery` sidecar (and the
 * field facts beside it) merged into whatever details it already carried, so
 * `error.details.recovery` is the report and the prose is never the whole of
 * it. A value that is not an `Error` is returned untouched: no sidecar is ever
 * fabricated for a foreign value.
 */
export function withRecoveryDetails<T>(error: T, details: Record<string, unknown>): T {
  if (!(error instanceof Error)) return error;
  const target = error as { details?: Record<string, unknown> };
  target.details = { ...(target.details ?? {}), ...details };
  return error;
}

/** §4.2 the revision half of one state intent's freshness, as the frames report it. */
export type TokenFreshness = Readonly<{
  /** The record revision the caller's token carries (the state it had read). */
  readRevision: number;
  /** The record revision this transaction holds. */
  currentRevision: number;
  /** `false` when an accepted operation advanced the record since that read. */
  current: boolean;
}>;

// ---------------------------------------------------------------------------
// Store-side helpers
// ---------------------------------------------------------------------------

type StoreIdentity = { storeId: string; epoch: number };

function corrupt(detail: string): StoreError {
  return new StoreError("store.corrupt", `${detail}; the execution authority cannot be verified`);
}

function readStoreIdentity(db: StoreDb): StoreIdentity {
  const row = db.prepare("select store_id, authority_epoch from store_meta where id = 1").get() as
    | { store_id?: unknown; authority_epoch?: unknown }
    | undefined;
  if (!row || typeof row.store_id !== "string" || typeof row.authority_epoch !== "number") {
    throw corrupt("store_meta is missing or malformed");
  }
  return { storeId: row.store_id, epoch: row.authority_epoch };
}

/**
 * Read the execution metadata singleton inside the caller's transaction. The
 * schema/table checks are `openStore`'s (C1); this re-read exists so the
 * authority state and root revision a read or transition acts on come from the
 * SAME snapshot as the rows it touches.
 */
function readExecutionMetaRow(db: StoreDb): ExecutionMeta {
  const row = db
    .prepare(
      "select protocol_version, authority_state, revision, root_updated_at, manifest_id, activated_at " +
        "from execution_meta where id = 1",
    )
    .get() as
    | {
        protocol_version?: unknown;
        authority_state?: unknown;
        revision?: unknown;
        root_updated_at?: unknown;
        manifest_id?: unknown;
        activated_at?: unknown;
      }
    | undefined;
  if (
    !row ||
    typeof row.protocol_version !== "number" ||
    (row.authority_state !== "legacy" && row.authority_state !== "staged" && row.authority_state !== "active") ||
    typeof row.revision !== "number" ||
    typeof row.root_updated_at !== "string" ||
    (row.manifest_id !== null && row.manifest_id !== undefined && typeof row.manifest_id !== "string") ||
    (row.activated_at !== null && row.activated_at !== undefined && typeof row.activated_at !== "string")
  ) {
    throw corrupt("execution_meta is missing or malformed");
  }
  return {
    protocolVersion: row.protocol_version,
    authorityState: row.authority_state,
    revision: row.revision,
    rootUpdatedAt: row.root_updated_at,
    manifestId: (row.manifest_id as string | null | undefined) ?? null,
    activatedAt: (row.activated_at as string | null | undefined) ?? null,
  };
}

function storedJsonObject(text: unknown, what: string): Record<string, unknown> {
  if (typeof text !== "string") throw corrupt(`${what} is not a JSON string`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw corrupt(`${what} is not valid JSON (${(error as Error).message})`);
  }
  if (!isPlainObject(parsed)) throw corrupt(`${what} is not a JSON object`);
  return parsed;
}

function storedRevision(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw corrupt(`${what} is not a positive safe integer`);
  }
  return value;
}

function storedText(value: unknown, what: string): string {
  if (typeof value !== "string") throw corrupt(`${what} is not a string`);
  return value;
}

function validationRefusal(what: string, violations: Array<{ code: string; message: string }>): StoreError {
  return corrupt(`${what} does not validate (${violations.map((entry) => `${entry.code}: ${entry.message}`).join("; ")})`);
}

/** The frozen catalog input of one plan row, or null when the plan carries none. */
function readFrozenInput(json: unknown, what: string): CatalogExecutionPin | null {
  if (json === null || json === undefined) return null;
  const pin = storedJsonObject(json, what);
  if (
    !isNonEmptyString(pin.store_id) ||
    !STORE_UUID_RE.test(pin.store_id) ||
    typeof pin.entity_revision !== "number" ||
    !Number.isSafeInteger(pin.entity_revision) ||
    pin.entity_revision <= 0 ||
    !isNonEmptyString(pin.document_hash) ||
    !isNonEmptyString(pin.relation_hash)
  ) {
    throw corrupt(`${what} is not a complete catalog execution pin`);
  }
  const keys = Object.keys(pin);
  if (keys.length !== 4) {
    throw corrupt(`${what} carries fields beyond the catalog execution pin contract`);
  }
  return {
    store_id: pin.store_id,
    entity_revision: pin.entity_revision,
    document_hash: pin.document_hash,
    relation_hash: pin.relation_hash,
  };
}

function sessionRef(store: StoreIdentity, workflowId: string, row: Record<string, unknown>): ExecutionSessionRef {
  if (row.role !== "coordinator") throw corrupt(`execution_sessions(${workflowId}) carries a non-coordinator role`);
  if (!isNonEmptyString(row.session_id)) throw corrupt(`execution_sessions(${workflowId}) carries an empty session identity`);
  if (typeof row.epoch !== "number" || !Number.isSafeInteger(row.epoch) || row.epoch < 0) {
    throw corrupt(`execution_sessions(${workflowId},${row.session_id}) carries a non-integer epoch`);
  }
  return {
    storeId: store.storeId,
    epoch: row.epoch,
    workflowId,
    role: "coordinator",
    sessionId: row.session_id,
  };
}
/**
 * §2.2/§3.1 the workflow's integration merge lease as the DB holds it: ONE row
 * per workflow (the merge is workflow-wide and exclusive) carrying the claim
 * plus the tombstone a release leaves behind. A released row keeps its
 * revision, owner epoch and identity — the §3.1 ABA guard, because deleting it
 * would let a later claim reuse the same revision — and is not a claim: the
 * view reports `null` for it, exactly as the file route deletes the key on
 * release. A row that carries no `status` is a claim.
 */
type StoredIntegrationLease = {
  lease: IntegrationMergeLease;
  status: "held" | "released";
  revision: number;
  ownerEpoch: number;
};

function readIntegrationLease(json: unknown, what: string): IntegrationMergeLease {
  const lease = storedJsonObject(json, what);
  const validation = validateIntegrationMergeLease(lease);
  if (!validation.ok) throw validationRefusal(what, validation.violations);
  return lease as unknown as IntegrationMergeLease;
}

function readIntegrationLeaseRow(db: StoreDb, workflowId: string): StoredIntegrationLease | null {
  const row = db
    .prepare("select revision, owner_epoch, lease_json from execution_integration_leases where workflow_id = ?")
    .get(workflowId) as { revision?: unknown; owner_epoch?: unknown; lease_json?: unknown } | undefined;
  if (row === undefined) return null;
  const what = `execution_integration_leases(${workflowId}).lease_json`;
  const lease = readIntegrationLease(row.lease_json, what);
  const status = lease.status;
  if (status !== undefined && status !== "held" && status !== "released") {
    throw corrupt(`${what} carries status ${JSON.stringify(status)}, which is neither held nor released`);
  }
  return {
    lease,
    status: status === "released" ? "released" : "held",
    revision: storedRevision(row.revision, `execution_integration_leases(${workflowId}).revision`),
    ownerEpoch: storedRevision(row.owner_epoch, `execution_integration_leases(${workflowId}).owner_epoch`),
  };
}

/** Assemble one workflow's view (workflow row, plans, sessions, leases, inputs). */
function readWorkflowView(
  db: StoreDb,
  store: StoreIdentity,
  workflowId: string,
): ExecutionState["workflows"][number] {
  const workflowRow = db
    .prepare("select revision, state_json from execution_workflows where workflow_id = ?")
    .get(workflowId) as { revision?: unknown; state_json?: unknown } | undefined;
  if (!workflowRow) {
    throw corrupt(`execution_registry lists workflow ${workflowId} without an execution_workflows row`);
  }
  const revision = storedRevision(workflowRow.revision, `execution_workflows(${workflowId}).revision`);
  const state = storedJsonObject(workflowRow.state_json, `execution_workflows(${workflowId}).state_json`);
  if (state.id !== workflowId) {
    throw corrupt(
      `execution_workflows(${workflowId}).state_json carries id ${JSON.stringify(state.id)} and does not describe its own key`,
    );
  }
  // §2.2: `plans` and `integration_merge_lease` are OWNED by execution_plans and
  // execution_integration_leases. A second copy inside the header would be a
  // second authority, so it is refused rather than merged or dropped.
  if (state.plans !== undefined || state.integration_merge_lease !== undefined || state.coordinator_session !== undefined) {
    throw corrupt(
      `execution_workflows(${workflowId}).state_json carries plans/integration_merge_lease/coordinator_session, which are owned by ` +
        `execution_plans/execution_integration_leases/execution_sessions`,
    );
  }
  const workflowValidation = validateWorkflowSnapshot({ ...state, plans: [] });
  if (!workflowValidation.ok) {
    throw validationRefusal(`execution_workflows(${workflowId}).state_json`, workflowValidation.violations);
  }

  const sessions = db
    .prepare("select role, session_id, epoch, state from execution_sessions where workflow_id = ? and role = 'coordinator'")
    .all(workflowId) as Array<Record<string, unknown>>;
  const activeSessions = sessions.filter((entry) => entry.state === "active");
  const inputs = db
    .prepare("select plan_id, catalog_pin_json from execution_inputs where workflow_id = ?")
    .all(workflowId) as Array<Record<string, unknown>>;
  const integrationRow = readIntegrationLeaseRow(db, workflowId);
  const coordinatorRow = activeSessions.find((row) => row.role === "coordinator");
  const integrationLease = integrationRow === null || integrationRow.status === "released" ? null : integrationRow.lease;

  const planRows = db
    .prepare(
      "select plan_id, revision, ordinal, state_json, coordination_json from execution_plans " +
        "where workflow_id = ? order by ordinal",
    )
    .all(workflowId) as Array<{
    plan_id?: unknown;
    revision?: unknown;
    ordinal?: unknown;
    state_json?: unknown;
    coordination_json?: unknown;
  }>;

  const planTokens: Record<string, ExecutionToken> = {};
  const plans: ExecutionPlanView[] = [];
  const planIds = planRows.map((entry) => storedText(entry.plan_id, `execution_plans(${workflowId}).plan_id`));
  // §D/§A1 the snapshot shape the SHARED route rules read: the workflow header
  // owns no plans (they are `execution_plans` rows), so the row identities are
  // projected in here once and whether a plan is the single row of a standalone
  // development workflow stays exactly the shared rule's decision.
  const routeSnapshot = {
    ...(state as unknown as WorkflowSnapshot),
    plans: planIds.map((planId) => ({ id: planId }) as PlanRow),
  } as WorkflowSnapshot;
  for (const row of planRows) {
    const planId = storedText(row.plan_id, `execution_plans(${workflowId}).plan_id`);
    const planRevision = storedRevision(row.revision, `execution_plans(${workflowId},${planId}).revision`);
    const planState = storedJsonObject(row.state_json, `execution_plans(${workflowId},${planId}).state_json`);
    const storedCoordination = storedJsonObject(
      row.coordination_json,
      `execution_plans(${workflowId},${planId}).coordination_json`,
    );
    // §2.2: the plan state is the row minus `coordination`/`execution_lease`, and
    // the stored coordination block is the block minus `revision`/`session`.
    // Anything else is a second authority or a session credential in the DB and
    // refuses instead of being merged.
    if (planState.coordination !== undefined || planState.execution_lease !== undefined) {
      throw corrupt(
        `execution_plans(${workflowId},${planId}).state_json carries coordination/execution_lease, which are owned ` +
          `by coordination_json, not by the row state`,
      );
    }
    if (planState.id !== planId) {
      throw corrupt(
        `execution_plans(${workflowId},${planId}).state_json carries id ${JSON.stringify(planState.id)} and does not describe its own key`,
      );
    }
    const planValidation = validatePlanRow(planState);
    if (!planValidation.ok) {
      throw validationRefusal(`execution_plans(${workflowId},${planId}).state_json`, planValidation.violations);
    }
    if (storedCoordination.revision !== undefined || storedCoordination.session !== undefined) {
      throw corrupt(
        `execution_plans(${workflowId},${planId}).coordination_json carries revision/session, which live in the ` +
          `revision column and in execution_sessions; the DB authority stores neither`,
      );
    }
    // The row column is the revision; the stored block carries the rest (§2.2).
    const coordinationViolations = storedCoordinationViolations(storedCoordination, {
      revision: planRevision,
      route: rowValidationRoute(routeSnapshot, planState as PlanRow),
      what: `execution_plans(${workflowId},${planId}).coordination_json`,
    });
    if (coordinationViolations.length > 0) {
      throw validationRefusal(`execution_plans(${workflowId},${planId}).coordination_json`, coordinationViolations);
    }
    const hasCoordination = Object.keys(storedCoordination).length > 0;
    const inputRow = inputs.find((entry) => entry.plan_id === planId);
    const projectedCoordination = { revision: planRevision, ...storedCoordination };
    planTokens[planId] = executionToken("plan", store.storeId, store.epoch, [workflowId, planId], planRevision);
    plans.push({
      workflow: state as unknown as ExecutionPlanView["workflow"],
      plan: planState as unknown as ExecutionPlanView["plan"],
      coordination: hasCoordination ? (projectedCoordination as unknown as RowCoordination) : null,
      integrationLease,
      frozenInput: inputRow
        ? readFrozenInput(inputRow.catalog_pin_json, `execution_inputs(${workflowId},${planId}).catalog_pin_json`)
        : null,
    });
  }

  return {
    workflowToken: executionToken("workflow", store.storeId, store.epoch, [workflowId], revision),
    planTokens,
    state: state as unknown as ExecutionState["workflows"][number]["state"],
    plans,
    coordinator: coordinatorRow ? sessionRef(store, workflowId, coordinatorRow) : null,
    integrationLease,
  };
}

/** The whole graph in the caller's transaction: registry order is creation order. */
function readExecutionGraph(db: StoreDb, store: StoreIdentity, meta: ExecutionMeta): ExecutionState {
  const registry = db
    .prepare("select workflow_id, entry_json from execution_registry order by rowid")
    .all() as Array<{ workflow_id?: unknown; entry_json?: unknown }>;
  const entries: WorkflowEntry[] = [];
  const workflows: ExecutionState["workflows"] = [];
  const registeredIds = new Set<string>();
  for (const row of registry) {
    const workflowId = storedText(row.workflow_id, "execution_registry.workflow_id");
    const entry = storedJsonObject(row.entry_json, `execution_registry(${workflowId}).entry_json`);
    const validation = validateWorkflowEntry(entry);
    if (!validation.ok) throw validationRefusal(`execution_registry(${workflowId}).entry_json`, validation.violations);
    if (entry.id !== workflowId) {
      throw corrupt(`execution_registry(${workflowId}).entry_json carries id ${JSON.stringify(entry.id)}`);
    }
    registeredIds.add(workflowId);
    entries.push(entry as unknown as WorkflowEntry);
    workflows.push(readWorkflowView(db, store, workflowId));
  }
  const terminalUnregistered: NonNullable<ExecutionState["terminalUnregistered"]> = [];
  const terminalAdoptions: NonNullable<ExecutionState["terminalAdoptions"]> = [];
  const headers = db.prepare("select workflow_id, revision, state_json from execution_workflows order by rowid")
    .all() as Array<{ workflow_id?: unknown; revision?: unknown; state_json?: unknown }>;
  for (const row of headers) {
    const id = storedText(row.workflow_id, "execution_workflows.workflow_id");
    if (registeredIds.has(id)) continue;
    const state = storedJsonObject(row.state_json, `execution_workflows(${id}).state_json`);
    if (state.status !== "completed" && state.status !== "stopped" && state.status !== "failed") continue;
    const revision = storedRevision(row.revision, `execution_workflows(${id}).revision`);
    if (isNonEmptyString(state.lifecycle_adopted_at) && isNonEmptyString(state.adopt_reason) &&
        isNonEmptyString(state.adoption_actor_session_id) && isNonEmptyString(state.adoption_operation_id)) {
      terminalAdoptions.push({
        id, status: state.status, revision,
        lifecycle_adopted_at: state.lifecycle_adopted_at,
        adopt_reason: state.adopt_reason,
        actor_session_id: state.adoption_actor_session_id,
        operation_id: state.adoption_operation_id,
      });
    } else {
      terminalUnregistered.push({ id, status: state.status, revision });
    }
  }
  return {
    root: { version: 2, updated_at: meta.rootUpdatedAt, workflows: entries },
    workflows,
    ...(terminalUnregistered.length === 0 ? {} : { terminalUnregistered }),
    ...(terminalAdoptions.length === 0 ? {} : { terminalAdoptions }),
  };
}

// ---------------------------------------------------------------------------
// Transaction ownership (§4.1)
// ---------------------------------------------------------------------------

/**
 * Transaction owners per canonical DB path and async context: a nested domain
 * operation on the same store refuses `execution.reentrant` instead of opening
 * a second transaction, while independent concurrent callers (separate async
 * chains) are not treated as nested. Same primitive and same reasoning as
 * `withStatusWriteLock`'s reentrancy detection (lease.ts).
 */
const ownedTransactions = new AsyncLocalStorage<ReadonlySet<string>>();

/** What a transition or read body may address — the owned handle plus the store identity it read. */
export type ExecutionTransaction = {
  db: StoreDb;
  storeId: string;
  epoch: number;
  /** `execution_meta` as read inside this transaction; `authorityState` still applies. */
  execution: ExecutionMeta;
};

/**
 * §4.1 one transaction per accepted domain operation: open one handle,
 * `BEGIN IMMEDIATE`, read the store identity and execution metadata, run a
 * SYNCHRONOUS typed transition body, then commit or roll back as a unit.
 *
 * Re-entry refuses SYNCHRONOUSLY, before a handle is opened: a nested domain
 * operation cannot silently become a second transaction, and the caller's
 * transition body sees the refusal at the call site.
 *
 * Module-level export for C3/C4 and the ownership proofs; intentionally absent
 * from the package index, so it is never a public arbitrary SQL writer.
 */
export function withExecutionTransaction<T>(
  context: StoreContext,
  transition: (tx: ExecutionTransaction) => T,
): Promise<T> {
  const dbPath = storeDbPath(context);
  const held = ownedTransactions.getStore();
  if (held?.has(dbPath)) {
    throw new ExecutionError(
      "execution.reentrant",
      `this async context already owns a transaction on ${dbPath}. A domain operation opens exactly one ` +
        `transaction; a nested call would commit or roll back the outer one's work and is refused before anything runs.`,
    );
  }
  return ownedTransactions.run(new Set([...(held ?? []), dbPath]), async () => {
    const handle = await openStore(context, "write");
    try {
      if (handle.execution === null) {
        throw new ExecutionError(
          "execution.not-active",
          `the store at ${dbPath} predates the execution schema (migration ${handle.schemaVersion} applied). ` +
            `There is no execution authority to transact against; nothing was written.`,
        );
      }
      handle.db.exec("begin immediate");
      const execution = readExecutionMetaRow(handle.db);
      const identity = readStoreIdentity(handle.db);
      try {
        const result = transition({
          db: handle.db,
          storeId: identity.storeId,
          epoch: identity.epoch,
          execution,
        });
        if (typeof (result as { then?: unknown })?.then === "function") {
          throw new ExecutionError(
            "execution.reentrant",
            "the transition body returned a promise. An execution transaction body is synchronous: nothing " +
              "awaits, launches or reads outside the transaction between BEGIN and COMMIT.",
          );
        }
        handle.db.exec("commit");
        return result;
      } catch (error) {
        try {
          handle.db.exec("rollback");
        } catch {
          // nothing committed either way
        }
        throw error;
      }
    } finally {
      handle.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Read and initialize (§3)
// ---------------------------------------------------------------------------

/**
 * §3 one consistent READ of the execution authority: a read-intent handle, a
 * read transaction and the metadata singleton re-read inside it, so the body
 * sees the SAME snapshot. Same fail-closed order as `withExecutionTransaction`
 * (metadata and identity first, in-transaction), without taking SQLite's write
 * lock: a reader never blocks a writer, and a migrated or staged store is never
 * read as empty authority. The body is synchronous by construction — no
 * database work happens between `begin` and `commit`.
 */
async function withExecutionReadTransaction<T>(
  context: StoreContext,
  body: (tx: ExecutionTransaction) => T,
): Promise<T> {
  const handle = await openStore(context, "read");
  try {
    if (handle.execution === null) {
      throw new ExecutionError(
        "execution.not-active",
        "this store predates the execution schema, so it has no execution authority. Upgrade the store and " +
          "initialize the execution domain before reading execution state.",
      );
    }
    const db = handle.db;
    db.exec("begin");
    try {
      const meta = readExecutionMetaRow(db);
      if (meta.authorityState !== "active") {
        throw new ExecutionError(
          "execution.not-active",
          `the execution authority is ${meta.authorityState}; ordinary execution reads require an active authority. ` +
            `A staged store is inspectable only through migration diagnostics.`,
        );
      }
      const store = readStoreIdentity(db);
      const result = body({ db, storeId: store.storeId, epoch: store.epoch, execution: meta });
      db.exec("commit");
      return result;
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // the read transaction is already gone
      }
      throw error;
    }
  } finally {
    handle.close();
  }
}

/**
 * §3 consistent state read: one read-only transaction over the whole graph,
 * returning the root register with its active lifecycles and the root token the
 * caller passes back as CAS. Refuses `execution.not-active` unless the execution
 * authority is active — a migrated or staged store is never read as empty
 * authority, and this reader mints no store.
 */
export async function readExecutionState(context: StoreContext): Promise<ExecutionRead<ExecutionState>> {
  return withExecutionReadTransaction(context, (tx) => ({
    data: readExecutionGraph(tx.db, { storeId: tx.storeId, epoch: tx.epoch }, tx.execution),
    token: executionToken("root", tx.storeId, tx.epoch, [], tx.execution.revision),
    storeId: tx.storeId,
    epoch: tx.epoch,
  }));
}
/**
 * Read the cleanup safety universe from ACTIVE authority, including retained
 * workflow rows that are no longer members of the root registry.
 */
export async function readExecutionCleanupSnapshots(
  context: StoreContext,
  workflowId: string,
): Promise<{ selected: WorkflowSnapshot; workflows: readonly WorkflowSnapshot[] }> {
  if (!isNonEmptyString(workflowId)) throw new CoordinationError("coordination.invalid-input", "Invalid workflowId: provide a non-empty value. Inspect registered workflows with mstar status validate.");
  return withExecutionReadTransaction(context, (tx) => {
    const store = { storeId: tx.storeId, epoch: tx.epoch };
    const registered = readExecutionGraph(tx.db, store, tx.execution);
    const byId = new Map<string, WorkflowSnapshot>();
    for (const workflow of registered.workflows) byId.set(workflow.state.id, cleanupSnapshot(workflow));
    const retained = tx.db.prepare("select workflow_id from execution_workflows order by rowid").all() as Array<{ workflow_id?: unknown }>;
    for (const row of retained) {
      const id = storedText(row.workflow_id, "execution_workflows.workflow_id");
      if (!byId.has(id)) byId.set(id, cleanupSnapshot(readWorkflowView(tx.db, store, id)));
    }
    const selected = byId.get(workflowId);
    if (selected === undefined) {
      throw new CoordinationError(
        "coordination.workflow-not-found",
        "The requested workflow is not registered in this execution authority. Inspect registered workflows with mstar status validate; if none remain, no workflow-scoped cleanup can be selected.",
        { workflow_id: workflowId },
      );
    }
    return { selected, workflows: [...byId.values()] };
  });
}

function cleanupSnapshot(workflow: ExecutionState["workflows"][number]): WorkflowSnapshot {
  return {
    ...(workflow.state as unknown as WorkflowSnapshot),
    ...(workflow.integrationLease === null ? {} : { integration_merge_lease: workflow.integrationLease }),
    plans: workflow.plans.map(({ plan, coordination }) => ({
      ...plan,
      ...(coordination === null ? {} : { coordination }),
    })),
  };
}

/**
 * §3 the same consistent state read INSIDE a transaction the caller already
 * owns — the receipt payload of a transition that returns the whole graph (its
 * accepted effect as committed, which is why a terminal transition's receipt no
 * longer lists the workflow it just unregistered). A second read handle here
 * would be the nested transaction §4.1 refuses.
 *
 * `execution_meta` is read from THIS transaction rather than reused from the
 * snapshot `withExecutionTransaction` read at `BEGIN`, because the accepted
 * transition's own writes may have advanced the root revision and its timestamp
 * after that snapshot (`recordRootMembershipLoss` on a terminal close). The
 * receipt must witness the COMMITTED root revision — it is the token the caller
 * stores back as CAS, and a fresh `readExecutionState` would observe exactly
 * this row — which is the same arithmetic the creation writer performs when it
 * builds its receipt from the metadata it just advanced.
 */
export function readExecutionStateGraph(tx: ExecutionTransaction): ExecutionRead<ExecutionState> {
  const meta = readExecutionMetaRow(tx.db);
  return {
    data: readExecutionGraph(tx.db, { storeId: tx.storeId, epoch: tx.epoch }, meta),
    token: executionToken("root", tx.storeId, tx.epoch, [], meta.revision),
    storeId: tx.storeId,
    epoch: tx.epoch,
  };
}

/**
 * Live legacy execution sources of a control harness. The v2/v1 root register is
 * the file at the harness root; snapshots, `sessions/*.json` envelopes and
 * `notes.jsonl` ledgers all live under the workflow tree. Archived history under
 * `<harness>/archived/` is read-only provenance rather than a live source, so it
 * does not block an empty initialization.
 */
function assertNoLegacyExecutionSources(context: StoreContext): void {
  const harnessDir = dirname(storeDbPath(context));
  const workflowDir = resolveWorkflowDir(harnessDir, { harnessDir });
  const sources: string[] = [];
  const statusPath = join(harnessDir, "status.json");
  if (existsSync(statusPath)) sources.push(statusPath);
  if (existsSync(workflowDir)) {
    // Fail closed: a path that exists but cannot be listed is a source too.
    let entries: string[];
    try {
      entries = readdirSync(workflowDir);
    } catch {
      entries = ["<unreadable>"];
    }
    if (entries.length > 0) sources.push(`${workflowDir} (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`);
  }
  if (sources.length > 0) {
    throw new ExecutionError(
      "execution.not-empty",
      `the control harness at ${harnessDir} still holds live execution sources: ${sources.join(", ")}. ` +
        `Execution authority is initialized only for an empty execution workspace \u2014 this workspace belongs on the ` +
        `staged migration route. Nothing was created or modified.`,
    );
  }
}

/** §3: the store must already be the ACTIVE issue/catalog authority. */
function assertActiveStoreAuthority(db: StoreDb): void {
  const row = db.prepare("select authority_state from store_meta where id = 1").get() as
    | { authority_state?: unknown }
    | undefined;
  if (!row || typeof row.authority_state !== "string") throw corrupt("store_meta is missing");
  if (row.authority_state !== "active") {
    throw new ExecutionError(
      "store.not-active",
      `the issue/catalog store is ${row.authority_state}; run \`mstar store upgrade --operator <name>\` to import legacy ` +
        "workspace rows and activate both authorities; nothing was modified.",
    );
  }
}

/** §3: no execution records and no catalog execution binding may exist yet. */
function assertExecutionDomainEmpty(db: StoreDb, meta: ExecutionMeta): void {
  if (meta.authorityState === "staged") {
    throw new ExecutionError(
      "execution.not-active",
      "the execution authority is staged. Run `mstar store upgrade --operator <name>` to import workspace records " +
        "and complete the minimal cutover; nothing was modified.",
    );
  }
  if (meta.authorityState === "active") {
    throw new ExecutionError(
      "execution.not-empty",
      "the execution authority is already active. Initialization is create-only and never resets a live " +
        "execution domain; nothing was modified.",
    );
  }
  const tables = [
    "execution_workflows",
    "execution_registry",
    "execution_plans",
    "execution_sessions",
    "execution_integration_leases",
    "execution_inputs",
    "execution_operations",
    "execution_migrations",
    "catalog_execution_bindings",
  ];
  for (const table of tables) {
    const row = db.prepare(`select count(*) as n from ${table}`).get() as { n?: unknown } | undefined;
    const count = typeof row?.n === "number" ? row.n : 0;
    if (count > 0) {
      throw new ExecutionError(
        "execution.not-empty",
        `${table} already holds ${count} row(s). Initialization creates an empty execution authority and never ` +
          `clears or adopts existing records; nothing was modified.`,
      );
    }
  }
}

/**
 * §3 create-only empty-execution initializer: require an active issue/catalog
 * store, no live execution sources and an empty execution domain, then flip
 * execution `legacy → active`, seed the empty root revision and advance the
 * store-wide epoch in ONE transaction. Issue/catalog rows are untouched; the
 * schema upgrade alone never activates execution. This is a real domain
 * initializer for a genuinely empty execution workspace, not a test flag, and it
 * is wired to no CLI.
 */
export async function initializeExecutionAuthority(context: StoreContext): Promise<ExecutionRead<ExecutionState>> {
  const harnessDir = dirname(storeDbPath(context));
  const statusPath = join(harnessDir, "status.json");
  // Same-host exclusive write lock used by status.json / snapshot writers
  // (`withStatusWriteLock` in lease.ts). File lock first, then the SQLite
  // transaction — never the other way around. Recheck the filesystem witness
  // immediately before commit so a rogue writer that skipped the lock still
  // cannot land an active authority beside a live legacy source.
  return withStatusWriteLock(statusPath, async () => {
    assertNoLegacyExecutionSources(context);
    await withExecutionTransaction(context, (tx) => {
      assertActiveStoreAuthority(tx.db);
      assertExecutionDomainEmpty(tx.db, tx.execution);
      const now = new Date().toISOString();
      tx.db
        .prepare(
          "update execution_meta set authority_state = 'active', revision = revision + 1, root_updated_at = ?, " +
            "activated_at = ? where id = 1",
        )
        .run(now, now);
      tx.db.prepare("update store_meta set authority_epoch = authority_epoch + 1, revision = revision + 1 where id = 1").run();
      assertNoLegacyExecutionSources(context);
    });
    return readExecutionState(context);
  });
}

// ---------------------------------------------------------------------------
// Domain creation: workflow identity, registry membership, sealed inputs (§3)
// ---------------------------------------------------------------------------

/** §3.1 operation ids: nonempty ASCII `[A-Za-z0-9._:-]+`, at most 128 characters. */
const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * §3.1 the operation-id gate every domain verb runs before it touches a store:
 * the id is the store-epoch-scoped idempotency key of one request, so an
 * unusable one is refused as caller input rather than becoming a ledger row.
 */
export function assertOperationId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID_RE.test(value)) {
    throw invalidInput(
      "Invalid operation id: provide 1–128 ASCII characters from [A-Za-z0-9._:-]. Inspect workflow authority with mstar status validate.",
    );
  }
  return value;
}

/** §3.1: the operation kind the create request hash is namespaced by. */
const CREATE_WORKFLOW_OPERATION = "createExecutionWorkflow";

/** One plan row of a supplied snapshot, with the catalog selection it records. */
type ResolvedCreationPlan = {
  planId: string;
  /** The frozen row as supplied — the input of `executionInputHash`. */
  row: Record<string, unknown>;
  /** The catalog selection the row records, or `null` when it selects none. */
  pin: CatalogExecutionPin | null;
};

/** §3 the resolved create request: identity, the entry/snapshot pair and the plan rows it seals. */
export type ResolvedCreation = {
  workflowId: string;
  entry: WorkflowEntry;
  snapshot: WorkflowSnapshot;
  plans: ResolvedCreationPlan[];
};

/** The single carrier of all caller-input refusals (§5 retains `coordination.*`). */
function invalidInput(detail: string): CoordinationError {
  return new CoordinationError("coordination.invalid-input", detail);
}

/** The single carrier of the create-only refusals: a lifecycle that is not new. */
function notNewLifecycle(detail: string): ExecutionError {
  return new ExecutionError("execution.not-empty", detail);
}

/**
 * The catalog selection one supplied plan row records (`metadata.catalog_pin`,
 * the state-projection contract §1 pin), or `null` when the row selects none.
 * An unbound plan is legitimate — no catalog store, or a plan the catalog does
 * not select — and creation never invents a selection for it. A pin that is not
 * the complete four-field identity is a frozen-input conflict, never a partial
 * pin that would be sealed as if it were whole.
 */
export function suppliedCatalogPin(row: Record<string, unknown>, workflowId: string, planId: string): CatalogExecutionPin | null {
  const metadata = isPlainObject(row.metadata) ? row.metadata : null;
  const raw = metadata === null ? undefined : metadata.catalog_pin;
  if (raw === undefined || raw === null) return null;
  const what = `plan ${planId}'s metadata.catalog_pin`;
  const details = { workflow_id: workflowId, plan_id: planId };
  if (!isPlainObject(raw) || Object.keys(raw).length !== 4) {
    throw new ExecutionPinConflictError(
      `${what} is not a complete catalog execution pin (store_id, entity_revision, document_hash, relation_hash); ` +
        "a malformed selection is never sealed as authority",
      details,
    );
  }
  if (
    !isNonEmptyString(raw.store_id) ||
    !STORE_UUID_RE.test(raw.store_id) ||
    typeof raw.entity_revision !== "number" ||
    !Number.isSafeInteger(raw.entity_revision) ||
    raw.entity_revision <= 0 ||
    !isNonEmptyString(raw.document_hash) ||
    !isNonEmptyString(raw.relation_hash)
  ) {
    throw new ExecutionPinConflictError(
      `${what} is not a complete catalog execution pin (store_id, entity_revision, document_hash, relation_hash) ` +
        `\u2014 got ${JSON.stringify(raw)}`,
      details,
    );
  }
  return {
    store_id: raw.store_id,
    entity_revision: raw.entity_revision,
    document_hash: raw.document_hash,
    relation_hash: raw.relation_hash,
  };
}

/**
 * §3 argument resolution for `createExecutionWorkflow`: caller scope, the
 * operation id, the entry/snapshot pair and its identity anchors, and the
 * snapshot's new/unbound/unleased/no-accepted-evidence requirement. Pure
 * argument checks — no store is opened, and nothing here can read or write
 * authority. A snapshot that carries coordinator binding, leases, delivery
 * evidence or a terminal status is a historical lifecycle: it belongs on the
 * migration route, never on the create-only path.
 *
 * The caller's session id is creator ATTRIBUTION, not a creation requirement:
 * an ACTIVE registration from a transport that carries no session identity
 * creates the workflow with a NULL `creator_session_id`, and the trust
 * boundary lives at bind time — the first coordinator bind adopts a
 * NULL-creator workflow once (§2.3), after which the creator fence holds.
 */
export function resolveCreateWorkflow(
  caller: ExecutionCaller,
  entry: unknown,
  snapshot: unknown,
  operationId: unknown,
): ResolvedCreation {
  if (!isPlainObject(caller)) {
    throw invalidInput("Invalid execution caller: provide a coordinator caller object. Inspect workflow authority with mstar status validate.");
  }
  assertOperationId(operationId);
  const entryGate = validateWorkflowEntry(entry);
  const snapshotGate = validateWorkflowSnapshot(snapshot);
  const violations = [...entryGate.violations, ...snapshotGate.violations];
  if (violations.length > 0) {
    throw new CoordinationError(
      "coordination.invalid-input",
      "Workflow entry/snapshot is invalid. Inspect registered workflow state with mstar status validate.",
      { violations: violations.map(({ code, message }) => ({ code, message })) },
    );
  }
  const workflow = entry as WorkflowEntry;
  const doc = snapshot as WorkflowSnapshot & Record<string, unknown>;
  const workflowId = workflow.id;

  if (caller.role !== "coordinator") {
    throw new ExecutionError("execution.scope-mismatch", "creating a workflow is a coordinator operation");
  }
  if (caller.workflowId !== workflowId) {
    throw new ExecutionError(
      "execution.scope-mismatch",
      `the caller belongs to workflow ${caller.workflowId}, not to the workflow ${workflowId} this request creates`,
    );
  }
  for (const field of ["id", "type", "started_at"] as const) {
    if (workflow[field] !== doc[field]) {
      throw invalidInput(
        `the workflow entry and its snapshot disagree on ${field}: entry ${JSON.stringify(workflow[field])}, ` +
          `snapshot ${JSON.stringify(doc[field])}. Registration fixes the identity anchors; creation never reconciles them.`,
      );
    }
  }
  if (doc.coordination !== undefined || doc.integration_merge_lease !== undefined || doc.delivery !== undefined) {
    throw notNewLifecycle(
      `snapshot ${workflowId} already carries a coordinator binding, an integration merge lease or delivery evidence. ` +
        `Creation writes a NEW, unbound, unleased lifecycle that owns no accepted evidence; an existing lifecycle ` +
        `belongs on the staged migration route. Nothing was created.`,
    );
  }
  if (isTerminalSnapshot(doc)) {
    throw notNewLifecycle(
      `snapshot ${workflowId} is ${doc.status}. Registry membership selects an ACTIVE lifecycle, so a terminal snapshot ` +
        `is never created into the root register; nothing was created.`,
    );
  }

  const plans: ResolvedCreationPlan[] = [];
  const seen = new Set<string>();
  for (const row of doc.plans) {
    const planId = rowPlanId(row) as string;
    if (seen.has(planId)) {
      throw new CoordinationError("coordination.invalid-input", "Snapshot contains a duplicate plan identity. Inspect workflow rows with mstar status validate.", { workflow_id: workflowId, plan_id: planId });
    }
    seen.add(planId);
    // The row's own coordination block is accepted execution evidence
    // (prepared config, progress, completion) that a new lifecycle cannot
    // inherit; `execution_plans.coordination_json` owns it.
    if (row.execution_lease !== undefined || row.coordination !== undefined) {
      throw notNewLifecycle(
        `plan ${planId} of snapshot ${workflowId} already carries a coordination block or an execution lease. ` +
          `Creation writes unbound, unleased rows that own no accepted evidence; nothing was created.`,
      );
    }
    plans.push({ planId, row, pin: suppliedCatalogPin(row, workflowId, planId) });
  }
  return { workflowId, entry: workflow, snapshot: doc, plans };
}

/**
 * §3.1 request hash: operation kind, exact scope, expected token, caller
 * identity and payload, in the canonical value form. Reusing an operation id
 * with any other payload, scope, token or caller refuses
 * `execution.operation-conflict` instead of replaying a foreign receipt.
 */
function createWorkflowRequestHash(
  caller: ExecutionCaller,
  creation: ResolvedCreation,
  expected: ExecutionToken,
): string {
  return createHash("sha256")
    .update(
      serializeExecutionValue({
        operation: CREATE_WORKFLOW_OPERATION,
        workflow_id: creation.workflowId,
        expected,
        caller: {
          session_id: caller.sessionId,
          role: caller.role,
          workflow_id: caller.workflowId,
        },
        entry: creation.entry,
        snapshot: creation.snapshot,
      }),
      "utf8",
    )
    .digest("hex");
}

/** The committed receipt of one operation id on the current epoch, or `null`. */
function readCommittedOperation(
  db: StoreDb,
  epoch: number,
  operationId: string,
): { requestHash: string; storeId: string; workflowId: string; resultJson: string } | null {
  const row = db
    .prepare("select request_hash, store_id, workflow_id, result_json from execution_operations where epoch = ? and operation_id = ?")
    .get(epoch, operationId) as
    | { request_hash?: unknown; store_id?: unknown; workflow_id?: unknown; result_json?: unknown }
    | undefined;
  if (!row) return null;
  const what = `execution_operations(${epoch},${operationId})`;
  return {
    requestHash: storedText(row.request_hash, `${what}.request_hash`),
    storeId: storedText(row.store_id, `${what}.store_id`),
    workflowId: storedText(row.workflow_id, `${what}.workflow_id`),
    resultJson: storedText(row.result_json, `${what}.result_json`),
  };
}

/**
 * The recorded receipt of an idempotent retry. The caller's CAS is deliberately
 * NOT re-evaluated (the first attempt already advanced the revisions, so a
 * re-evaluated token would always look stale), but the receipt must still
 * belong to this store, epoch, workflow and addressed record — a contradictory
 * committed row is `store.corrupt` rather than a served success. `token`
 * names the address the receipt must carry: the root, or the session a bind
 * returned.
 */
function readCommittedReceipt<T>(
  recorded: { storeId: string; workflowId: string; resultJson: string },
  tx: ExecutionTransaction,
  operationId: string,
  workflowId: string,
  token: { kind: ExecutionKind; key: readonly string[] },
): ExecutionRead<T> {
  const what = `execution_operations(${tx.epoch},${operationId})`;
  if (recorded.storeId !== tx.storeId || recorded.workflowId !== workflowId) {
    throw corrupt(
      `${what} records store ${JSON.stringify(recorded.storeId)} and workflow ${JSON.stringify(recorded.workflowId)}, ` +
        `which is not the workflow ${workflowId} this request addresses`,
    );
  }
  const receipt = storedJsonObject(recorded.resultJson, `${what}.result_json`);
  const recordedToken = receipt.token;
  const parsed = parseExecutionToken(recordedToken);
  const sameKey =
    parsed.key.length === token.key.length && parsed.key.every((part, index) => part === token.key[index]);
  if (parsed.kind !== token.kind || parsed.storeId !== tx.storeId || parsed.epoch !== tx.epoch || !sameKey) {
    throw corrupt(
      `${what}.result_json carries a token that does not address ${token.kind} ${JSON.stringify(token.key)} of this ` +
        `store in this epoch`,
    );
  }
  if (!isNonEmptyString(receipt.storeId) || receipt.storeId !== tx.storeId || typeof receipt.epoch !== "number") {
    throw corrupt(`${what}.result_json does not record the store identity it was committed under`);
  }
  if (!isPlainObject(receipt.data)) throw corrupt(`${what}.result_json carries no execution state`);
  const recovery = receipt.operationRecovery;
  if (recovery !== undefined) {
    // Historical DB receipts stay READABLE: the envelope's own recovery fields
    // are validated (a corrupt row is still `store.corrupt`), but a retired
    // per-operation sidecar's `details` — the previous-seal provenance the
    // reseal producers no longer emit — is accepted as recorded diagnostic
    // payload rather than being re-asserted against a retired digest shape.
    if (
      !isPlainObject(recovery) ||
      !["applied", "already-satisfied", "partial", "unresolved"].includes(String(recovery.outcome)) ||
      !["none", "committed", "partial", "unknown"].includes(String(recovery.commitState)) ||
      !isPlainObject(recovery.target) ||
      !Array.isArray(recovery.applied) ||
      !Array.isArray(recovery.unresolved) ||
      !Array.isArray(recovery.resolvedFrom) ||
      !Array.isArray(recovery.warnings)
    ) {
      throw corrupt(`${what}.result_json carries an invalid recovery sidecar`);
    }
  }
  // Stored diagnostic payload; its envelope was checked above and a retired
  // `details` provenance is passed through unchanged for the reader.
  const storedRecovery = recovery as ExecutionReceiptRecovery | undefined;
  return {
    data: receipt.data as T,
    token: recordedToken as ExecutionToken,
    storeId: receipt.storeId,
    epoch: receipt.epoch,
    ...(storedRecovery === undefined ? {} : { operationRecovery: storedRecovery }),
  };
}

/** §3: create-only identity — an existing workflow row is never re-registered. */
function assertWorkflowIdentityIsNew(db: StoreDb, workflowId: string): void {
  const row = db.prepare("select revision from execution_workflows where workflow_id = ?").get(workflowId) as
    | { revision?: unknown }
    | undefined;
  if (!row) return;
  throw notNewLifecycle(
    `execution_workflows already holds workflow ${workflowId} (revision ${String(row.revision)}). A workflow identity is ` +
      `create-only: re-creating it never restores registry membership, resets revisions or rewrites its rows. ` +
      `Nothing was created.`,
  );
}

/**
 * §3/§7: creation binds EXISTING catalog entity identities and never fabricates
 * a selection. A row that records a catalog pin must have that pin's selected
 * plan entity present in this store's catalog (the store-independent check
 * `prepare` enforces). A current catalog revision that moved past the recorded
 * `entity_revision` is explicitly tolerated — the pin freezes an identity, not
 * a pointer — and the pin's recorded `document_hash` is provenance: the frozen
 * input is the sealed selection itself, so a recorded digest that has moved on
 * is history rather than a disagreement to refuse.
 */
function assertSelectedCatalogEntities(
  db: StoreDb,
  storeId: string,
  workflowId: string,
  plans: readonly ResolvedCreationPlan[],
): void {
  const entity = db.prepare("select revision from catalog_entities where kind = 'plan' and id = ?");
  for (const plan of plans) {
    const { pin } = plan;
    if (pin === null) continue;
    const details = { workflow_id: workflowId, plan_id: plan.planId, pin };
    if (pin.store_id !== storeId) {
      throw new ExecutionPinConflictError(
        `plan ${plan.planId} selects catalog store ${pin.store_id}, which is not this store (${storeId}) \u2014 a foreign ` +
          `selection is never sealed as this store's frozen input`,
        details,
      );
    }
    if (entity.get(plan.planId) === undefined) {
      throw new ExecutionPinConflictError(
        `plan ${plan.planId} is pinned to catalog plan entity ${plan.planId} at revision ${pin.entity_revision}, but the ` +
          `catalog does not hold that entity. Creation binds existing catalog identities and never fabricates one; ` +
          `register the plan or drop the pin`,
        details,
      );
    }
  }
}

/** §2.2: the registry row order is creation order, so rows are inserted in list order. */
function writeCreatedWorkflow(
  db: StoreDb,
  input: { workflowId: string; entry: WorkflowEntry; snapshot: WorkflowSnapshot; plans: readonly ResolvedCreationPlan[]; creatorSessionId: string | null; now: string },
): void {
  const { workflowId, entry, snapshot, plans, creatorSessionId, now } = input;
  // §2.2: the workflow header is the snapshot minus the plan collection it does
  // not own (`plans`); the binding/lease blocks were refused above, so the
  // stored header can never carry a second coordinator or merge authority.
  const header: Record<string, unknown> = { ...(snapshot as unknown as Record<string, unknown>) };
  delete header.plans;
  db.prepare(
    "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) " +
      "values (?, 1, ?, ?, ?, ?)",
  ).run(workflowId, creatorSessionId, JSON.stringify(header), now, now);
  db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)").run(workflowId, JSON.stringify(entry));

  const insertPlan = db.prepare(
    "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) " +
      "values (?, ?, 1, ?, ?, '{}')",
  );
  const insertInput = db.prepare(
    "insert into execution_inputs(workflow_id, plan_id, revision, input_json, input_hash, catalog_pin_json) " +
      "values (?, ?, 1, ?, ?, ?)",
  );
  plans.forEach((plan, ordinal) => {
    // §2.2: the stored plan state is the row minus the blocks that live in their
    // own columns, and `state_json.id` IS the row key — the DB authority
    // addresses a plan by its canonical id.
    const state: Record<string, unknown> = { ...plan.row, id: plan.planId };
    delete state.coordination;
    delete state.execution_lease;
    insertPlan.run(workflowId, plan.planId, ordinal, JSON.stringify(state));
    // §2.2: ONE sealed selection per plan — the exact `executionInputHash`
    // selection, hashed by the unchanged catalog algorithm, plus that row's
    // recorded pin. Later catalog edits never rewrite either column.
    insertInput.run(
      workflowId,
      plan.planId,
      JSON.stringify(executionInputSelection(plan.row, plan.planId)),
      executionInputHash(plan.row, plan.planId),
      plan.pin === null ? null : JSON.stringify(plan.pin),
    );
  });
}

/**
 * §2.2/§3 the WRITE half of create-only workflow creation, on a handle the
 * caller ALREADY owns: the identity/newness checks, registry membership, the
 * workflow header, its plan rows and their sealed frozen inputs, plus the
 * exactly-once revision pair an accepted creation performs.
 *
 * Extracted because TWO composed domains write a created lifecycle through it:
 * `createExecutionWorkflow`, where creation is the whole operation, and the
 * active catalog registration, where creation and the reviewed catalog delta
 * commit together. The read half, the CAS frame and the receipt stay with the
 * verb that owns the operation id, so neither caller re-derives what a created
 * workflow is and no second creator drifts from this one.
 */
export function writeExecutionCreation(
  tx: ExecutionTransaction,
  input: { caller: ExecutionCaller; creation: ResolvedCreation; now: string },
): void {
  assertWorkflowIdentityIsNew(tx.db, input.creation.workflowId);
  assertSelectedCatalogEntities(tx.db, tx.storeId, input.creation.workflowId, input.creation.plans);
  writeCreatedWorkflow(tx.db, {
    workflowId: input.creation.workflowId,
    entry: input.creation.entry,
    snapshot: input.creation.snapshot,
    plans: input.creation.plans,
    // Creator attribution: a caller with no session identity (the empty-string
    // spelling of an unset id) registers a NULL creator that the first
    // coordinator bind adopts; an explicit id is recorded as given.
    creatorSessionId: isNonEmptyString(input.caller.sessionId) ? input.caller.sessionId : null,
    now: input.now,
  });
  // Registry membership is a root change: the root revision and its timestamp
  // advance together here, and this writer advances the STORE revision exactly
  // once — the store-revision half of the multi-domain transaction. Catalog data
  // is deliberately not this writer's business: each published catalog mutation
  // advances `catalog_revision` through the catalog domain's own rule, so a
  // composed registration bumps it once per published row and never twice for
  // one row.
  tx.db.prepare("update execution_meta set revision = revision + 1, root_updated_at = ? where id = 1").run(input.now);
  tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
}

/**
 * §3.1 the root token as THIS transaction currently holds it: the CAS a caller
 * stores back after an accepted operation that changed registry membership.
 * `execution_meta` is read from the caller's own handle rather than reused from
 * the snapshot `withExecutionTransaction` took at BEGIN, because an accepted
 * creation has already superseded that revision — so the token is exactly the
 * one a fresh `readExecutionState` would mint.
 */
export function executionRootTokenOf(tx: ExecutionTransaction): ExecutionToken {
  return executionToken("root", tx.storeId, tx.epoch, [], readExecutionMetaRow(tx.db).revision);
}

/**
 * Adopt a terminal header that was imported without ACTIVE registry membership.
 * This is deliberately not a close: the terminal state is unchanged and no
 * registry membership is created.
 */
export async function adoptTerminalWorkflow(
  context: ExecutionContext,
  input: { workflowId: string; expectedRevision: number; reason: string; operationId: string },
): Promise<ExecutionReceipt<ExecutionState>> {
  const caller = context.caller;
  if (caller.role !== "coordinator" || caller.workflowId !== input.workflowId || !isNonEmptyString(caller.sessionId)) {
    throw new ExecutionError("execution.scope-mismatch", "terminal adoption requires an acquired coordinator identity addressing the selected workflow");
  }
  if (!isNonEmptyString(input.workflowId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      !isNonEmptyString(input.reason) || !isNonEmptyString(input.operationId)) {
    throw new ExecutionError("execution.adoption-invalid", "workflowId, positive expectedRevision, non-empty reason, and operationId are required");
  }
  const requestHash = semanticRequestHash({
    operation: "workflow.adopt-terminal",
    address: { workflowId: input.workflowId },
    caller,
    intent: { expectedRevision: input.expectedRevision, reason: input.reason },
  });
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError("execution.not-active", `the execution authority is ${tx.execution.authorityState}; terminal adoption requires an active authority`);
    }
    const replay = readOperationReplay<ExecutionState>(tx, {
      operationId: input.operationId,
      requestHash,
      workflowId: input.workflowId,
      planId: null,
      token: { kind: "root", key: [] },
    });
    if (replay !== null) return replay;
    const row = tx.db.prepare("select revision, state_json from execution_workflows where workflow_id = ?")
      .get(input.workflowId) as { revision?: unknown; state_json?: unknown } | undefined;
    if (row === undefined) {
      throw new ExecutionError("execution.adoption-refused", `workflow ${input.workflowId} has no terminal header to adopt; register the workflow through the supported workflow registration route`);
    }
    const revision = storedRevision(row.revision, `execution_workflows(${input.workflowId}).revision`);
    if (revision !== input.expectedRevision) {
      throw new ExecutionError("execution.header-revision-conflict", `workflow ${input.workflowId} header revision is ${revision}, not expected revision ${input.expectedRevision}; re-read status validate and retry with its listed revision`);
    }
    const registered = tx.db.prepare("select 1 as present from execution_registry where workflow_id = ?").get(input.workflowId);
    if (registered !== undefined) {
      throw new ExecutionError("execution.adoption-refused", `workflow ${input.workflowId} is already registered; finish its lifecycle through mstar status workflow-close`);
    }
    const state = storedJsonObject(row.state_json, `execution_workflows(${input.workflowId}).state_json`);
    if (state.status !== "completed" && state.status !== "stopped" && state.status !== "failed") {
      throw new ExecutionError("execution.adoption-refused", `workflow ${input.workflowId} is not terminal; no supported exit exists for a non-terminal header without registry membership`);
    }
    if ((state.status === "stopped" || state.status === "failed") && !isNonEmptyString(state.stop_reason)) {
      throw new ExecutionError("execution.adoption-refused", `workflow ${input.workflowId} has no recorded terminal reason in its header; no supported exit exists for a stopped/failed header missing the recorded reason`);
    }
    const activeSession = tx.db.prepare(
      "select session_id from execution_sessions where workflow_id = ? and epoch = ? and state = 'active' limit 1",
    ).get(input.workflowId, tx.epoch);
    if (activeSession !== undefined) {
      throw new ExecutionError("execution.adoption-refused", `workflow ${input.workflowId} has an ACTIVE coordinator session at the current epoch; no supported exit exists for a terminal header holding an ACTIVE session at the current epoch`);
    }
    if (state.lifecycle_adopted_at !== undefined || state.adopt_reason !== undefined) {
      throw new ExecutionError("execution.adoption-refused", `workflow ${input.workflowId} already has a terminal-adoption record; read status validate and use the recorded result`);
    }
    const now = new Date().toISOString();
    const nextState = {
      ...state,
      lifecycle_adopted_at: now,
      adopt_reason: input.reason,
      adoption_actor_session_id: caller.sessionId,
      adoption_operation_id: input.operationId,
    };
    tx.db.prepare("update execution_workflows set revision = revision + 1, state_json = ?, updated_at = ? where workflow_id = ? and revision = ?")
      .run(JSON.stringify(nextState), now, input.workflowId, input.expectedRevision);
    tx.db.prepare("update execution_meta set revision = revision + 1, root_updated_at = ? where id = 1").run(now);
    tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    const receipt: ExecutionRead<ExecutionState> = {
      data: readExecutionGraph(tx.db, { storeId: tx.storeId, epoch: tx.epoch }, readExecutionMetaRow(tx.db)),
      token: executionRootTokenOf(tx),
      storeId: tx.storeId,
      epoch: tx.epoch,
    };
    writeOperationReceipt(tx, { operationId: input.operationId, requestHash, workflowId: input.workflowId, planId: null, receipt, now });
    return { ...receipt, operationId: input.operationId, replayed: false };
  });
}

/**
 * §3 create-only workflow creation: registry membership, the workflow header,
 * its plan rows and their SEALED frozen inputs are written in ONE transaction
 * against an exact root CAS token, together with the operation receipt that
 * makes an identical retry idempotent.
 *
 * Parent/child revisions (§3.1): registry membership changes advance the root
 * revision exactly once (and `store_meta.revision` once for the multi-domain
 * transaction), while every record created here starts at revision 1 — the
 * workflow header, each plan row and each sealed input. A retry of a committed
 * operation advances NONE of them.
 *
 * Refusals leave every accepted record untouched: a wrong token kind/scope,
 * a foreign store, a stale epoch or a superseded root revision refuses before
 * any write, and every later refusal rolls the transaction back.
 */
export async function createExecutionWorkflow(
  context: ExecutionContext,
  input: { entry: WorkflowEntry; snapshot: WorkflowSnapshot; expected: ExecutionToken; operationId: string },
): Promise<ExecutionReceipt<ExecutionState>> {
  const creation = resolveCreateWorkflow(context.caller, input?.entry, input?.snapshot, input?.operationId);
  const operationId = input.operationId;
  const requestHash = createWorkflowRequestHash(context.caller, creation, input.expected);
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; domain creation requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    // Idempotent replay: only the CURRENT epoch's committed receipt replays, and
    // only for the identical request. A different payload on the same id is a
    // conflict, never a silent overwrite of the recorded receipt.
    const recorded = readCommittedOperation(tx.db, tx.epoch, operationId);
    if (recorded !== null) {
      if (recorded.requestHash !== requestHash) {
        throw new ExecutionError(
          "execution.operation-conflict",
          `operation id ${JSON.stringify(operationId)} is already committed on this store epoch for a different request ` +
            `(kind, scope, expected token, caller or payload). An operation id is an idempotency key, not a reusable ` +
            `slot \u2014 retry the committed request unchanged or use a new id. Nothing was created.`,
        );
      }
      return {
        ...readCommittedReceipt<ExecutionState>(recorded, tx, operationId, creation.workflowId, { kind: "root", key: [] }),
        operationId,
        replayed: true,
      };
    }
    // §3.1 CAS: the parent (root) token of THIS store, epoch, address and
    // revision. Creation uses the parent token, never a zero/sentinel revision.
    assertExecutionToken(input.expected, {
      kind: "root",
      storeId: tx.storeId,
      epoch: tx.epoch,
      key: [],
      revision: tx.execution.revision,
    });

    const now = new Date().toISOString();
    writeExecutionCreation(tx, { caller: context.caller, creation, now });

    const meta = readExecutionMetaRow(tx.db);
    const store: StoreIdentity = { storeId: tx.storeId, epoch: tx.epoch };
    const receipt: ExecutionRead<ExecutionState> = {
      data: readExecutionGraph(tx.db, store, meta),
      token: executionToken("root", store.storeId, store.epoch, [], meta.revision),
      storeId: store.storeId,
      epoch: store.epoch,
    };
    tx.db
      .prepare(
        "insert into execution_operations(epoch, operation_id, request_hash, store_id, workflow_id, plan_id, result_json, committed_at) " +
          "values (?, ?, ?, ?, ?, null, ?, ?)",
      )
      .run(tx.epoch, operationId, requestHash, tx.storeId, creation.workflowId, JSON.stringify(receipt), now);
    return { ...receipt, operationId, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Domain sessions: role-scoped binding and the session-scoped plan read
// (§2.2 session/lease tables, §2.3 session semantics, §3 bind/read verbs)
// ---------------------------------------------------------------------------

/** §3.1: the operation kind a session bind hashes its request under. */
const BIND_SESSION_OPERATION = "bindExecutionSession";

/** §2.2 `execution_sessions.state`: a closed set, never a free-form label. */
export type ExecutionSessionState = "active" | "suspended" | "revoked";

const EXECUTION_SESSION_STATES: readonly ExecutionSessionState[] = ["active", "suspended", "revoked"];

/** §2.2 one stored session row: its typed identity plus the ownership record beside it. */
export type SessionRow = { ref: ExecutionSessionRef; revision: number; state: ExecutionSessionState };

/** A coordinator session addresses one workflow; plans are explicit operation addresses. */
type SessionAddress = { workflowId: string; role: "coordinator"; sessionId: string };
type ResolvedBind = { role: "coordinator"; workflowId: string; sessionId: string; operationId: string };

function resolveBindRequest(caller: ExecutionCaller, input: unknown): ResolvedBind {
  if (!isPlainObject(input)) throw invalidInput("Invalid session bind: provide a request object. Inspect workflow authority with mstar status validate.");
  if (!isNonEmptyString(caller?.sessionId)) throw invalidInput("Invalid execution caller: provide a non-empty session identity. Inspect workflow authority with mstar status validate.");
  const { workflowId } = input;
  const operationId = assertOperationId(input.operationId);
  if (!isNonEmptyString(workflowId)) throw invalidInput("Invalid session bind: provide a non-empty workflowId. Inspect registered workflows with mstar status validate.");
  if (caller.role !== "coordinator" || caller.workflowId !== workflowId) {
    throw new ExecutionError("execution.scope-mismatch", "the session bind must address the trusted caller's coordinator workflow");
  }
  return { role: "coordinator", workflowId, sessionId: caller.sessionId, operationId };
}

function bindSessionRequestHash(caller: ExecutionCaller, bind: ResolvedBind, expected: ExecutionToken): string {
  return createHash("sha256").update(serializeExecutionValue({
    operation: BIND_SESSION_OPERATION,
    workflow_id: bind.workflowId,
    role: bind.role,
    expected,
    caller: { session_id: caller.sessionId, role: caller.role, workflow_id: caller.workflowId },
  }), "utf8").digest("hex");
}

function storedSessionState(value: unknown, what: string): ExecutionSessionState {
  if (!EXECUTION_SESSION_STATES.includes(value as ExecutionSessionState)) {
    throw corrupt(`${what} is ${JSON.stringify(value)}, which is not a session state`);
  }
  return value as ExecutionSessionState;
}

function readSessionRows(db: StoreDb, store: StoreIdentity, workflowId: string): SessionRow[] {
  const rows = db.prepare("select role, session_id, epoch, revision, state from execution_sessions where workflow_id = ? and role = 'coordinator'")
    .all(workflowId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const ref = sessionRef(store, workflowId, row);
    return {
      ref,
      revision: storedRevision(row.revision, `execution_sessions(${workflowId},${ref.sessionId}).revision`),
      state: storedSessionState(row.state, `execution_sessions(${workflowId},${ref.sessionId}).state`),
    };
  });
}


/** §2.2: one workflow header row's CAS revision, or `coordination.workflow-not-found`. */
function readWorkflowHeaderRow(db: StoreDb, workflowId: string): { revision: number; creatorSessionId: string | null } {
  const row = db
    .prepare("select revision, creator_session_id from execution_workflows where workflow_id = ?")
    .get(workflowId) as { revision?: unknown; creator_session_id?: unknown } | undefined;
  if (row === undefined) {
    throw new CoordinationError(
      "coordination.workflow-not-found",
      `workflow ${workflowId} is not in the execution authority. A session binds only to a registered lifecycle; ` +
        `nothing was bound.`,
      { workflow_id: workflowId },
    );
  }
  if (row.creator_session_id !== null && row.creator_session_id !== undefined && !isNonEmptyString(row.creator_session_id)) {
    throw corrupt(`execution_workflows(${workflowId}).creator_session_id is not a session identity`);
  }
  return {
    revision: storedRevision(row.revision, `execution_workflows(${workflowId}).revision`),
    creatorSessionId: isNonEmptyString(row.creator_session_id) ? row.creator_session_id : null,
  };
}

/**
 * §2.3 the grouped problem details of one session-authority refusal, in the
 * SAME snake_case details convention as `authorityEpochRefusal`: the
 * `RecoveryProblem` facts plus the engine-built `recovery` sidecar, so a
 * consumer reads what was withheld and which decision is open without parsing
 * prose. Shared by the unbound-binding and foreign-holder refusals so both
 * authority paths report the same contract.
 */
function sessionRefusalDetails(input: {
  problem: RecoveryProblem;
  target?: RecoveryDetails["target"];
  facts?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    component: input.problem.component,
    path: input.problem.path,
    ...input.facts,
    sources_tried: input.problem.sourcesTried,
    current_facts: input.problem.currentFacts,
    available_work: input.problem.availableWork,
    recovery: unresolvedRecovery({ target: input.target ?? {}, unresolved: [input.problem] }),
  };
}

/**
 * §2.3 the coordinator recovery entry the session-unavailable refusal offers,
 * truthful about what `recoverExecutionCoordinator` does with THIS row. While
 * the workflow holds a current-epoch ACTIVE holder, the transition replaces
 * only the holder it names, so naming this non-active row is refused (a
 * foreign-identity mismatch) — the reachable paths are the live holder's own
 * reference, or a recovery that names THAT holder with stop evidence for it.
 * With no live holder the recovery naming this row is the real way back, so the
 * entry spells out its complete inputs.
 */
function coordinatorRecoveryWork(input: {
  rows: SessionRow[];
  workflowId: string;
  epoch: number;
  sessionId: string;
  rowState: string;
  rowEpoch: number;
}): string[] {
  // Same holder test recoverExecutionCoordinator fences its duplicate-holder
  // refusal with: an ACTIVE row at the CURRENT epoch.
  const live = input.rows.find((row) => row.state === "active" && row.ref.epoch === input.epoch);
  if (live !== undefined) {
    return [
      `recovering over this row by naming it is refused while workflow ${JSON.stringify(input.workflowId)} holds the ` +
        `ACTIVE coordinator session ${JSON.stringify(live.ref.sessionId)} at epoch ${input.epoch}: ` +
        `recoverExecutionCoordinator replaces only the holder it names, and a normal bind never revives this ` +
        `${input.rowState} row (epoch ${input.rowEpoch}) \u2014 run the addressed effect through ` +
        `${JSON.stringify(live.ref.sessionId)}'s own live reference, or recover over that holder: the recovery names ` +
        `${JSON.stringify(live.ref.sessionId)} as the prior holder and carries a valid operator attestation with its ` +
        `stopped/reloaded entry \u2014 the attestation is the stop evidence, and no change to the holder's row is ` +
        `needed first`,
    ];
  }
  return [
    `recovery is the coordinator recovery transition recoverExecutionCoordinator: it takes the workflow token ` +
      `of the current epoch, an operation id and a non-empty reason, names ${JSON.stringify(input.sessionId)} ` +
      `as the prior holder it replaces and carries a valid operator attestation \u2014 exactly one installed ` +
      `current-coordinator consumer plus an entry naming that holder stopped/reloaded \u2014 and it reactivates ` +
      `this ${input.rowState} row (epoch ${input.rowEpoch}) at the current epoch; a normal bind never revives it`,
  ];
}

/**
 * §2.3/§2.2 the binding this store ACTUALLY holds for the addressed scope at
 * the CURRENT epoch, or the refusal. A reference is a typed lookup identity,
 * not a bearer credential: an unknown, suspended, revoked, foreign or
 * epoch-invalidated session authorizes nothing, and no session file is ever
 * consulted as a substitute.
 */
function liveSession(tx: ExecutionTransaction, address: SessionAddress): SessionRow {
  const store: StoreIdentity = { storeId: tx.storeId, epoch: tx.epoch };
  const rows = readSessionRows(tx.db, store, address.workflowId);
  const mine = rows.find((row) => row.ref.sessionId === address.sessionId);
  if (mine === undefined || mine.state !== "active" || mine.ref.epoch !== tx.epoch) {
    const problem: RecoveryProblem = {
      component: "session",
      path: "session",
      code: "execution.session-unavailable",
      sourcesTried: [`the coordinator session rows of workflow ${JSON.stringify(address.workflowId)}, read in this transaction`],
      currentFacts: [
        `the reference names coordinator session ${JSON.stringify(address.sessionId)} of workflow ${JSON.stringify(address.workflowId)}`,
        mine === undefined
          ? `the store holds no coordinator session row for ${JSON.stringify(address.sessionId)} at the current epoch ${tx.epoch}`
          : `session ${JSON.stringify(address.sessionId)}'s row is ${mine.state} in epoch ${mine.ref.epoch}, while the store's ` +
              `current authority epoch is ${tx.epoch}`,
      ],
      needed: `a session reference the store holds ACTIVE for the coordinator of workflow ${JSON.stringify(address.workflowId)} ` +
        `at the current epoch ${tx.epoch}`,
      withheldEffect:
        "only the addressed effect: authority was withheld, so nothing was written, no revision advanced and no receipt " +
        "was committed under this operation",
      availableWork: [
        `present the session reference of a binding the store holds ACTIVE for the coordinator of workflow ` +
          `${JSON.stringify(address.workflowId)} at epoch ${tx.epoch}`,
        ...(mine === undefined
          ? ["bind the coordinator session first \u2014 the bind verb takes the workflow, the full execution token and an operation id"]
          : coordinatorRecoveryWork({
              rows,
              workflowId: address.workflowId,
              epoch: tx.epoch,
              sessionId: address.sessionId,
              rowState: mine.state,
              rowEpoch: mine.ref.epoch,
            })),
        "retry the operation with the reference and token of the current epoch",
      ],
    };
    throw new ExecutionError(
      "execution.session-unavailable",
      `workflow ${address.workflowId} holds no ACTIVE coordinator session ${address.sessionId} in epoch ${tx.epoch}` +
        `${mine === undefined ? "" : ` (its row is ${mine.state} in epoch ${mine.ref.epoch})`}. An execution session ` +
        `reference authorizes only the binding the store records at the current epoch; a legacy session envelope is ` +
        `never consulted.`,
      sessionRefusalDetails({
        problem,
        target: { workflowId: address.workflowId },
        facts: {
          session_id: address.sessionId,
          workflow_id: address.workflowId,
          role: address.role,
          current_epoch: tx.epoch,
          ...(mine === undefined ? {} : { row_state: mine.state, row_epoch: mine.ref.epoch }),
        },
      }),
    );
  }
  return mine;
}


/** §2.1: a reference from another store or another epoch fences before anything is read. */
function assertReferenceAuthority(
  tx: ExecutionTransaction,
  referenceStoreId: string,
  referenceEpoch: number,
  target?: RecoveryDetails["target"],
): void {
  assertAuthorityGeneration(tx, { referenceStoreId, referenceEpoch, ...(target === undefined ? {} : { target }) });
}


function writeExecutionSession(
  db: StoreDb,
  input: { workflowId: string; address: SessionAddress; epoch: number; now: string },
): void {
  db.prepare(
    "insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) " +
      "values (?, 'coordinator', ?, ?, 1, 'active', ?)",
  ).run(input.workflowId, input.address.sessionId, input.epoch, input.now);
}


/**
 * §2.2 write one plan's state and coordination blocks in ONE statement: the row
 * revision is the column, `state_json` is the row minus the blocks that live in
 * their own columns, and `coordination_json` is the coordination block minus
 * `revision`/`session` — the DB authority stores neither, and the reader
 * refuses a row that carries them.
 */
export function writePlanCoordinationRow(
  tx: ExecutionTransaction,
  input: {
    workflowId: string;
    planId: string;
    state: Record<string, unknown>;
    coordination: Record<string, unknown>;
    revision: number;
  },
): void {
  tx.db
    .prepare(
      "update execution_plans set state_json = ?, coordination_json = ?, revision = ? where workflow_id = ? and plan_id = ?",
    )
    .run(JSON.stringify(input.state), JSON.stringify(input.coordination), input.revision, input.workflowId, input.planId);
}

/** §2.2 one plan's sealed frozen input, as the DB holds it. */
export type ExecutionSealedInput = {
  /** The input row's own revision (§3.1: it advances only when it changes). */
  revision: number;
  /** The frozen execution-input selection's hash — the sealed document half. */
  inputHash: string;
  /** The catalog identity the frozen input selects, or `null`. */
  pin: CatalogExecutionPin | null;
};

/** §2.2 the sealed frozen input of one plan, read inside the caller's transaction. */
export function readExecutionSealedInput(
  tx: ExecutionTransaction,
  workflowId: string,
  planId: string,
): ExecutionSealedInput {
  const row = tx.db
    .prepare("select revision, input_hash, catalog_pin_json from execution_inputs where workflow_id = ? and plan_id = ?")
    .get(workflowId, planId) as { revision?: unknown; input_hash?: unknown; catalog_pin_json?: unknown } | undefined;
  if (row === undefined) {
    throw corrupt(`plan ${planId} has no sealed execution input in workflow ${workflowId}`);
  }
  return {
    revision: storedRevision(row.revision, `execution_inputs(${workflowId},${planId}).revision`),
    inputHash: storedText(row.input_hash, `execution_inputs(${workflowId},${planId}).input_hash`),
    pin: readFrozenInput(row.catalog_pin_json, `execution_inputs(${workflowId},${planId}).catalog_pin_json`),
  };
}

/**
 * §2.2/§7 the ONE writer of a plan's frozen catalog selection after creation:
 * the eligible authorized `prepare` re-selects the pin (or clears it) and
 * records it in the same transaction that seals the Assignment. `input_json`
 * and `input_hash` are never rewritten — they are the sealed selection — and
 * the input row's own revision advances only when its record actually changes,
 * so an idempotent re-selection leaves the row untouched.
 */
export function writeExecutionInputPin(
  tx: ExecutionTransaction,
  input: { workflowId: string; planId: string; pin: CatalogExecutionPin | null },
): void {
  const sealed = readExecutionSealedInput(tx, input.workflowId, input.planId);
  const storedPinJson = sealed.pin === null ? null : serializeExecutionValue(sealed.pin);
  const nextPinJson = input.pin === null ? null : serializeExecutionValue(input.pin);
  if (storedPinJson === nextPinJson) return;
  tx.db
    .prepare("update execution_inputs set catalog_pin_json = ?, revision = ? where workflow_id = ? and plan_id = ?")
    .run(nextPinJson, sealed.revision + 1, input.workflowId, input.planId);
}

/**
 * §3.1 the revision advance of one accepted plan operation: the addressed
 * workflow's revision and timestamp advance once (a child of it changed) and
 * the multi-domain transaction bumps the store revision once. Registry
 * membership did not change, so the root revision is untouched.
 */
export function advancePlanOperationRevisions(
  tx: ExecutionTransaction,
  input: { workflowId: string; now: string },
): void {
  tx.db
    .prepare("update execution_workflows set revision = revision + 1, updated_at = ? where workflow_id = ?")
    .run(input.now, input.workflowId);
  tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
}

/**
 * §3.1 the revision advance of one accepted WORKFLOW-level operation: the
 * addressed workflow's revision and timestamp advance once (its header or a
 * child of it changed) and the multi-domain transaction bumps the store
 * revision once. Registry membership did not change, so the root revision is
 * untouched — the terminal transition records its membership loss separately
 * (`recordRootMembershipLoss`), so the store revision still advances exactly
 * once per accepted operation.
 */
export function advanceWorkflowHeaderRevision(tx: ExecutionTransaction, input: { workflowId: string; now: string }): void {
  tx.db
    .prepare("update execution_workflows set revision = revision + 1, updated_at = ? where workflow_id = ?")
    .run(input.now, input.workflowId);
  tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
}

/**
 * §2.2/§7 the terminal transition's membership half: the workflow leaves the
 * ACTIVE registry while its `execution_workflows` row, its plan rows and its
 * history stay exactly where they are (no catalog row is touched — current
 * catalog history is never deleted by lifecycle completion). Registry
 * membership is a root change, so the root revision and its timestamp advance
 * together; the store revision was already advanced once by the frame, so this
 * does not bump it a second time.
 */
export function recordRootMembershipLoss(tx: ExecutionTransaction, input: { workflowId: string; now: string }): void {
  tx.db.prepare("delete from execution_registry where workflow_id = ?").run(input.workflowId);
  tx.db.prepare("update execution_meta set revision = revision + 1, root_updated_at = ? where id = 1").run(input.now);
}

/** §2.2 one workflow header's own stored state, or `coordination.workflow-not-found`. */
export function requireWorkflowState(
  tx: ExecutionTransaction,
  workflowId: string,
): { revision: number; state: Record<string, unknown> } {
  const row = tx.db
    .prepare("select revision, state_json from execution_workflows where workflow_id = ?")
    .get(workflowId) as { revision?: unknown; state_json?: unknown } | undefined;
  if (row === undefined) {
    throw new CoordinationError(
      "coordination.workflow-not-found",
      "Workflow is not in the execution authority. Inspect registered workflows with mstar status validate.",
      { workflow_id: workflowId },
    );
  }
  return {
    revision: storedRevision(row.revision, `execution_workflows(${workflowId}).revision`),
    state: storedJsonObject(row.state_json, `execution_workflows(${workflowId}).state_json`),
  };
}

/**
 * §2.2 the one header writer of a workflow-level transition: the stored state
 * is replaced as a whole (the caller validated it) and the revision column is
 * the frame's separate advance, so no writer can smuggle a revision into the
 * document.
 */
export function writeWorkflowState(tx: ExecutionTransaction, input: { workflowId: string; state: Record<string, unknown> }): void {
  tx.db
    .prepare("update execution_workflows set state_json = ? where workflow_id = ?")
    .run(JSON.stringify(input.state), input.workflowId);
}

/* ------------------------------------------------------------------------ *
 * §3/§4.2 the lease and liveness primitives the plan transitions write through
 * ------------------------------------------------------------------------ */

/**
 * §3.1 the session identities this workflow CURRENTLY holds active at the
 * current epoch. This is the only evidence a stopped owner is decided by: a
 * session is live because its own row says so at this epoch — never because a
 * lease is old, a heartbeat is stale or a caller says the process is gone
 * (§4.2: heartbeats are observations, not expiry authorization).
 */
export function readLiveSessionIdentities(tx: ExecutionTransaction, workflowId: string): ReadonlySet<string> {
  const rows = tx.db
    .prepare("select session_id from execution_sessions where workflow_id = ? and state = 'active' and epoch = ?")
    .all(workflowId, tx.epoch) as Array<{ session_id?: unknown }>;
  return new Set(rows.map((row) => storedText(row.session_id, `execution_sessions(${workflowId}).session_id`)));
}


/**
 * §2.2 the stored coordinator session rows of one workflow, INCLUDING the
 * non-active ones — the recovery bootstrap has to see the suspended, revoked
 * and previous-epoch rows the ordinary bind treats as unusable. Availability
 * is still decided by `state` and the current epoch together, by the caller.
 */
export function readWorkflowSessionRows(tx: ExecutionTransaction, workflowId: string, role: "coordinator"): SessionRow[] {
  if (role !== "coordinator") {
    throw new CoordinationError("coordination.identity-mismatch", "Execution authority supports coordinator session rows only. Inspect registered workflow authority with mstar status validate.", {
      role,
    });
  }
  return readSessionRows(tx.db, { storeId: tx.storeId, epoch: tx.epoch }, workflowId);
}

/**
 * §2.3 the revocation half of the recovery transition: the prior coordinator
 * stops being an ACTIVE binding. The row is kept — it is the history a later
 * reference must not silently re-own — and an already revoked row gains no
 * revision, so a retried recovery never rewrites the end of an ownership.
 */
export function revokeSessionRow(
  tx: ExecutionTransaction,
  input: { workflowId: string; role: "coordinator"; sessionId: string },
): void {
  if (input.role !== "coordinator") {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      "Execution authority can revoke coordinator session rows only. Inspect registered workflow authority with mstar status validate.",
      { role: input.role },
    );
  }
  tx.db
    .prepare(
      "update execution_sessions set state = 'revoked', revision = revision + 1 " +
        "where workflow_id = ? and role = 'coordinator' and session_id = ? and state <> 'revoked'",
    )
    .run(input.workflowId, input.sessionId);
}

/** Recovery reactivates only the coordinator identity for the workflow. */
export function bindRecoveredSession(
  tx: ExecutionTransaction,
  input: { workflowId: string; role: "coordinator"; sessionId: string; epoch: number; now: string },
): number {
  const existing = tx.db.prepare(
    "select revision from execution_sessions where workflow_id=? and role='coordinator' and session_id=?",
  ).get(input.workflowId, input.sessionId) as { revision?: unknown } | undefined;
  if (existing === undefined) {
    writeExecutionSession(tx.db, {
      workflowId: input.workflowId,
      address: { workflowId: input.workflowId, role: "coordinator", sessionId: input.sessionId },
      epoch: input.epoch,
      now: input.now,
    });
    return 1;
  }
  const revision = storedRevision(existing.revision, `execution_sessions(${input.workflowId},${input.sessionId}).revision`) + 1;
  tx.db.prepare(
    "update execution_sessions set state='active', epoch=?, revision=?, bound_at=? where workflow_id=? and role='coordinator' and session_id=?",
  ).run(input.epoch, revision, input.now, input.workflowId, input.sessionId);
  return revision;
}

/**
 * §3/§E claim the workflow's integration merge lease for ONE attempt: the merge
 * is workflow-wide and exclusive, so this is the single row that says who is
 * merging what, and it names the plan and source branch it belongs to (a holder
 * match alone is never ownership). The row's own revision advances because its
 * record changed (§3.1); a re-claim by the same attempt is not this caller's
 * path — `integration-start` re-verifies a started attempt without writing.
 */
export function claimIntegrationMergeLease(
  tx: ExecutionTransaction,
  input: { workflowId: string; lease: IntegrationMergeLease },
): void {
  const existing = readIntegrationLeaseRow(tx.db, input.workflowId);
  tx.db
    .prepare(
      "insert or replace into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, ?, ?, ?)",
    )
    .run(
      input.workflowId,
      existing === null ? 1 : existing.revision + 1,
      tx.epoch,
      JSON.stringify({ ...input.lease, status: "held" }),
    );
}

/**
 * §3/§E release the workflow's integration merge lease, recording who held it,
 * who released it and why. The row is NOT deleted: it keeps its revision and
 * owner epoch as the §3.1 ABA guard, and reads as unclaimed (`null`) exactly as
 * the file route's deleted key does. Releasing an unclaimed or already released
 * lease is a no-op, so a replay never rewrites the provenance of a release.
 */
export function releaseIntegrationMergeLease(
  tx: ExecutionTransaction,
  input: { workflowId: string; claim: IntegrationMergeLease; releasedBy: string; reason: string; now: string },
): void {
  const existing = readIntegrationLeaseRow(tx.db, input.workflowId);
  if (existing === null || existing.status === "released") return;
  const tombstone = {
    ...input.claim,
    status: "released",
    prior_holder: input.claim.holder,
    released_by: input.releasedBy,
    released_at: input.now,
    release_reason: input.reason,
  };
  tx.db
    .prepare("update execution_integration_leases set revision = ?, lease_json = ? where workflow_id = ?")
    .run(existing.revision + 1, JSON.stringify(tombstone), input.workflowId);
}


/**
 * §3.1 the committed receipt of one operation id, or `null` for a first
 * attempt. A recorded id whose request hash differs is
 * `execution.operation-conflict` — an operation id is an idempotency key, not a
 * reusable slot — while the identical retry gets its recorded receipt back
 * without re-evaluating the CAS the first attempt already advanced.
 *
 * The caller revalidates current authority BEFORE calling this (it supplies the
 * transaction it already authorized the caller in), so a revoked or foreign
 * session never replays another actor's receipt.
 */
export function readPlanOperationReplay<T>(
  tx: ExecutionTransaction,
  input: { operationId: string; requestHash: string; workflowId: string; planId: string },
): ExecutionReceipt<T> | null {
  const replay = readOperationReplay<T>(tx, {
    ...input,
    token: { kind: "plan", key: [input.workflowId, input.planId] },
  });
  if (replay === null) return null;
  // The persisted read envelope uses operationRecovery; ordinary plan actions
  // expose recovery on both the first result and the recorded-receipt replay.
  const { operationRecovery, ...receipt } = replay;
  return { ...receipt, ...(operationRecovery === undefined ? {} : { recovery: operationRecovery }) };
}

/**
 * §3.1 the same replay on the READ route, before any write transaction is opened:
 * the committed receipt of one operation id, or `null` for a first attempt. A
 * `complete` (or any plan verb) whose external proof is expensive or destructive
 * to repeat consults this FIRST — a matching operation id whose receipt carries
 * the same request fingerprint is served without re-running Git or re-hashing
 * evidence.
 *
 * §2.3 the same READ transaction first revalidates the caller's CURRENT
 * authority: the caller must be the trusted coordinator the resolved address
 * named, the reference's store/epoch fence must hold, and the caller's own row
 * must be ACTIVE at this epoch — the same two facts `liveSession` decides through
 * the ordinary plan witness. A reference that is foreign, stale or belongs to a
 * suspended/revoked/epoch-invalidated binding authorizes nothing here, so a
 * revoked coordinator cannot regain a completed row through an old receipt. Only
 * then is the operation ledger consulted; a mismatched fingerprint still refuses
 * `execution.operation-conflict`.
 */
export async function readPlanOperationReplayBeforeProof<T>(
  context: ExecutionContext,
  read: ResolvedPlanRead,
  input: { operationId: string; requestHash: string },
): Promise<ExecutionReceipt<T> | null> {
  const caller = context.caller;
  if (caller.role !== "coordinator" || caller.sessionId !== read.sessionId || caller.workflowId !== read.workflowId) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      "Trusted caller does not match the coordinator session resolved for this plan address. Inspect workflow authority with mstar status validate.",
      { session_id: read.sessionId, workflow_id: read.workflowId },
    );
  }
  return withExecutionReadTransaction(context, (tx) => {
    assertReferenceAuthority(tx, read.referenceStoreId, read.referenceEpoch);
    liveSession(tx, { workflowId: read.workflowId, role: "coordinator", sessionId: read.sessionId });
    return readPlanOperationReplay<T>(tx, {
      ...input,
      workflowId: read.workflowId,
      planId: read.planId,
    });
  });
}

/**
 * §3.1 the same replay for ANY addressed record: the committed receipt of one
 * operation id, or `null` for a first attempt. `token` names the address the
 * receipt must carry — a plan, a session, the workflow header — so a receipt
 * recorded for another address of this store is `store.corrupt` rather than a
 * served success. One implementation, because the idempotency rule is one rule.
 */
export function readOperationReplay<T>(
  tx: ExecutionTransaction,
  input: {
    operationId: string;
    requestHash: string;
    workflowId: string;
    planId: string | null;
    token: { kind: ExecutionKind; key: readonly string[] };
  },
): ExecutionReceipt<T> | null {
  const recorded = readCommittedOperation(tx.db, tx.epoch, input.operationId);
  if (recorded === null) return null;
  if (recorded.requestHash !== input.requestHash) {
    // §4.1 (A13) the operation id is already committed for a DIFFERENT semantic
    // intent: the receipt is not restored and the requested effect is withheld,
    // and the typed cause names both so the caller sees the mismatch instead of
    // a bare conflict.
    const problem: RecoveryProblem = {
      component: "operation",
      path: "operationId",
      code: "execution.operation-conflict",
      sourcesTried: [
        `execution_operations(epoch ${tx.epoch}, ${JSON.stringify(input.operationId)})`,
        "the requested operation's semantic selection",
      ],
      currentFacts: [
        `operation id ${JSON.stringify(input.operationId)} is committed for workflow ${recorded.workflowId} ` +
          `with request fingerprint ${recorded.requestHash}`,
        `the requested operation's fingerprint is ${input.requestHash}`,
      ],
      needed:
        "retry the committed request unchanged (an operation id is an idempotency key, not a reusable slot), or use a " +
        "new operation id for the new effect",
      withheldEffect:
        "the requested effect, exactly as sent: no state was restored from the committed receipt either",
      availableWork: [
        `read the current state of workflow ${recorded.workflowId}`,
        "retry the committed request unchanged under its own operation id",
        "express the new effect under a new operation id",
      ],
    };
    throw new ExecutionError(
      "execution.operation-conflict",
      `operation id ${JSON.stringify(input.operationId)} is already committed on this store epoch for a different semantic ` +
        `request (its addressed record, caller or business payload). An operation id is an idempotency key, not a reusable ` +
        `slot \u2014 retry the committed request unchanged or use a new id. Nothing was written.`,
      {
        component: problem.component,
        path: problem.path,
        operation_id: input.operationId,
        recorded_fingerprint: recorded.requestHash,
        requested_fingerprint: input.requestHash,
        sources_tried: problem.sourcesTried,
        current_facts: problem.currentFacts,
        available_work: problem.availableWork,
        recovery: unresolvedRecovery({
          target: { workflowId: input.workflowId, ...(input.planId === null ? {} : { planId: input.planId }) },
          unresolved: [problem],
        }),
      },
    );
  }
  const receipt = readCommittedReceipt<T>(recorded, tx, input.operationId, input.workflowId, input.token);
  return { ...receipt, operationId: input.operationId, replayed: true };
}

/** §3.1 record one committed operation receipt inside the transaction that produced it. */
export function writePlanOperationReceipt(
  tx: ExecutionTransaction,
  input: {
    operationId: string;
    requestHash: string;
    workflowId: string;
    planId: string;
    receipt: ExecutionRead<unknown>;
    now: string;
  },
): void {
  writeOperationReceipt(tx, input);
}

/**
 * §3.1 the one receipt writer: the committed receipt of an accepted operation
 * (`planId: null` for a workflow-level operation), recorded inside the same
 * transaction that produced the effect, so a rolled-back operation leaves no
 * success behind.
 */
export function writeOperationReceipt(
  tx: ExecutionTransaction,
  input: {
    operationId: string;
    requestHash: string;
    workflowId: string;
    planId: string | null;
    receipt: ExecutionRead<unknown>;
    now: string;
  },
): void {
  tx.db
    .prepare(
      "insert into execution_operations(epoch, operation_id, request_hash, store_id, workflow_id, plan_id, result_json, committed_at) " +
        "values (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      tx.epoch,
      input.operationId,
      input.requestHash,
      tx.storeId,
      input.workflowId,
      input.planId,
      JSON.stringify(input.receipt),
      input.now,
    );
}

/** §2.3 the authorization one session-authorized plan address resolves to. */
export type ResolvedPlanRead = {
  workflowId: string;
  role: "coordinator";
  sessionId: string;
  planId: string;
  referenceStoreId: string;
  referenceEpoch: number;
};

/** Resolve an explicit plan address against the caller's coordinator identity. */
export function resolvePlanRead(caller: ExecutionCaller, session: unknown, planId: unknown): ResolvedPlanRead {
  if (!isPlainObject(session)) throw invalidInput("Invalid plan read: provide an execution session reference. Inspect workflow authority with mstar status validate.");
  const { storeId, epoch, workflowId, role, sessionId } = session;
  if (
    !isNonEmptyString(storeId) || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0 ||
    !isNonEmptyString(workflowId) || !isNonEmptyString(sessionId) || role !== "coordinator"
  ) {
    throw invalidInput("Invalid coordinator session reference: provide storeId, positive epoch, workflowId, role, and sessionId. Inspect workflow authority with mstar status validate.");
  }
  if (!isNonEmptyString(planId)) throw invalidInput("Invalid plan read: provide the explicit plan id. Inspect workflow rows with mstar status validate.");
  if (caller.role !== "coordinator" || caller.sessionId !== sessionId || caller.workflowId !== workflowId) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      "Trusted caller does not match the coordinator session reference. Inspect workflow authority with mstar status validate.",
    );
  }
  return { workflowId, role, sessionId, planId, referenceStoreId: storeId, referenceEpoch: epoch };
}

/**
 * §2.3 the bind of the workflow's ONE coordinator, into a running lifecycle.
 *
 * A normal bind is a BOOTSTRAP, never a recovery: it refuses (a) while a
 * current-epoch ACTIVE coordinator holds the workflow — that holder's own live
 * reference is the way in — (b) when this identity already has a row that is
 * not ACTIVE at the current epoch (suspended, revoked or epoch-invalidated),
 * and (c) when the workflow was created by a DIFFERENT identity. The suspended,
 * revoked and epoch-invalidated rows are revived ONLY through the named
 * coordinator recovery (`recoverExecutionCoordinator`), which requires the prior
 * holder and its stop/reload attestation; first-bind adoption is unavailable
 * once any coordinator record exists. Every refusal names the recorded facts and
 * the supported route, so the caller can act instead of guessing.
 */
export async function bindExecutionSession(
  context: ExecutionContext,
  input: { workflowId: string; expected: ExecutionToken; operationId: string },
): Promise<ExecutionReceipt<ExecutionSessionRef>> {
  const bind = resolveBindRequest(context.caller, input);
  const requestHash = bindSessionRequestHash(context.caller, bind, input.expected);
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; binding a session requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    const recorded = readCommittedOperation(tx.db, tx.epoch, bind.operationId);
    if (recorded !== null) {
      if (recorded.requestHash !== requestHash) {
        throw new ExecutionError(
          "execution.operation-conflict",
          `operation id ${JSON.stringify(bind.operationId)} is already committed on this store epoch for a different request. ` +
            `An operation id is an idempotency key, not a reusable slot \u2014 retry the committed request unchanged, or express the ` +
            `new effect under a new operation id. Nothing was bound.`,
          { operation_id: bind.operationId, recorded_fingerprint: recorded.requestHash, requested_fingerprint: requestHash },
        );
      }
      const receipt = readCommittedReceipt<ExecutionSessionRef>(recorded, tx, bind.operationId, bind.workflowId, {
        kind: "session", key: [bind.workflowId, "coordinator", bind.sessionId],
      });
      assertReferenceAuthority(tx, receipt.data.storeId, receipt.data.epoch);
      liveSession(tx, { workflowId: bind.workflowId, role: "coordinator", sessionId: bind.sessionId });
      return { ...receipt, operationId: bind.operationId, replayed: true };
    }
    const header = readWorkflowHeaderRow(tx.db, bind.workflowId);
    assertExecutionToken(input.expected, {
      kind: "workflow", storeId: tx.storeId, epoch: tx.epoch, key: [bind.workflowId], revision: header.revision,
    });
    const view = readWorkflowView(tx.db, { storeId: tx.storeId, epoch: tx.epoch }, bind.workflowId);
    if (view.state.status !== "running") {
      throw new CoordinationError(
        "coordination.invalid-transition",
        "Coordinator session binding requires a running workflow lifecycle. Inspect current workflow state with mstar status validate.",
        { workflow_id: bind.workflowId, status: view.state.status },
      );
    }
    const rows = readSessionRows(tx.db, { storeId: tx.storeId, epoch: tx.epoch }, bind.workflowId);
    // (a) a live holder is never replaced by a bind.
    const live = rows.find((row) => row.state === "active" && row.ref.epoch === tx.epoch);
    if (live !== undefined) {
      throw sessionBindRefusal({
        code: "coordination.identity-mismatch",
        detail:
          `workflow ${bind.workflowId} already holds the ACTIVE coordinator session ${JSON.stringify(live.ref.sessionId)} at ` +
          `epoch ${tx.epoch}. Ownership is not replaceable by a bind: resume that holder's own binding, or run ` +
          `recoverExecutionCoordinator naming ${JSON.stringify(live.ref.sessionId)} with its stop/reload attestation. Nothing was bound.`,
        workflowId: bind.workflowId,
        sessionId: bind.sessionId,
        holder: live.ref.sessionId,
        holderEpoch: live.ref.epoch,
        facts: { holder: live.ref.sessionId, holder_epoch: live.ref.epoch, current_epoch: tx.epoch },
      });
    }
    // (b) a non-active own row is history: only the named recovery revives it.
    const mine = rows.find((row) => row.ref.sessionId === bind.sessionId);
    if (mine !== undefined && (mine.state !== "active" || mine.ref.epoch !== tx.epoch)) {
      throw sessionBindRefusal({
        code: "execution.session-unavailable",
        detail:
          `workflow ${bind.workflowId} records session ${JSON.stringify(bind.sessionId)} in state ${mine.state} at epoch ` +
          `${mine.ref.epoch}; the current epoch is ${tx.epoch}. A suspended, revoked or epoch-invalidated binding is never revived ` +
          `by a normal bind \u2014 run recoverExecutionCoordinator, which takes the workflow token, an operation id, a reason and the ` +
          `prior holder ${JSON.stringify(bind.sessionId)} with its stop/reload attestation. Nothing was bound.`,
        workflowId: bind.workflowId,
        sessionId: bind.sessionId,
        holder: bind.sessionId,
        holderEpoch: mine.ref.epoch,
        facts: { row_state: mine.state, row_epoch: mine.ref.epoch, current_epoch: tx.epoch },
      });
    }
    // (c) the creating identity owns the first bind; a foreign identity never
    // adopts a lifecycle, and adoption is unavailable once any record exists.
    if (header.creatorSessionId !== null && header.creatorSessionId !== bind.sessionId) {
      // §2.3 the recovery holder is a session THIS STORE records, never the
      // creator header: a creator that never bound has no row to recover, so the
      // truthful facts are the rows (possibly none) and, when history exists, the
      // recorded identity with its own epoch.
      const recorded = rows[0];
      throw sessionBindRefusal({
        code: "coordination.identity-mismatch",
        detail:
          `workflow ${bind.workflowId} was created by session ${JSON.stringify(header.creatorSessionId)}; the trusted caller is ` +
          `${JSON.stringify(bind.sessionId)}. A coordinator session binds only through the creating identity` +
          (recorded === undefined
            ? `, and this workflow records NO coordinator session row to recover \u2014 its supported route is recoverExecutionCoordinator ` +
              `with priorSessionId: null, a reason and a valid activation attestation`
            : `, or through recoverExecutionCoordinator naming the recorded coordinator ${JSON.stringify(recorded.ref.sessionId)} ` +
              `(epoch ${recorded.ref.epoch}) with stop attestation`) +
          `. Nothing was bound.`,
        workflowId: bind.workflowId,
        sessionId: bind.sessionId,
        holder: recorded === undefined ? null : recorded.ref.sessionId,
        holderEpoch: recorded === undefined ? tx.epoch : recorded.ref.epoch,
        facts: {
          creator_session_id: header.creatorSessionId,
          caller_session_id: bind.sessionId,
          recorded_coordinator_rows: rows.length,
        },
      });
    }
    if (header.creatorSessionId === null) {
      // First-bind adoption is a NEWLY created lifecycle's path: a historical
      // coordinator record means the lifecycle already had a creator, so a
      // creator-less header with records is a recovery case, not an adoption.
      if (rows.length > 0) {
        const recorded = rows[0]!;
        throw sessionBindRefusal({
          code: "coordination.identity-mismatch",
          detail:
            `workflow ${bind.workflowId} records ${String(rows.length)} coordinator session row(s) while its creator identity is ` +
            `unset, so first-bind adoption is unavailable \u2014 use recoverExecutionCoordinator naming the recorded coordinator ` +
            `${JSON.stringify(recorded.ref.sessionId)} (epoch ${recorded.ref.epoch}) with its stop/reload attestation, the current ` +
            `workflow token, an operation id, a reason and a valid activation attestation. Nothing was bound.`,
          workflowId: bind.workflowId,
          sessionId: bind.sessionId,
          holder: recorded.ref.sessionId,
          holderEpoch: recorded.ref.epoch,
          facts: { coordinator_rows: rows.length },
        });
      }
      tx.db.prepare("update execution_workflows set creator_session_id = ? where workflow_id = ?").run(bind.sessionId, bind.workflowId);
    }
    const now = new Date().toISOString();
    const address: SessionAddress = { workflowId: bind.workflowId, role: "coordinator", sessionId: bind.sessionId };
    writeExecutionSession(tx.db, { workflowId: bind.workflowId, address, epoch: tx.epoch, now });
    advanceWorkflowHeaderRevision(tx, { workflowId: bind.workflowId, now });
    const data: ExecutionSessionRef = {
      storeId: tx.storeId, epoch: tx.epoch, workflowId: bind.workflowId, role: "coordinator", sessionId: bind.sessionId,
    };
    const receipt: ExecutionRead<ExecutionSessionRef> = {
      data,
      token: executionToken("session", tx.storeId, tx.epoch, [bind.workflowId, "coordinator", bind.sessionId], 1),
      storeId: tx.storeId,
      epoch: tx.epoch,
    };
    writeOperationReceipt(tx, { operationId: bind.operationId, requestHash, workflowId: bind.workflowId, planId: null, receipt, now });
    return { ...receipt, operationId: bind.operationId, replayed: false };
  });
}

/** One bind refusal with the recorded facts and the supported recovery route, in the shared recovery-details convention. */
function sessionBindRefusal(input: {
  code: CoordinationErrorCode | "execution.session-unavailable";
  detail: string;
  workflowId: string;
  sessionId: string;
  holder: string | null;
  holderEpoch: number;
  facts: Record<string, unknown>;
}): ExecutionError {
  const problem: RecoveryProblem = {
    component: "session",
    path: "session",
    code: input.code,
    sourcesTried: [`the coordinator session rows of workflow ${JSON.stringify(input.workflowId)}, read in this transaction`],
    currentFacts: [input.detail],
    needed:
      input.holder === null
        ? `the supported route for a workflow with no recorded coordinator row: recoverExecutionCoordinator with priorSessionId: null, ` +
          `a non-empty reason and a valid activation attestation, or \u2014 while the workflow is still unbound \u2014 a bind by the creating identity`
        : `the supported coordinator recovery: run recoverExecutionCoordinator naming the RECORDED coordinator ` +
          `${JSON.stringify(input.holder)} (epoch ${input.holderEpoch}) with its stop/reload attestation, or resume that holder's own ` +
          `live reference while it is current`,
    withheldEffect:
      "the session binding and its revision: authority was withheld, so no row, revision or receipt changed under this operation",
    availableWork:
      input.holder === null
        ? [
            `run recoverExecutionCoordinator with priorSessionId: null once the workflow needs a new coordinator`,
            "independent operations on other workflows continue",
          ]
        : [
            `resume the recorded coordinator's own binding through resumeExecutionSession while its row is current`,
            `run recoverExecutionCoordinator for that recorded holder once its stop/reload is attested`,
            "independent operations on other workflows continue",
          ],
  };
  return new ExecutionError("execution.session-unavailable", input.detail, {
    component: problem.component,
    path: problem.path,
    workflow_id: input.workflowId,
    session_id: input.sessionId,
    ...(input.holder === null ? {} : { holder: input.holder }),
    ...input.facts,
    sources_tried: problem.sourcesTried,
    current_facts: problem.currentFacts,
    needed: problem.needed,
    available_work: problem.availableWork,
    recovery: unresolvedRecovery({ target: { workflowId: input.workflowId }, unresolved: [problem] }),
  });
}

/**
 * §2.3/§3 the sealed authorization context of one accepted plan operation: the
 * addressed plan's authoritative view, the tokens a mutation presents back as
 * CAS, and the session the store holds for the call's seat.
 *
 * Every field is read inside the caller's transaction from the binding the store
 * ACTUALLY holds at the current epoch, so no part of a witness can be a stale
 * snapshot. It carries no file path and no bearer value: a session envelope is
 * not part of DB authority, and this is the whole context a DB operation is
 * authorized by (§2.3).
 */
export type ExecutionPlanWitness = {
  workflowId: string;
  planId: string;
  /** The addressed plan's §3 view. */
  view: ExecutionPlanView;
  /**
   * The OTHER plans of the same workflow, as read in this transaction. A
   * workflow-scoped rule that has to know its siblings — a plan reports only
   * its own L2 track branches — reads them here instead of issuing a second
   * query, so the read stays bounded by the addressed workflow.
   */
  siblings: readonly ExecutionPlanView[];
  /** The plan's CAS token; a mutation's `expected` must be exactly this. */
  token: ExecutionToken;
  /** The plan row's revision — the value `token` carries (§3.1). */
  revision: number;
  /** The workflow's CAS token, advanced when its header or a child changes. */
  workflowToken: ExecutionToken;
  /** The session row the store holds for this call's addressed scope. */
  session: ExecutionSessionRef;
};

/**
 * §2.3 the sealed witness of one plan operation, read inside the caller's
 * transaction: the address `resolvePlanRead` already authorized is revalidated
 * against the session rows of the current epoch, and the addressed plan is
 * selected under that authority. A reference that is not the caller's own, that
 * belongs to another store or epoch, or that names another plan authorizes
 * nothing here — and it is never resolved from a session file.
 *
 * The address arrives already authorized because WHERE that gate runs belongs
 * to the caller, not to this reader: `readExecutionPlan` resolves it before it
 * opens the store, and the DB dispatch resolves it inside the transaction it
 * already owns.
 */
export function readExecutionPlanWitness(tx: ExecutionTransaction, read: ResolvedPlanRead): ExecutionPlanWitness {
  assertReferenceAuthority(tx, read.referenceStoreId, read.referenceEpoch);
  const live = liveSession(tx, {
    workflowId: read.workflowId,
    role: "coordinator",
    sessionId: read.sessionId,
  });
  const workflow = readWorkflowView(tx.db, { storeId: tx.storeId, epoch: tx.epoch }, read.workflowId);
  const view = workflow.plans.find((candidate) => candidate.plan.id === read.planId);
  const token = workflow.planTokens[read.planId];
  if (view === undefined || token === undefined) {
    throw new CoordinationError(
      "coordination.plan-not-found",
      "The addressed workflow holds no matching plan. Inspect plan rows with mstar status validate.",
      { workflow_id: read.workflowId, plan_id: read.planId },
    );
  }
  return {
    workflowId: read.workflowId,
    planId: read.planId,
    view,
    siblings: workflow.plans.filter((candidate) => candidate.plan.id !== read.planId),
    token,
    revision: parseExecutionToken(token).revision,
    workflowToken: workflow.workflowToken,
    session: live.ref,
  };
}

/**
 * §2.3 the authorization one workflow-level write addresses: the trusted
 * caller's own coordinator scope, plus the reference it claims to hold.
 */
export type ResolvedWorkflowWrite = {
  workflowId: string;
  sessionId: string;
  referenceStoreId: string;
  referenceEpoch: number;
};

/**
 * §2.3/§3 the seat and reference gate of one WORKFLOW-level operation — the
 * sibling of `resolvePlanRead`. The seat is checked first: a workflow-level
 * transition belongs to the workflow's coordinator. The reference is then the
 * caller's OWN coordinator address: possession of a reference or another
 * workflow's address authorizes nothing.
 *
 * Pure argument checks — no store is opened — so each transport decides where
 * this gate sits relative to its own store access.
 */
export function resolveWorkflowWrite(caller: ExecutionCaller, session: unknown, workflowId: unknown): ResolvedWorkflowWrite {
  if (caller?.role !== "coordinator") throw new ExecutionError("execution.scope-mismatch", "workflow writes require the coordinator identity");
  if (!isNonEmptyString(caller.sessionId)) throw invalidInput("Invalid execution caller: provide a non-empty session identity. Inspect workflow authority with mstar status validate.");
  if (!isNonEmptyString(workflowId)) throw invalidInput("Invalid workflow operation: provide the non-empty workflow id it addresses. Inspect registered workflows with mstar status validate.");
  if (!isPlainObject(session)) throw invalidInput("Invalid workflow operation: provide an execution session reference. Inspect workflow authority with mstar status validate.");
  const { storeId, epoch, workflowId: boundWorkflowId, role, sessionId } = session;
  if (!isNonEmptyString(storeId) || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0 ||
    !isNonEmptyString(boundWorkflowId) || !isNonEmptyString(sessionId) || role !== "coordinator") {
    throw invalidInput("Invalid workflow operation: provide a valid coordinator session reference. Inspect workflow authority with mstar status validate.");
  }
  if (caller.sessionId !== sessionId || caller.workflowId !== boundWorkflowId) {
    throw new ExecutionError("execution.scope-mismatch", "the trusted caller does not match the supplied coordinator reference");
  }
  if (caller.workflowId !== workflowId) throw new ExecutionError("execution.scope-mismatch", "the caller does not own the addressed workflow");
  return { workflowId, sessionId, referenceStoreId: storeId, referenceEpoch: epoch };
}

/**
 * §2.3 the live coordinator binding of one workflow-level address: the
 * reference's store/epoch fence first, then the ACTIVE coordinator row the store
 * actually holds — a suspended, revoked, epoch-invalidated or foreign session
 * authorizes nothing, and no session file is ever consulted.
 */
export function resolveWorkflowSession(tx: ExecutionTransaction, read: ResolvedWorkflowWrite): ExecutionSessionRef {
  assertReferenceAuthority(tx, read.referenceStoreId, read.referenceEpoch);
  return liveSession(tx, { workflowId: read.workflowId, role: "coordinator", sessionId: read.sessionId }).ref;
}

/**
 * §2.3/§3 the sealed authorization context of one accepted WORKFLOW-level
 * operation: the workflow's authoritative view, its CAS token and the
 * coordinator session the store holds for the call. Every field is read inside
 * the caller's transaction, so no part of it is a stale snapshot.
 */
export type ExecutionWorkflowWitness = {
  workflowId: string;
  view: ExecutionState["workflows"][number];
  /** The workflow's CAS token; a mutation's `expected` must be exactly this. */
  token: ExecutionToken;
  /** The header row's revision — the value `token` carries (§3.1). */
  revision: number;
  /** The ACTIVE coordinator session row this call was authorized through. */
  session: ExecutionSessionRef;
};

/**
 * §2.3/§3.1 the witness of one workflow-level operation: the caller's own live
 * coordinator binding, the workflow's ACTIVE registry membership and its
 * authoritative view. Membership is required because membership alone selects
 * an active lifecycle: a terminal workflow stays as history in
 * `execution_workflows` and is never amended through this route.
 */
export function readExecutionWorkflowWitness(
  tx: ExecutionTransaction,
  read: ResolvedWorkflowWrite,
): ExecutionWorkflowWitness {
  const session = resolveWorkflowSession(tx, read);
  const registered = tx.db.prepare("select 1 as present from execution_registry where workflow_id = ?").get(read.workflowId);
  if (registered === undefined) {
    throw new CoordinationError(
      "coordination.workflow-not-found",
      `workflow ${read.workflowId} is not registered as an ACTIVE lifecycle \u2014 a terminal or unregistered workflow stays ` +
        `as history and is never amended`,
      { workflow_id: read.workflowId },
    );
  }
  const view = readWorkflowView(tx.db, { storeId: tx.storeId, epoch: tx.epoch }, read.workflowId);
  return {
    workflowId: read.workflowId,
    view,
    token: view.workflowToken,
    revision: parseExecutionToken(view.workflowToken).revision,
    session,
  };
}

/**
 * §3 the session-authorized plan read: one consistent read of the plan's
 * authoritative view, served only when the supplied reference is the binding
 * the trusted caller actually holds at the current epoch. The returned plan token is
 * the CAS a later coordination mutation passes back.
 *
 * The reference gate runs BEFORE the store is opened: a malformed or
 * caller-mismatched request is refused by itself, never by — or after — an
 * authority-state or store-open failure.
 */
export function readExecutionPlan(context: ExecutionContext, planId: string): Promise<ExecutionRead<ExecutionPlanView>>;
export function readExecutionPlan(context: ExecutionContext, session: ExecutionSessionRef, planId: string): Promise<ExecutionRead<ExecutionPlanView>>;
export async function readExecutionPlan(
  context: ExecutionContext,
  sessionOrPlanId: ExecutionSessionRef | string,
  addressedPlanId?: string,
): Promise<ExecutionRead<ExecutionPlanView>> {
  const planId = typeof sessionOrPlanId === "string" ? sessionOrPlanId : addressedPlanId;
  if (!isNonEmptyString(planId)) throw invalidInput("Invalid plan read: provide the plan id it selects. Inspect plan rows with mstar status validate.");
  const session = typeof sessionOrPlanId === "string"
    ? (await readOwnExecutionSession(context)).data
    : sessionOrPlanId;
  const read = resolvePlanRead(context.caller, session, planId);
  return withExecutionReadTransaction(context, (tx) => {
    const witness = readExecutionPlanWitness(tx, read);
    return { data: witness.view, token: witness.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/**
 * Read one active session row without changing its revision.
 */
export async function readExecutionSession(
  context: ExecutionContext,
  session: ExecutionSessionRef,
): Promise<ExecutionRead<ExecutionSessionRef>> {
  if (!isPlainObject(session) || !isNonEmptyString(session.storeId) || !Number.isSafeInteger(session.epoch) || session.epoch <= 0) {
    throw invalidInput("Invalid execution session reference: provide a store id and positive safe-integer epoch. Inspect workflow authority with mstar status validate.");
  }
  if (
    session.workflowId !== context.caller.workflowId ||
    session.role !== context.caller.role ||
    session.sessionId !== context.caller.sessionId
  ) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      "Trusted caller does not independently match the supplied execution session reference. Inspect workflow authority with mstar status validate.",
    );
  }
  return withExecutionReadTransaction(context, (tx) => {
    assertReferenceAuthority(tx, session.storeId, session.epoch);
    const live = liveSession(tx, {
      workflowId: session.workflowId,
      role: "coordinator",
      sessionId: session.sessionId,
    });
    return {
      data: live.ref,
      token: executionToken("session", tx.storeId, tx.epoch, [live.ref.workflowId, live.ref.role, live.ref.sessionId], live.revision),
      storeId: tx.storeId,
      epoch: tx.epoch,
    };
  });
}

/* ------------------------------------------------------------------------ *
 * §2.3/§4.1 the caller's OWN binding, reconstructed from its durable row
 * (R8/R9; A09/A15/A16)
 * ------------------------------------------------------------------------ */

/**
 * §2.3 the caller's OWN address. The trusted caller's identity IS the address,
 * so no part of it is read from request JSON, and every check here is an
 * argument check — no store is opened.
 */
function ownSessionAddress(caller: ExecutionCaller | undefined): SessionAddress {
  if (!isPlainObject(caller) || !isNonEmptyString(caller.sessionId) || !isNonEmptyString(caller.workflowId)) {
    throw invalidInput("Coordinator session reconstruction requires workflowId and sessionId from the trusted caller. Inspect workflow authority with mstar status validate.");
  }
  if (caller.role !== "coordinator") {
    throw invalidInput("Invalid execution session role: expected coordinator. Inspect workflow authority with mstar status validate.");
  }
  return { workflowId: caller.workflowId, role: "coordinator", sessionId: caller.sessionId };
}

/**
 * §2.3/§4.1 (R9/A16) the caller's own question when this store records NO row
 * for its identity: the durable facts, the ONE decision that would make its
 * coordinator binding current, the effect withheld — that identity's own
 * binding, never another holder's — and what still works meanwhile.
 *
 * `holder` is the workflow's ACTIVE coordinator record (no epoch filter), so
 * this refusal names the same fact a bind's foreign-holder fence names.
 * Reporting is all this path does: a held workflow-wide coordinator scope is
 * never revived, stolen or replaced here — the narrow recovery transition owns
 * replacement, and only after validated stop evidence.
 */
function unresolvedOwnSession(address: SessionAddress, rows: readonly SessionRow[]): never {
  const holder = rows.find((row) => row.state === "active");
  const code = holder === undefined ? "coordination.session-not-found" : "coordination.identity-mismatch";
  const currentFacts = [
    `the trusted caller is coordinator session ${address.sessionId} of workflow ${address.workflowId}`,
    holder === undefined
      ? `workflow ${address.workflowId} records no coordinator session ${address.sessionId} and holds no ACTIVE coordinator session`
      : `workflow ${address.workflowId} holds the ACTIVE coordinator session ${holder.ref.sessionId} (epoch ${holder.ref.epoch})`,
  ];
  const problem: RecoveryProblem = {
    component: "session",
    path: "session",
    code,
    sourcesTried: [
      `execution_sessions rows of workflow ${address.workflowId} for role coordinator`,
      "the trusted caller identity (workflow, role, session)",
    ],
    currentFacts,
    needed:
      holder === undefined
        ? `a binding this identity can resume: bind coordinator session ${address.sessionId} to workflow ${address.workflowId}`
        : `the stop/recovery decision for the live coordinator ${holder.ref.sessionId}: the named coordinator recovery with ` +
          `stop evidence for that holder`,
    withheldEffect:
      `only this identity's own session binding and reference \u2014 no row was written, and the coordinator scope of ` +
      `workflow ${address.workflowId} is never taken over by another name here`,
    availableWork: [
      `read the state of workflow ${address.workflowId} and every plan row it holds`,
      ...(holder === undefined
        ? ["establish an authorized coordinator binding for the caller identity"]
        : [
            "continue the active holder's own binding from that holder's identity",
            "complete the registered coordinator-recovery flow after the holder stop is attested",
          ]),
    ],
  };
  throw new CoordinationError(code, "The caller has no usable coordinator session binding. Inspect workflow state with mstar status validate.", {
    component: problem.component,
    path: problem.path,
    workflow_id: address.workflowId,
    role: address.role,
    session_id: address.sessionId,
    ...(holder === undefined ? {} : { holder: holder.ref.sessionId }),
    sources_tried: problem.sourcesTried,
    current_facts: problem.currentFacts,
    available_work: problem.availableWork,
    recovery: unresolvedRecovery({
      target: { workflowId: address.workflowId },
      unresolved: [problem],
      resolvedFrom: [
        { path: "workflowId", source: "caller.identity" },
        { path: "role", source: "caller.identity" },
        { path: "sessionId", source: "caller.identity" },
      ] satisfies ResolutionSource[],
    }),
  });
}

/**
 * §2.3/§4.1 (R8, A09/A15) the caller's OWN current coordinator binding,
 * reconstructed from the session row this store holds instead of a reference
 * the caller had to keep. The reference a host caches is a PROJECTION of that
 * row: the store's own `{storeId, epoch}` generation and the session revision
 * belong to the store, so a host that lost the envelope loses nothing the
 * engine cannot read back — the trusted caller identity names the workflow, and
 * this read answers with the row recorded for it at the CURRENT epoch.
 *
 * It is a READ: no identity, `bound_at` or revision is written, so a repeat
 * after a lost response returns the same binding (A09). When this store holds
 * no usable binding for the caller's own identity the refusal is the caller's
 * own question (`unresolvedOwnSession`) or the precise stored-state verdict of
 * `liveSession`; a foreign holder's row is never touched, and reads of
 * unrelated workflows continue.
 */
export async function readOwnExecutionSession(context: ExecutionContext): Promise<ExecutionRead<ExecutionSessionRef>> {
  const address = ownSessionAddress(context?.caller);
  return withExecutionReadTransaction(context, (tx) => {
    const store: StoreIdentity = { storeId: tx.storeId, epoch: tx.epoch };
    const rows = readSessionRows(tx.db, store, address.workflowId);
    if (rows.every((row) => row.ref.sessionId !== address.sessionId)) unresolvedOwnSession(address, rows);
    const live = liveSession(tx, address);
    return {
      data: live.ref,
      token: executionToken("session", tx.storeId, tx.epoch, [live.ref.workflowId, live.ref.role, live.ref.sessionId], live.revision),
      storeId: tx.storeId,
      epoch: tx.epoch,
    };
  });
}
