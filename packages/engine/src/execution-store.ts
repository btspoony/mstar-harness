/**
 * execution-store.ts — the execution authority's canonical value form, version
 * token grammar, one-transaction ownership boundary and its read/initialize
 * verbs (primary spec §3, §3.1, §4.1; authority states §2.1).
 *
 * Task ownership: C1 owns the migration-4 schema in `store-db.ts`; THIS module
 * (C2) owns the canonicalizer, the `exec-v1` token grammar, the internal
 * transaction primitive and the real create-only empty-execution initializer.
 * C3/C4 own the workflow/session domain operations and compose with the token
 * and transaction primitives exposed here — no coordination, registration or
 * session-binding verb is defined or stubbed in this module.
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
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CatalogExecutionPin } from "./coordination.js";
import { isNonEmptyString, isPlainObject, validateRowCoordination, type RowCoordination } from "./coordination-write.js";
import {
  validateExecutionLease,
  validateIntegrationMergeLease,
  type ExecutionLease,
  type IntegrationMergeLease,
} from "./lease.js";
import { resolveWorkflowDir } from "./path.js";
import { validateWorkflowEntry, type PlanRow, type StatusV2Doc, type WorkflowEntry } from "./status.js";
import {
  openStore,
  StoreError,
  storeDbPath,
  type ExecutionMeta,
  type StoreContext,
  type StoreDb,
} from "./store-db.js";
import type { WorkflowSnapshot } from "./workflow.js";

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
  | "execution.canonical-value"
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
    typeof pin.store_id !== "string" ||
    typeof pin.entity_revision !== "number" ||
    typeof pin.document_hash !== "string" ||
    typeof pin.relation_hash !== "string"
  ) {
    throw corrupt(`${what} is not a complete catalog execution pin`);
  }
  return pin as unknown as CatalogExecutionPin;
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

function sessionRef(store: StoreIdentity, workflowId: string, row: Record<string, unknown>): ExecutionSessionRef {
  const role = row.role === "plan-pm" ? "plan-pm" : "coordinator";
  return {
    storeId: store.storeId,
    epoch: typeof row.epoch === "number" ? row.epoch : store.epoch,
    workflowId,
    role,
    sessionId: String(row.session_id),
    planId: typeof row.plan_id === "string" ? row.plan_id : null,
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
  if (state.plans !== undefined || state.integration_merge_lease !== undefined) {
    throw corrupt(
      `execution_workflows(${workflowId}).state_json carries plans/integration_merge_lease, which are owned by ` +
        `execution_plans/execution_integration_leases`,
    );
  }

  const sessions = db
    .prepare("select role, session_id, plan_id, epoch from execution_sessions where workflow_id = ? and state = 'active'")
    .all(workflowId) as Array<Record<string, unknown>>;
  const leases = db
    .prepare("select plan_id, lease_json from execution_leases where workflow_id = ?")
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
    planTokens[planId] = executionToken("plan", store.storeId, store.epoch, [workflowId, planId], planRevision);
    plans.push({
      workflow: state as unknown as ExecutionPlanView["workflow"],
      plan: planState as unknown as ExecutionPlanView["plan"],
      coordination: hasCoordination
        ? (projectedCoordination as unknown as Omit<RowCoordination, "session">)
        : null,
      session: sessionRow ? sessionRef(store, workflowId, sessionRow) : null,
      executionLease: leaseRow
        ? readExecutionLease(leaseRow.lease_json, `execution_leases(${workflowId},${planId}).lease_json`)
        : null,
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

/** What a transition body may address — the owned handle plus the store identity it read. */
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
      const execution = readExecutionMetaRow(handle.db);
      const identity = readStoreIdentity(handle.db);
      handle.db.exec("begin immediate");
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
 * §3 consistent state read: one read-only transaction over the whole graph,
 * returning the root register with its active lifecycles and the root token the
 * caller passes back as CAS. Refuses `execution.not-active` unless the execution
 * authority is active — a migrated or staged store is never read as empty
 * authority, and this reader mints no store.
 */
export async function readExecutionState(context: StoreContext): Promise<ExecutionRead<ExecutionState>> {
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
      const data = readExecutionGraph(db, store, meta);
      db.exec("commit");
      return {
        data,
        token: executionToken("root", store.storeId, store.epoch, [], meta.revision),
        storeId: store.storeId,
        epoch: store.epoch,
      };
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
  // Filesystem preconditions run before SQLite ownership (§4.1): no async or
  // external work happens inside the write transaction.
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
    // Activation advances the store-wide epoch and the store revision exactly
    // once, the same unit the issue/catalog activation barrier commits.
    tx.db.prepare("update store_meta set authority_epoch = authority_epoch + 1, revision = revision + 1 where id = 1").run();
  });
  return readExecutionState(context);
}
