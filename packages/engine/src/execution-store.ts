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
 * surface — `bindExecutionSession` (trusted-caller coordinator/plan-pm binding
 * plus the plan's initial execution lease) and the session-authorized
 * `readExecutionPlan`. The coordination-mutation verbs (W1–W6), the public
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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  ExecutionPinConflictError,
  executionInputHash,
  executionInputSelection,
  leaseFailure,
  type CatalogExecutionPin,
} from "./coordination.js";
import {
  CoordinationError,
  isNonEmptyString,
  isPlainObject,
  validateRowCoordination,
  type RowCoordination,
} from "./coordination-write.js";
import {
  claimLease,
  validateExecutionLease,
  validateIntegrationMergeLease,
  withStatusWriteLock,
  type ClaimLeaseFields,
  type ExecutionLease,
  type IntegrationMergeLease,
} from "./lease.js";
import { resolveWorkflowDir } from "./path.js";
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
import { isTerminalSnapshot, validateWorkflowSnapshot, type WorkflowSnapshot } from "./workflow.js";

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
  | "store.not-active"
  | "store.stale-epoch";

/** Typed refusal with an actionable, stable code. */
export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ExecutionError";
    this.code = code;
  }
}

/** §2.1: the address kind a version token belongs to. */
export type ExecutionKind = "root" | "workflow" | "plan" | "session" | "execution-lease" | "integration-lease" | "input";

/** §3.1: an `exec-v1:` version token — an opaque CAS string, never a revision. */
export type ExecutionToken = string & { readonly __executionToken: unique symbol };

/** §3: the DB session reference a state view carries (an identity, not a credential). */
export type ExecutionSessionRef = {
  storeId: string;
  epoch: number;
  workflowId: string;
  role: "coordinator" | "plan-pm";
  sessionId: string;
  planId: string | null;
};

/** §3: one consistent authority read — data, its token and the store it came from. */
export type ExecutionRead<T> = { data: T; token: ExecutionToken; storeId: string; epoch: number };

/** §3: the per-plan view of an authoritative state read. */
export type ExecutionPlanView = {
  workflow: Omit<WorkflowSnapshot, "plans" | "coordinator_session" | "integration_merge_lease">;
  plan: Omit<PlanRow, "coordination" | "execution_lease">;
  coordination: Omit<RowCoordination, "session"> | null;
  session: ExecutionSessionRef | null;
  executionLease: ExecutionLease | null;
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
};

/**
 * §3: the trusted caller a domain verb authorizes against. It comes only from
 * the adapter's trusted host identity (or the engine-owned local CLI identity
 * acquisition), NEVER from model request JSON — a caller-written role string
 * authorizes nothing.
 */
export type ExecutionCaller = {
  sessionId: string;
  role: "coordinator" | "plan-pm";
  workflowId: string;
  planId: string | null;
};

/** §3: a domain call's context — the addressed store plus the trusted caller. */
export type ExecutionContext = StoreContext & { caller: ExecutionCaller };

/**
 * §3: the committed result of a domain operation. `data`/`token` describe the
 * state the operation produced (a replay returns the RECORDED receipt, not a
 * re-read), and `replayed` distinguishes the idempotent retry from the commit.
 */
export type ExecutionReceipt<T> = ExecutionRead<T> & { operationId: string; replayed: boolean };

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
  "execution-lease": 2,
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
    throw tokenRefusal(`${what} must be a positive safe integer — got ${String(value)}`);
  }
  return String(value);
}

function positiveDecimal(text: string, what: string): number {
  if (!DECIMAL_RE.test(text)) {
    throw tokenRefusal(
      `${what} must be a plain decimal without sign, whitespace or leading zeros — got ${JSON.stringify(text)}`,
    );
  }
  const value = Number(text);
  if (value === 0) throw tokenRefusal(`${what} must be greater than 0 — got ${JSON.stringify(text)}`);
  if (value > Number.MAX_SAFE_INTEGER) {
    throw tokenRefusal(`${what} exceeds Number.MAX_SAFE_INTEGER — got ${JSON.stringify(text)}`);
  }
  return value;
}

function assertKeyShape(kind: ExecutionKind, key: readonly string[]): void {
  const expected = KIND_KEY_LENGTHS[kind];
  if (key.length !== expected) {
    throw tokenRefusal(`a ${kind} token key carries ${expected} part(s) — got ${key.length}`);
  }
  for (const part of key) {
    if (!isNonEmptyString(part)) throw tokenRefusal(`every ${kind} token key part must be a non-empty string`);
  }
  if (kind === "session" && key[1] !== "coordinator" && key[1] !== "plan-pm") {
    throw tokenRefusal(`a session token key carries the role as its second part — got ${JSON.stringify(key[1])}`);
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
    decoded = JSON.parse(Buffer.from(key64, "base64url").toString("utf8"));
  } catch {
    throw tokenRefusal("a token key must be base64url-wrapped UTF-8 JSON");
  }
  if (!Array.isArray(decoded) || decoded.some((part) => typeof part !== "string")) {
    throw tokenRefusal("a token key must decode to a JSON array of strings");
  }
  const key = decoded as string[];
  assertKeyShape(kind, key);
  // Canonical encoding, checked by reconstruction: padding, embedded whitespace,
  // non-minimal base64 and reordered output all disagree with the input here.
  if (encodeTokenKey(key) !== key64) throw tokenRefusal("a token key must be the canonical encoding of its key array");
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
  if (!STORE_UUID_RE.test(storeId)) throw tokenRefusal(`a store identity must be a lowercase UUID — got ${JSON.stringify(storeId)}`);
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
  if (typeof value !== "string") throw tokenRefusal(`an execution token must be a string — got ${typeof value}`);
  const parts = value.split(":");
  if (parts.length !== 6) throw tokenRefusal(`an execution token has 6 colon-separated parts — got ${parts.length}`);
  const [prefix, kindText, storeId, epochText, key64, revisionText] = parts;
  if (prefix !== TOKEN_PREFIX) throw tokenRefusal(`an execution token starts with ${TOKEN_PREFIX} — got ${JSON.stringify(prefix)}`);
  if (!isExecutionKind(kindText)) throw tokenRefusal(`unknown execution kind ${JSON.stringify(kindText)}`);
  const kind = kindText;
  if (!STORE_UUID_RE.test(storeId)) throw tokenRefusal(`a store identity must be a lowercase UUID — got ${JSON.stringify(storeId)}`);
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
  const parsed = parseExecutionToken(value);
  if (parsed.kind !== expected.kind) {
    throw new ExecutionError(
      "execution.token-kind",
      `expected a ${expected.kind} token — got a ${parsed.kind} token. The address kind is never inferred from a supplied token.`,
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
    );
  }
  if (parsed.epoch !== expected.epoch) {
    throw new ExecutionError(
      "store.stale-epoch",
      `the token carries epoch ${parsed.epoch}; the current epoch is ${expected.epoch}. Reopen the store and re-read before retrying.`,
    );
  }
  if (expected.revision !== undefined && parsed.revision !== expected.revision) {
    throw new ExecutionError(
      "execution.stale-token",
      `the token carries revision ${parsed.revision}; the current revision is ${expected.revision}. Re-read and retry with the current token.`,
    );
  }
  return parsed;
}

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

