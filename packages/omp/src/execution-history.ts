/**
 * Execution host history — the pure reader/exporter for the five OMP hidden
 * `appendEntry` ledgers.
 *
 * Primary spec: `mstar-host/references/omp.md` § Phase-2 native delivery and
 * § coordinator model handoff; architecture contract §6 (host-ledger adoption)
 * and §4.2's "host hidden result" row, which requires the native host exporter
 * to supply ordered entry ID/type/payload digests in a bounded evidence file.
 *
 * The hidden `customType` inventory is closed and frozen:
 * `mstar:phase2`, `mstar:phase2-continuation`, `mstar:phase2-checkpoint`,
 * `mstar:phase2-launch-reservation` and `mstar:model-handoff`. This module
 * recognizes exactly those literals. It never renames one, never adds one,
 * never substitutes a different name for one, and never rewrites the native
 * ledger: `readExecutionHostHistory` returns the recognized entries in recorded
 * order with every payload preserved verbatim, and
 * `exportExecutionHostHistory` serializes that history as canonical evidence.
 *
 * What this module deliberately is **not**:
 *
 * - **Not an authority.** It produces no session reference, no `ExecutionBinding`
 *   and no writer seat, and it takes no session argument — so no caller can ask
 *   it for "the current session", and it cannot promote the newest record into
 *   one. A stale or foreign `coordinatorSessionPath` is retained as provenance
 *   (where the record came from), never resolved into a binding: an old record
 *   is readable history only.
 * - **Not a repair path.** A recognized hidden entry this module cannot decode is
 *   diagnosed (`diagnostics`) and its payload is left exactly as read. Nothing is
 *   guessed: an entry with no declared session identity is never attributed to a
 *   session by adjacency, recency or path, and an unrelated `customType` stays
 *   unrelated rather than being reported as a hidden type.
 * - **Not an IO surface.** No file, no host facade, no global state: the entries
 *   come from the caller's own session ledger and the export is returned as a
 *   string. The caller (H2) owns writing any evidence file.
 *
 * Raw evidence and decoded view are separate fields on purpose (`payload` /
 * `payloadHash` vs `view`), so a consumer that replays ledger semantics reads
 * the advisory view while a consumer that reports coverage reads the preserved
 * bytes' digest. An identity field the view does not name — a legacy launch
 * reservation's own launch id, for instance — is never dropped: it survives
 * verbatim inside `payload` and inside `payloadHash`, and the export keeps it
 * byte-for-byte. The serialized export is canonical evidence; it is never an
 * `ExecutionBinding` and carries no credential.
 */
import { createHash } from "node:crypto";
import { serializeExecutionValue } from "@mstar-harness/engine";

/* ------------------------------------------------------------------------- *
 * The frozen hidden-type inventory
 * ------------------------------------------------------------------------- */

/**
 * The five hidden ledger `customType` literals, in contract order. Exported so
 * no consumer duplicates the literals and none of them can drift by a typo.
 */
export const EXECUTION_HOST_HISTORY_TYPES = [
  "mstar:phase2",
  "mstar:phase2-continuation",
  "mstar:phase2-checkpoint",
  "mstar:phase2-launch-reservation",
  "mstar:model-handoff",
] as const;

export type ExecutionHostHistoryType = (typeof EXECUTION_HOST_HISTORY_TYPES)[number];

/**
 * The closed `mstar:phase2` decision kinds — the restore parser's own set, so a
 * recognized phase-2 entry that declares an unknown kind is diagnosed instead of
 * being read as some other record.
 */
const PHASE2_KINDS = ["bind", "checkpoint", "reminder", "user-turn"] as const;

/**
 * The closed model-handoff states: the two non-terminal ones (`pending`,
 * `attempting`) plus the four terminal ones (`handed_off`, `cancelled`,
 * `failed`, `uncertain`). `cancelled` is what makes a handoff one-shot: the
 * record itself says the switch must not fire again.
 */
const HANDOFF_STATES = ["pending", "attempting", "handed_off", "cancelled", "failed", "uncertain"] as const;