function readExecutionLease(json: unknown, what: string): ExecutionLease {
  const lease = storedJsonObject(json, what);
  const validation = validateExecutionLease(lease);
  if (!validation.ok) throw validationRefusal(what, validation.violations);
  return lease as unknown as ExecutionLease;
}

function readIntegrationLease(json: unknown, what: string): IntegrationMergeLease {
  const lease = storedJsonObject(json, what);
  const validation = validateIntegrationMergeLease(lease);
  if (!validation.ok) throw validationRefusal(what, validation.violations);
  return lease as unknown as IntegrationMergeLease;
}

/**
 * §2.2 lease ownership invariant: a HELD execution lease must carry the holder
 * session identity and role it owns the plan through, and the DB-named scope
 * fields (`plan_worktree_path` / `plan_branch`) must agree with the
 * `ExecutionLease` identity fields they mirror. A lease that claims the CURRENT
 * epoch must name that epoch's ACTIVE plan-pm session — the session row's own
 * `epoch` included, because a row superseded by a later epoch is not that
 * session; `bindExecutionSession` writes exactly this pair. A lease whose
 * `owner_epoch` is behind the store (a suspended or migration-recovered one) is
 * REPRESENTED rather than repaired: it agrees with no current session and
 * authorizes nothing, because every mutation revalidates the epoch.
 */
function assertLeaseOwnership(
  lease: ExecutionLease,
  sessionRow: Record<string, unknown> | undefined,
  ownerEpoch: number,
  store: StoreIdentity,
  workflowId: string,
  planId: string,
): void {
  if (lease.status !== "held") return;
  const what = `execution_leases(${workflowId},${planId}).lease_json`;
  if (!isNonEmptyString(lease.holder_session_id) || (lease.holder_role !== "plan-pm" && lease.holder_role !== "coordinator")) {
    throw corrupt(`${what} is held without the holder session identity and role it must agree with`);
  }
  if (lease.plan_worktree_path !== lease.worktree_path || lease.plan_branch !== lease.working_branch) {
    throw corrupt(`${what} records a plan scope that disagrees with its own lease identity fields`);
  }
  if (ownerEpoch !== store.epoch) return;
  if (sessionRow === undefined) {
    throw corrupt(`${what} is held in epoch ${ownerEpoch} by session ${String(lease.holder_session_id)} while ${planId} has no active plan session`);
  }
  if (sessionRow.epoch !== ownerEpoch) {
    throw corrupt(
      `${what} is held in epoch ${ownerEpoch} by ${String(lease.holder_role)} session ${String(lease.holder_session_id)}, but the ` +
        `active ${String(sessionRow.role)} session of ${planId} is ${String(sessionRow.session_id)} in epoch ${String(sessionRow.epoch)}; ` +
        `a lease and the session row it names as its owner are ONE ownership fact of one epoch`,
    );
  }
  if (sessionRow.session_id !== lease.holder_session_id || sessionRow.role !== lease.holder_role) {
    throw corrupt(
      `${what} is held by ${String(lease.holder_role)} session ${String(lease.holder_session_id)}, but the active session of ` +
        `${planId} in epoch ${ownerEpoch} is ${String(sessionRow.role)} session ${String(sessionRow.session_id)}`,
    );
  }
}

function sessionRef(store: StoreIdentity, workflowId: string, row: Record<string, unknown>): ExecutionSessionRef {
  const role = row.role;
  if (role !== "plan-pm" && role !== "coordinator") {
    throw corrupt(`execution_sessions(${workflowId}) carries role ${JSON.stringify(role)}`);
  }
  if (!isNonEmptyString(row.session_id)) {
    throw corrupt(`execution_sessions(${workflowId}) carries an empty session identity`);
  }
  if (typeof row.epoch !== "number" || !Number.isSafeInteger(row.epoch) || row.epoch < 0) {
    throw corrupt(`execution_sessions(${workflowId},${row.session_id}) carries a non-integer epoch`);
  }
  let planId: string | null = null;
  if (role === "plan-pm") {
    if (!isNonEmptyString(row.plan_id)) {
      throw corrupt(`execution_sessions(${workflowId},${row.session_id}) is a plan-pm row without a plan id`);
    }
    planId = row.plan_id;
  } else if (row.plan_id !== null && row.plan_id !== undefined) {
    throw corrupt(`execution_sessions(${workflowId},${row.session_id}) is a coordinator row with a plan id`);
  }
  return {
    storeId: store.storeId,
    epoch: row.epoch,
    workflowId,
    role,
    sessionId: row.session_id,
    planId,
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
    .prepare("select role, session_id, plan_id, epoch from execution_sessions where workflow_id = ? and state = 'active'")
    .all(workflowId) as Array<Record<string, unknown>>;
  const leases = db
    .prepare("select plan_id, owner_epoch, lease_json from execution_leases where workflow_id = ?")
    .all(workflowId) as Array<Record<string, unknown>>;
  const inputs = db
    .prepare("select plan_id, catalog_pin_json from execution_inputs where workflow_id = ?")
    .all(workflowId) as Array<Record<string, unknown>>;
  const integrationRow = db
    .prepare("select lease_json from execution_integration_leases where workflow_id = ?")
    .get(workflowId) as { lease_json?: unknown } | undefined;

  const coordinatorRow = sessions.find((row) => row.role === "coordinator");
  const integrationLease = integrationRow
    ? readIntegrationLease(integrationRow.lease_json, `execution_integration_leases(${workflowId}).lease_json`)
    : null;

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
          `by coordination_json/execution_leases`,
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
    const projectedCoordination = { revision: planRevision, ...storedCoordination };
    const coordinationViolations = validateRowCoordination(projectedCoordination);
    if (coordinationViolations.length > 0) {
      throw validationRefusal(`execution_plans(${workflowId},${planId}).coordination_json`, coordinationViolations);
    }
    const hasCoordination = Object.keys(storedCoordination).length > 0;
    const sessionRow = sessions.find((entry) => entry.role === "plan-pm" && entry.plan_id === planId);
    const leaseRow = leases.find((entry) => entry.plan_id === planId);
    const inputRow = inputs.find((entry) => entry.plan_id === planId);
    const executionLease = leaseRow
      ? readExecutionLease(leaseRow.lease_json, `execution_leases(${workflowId},${planId}).lease_json`)
      : null;
    // §2.2: a held lease and the plan's active session are ONE ownership fact
    // recorded in two rows; the reader refuses a pair that disagrees.
    if (leaseRow !== undefined && executionLease !== null) {
      assertLeaseOwnership(
        executionLease,
        sessionRow,
        storedRevision(leaseRow.owner_epoch, `execution_leases(${workflowId},${planId}).owner_epoch`),
        store,
        workflowId,
        planId,
      );
    }
    planTokens[planId] = executionToken("plan", store.storeId, store.epoch, [workflowId, planId], planRevision);
    plans.push({
      workflow: state as unknown as ExecutionPlanView["workflow"],
      plan: planState as unknown as ExecutionPlanView["plan"],
      coordination: hasCoordination
        ? (projectedCoordination as unknown as Omit<RowCoordination, "session">)
        : null,
      session: sessionRow ? sessionRef(store, workflowId, sessionRow) : null,
      executionLease,
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
  for (const row of registry) {
    const workflowId = storedText(row.workflow_id, "execution_registry.workflow_id");
    const entry = storedJsonObject(row.entry_json, `execution_registry(${workflowId}).entry_json`);
    const validation = validateWorkflowEntry(entry);
    if (!validation.ok) throw validationRefusal(`execution_registry(${workflowId}).entry_json`, validation.violations);
    if (entry.id !== workflowId) {
      throw corrupt(`execution_registry(${workflowId}).entry_json carries id ${JSON.stringify(entry.id)}`);
    }
    entries.push(entry as unknown as WorkflowEntry);
    workflows.push(readWorkflowView(db, store, workflowId));
  }
  return { root: { version: 2, updated_at: meta.rootUpdatedAt, workflows: entries }, workflows };
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
        `Execution authority is initialized only for an empty execution workspace — this workspace belongs on the ` +
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
      `the issue/catalog store is ${row.authority_state}; execution authority is initialized only on an active ` +
        `store. Complete the store activation barrier first — nothing was modified.`,
    );
  }
}

/** §3: no execution records and no catalog execution binding may exist yet. */
function assertExecutionDomainEmpty(db: StoreDb, meta: ExecutionMeta): void {
  if (meta.authorityState === "staged") {
    throw new ExecutionError(
      "execution.not-active",
      "the execution authority is staged by a migration manifest. Initialization creates an EMPTY active " +
        "authority and never adopts or discards staged rows; finish or abort that migration instead.",
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
    "execution_leases",
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

type ResolvedCreation = {
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
function suppliedCatalogPin(row: Record<string, unknown>, workflowId: string, planId: string): CatalogExecutionPin | null {
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
        `— got ${JSON.stringify(raw)}`,
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
 */
function resolveCreateWorkflow(
  caller: ExecutionCaller,
  entry: unknown,
  snapshot: unknown,
  operationId: unknown,
): ResolvedCreation {
  if (!isNonEmptyString(caller?.sessionId)) {
    throw invalidInput("the execution caller needs a non-empty session identity");
  }
  if (typeof operationId !== "string" || !OPERATION_ID_RE.test(operationId)) {
    throw invalidInput(
      `an operation id must be a nonempty ASCII [A-Za-z0-9._:-]+ string of at most 128 characters — got ${JSON.stringify(operationId)}`,
    );
  }
  const entryGate = validateWorkflowEntry(entry);
  const snapshotGate = validateWorkflowSnapshot(snapshot);
  const violations = [...entryGate.violations, ...snapshotGate.violations];
  if (violations.length > 0) {
    throw invalidInput(
      `the workflow entry/snapshot does not validate (${violations.map((entry) => `${entry.code}: ${entry.message}`).join("; ")})`,
    );
  }
  const workflow = entry as WorkflowEntry;
  const doc = snapshot as WorkflowSnapshot & Record<string, unknown>;
  const workflowId = workflow.id;

  if (caller.role !== "coordinator" || caller.planId !== null) {
    throw new ExecutionError(
      "execution.scope-mismatch",
      `creating a workflow is a coordinator operation; the supplied caller is a ${caller.role} session` +
        `${caller.planId === null ? "" : ` for plan ${caller.planId}`}. The caller identity is never taken from request JSON.`,
    );
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
      throw invalidInput(`snapshot ${workflowId} lists plan ${planId} twice — a plan row is one identity`);
    }
    seen.add(planId);
    // The row's own lease and coordination blocks are accepted execution
    // evidence (handoffs, prepared inputs, holders) that a new lifecycle cannot
    // inherit; `execution_leases`/`execution_plans.coordination_json` own them.
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
          plan_id: caller.planId,
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
  return {
    data: receipt.data as T,
    token: recordedToken as ExecutionToken,
    storeId: receipt.storeId,
    epoch: receipt.epoch,
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
 * plan entity present in this store's catalog, and the pin must describe the
 * very row it is sealed with (the store-independent check `prepare` enforces).
 * A current catalog revision that moved past the recorded `entity_revision` is
 * explicitly tolerated — the pin freezes an identity, not a pointer.
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
        `plan ${plan.planId} selects catalog store ${pin.store_id}, which is not this store (${storeId}) — a foreign ` +
          `selection is never sealed as this store's frozen input`,
        details,
      );
    }
    if (executionInputHash(plan.row, plan.planId) !== pin.document_hash) {
      throw new ExecutionPinConflictError(
        `plan ${plan.planId}'s supplied pin records document hash ${pin.document_hash.slice(0, 12)}…, but the frozen ` +
          `execution input it is sealed with hashes differently — the pin and its row disagree; neither side is rewritten`,
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
  input: { workflowId: string; entry: WorkflowEntry; snapshot: WorkflowSnapshot; plans: readonly ResolvedCreationPlan[]; creatorSessionId: string; now: string },
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
            `slot — retry the committed request unchanged or use a new id. Nothing was created.`,
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

    assertWorkflowIdentityIsNew(tx.db, creation.workflowId);
    assertSelectedCatalogEntities(tx.db, tx.storeId, creation.workflowId, creation.plans);

    const now = new Date().toISOString();
    writeCreatedWorkflow(tx.db, {
      workflowId: creation.workflowId,
      entry: creation.entry,
      snapshot: creation.snapshot,
      plans: creation.plans,
      creatorSessionId: context.caller.sessionId,
      now,
    });
    // Registry membership is a root change: the root revision and its timestamp
    // advance together, and the multi-domain transaction bumps the store
    // revision once (no catalog data changed, so catalog_revision is untouched).
    tx.db
      .prepare("update execution_meta set revision = revision + 1, root_updated_at = ? where id = 1")
      .run(now);
    tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();

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
type ExecutionSessionState = "active" | "suspended" | "revoked";

const EXECUTION_SESSION_STATES: readonly ExecutionSessionState[] = ["active", "suspended", "revoked"];

/** §2.2 one stored session row: its typed identity plus the ownership record beside it. */
type SessionRow = { ref: ExecutionSessionRef; revision: number; state: ExecutionSessionState };

/** §2.3 the workflow/plan/role a call is authorized against; `planId` is null exactly for a coordinator. */
type SessionAddress = {
  workflowId: string;
  role: ExecutionCaller["role"];
  sessionId: string;
  planId: string | null;
};

/** The address one bind request resolves to, once it is the trusted caller's own. */
type ResolvedBind =
  | { role: "coordinator"; planId: null; workflowId: string; sessionId: string; operationId: string }
  | { role: "plan-pm"; planId: string; workflowId: string; sessionId: string; operationId: string };

function sessionRoleRefusal(detail: string, details: Record<string, unknown> = {}): CoordinationError {
  return new CoordinationError("coordination.session-role", detail, details);
}

/**
 * §2.3 the identity gate of `bindExecutionSession`. The request describes the
 * binding the caller wants; `ExecutionContext.caller` — the trusted host/engine
 * identity, never model request JSON — is the only thing that decides whether
 * the caller may have it. A request whose role, workflow or plan is not the
 * caller's own is refused: naming `role: "coordinator"` in the request never
 * promotes a plan-pm caller, and a caller-written role string authorizes
 * nothing. Pure argument checks — no store is opened.
 */
function resolveBindRequest(caller: ExecutionCaller, input: unknown): ResolvedBind {
  if (!isPlainObject(input)) throw invalidInput("a session bind needs a request object");
  if (!isNonEmptyString(caller?.sessionId)) throw invalidInput("the execution caller needs a non-empty session identity");
  const { workflowId, planId, role, operationId } = input;
  if (typeof operationId !== "string" || !OPERATION_ID_RE.test(operationId)) {
    throw invalidInput(
      `an operation id must be a nonempty ASCII [A-Za-z0-9._:-]+ string of at most 128 characters — got ${JSON.stringify(operationId)}`,
    );
  }
  if (role !== "coordinator" && role !== "plan-pm") {
    throw invalidInput(`a session role is "coordinator" or "plan-pm" — got ${JSON.stringify(role)}`);
  }
  if (!isNonEmptyString(workflowId)) throw invalidInput("a session bind needs a non-empty workflowId");
  if (caller.role !== role) {
    throw sessionRoleRefusal(
      `the trusted caller is a ${caller.role} session; a bind request is never authorized by the role it names for itself`,
      { caller_role: caller.role, requested_role: role },
    );
  }
  if (caller.workflowId !== workflowId) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `the trusted caller identifies workflow ${JSON.stringify(caller.workflowId)}; this request binds a session of ` +
        `workflow ${JSON.stringify(workflowId)}. The caller identity is never taken from request JSON.`,
      { caller_workflow: caller.workflowId, requested_workflow: workflowId },
    );
  }
  if (role === "coordinator") {
    if (planId !== null) {
      throw invalidInput(`a coordinator bind takes no plan id — got ${JSON.stringify(planId)}`);
    }
    if (caller.planId !== null) {
      throw new CoordinationError(
        "coordination.session-mismatch",
        `the trusted caller identifies plan ${JSON.stringify(caller.planId)}; a coordinator address carries no plan id`,
        { caller_plan: caller.planId },
      );
    }
    return { role, planId: null, workflowId, sessionId: caller.sessionId, operationId };
  }
  if (!isNonEmptyString(planId)) {
    throw invalidInput(`a plan-pm bind needs the plan id it binds — got ${JSON.stringify(planId)}`);
  }
  if (caller.planId !== planId) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `the trusted caller identifies plan ${JSON.stringify(caller.planId)}; this request binds a session of plan ` +
        `${JSON.stringify(planId)}`,
      { caller_plan: caller.planId, requested_plan: planId },
    );
  }
  return { role, planId, workflowId, sessionId: caller.sessionId, operationId };
}

/**
 * §3.1 request hash: operation kind, exact scope (workflow, plan, role),
 * expected token and caller identity. Reusing an operation id for any other
 * request refuses `execution.operation-conflict` instead of replaying a foreign
 * receipt, and another actor cannot replay this one.
 */
function bindSessionRequestHash(caller: ExecutionCaller, bind: ResolvedBind, expected: ExecutionToken): string {
  return createHash("sha256")
    .update(
      serializeExecutionValue({
        operation: BIND_SESSION_OPERATION,
        workflow_id: bind.workflowId,
        plan_id: bind.planId,
        role: bind.role,
        expected,
        caller: {
          session_id: caller.sessionId,
          role: caller.role,
          workflow_id: caller.workflowId,
          plan_id: caller.planId,
        },
      }),
      "utf8",
    )
    .digest("hex");
}

function storedSessionState(value: unknown, what: string): ExecutionSessionState {
  if (!EXECUTION_SESSION_STATES.includes(value as ExecutionSessionState)) {
    throw corrupt(`${what} is ${JSON.stringify(value)}, which is not a session state`);
  }
  return value as ExecutionSessionState;
}

/**
 * Every stored session row of one workflow and role, validated field by field
 * inside the caller's transaction. Availability is decided by `state` and the
 * CURRENT epoch together: a row the store still records is re-read here rather
 * than trusted from a reference.
 */
function readSessionRows(db: StoreDb, store: StoreIdentity, workflowId: string, role: ExecutionCaller["role"]): SessionRow[] {
  const rows = db
    .prepare("select role, session_id, plan_id, epoch, revision, state from execution_sessions where workflow_id = ? and role = ?")
    .all(workflowId, role) as Array<Record<string, unknown>>;
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

/** §2.2: one plan row's CAS revision, or `coordination.plan-not-found`. */
function readPlanRevision(db: StoreDb, workflowId: string, planId: string): number {
  const row = db
    .prepare("select revision from execution_plans where workflow_id = ? and plan_id = ?")
    .get(workflowId, planId) as { revision?: unknown } | undefined;
  if (row === undefined) {
    throw new CoordinationError(
      "coordination.plan-not-found",
      `workflow ${workflowId} holds no plan ${planId} to bind`,
      { workflow_id: workflowId, plan_id: planId },
    );
  }
  return storedRevision(row.revision, `execution_plans(${workflowId},${planId}).revision`);
}

/**
 * §2.2 unique active ownership of the addressed scope: `mine` is this
 * identity's own record (the row key admits at most one per workflow/role/
 * session), and `holder` is the ACTIVE record of the addressed role and plan
 * (the partial unique indexes admit at most one). Both are read inside the
 * caller's transaction, so the answer cannot be a stale snapshot.
 */
function readOwnership(
  db: StoreDb,
  store: StoreIdentity,
  address: SessionAddress,
): { mine: SessionRow | undefined; holder: SessionRow | undefined } {
  const rows = readSessionRows(db, store, address.workflowId, address.role);
  return {
    mine: rows.find((row) => row.ref.sessionId === address.sessionId),
    holder: rows.find((row) => row.state === "active" && row.ref.planId === address.planId),
  };
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
  const rows = readSessionRows(tx.db, store, address.workflowId, address.role);
  const mine = rows.find((row) => row.ref.sessionId === address.sessionId);
  if (mine === undefined || mine.state !== "active" || mine.ref.epoch !== tx.epoch) {
    throw new ExecutionError(
      "execution.session-unavailable",
      `workflow ${address.workflowId} holds no ACTIVE ${address.role} session ${address.sessionId} in epoch ${tx.epoch}` +
        `${mine === undefined ? "" : ` (its row is ${mine.state} in epoch ${mine.ref.epoch})`}. An execution session ` +
        `reference authorizes only the binding the store records at the current epoch; a legacy session envelope is ` +
        `never consulted.`,
    );
  }
  if (mine.ref.planId !== address.planId) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `${address.role} session ${address.sessionId} is bound to plan ${JSON.stringify(mine.ref.planId)}, not to plan ` +
        `${JSON.stringify(address.planId)}`,
      { session_id: address.sessionId, bound_plan: mine.ref.planId, addressed_plan: address.planId },
    );
  }
  return mine;
}

/** §2.1: a reference from another store or another epoch fences before anything is read. */
function assertReferenceAuthority(tx: ExecutionTransaction, referenceStoreId: string, referenceEpoch: number): void {
  if (referenceStoreId !== tx.storeId) {
    throw new ExecutionError(
      "execution.scope-mismatch",
      `the session reference belongs to store ${referenceStoreId}, not to ${tx.storeId}`,
    );
  }
  if (referenceEpoch !== tx.epoch) {
    throw new ExecutionError(
      "store.stale-epoch",
      `the session reference carries epoch ${referenceEpoch}; the current epoch is ${tx.epoch}. Rebind the session and retry.`,
    );
  }
}

/**
 * §2.2/§4.1 the plan scope an initial execution lease records: the plan row's
 * own recorded worktree and branch (`metadata.worktree_path` /
 * `metadata.working_branch` — the anchors the legacy route pins from the
 * prepared Assignment and re-checks on every handoff). The DB authority reads
 * them from the row it already holds, so no file is authority here, and a
 * prepared row that records no plan scope cannot have a lease claimed from it:
 * ownership is never claimed from a guessed scope.
 */
function planLeaseScope(state: Record<string, unknown>, workflowId: string, planId: string): ClaimLeaseFields {
  const metadata = isPlainObject(state.metadata) ? state.metadata : {};
  const worktree = metadata.worktree_path;
  const branch = metadata.working_branch;
  if (!isNonEmptyString(worktree) || !isAbsolute(worktree) || !isNonEmptyString(branch)) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `plan ${planId} records no plan worktree/branch scope (metadata.worktree_path must be an absolute path and ` +
        `metadata.working_branch a non-empty branch), so an execution lease cannot be claimed for it`,
      { workflow_id: workflowId, plan_id: planId, worktree_path: worktree ?? null, working_branch: branch ?? null },
    );
  }
  return { worktree_path: worktree, working_branch: branch, session_label: "plan-pm" };
}

/** §2.2 one new ACTIVE session row; a new DB record starts at revision 1. */
function writeExecutionSession(
  db: StoreDb,
  input: { workflowId: string; address: SessionAddress; epoch: number; now: string },
): void {
  db.prepare(
    "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
      "values (?, ?, ?, ?, ?, 1, 'active', ?)",
  ).run(input.workflowId, input.address.role, input.address.sessionId, input.address.planId, input.epoch, input.now);
}

/**
 * §2.2 the plan's FIRST `execution_leases` row. The pure `claimLease`
 * transition carries the legacy `ExecutionLease` identity fields
 * (`holder`/`claimed_at`/`worktree_path`/`working_branch`); this adds the
 * ownership and observation fields the DB lease carries. Ownership is
 * `holder_session_id` + `holder_role` + the row's `owner_epoch` column, so the
 * fence is the column — rebinding the same identity after an epoch change
 * never revives this lease.
 */
function writeInitialExecutionLease(
  db: StoreDb,
  input: { workflowId: string; planId: string; address: SessionAddress; epoch: number; lease: ExecutionLease },
): void {
  const lease = {
    ...input.lease,
    lease_id: randomUUID(),
    holder_session_id: input.address.sessionId,
    holder_role: input.address.role,
    plan_worktree_path: input.lease.worktree_path,
    plan_branch: input.lease.working_branch,
    heartbeat_at: input.lease.claimed_at,
    status: "held",
  };
  db.prepare(
    "insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, ?, ?)",
  ).run(input.workflowId, input.planId, input.epoch, JSON.stringify(lease));
}

/**
 * §2.2 the stored plan state never duplicates the DB ownership rows: the
 * `claimLease` result's `execution_lease` is written to `execution_leases`, so
 * only the state (status included) is persisted here. The row revision advances
 * once because the state changed.
 */
function writePlanState(
  db: StoreDb,
  input: { workflowId: string; planId: string; state: Record<string, unknown>; revision: number },
): void {
  db.prepare("update execution_plans set state_json = ?, revision = ? where workflow_id = ? and plan_id = ?").run(
    JSON.stringify(input.state),
    input.revision,
    input.workflowId,
    input.planId,
  );
}

/** §2.3 the authorization one `readExecutionPlan` call resolves to. */
type ResolvedPlanRead = {
  workflowId: string;
  role: ExecutionCaller["role"];
  sessionId: string;
  planId: string;
  boundPlanId: string | null;
  referenceStoreId: string;
  referenceEpoch: number;
};

/**
 * §2.3 authorization gate of `readExecutionPlan`: the supplied reference names
 * the binding the trusted caller claims to hold, and the caller identity is
 * what authorizes the read. Possession of a reference — or of a legacy session
 * file — authorizes nothing on its own, and a plan-pm session addresses only
 * its own plan while a coordinator session addresses any plan of its workflow.
 */
function resolvePlanRead(caller: ExecutionCaller, session: unknown, planId: unknown): ResolvedPlanRead {
  const bound = session;
  if (!isPlainObject(bound)) throw invalidInput("a plan read needs an execution session reference");
  const { storeId, epoch, workflowId, role, sessionId, planId: boundPlanId } = bound;
  if (
    !isNonEmptyString(storeId) ||
    typeof epoch !== "number" ||
    !Number.isSafeInteger(epoch) ||
    epoch <= 0 ||
    !isNonEmptyString(workflowId) ||
    !isNonEmptyString(sessionId)
  ) {
    throw invalidInput(
      `a session reference carries {storeId, epoch, workflowId, role, sessionId, planId} — got ${JSON.stringify(bound)}`,
    );
  }
  if (role !== "coordinator" && role !== "plan-pm") {
    throw sessionRoleRefusal(`a session reference carries role ${JSON.stringify(role)}`, { role });
  }
  let planScope: string | null = null;
  if (role === "plan-pm") {
    if (!isNonEmptyString(boundPlanId)) {
      throw sessionRoleRefusal(
        `a plan-pm session reference carries ${JSON.stringify(boundPlanId)} as its plan id — a plan-pm session names the plan it is bound to`,
        { role, plan_id: boundPlanId },
      );
    }
    planScope = boundPlanId;
  } else if (boundPlanId !== null) {
    throw sessionRoleRefusal(
      `a coordinator session reference carries ${JSON.stringify(boundPlanId)} as its plan id — a coordinator address takes no plan id`,
      { role, plan_id: boundPlanId },
    );
  }
  if (!isNonEmptyString(caller?.sessionId)) throw invalidInput("the execution caller needs a non-empty session identity");
  if (caller.role !== role) {
    throw sessionRoleRefusal(
      `the trusted caller is a ${caller.role} session; a ${role} session reference does not authorize it`,
      { caller_role: caller.role, reference_role: role },
    );
  }
  if (caller.sessionId !== sessionId || caller.workflowId !== workflowId || caller.planId !== planScope) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `the trusted caller is session ${JSON.stringify(caller.sessionId)} of workflow ${JSON.stringify(caller.workflowId)} ` +
        `plan ${JSON.stringify(caller.planId)}; the supplied reference names session ${JSON.stringify(sessionId)} of ` +
        `workflow ${JSON.stringify(workflowId)} plan ${JSON.stringify(planScope)}`,
      { caller_session: caller.sessionId, reference_session: sessionId },
    );
  }
  if (!isNonEmptyString(planId)) throw invalidInput("a plan read needs the plan id it selects");
  if (role === "plan-pm" && planId !== planScope) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `plan session ${sessionId} addresses plan ${JSON.stringify(planScope)}; it cannot read plan ${JSON.stringify(planId)}`,
      { session_id: sessionId, bound_plan: planScope, addressed_plan: planId },
    );
  }
  return { workflowId, role, sessionId, planId, boundPlanId: planScope, referenceStoreId: storeId, referenceEpoch: epoch };
}