/** Payload fields that name an old session path — retained as provenance only, never authority. */
const PROVENANCE_PATH_FIELDS = ["coordinatorSessionPath"] as const;

/* ------------------------------------------------------------------------- *
 * Retained history shape
 * ------------------------------------------------------------------------- */

/** One provenance citation: the payload field that named a path, and the path as recorded. */
export type ExecutionHostHistoryProvenance = Readonly<{ field: string; path: string }>;

/**
 * The decoded advisory view of one recognized hidden entry. Everything here is
 * derived from the payload's own declared fields — never from ledger position,
 * timestamps or another entry — and it is advisory evidence, not authority.
 */
export type ExecutionHostHistoryView = Readonly<{
  /**
   * The payload's own schema generation: its `version` when it is a positive
   * safe integer, or `0` for a legacy unversioned payload. A payload carrying
   * any other generation counter keeps it verbatim in `payload`.
   */
  generation: number;
  /** The payload's declared `kind` field, verbatim. */
  declaredKind: string | null;
  /** The payload's declared `action` field, verbatim (e.g. the handoff `arm` / `handoff`). */
  declaredAction: string | null;
  /** The payload's declared `state` field, verbatim; for `mstar:model-handoff` this is the one-shot handoff state. */
  declaredState: string | null;
  workflowId: string | null;
  /** Accepted checkpoint identity (`observationKey`), the restore parser's dedup and latch key. */
  checkpointId: string | null;
  /** Declared operation identity (`operationId`), e.g. a launch reservation or handoff attempt id. */
  operationId: string | null;
  /** The payload's own dedup identity: `operationId` when declared, otherwise `checkpointId`. */
  dedupKey: string | null;
  /** True when the payload records its own cancellation (`state: "cancelled"` or a boolean `cancelled`). */
  cancelled: boolean;
  /** Old session paths, as provenance only. */
  provenance: readonly ExecutionHostHistoryProvenance[];
}>;

/**
 * One recognized hidden ledger entry, in native recorded order.
 *
 * `index` is the entry's zero-based position in the scanned ledger, so the
 * records array preserves native order without re-sorting or renumbering.
 * `payload` is the native payload exactly as read (or `null` when it was not
 * admissible to the canonical form — see `payload-unsupported`); `view` is the
 * advisory decode and is `null` whenever the entry produced a diagnostic.
 */
export type ExecutionHostHistoryRecord = Readonly<{
  index: number;
  entryId: string | null;
  type: ExecutionHostHistoryType;
  /** The session identity the payload declares for itself, or `null` when it declares none. Never inferred. */
  sessionId: string | null;
  /** Lowercase sha256 hex over the canonical form of `payload`, or `null` when the payload was not admissible. */
  payloadHash: string | null;
  payload: unknown;
  view: ExecutionHostHistoryView | null;
}>;

/** Every way a recognized hidden entry can fail to decode. */
export type ExecutionHostHistoryDiagnosticCode =
  | "entry-shape"
  | "entry-id-missing"
  | "payload-not-object"
  | "payload-unsupported"
  | "payload-version-invalid"
  | "payload-kind-invalid"
  | "payload-state-invalid"
  | "session-identity-missing";

export type ExecutionHostHistoryDiagnostic = Readonly<{
  index: number;
  type: ExecutionHostHistoryType;
  entryId: string | null;
  code: ExecutionHostHistoryDiagnosticCode;
  message: string;
}>;

/**
 * One retained host history: recognized records in native order plus the
 * diagnostics for recognized entries that could not be decoded. Unrelated
 * entries (any other `customType`, and non-custom entries) appear in neither
 * list — they are not this history's business.
 */
export type ExecutionHostHistory = Readonly<{
  version: 1;
  /** Artifact kind marker: canonical evidence, never an `ExecutionBinding`. */
  document: "execution-host-history";
  records: readonly ExecutionHostHistoryRecord[];
  diagnostics: readonly ExecutionHostHistoryDiagnostic[];
}>;