/**
 * §3 session bind: the trusted caller becomes the workflow's coordinator, or
 * the plan-pm of one prepared plan, in ONE transaction that also revalidates
 * the caller's identity, the current epoch, unique active ownership and the
 * plan's lease.
 *
 * - Coordinator: only the workflow's creating trusted identity may bind it,
 *   against the workflow's current token. A later or foreign identity never
 *   replaces a live owner.
 * - Plan-pm: the plan must be PREPARED (this module has no prepare transition —
 *   an unprepared plan is refused, never admitted) and must record its own
 *   worktree/branch scope; the bind claims the plan's execution lease through
 *   the same `claimLease` state machine the legacy transport uses.
 * - No file envelope is written, read or required: a session file is neither
 *   output nor authority here.
 *
 * Revisions (§3.1): a new session row and a new lease row start at revision 1,
 * the claimed plan's own revision advances once, the workflow revision advances
 * once because a child and a session changed, and the store revision advances
 * once for the multi-domain transaction. A replayed operation advances none.
 */
export async function bindExecutionSession(
  context: ExecutionContext,
  input: { workflowId: string; planId: string | null; role: "coordinator" | "plan-pm"; expected: ExecutionToken; operationId: string },
): Promise<ExecutionReceipt<ExecutionSessionRef>> {
  const bind = resolveBindRequest(context.caller, input);
  const requestHash = bindSessionRequestHash(context.caller, bind, input?.expected);
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
          `operation id ${JSON.stringify(bind.operationId)} is already committed on this store epoch for a different request ` +
            `(kind, scope, expected token, caller or payload). Retry the committed request unchanged or use a new id. ` +
            `Nothing was bound.`,
        );
      }
      const receipt = readCommittedReceipt<ExecutionSessionRef>(recorded, tx, bind.operationId, bind.workflowId, {
        kind: "session",
        key: [bind.workflowId, bind.role, bind.sessionId],
      });
      // §3.1: a replay revalidates the CURRENT authority instead of the
      // receipt's own CAS, so a revoked or epoch-invalidated binding never
      // hands back a success it no longer owns.
      assertReferenceAuthority(tx, receipt.data.storeId, receipt.data.epoch);
      liveSession(tx, receipt.data);
      return { ...receipt, operationId: bind.operationId, replayed: true };
    }
    const header = readWorkflowHeaderRow(tx.db, bind.workflowId);
    if (bind.role === "coordinator") {
      assertExecutionToken(input.expected, {
        kind: "workflow",
        storeId: tx.storeId,
        epoch: tx.epoch,
        key: [bind.workflowId],
        revision: header.revision,
      });
    } else {
      assertExecutionToken(input.expected, {
        kind: "plan",
        storeId: tx.storeId,
        epoch: tx.epoch,
        key: [bind.workflowId, bind.planId],
        revision: readPlanRevision(tx.db, bind.workflowId, bind.planId),
      });
    }

    const store: StoreIdentity = { storeId: tx.storeId, epoch: tx.epoch };
    const view = readWorkflowView(tx.db, store, bind.workflowId);
    const now = new Date().toISOString();
    const { mine, holder } = readOwnership(tx.db, store, bind);
    if (mine !== undefined && (mine.state !== "active" || mine.ref.epoch !== tx.epoch)) {
      throw new ExecutionError(
        "execution.session-unavailable",
        `workflow ${bind.workflowId} records session ${bind.sessionId} as a ${bind.role} session in state ` +
          `${mine.state} at epoch ${mine.ref.epoch}; the current epoch is ${tx.epoch}. A suspended, revoked or ` +
          `epoch-invalidated binding is never revived by a normal bind — the named recovery transition, with stop ` +
          `evidence and the prior holder, is the only way back. Nothing was bound.`,
      );
    }
    const existing = mine ?? holder;
    if (existing !== undefined) {
      throw new CoordinationError(
        "coordination.duplicate-holder",
        `workflow ${bind.workflowId} already records ${bind.role} session ${existing.ref.sessionId}` +
          `${existing.ref.planId === null ? "" : ` for plan ${existing.ref.planId}`} (${existing.state} at epoch ` +
          `${existing.ref.epoch}). Ownership is not replaceable by a bind: a live holder resumes through its own ` +
          `reference, and a normal bind never takes over a held scope. Nothing was bound.`,
        { holder: existing.ref.sessionId, workflow_id: bind.workflowId, plan_id: bind.planId },
      );
    }

    if (bind.role === "coordinator") {
      // §2.3: the FIRST coordinator bind of a newly created workflow is
      // permitted only to the identity that created it, so a foreign trusted
      // identity cannot claim a lifecycle it did not create.
      if (header.creatorSessionId === null || header.creatorSessionId !== bind.sessionId) {
        throw new ExecutionError(
          "execution.session-unavailable",
          `workflow ${bind.workflowId} was created by session ${JSON.stringify(header.creatorSessionId)}; the trusted ` +
            `caller is ${JSON.stringify(bind.sessionId)}. A coordinator session binds only through the creating ` +
            `identity (or the separate recovery transition after validated stop evidence). Nothing was bound.`,
        );
      }
      if (view.state.status !== "running") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `workflow ${bind.workflowId} is ${String(view.state.status)} — a coordinator session binds only to a running lifecycle`,
          { workflow_id: bind.workflowId, status: view.state.status },
        );
      }
    } else {
      const plan = view.plans.find((candidate) => candidate.plan.id === bind.planId);
      if (plan === undefined) {
        throw new CoordinationError(
          "coordination.plan-not-found",
          `workflow ${bind.workflowId} holds no plan ${bind.planId} to bind`,
          { workflow_id: bind.workflowId, plan_id: bind.planId },
        );
      }
      // §2.3: a plan bind requires PREPARED eligibility. The public prepare
      // transition is a later plan; until it exists an unprepared row is
      // refused rather than admitted through a bypass.
      if (plan.coordination === null || plan.coordination.prepared === undefined) {
        throw new CoordinationError(
          "coordination.not-prepared",
          `plan ${bind.planId} has no prepared Assignment in workflow ${bind.workflowId} — the coordinator must ` +
            `prepare it first. A plan session never claims ownership of an unprepared row.`,
          { workflow_id: bind.workflowId, plan_id: bind.planId },
        );
      }
      if (plan.executionLease !== null) {
        throw new CoordinationError(
          "coordination.duplicate-holder",
          `plan ${bind.planId} already holds an execution lease (holder session ` +
            `${JSON.stringify(plan.executionLease.holder_session_id)}, status ${JSON.stringify(plan.executionLease.status)}). ` +
            `A bind never replaces, steals or revives a recorded lease — reconcile is the transition that may move it. ` +
            `Nothing was bound.`,
          { workflow_id: bind.workflowId, plan_id: bind.planId, holder: plan.executionLease.holder_session_id },
        );
      }
      const scope = planLeaseScope(plan.plan as Record<string, unknown>, bind.workflowId, bind.planId);
      // The same pure transition the legacy transport runs; the row the DB
      // reader validated is its input, and `execution_leases` (not the row) is
      // where the resulting lease is stored.
      const transition = claimLease(plan.plan as PlanRow, bind.sessionId, scope);
      if (!transition.ok) throw leaseFailure(transition.violations);
      if (transition.outcome !== "claimed") {
        throw corrupt(
          `claiming the execution lease of plan ${bind.planId} returned ${String(transition.outcome)} although the plan ` +
            `held no lease`,
        );
      }
      writeInitialExecutionLease(tx.db, {
        workflowId: bind.workflowId,
        planId: bind.planId,
        address: bind,
        epoch: tx.epoch,
        lease: transition.row.execution_lease as ExecutionLease,
      });
      // §2.2: the lease lives in `execution_leases`, never in the row state.
      const state: Record<string, unknown> = { ...(transition.row as Record<string, unknown>) };
      delete state.execution_lease;
      writePlanState(tx.db, {
        workflowId: bind.workflowId,
        planId: bind.planId,
        state,
        revision: readPlanRevision(tx.db, bind.workflowId, bind.planId) + 1,
      });
    }

    writeExecutionSession(tx.db, { workflowId: bind.workflowId, address: bind, epoch: tx.epoch, now });
    // A session (and, for a plan, its lease) is a child of the workflow: the
    // workflow revision and its timestamp advance once, and the multi-domain
    // transaction bumps the store revision once. Registry membership did not
    // change, so the root revision is untouched.
    tx.db
      .prepare("update execution_workflows set revision = revision + 1, updated_at = ? where workflow_id = ?")
      .run(now, bind.workflowId);
    tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();

    const receipt: ExecutionRead<ExecutionSessionRef> = {
      data: {
        storeId: tx.storeId,
        epoch: tx.epoch,
        workflowId: bind.workflowId,
        role: bind.role,
        sessionId: bind.sessionId,
        planId: bind.planId,
      },
      // A new session row starts at revision 1 (§2.2), so its token does too.
      token: executionToken("session", tx.storeId, tx.epoch, [bind.workflowId, bind.role, bind.sessionId], 1),
      storeId: tx.storeId,
      epoch: tx.epoch,
    };
    tx.db
      .prepare(
        "insert into execution_operations(epoch, operation_id, request_hash, store_id, workflow_id, plan_id, result_json, committed_at) " +
          "values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(tx.epoch, bind.operationId, requestHash, tx.storeId, bind.workflowId, bind.planId, JSON.stringify(receipt), now);
    return { ...receipt, operationId: bind.operationId, replayed: false };
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
 * transaction: the trusted caller and the reference it claims are revalidated
 * against the session rows of the current epoch, and the addressed plan is
 * selected under that authority. A reference that is not the caller's own, that
 * belongs to another store or epoch, or that names another plan authorizes
 * nothing here — and it is never resolved from a session file.
 */
export function readExecutionPlanWitness(
  tx: ExecutionTransaction,
  caller: ExecutionCaller,
  session: ExecutionSessionRef,
  planId: string,
): ExecutionPlanWitness {
  const read = resolvePlanRead(caller, session, planId);
  assertReferenceAuthority(tx, read.referenceStoreId, read.referenceEpoch);
  const live = liveSession(tx, {
    workflowId: read.workflowId,
    role: read.role,
    sessionId: read.sessionId,
    planId: read.boundPlanId,
  });
  const workflow = readWorkflowView(tx.db, { storeId: tx.storeId, epoch: tx.epoch }, read.workflowId);
  const view = workflow.plans.find((candidate) => candidate.plan.id === read.planId);
  const token = workflow.planTokens[read.planId];
  if (view === undefined || token === undefined) {
    throw new CoordinationError(
      "coordination.plan-not-found",
      `workflow ${read.workflowId} holds no plan ${read.planId}`,
      { workflow_id: read.workflowId, plan_id: read.planId },
    );
  }
  return {
    workflowId: read.workflowId,
    planId: read.planId,
    view,
    token,
    revision: parseExecutionToken(token).revision,
    workflowToken: workflow.workflowToken,
    session: live.ref,
  };
}

/**
 * §3 the session-authorized plan read: one consistent read of the plan's
 * authoritative view, served only when the supplied reference is the binding
 * the trusted caller actually holds at the current epoch (a coordinator reads
 * any plan of its workflow, a plan-pm only its own). The returned plan token is
 * the CAS a later coordination mutation passes back.
 */
export async function readExecutionPlan(
  context: ExecutionContext,
  session: ExecutionSessionRef,
  planId: string,
): Promise<ExecutionRead<ExecutionPlanView>> {
  return withExecutionReadTransaction(context, (tx) => {
    const witness = readExecutionPlanWitness(tx, context.caller, session, planId);
    return { data: witness.view, token: witness.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}