/* ------------------------------------------------------------------------- *
 * Decoding
 * ------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function topLevelString(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  return typeof value === "string" && value !== "" ? value : null;
}

function nestedString(payload: Record<string, unknown>, parent: string, field: string): string | null {
  const owner = payload[parent];
  return isPlainObject(owner) ? topLevelString(owner, field) : null;
}

/**
 * The session identity a payload declares for itself. The current generations
 * name it `hostSessionId` (`mstar:phase2`) or `binding.sessionId`
 * (`mstar:model-handoff`); the legacy field name is read last. A payload that
 * declares none stays unattributed — this reader never derives a session from
 * the ledger's order, its neighbours or a recorded path.
 */
function declaredSessionId(payload: Record<string, unknown>): string | null {
  return (
    topLevelString(payload, "hostSessionId") ??
    nestedString(payload, "binding", "sessionId") ??
    topLevelString(payload, "sessionId")
  );
}

function declaredWorkflowId(payload: Record<string, unknown>): string | null {
  return topLevelString(payload, "workflowId") ?? nestedString(payload, "binding", "workflowId");
}

/** `0` for a legacy unversioned payload, the payload's `version` when it is a positive safe integer, else `null`. */
function declaredGeneration(payload: Record<string, unknown>): number | null {
  const value = payload.version;
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** Admission of one payload to the canonical form: its digest, or the canonical refusal that rejected it. */
type PayloadAdmission = Readonly<{ hash: string | null; refusal: string | null }>;

function admitPayload(payload: unknown): PayloadAdmission {
  try {
    const bytes = serializeExecutionValue(payload);
    return { hash: createHash("sha256").update(bytes, "utf8").digest("hex"), refusal: null };
  } catch (error) {
    return { hash: null, refusal: error instanceof Error ? error.message : String(error) };
  }
}

type Note = (code: ExecutionHostHistoryDiagnosticCode, message: string) => void;

/** The identity and advisory view decoded from one record payload. */
type DecodedPayload = Readonly<{ sessionId: string | null; view: ExecutionHostHistoryView }>;

function decodePayload(
  type: ExecutionHostHistoryType,
  payload: Record<string, unknown>,
  note: Note,
): DecodedPayload {
  const sessionId = declaredSessionId(payload);
  if (sessionId === null) {
    note(
      "session-identity-missing",
      "the payload declares no session identity (hostSessionId, binding.sessionId or the legacy sessionId field), so this entry is never attributed to a session by inference",
    );
  }

  const generation = declaredGeneration(payload);
  if (generation === null) {
    note(
      "payload-version-invalid",
      `the declared version ${JSON.stringify(payload.version)} is not a positive safe integer`,
    );
  }

  const declaredKind = topLevelString(payload, "kind");
  if (type === "mstar:phase2" && (declaredKind === null || !(PHASE2_KINDS as readonly string[]).includes(declaredKind))) {
    note(
      "payload-kind-invalid",
      `a ${type} payload must declare one of ${PHASE2_KINDS.join("|")}, received ${JSON.stringify(payload.kind)}`,
    );
  }

  const declaredState = topLevelString(payload, "state");
  if (type === "mstar:model-handoff" && (declaredState === null || !(HANDOFF_STATES as readonly string[]).includes(declaredState))) {
    note(
      "payload-state-invalid",
      `a ${type} payload must declare one of ${HANDOFF_STATES.join("|")}, received ${JSON.stringify(payload.state)}`,
    );
  }

  const checkpointId = topLevelString(payload, "observationKey");
  const operationId = topLevelString(payload, "operationId");
  const provenance: ExecutionHostHistoryProvenance[] = [];
  for (const field of PROVENANCE_PATH_FIELDS) {
    const path = topLevelString(payload, field);
    if (path !== null) provenance.push({ field, path });
  }

  return {
    sessionId,
    view: {
      generation: generation ?? 0,
      declaredKind,
      declaredAction: topLevelString(payload, "action"),
      declaredState,
      workflowId: declaredWorkflowId(payload),
      checkpointId,
      operationId,
      dedupKey: operationId ?? checkpointId,
      cancelled: declaredState === "cancelled" || payload.cancelled === true,
      provenance,
    },
  };
}

function decodeEntry(
  index: number,
  type: ExecutionHostHistoryType,
  entry: Record<string, unknown>,
  diagnostics: ExecutionHostHistoryDiagnostic[],
): ExecutionHostHistoryRecord {
  const notes: Array<Readonly<{ code: ExecutionHostHistoryDiagnosticCode; message: string }>> = [];
  const note: Note = (code, message) => {
    notes.push({ code, message });
  };

  const rawId: unknown = entry.id;
  const entryId = typeof rawId === "string" && rawId !== "" ? rawId : null;
  if (entry.type !== "custom") {
    note("entry-shape", `the entry carries the hidden type ${type} but is not a custom ledger entry`);
  }
  if (entryId === null) {
    note("entry-id-missing", "the entry declares no non-empty string id, so its native identity cannot be preserved");
  }

  const payload = entry.data;
  const admission = admitPayload(payload);
  if (admission.hash === null) {
    note("payload-unsupported", `the payload was not admitted to the canonical form: ${admission.refusal ?? "unknown cause"}`);
  }

  // A payload that was not admitted retains nothing derived from it: no
  // identity, no view. An identity without its evidence would be a guess.
  const payloadIsRecord = isPlainObject(payload);
  const admitted = admission.hash !== null;
  const decoded = admitted && payloadIsRecord ? decodePayload(type, payload, note) : null;
  if (admitted && !payloadIsRecord) {
    note("payload-not-object", `the payload is ${describeValue(payload)}, not a record object`);
  }

  for (const pending of notes) {
    diagnostics.push({ index, type, entryId, code: pending.code, message: pending.message });
  }
  const malformed = notes.length > 0;

  return {
    index,
    entryId,
    type,
    sessionId: decoded === null ? null : decoded.sessionId,
    payloadHash: admission.hash,
    payload: admitted ? payload : null,
    view: malformed || decoded === null ? null : decoded.view,
  };
}

/* ------------------------------------------------------------------------- *
 * Public surface
 * ------------------------------------------------------------------------- */

/**
 * Read the hidden history out of one session ledger.
 *
 * Entries are classified by the exact `customType` literal, and only the five
 * frozen hidden types are reported; every payload is preserved verbatim and
 * every recognized entry keeps its native position. Legacy and current payload
 * generations are both decoded — an unversioned payload is generation `0`, a
 * `version: 1` payload is generation `1` — and nothing is renamed, rewritten or
 * promoted. Entries that cannot be decoded are retained and diagnosed; they are
 * never guessed into a session, a binding or another type.
 */
export function readExecutionHostHistory(entries: readonly unknown[]): ExecutionHostHistory {
  const records: ExecutionHostHistoryRecord[] = [];
  const diagnostics: ExecutionHostHistoryDiagnostic[] = [];

  for (const [index, entry] of entries.entries()) {
    if (!isPlainObject(entry)) continue;
    const customType = entry.customType;
    if (!(EXECUTION_HOST_HISTORY_TYPES as readonly unknown[]).includes(customType)) continue;
    records.push(decodeEntry(index, customType as ExecutionHostHistoryType, entry, diagnostics));
  }

  return { version: 1, document: "execution-host-history", records, diagnostics };
}

/**
 * Serialize one read history as canonical evidence (the engine's §3.1 form:
 * sorted keys, no whitespace, one terminal LF).
 *
 * The exported document is byte-stable for equal histories and preserves order,
 * entry ids, payload digests and payloads exactly, so a consumer can replay it
 * without the native ledger and compare two exports byte-for-byte. It is
 * evidence, not authority: it contains no `ExecutionBinding`, no session
 * reference and no credential, and reading it back never binds a session.
 *
 * Total for any history returned by `readExecutionHostHistory`; a hand-built
 * history must itself be admissible to the canonical form.
 */
export function exportExecutionHostHistory(history: ExecutionHostHistory): string {
  return serializeExecutionValue(history);
}
