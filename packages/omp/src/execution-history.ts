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
 * Decoding policy — verified schemas or honest diagnosis, never guesswork:
 *
 * - Only the **two types that have a producer** are decoded, and only under the
 *   producer's own `version: 1` schema, mirrored field for field from
 *   `extensions/phase2-orchestration.ts` (`isPhase2Record`) and
 *   `extensions/model-handoff.ts` (`isHandoffRecord`). A record that violates
 *   that guard — a missing workflow, an unknown kind, an unknown action, a
 *   non-string operation id — produces no advisory view and is diagnosed.
 * - The single exception to generation `1` is the **version-2 `bind`** the active
 *   phase-2 producer writes: `{version: 2, kind: "bind", hostSessionId,
 *   workflowId, executionBinding}`. Its `executionBinding` is admitted by a
 *   **shape-only presence check** (`ExecutionHostHistoryExecutionBinding`) — the
 *   reference is a lookup the record carries, never authority, so no store id,
 *   epoch or session value is ever interpreted, resolved, compared or projected.
 *   Generation `2` is admitted for `kind: "bind"` alone; every other hidden type
 *   and every other phase-2 kind still decodes under `1` and nothing else, and a
 *   version-2 payload of any other shape stays unverified.
 * - The other three names have **no producer anywhere** in this repository's
 *   source or history (their literals are normative upstream only), and no
 *   historical payload generation of any of the five is verifiable. Such a
 *   payload is retained as raw evidence and diagnosed
 *   (`payload-generation-unverified`); this module never guesses a legacy
 *   schema, and therefore never guesses an identity from one.
 * - A payload that is not admissible to the canonical form is still retained
 *   in full (`payload` keeps the native value as read); it simply has no digest
 *   (`payloadHash: null` — a digest is never fabricated) and the export refuses
 *   explicitly instead of silently dropping it.
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
 *   guessed: an entry with no verified identity is never attributed to a session
 *   by adjacency, recency or path, and an unrelated `customType` stays unrelated
 *   rather than being reported as a hidden type.
 * - **Not an IO surface.** No file, no host facade, no global state: the entries
 *   come from the caller's own session ledger and the export is returned as a
 *   string. The caller (H2) owns writing any evidence file.
 *
 * Raw evidence and decoded view are separate fields on purpose (`payload` /
 * `payloadHash` vs `view`), so a consumer that replays ledger semantics reads
 * the advisory view while a consumer that reports coverage reads the preserved
 * bytes' digest. An identity field the view does not name — a legacy launch
 * reservation's own launch id, for instance — is never dropped: it survives
 * verbatim inside `payload`. The serialized export is canonical evidence; it is
 * never an `ExecutionBinding` and carries no credential.
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

/** The legacy payload schema generation, verified for every producer shape. */
const VERIFIED_GENERATION = 1;

/**
 * The one generation admitted beyond the legacy shape. The active phase-2
 * producer writes `{version: 2, kind: "bind", …, executionBinding}`, so
 * generation `2` is verified **for `kind: "bind"` only** — no other kind or
 * hidden type is admitted at generation 2 by this constant's existence.
 */
const VERIFIED_BIND_GENERATION = 2;

/**
 * Closed mirror of the phase-2 restore guard's own sets
 * (`extensions/phase2-orchestration.ts`): decision kinds, checkpoint reasons
 * and checkpoint decisions.
 */
const PHASE2_KINDS = ["bind", "checkpoint", "reminder", "user-turn"] as const;
const CHECKPOINT_REASONS = [
  "before-wait",
  "result-settled",
  "dependency-changed",
  "ownership-changed",
  "capacity-changed",
] as const;
const CHECKPOINT_DECISIONS = ["dispatched", "wait", "blocked"] as const;

/**
 * Closed mirror of the model-handoff restore guard's own sets
 * (`extensions/model-handoff.ts`): the two non-terminal states (`pending`,
 * `attempting`) plus the four terminal ones (`handed_off`, `cancelled`,
 * `failed`, `uncertain`), and the two actions. `cancelled` is what makes a
 * handoff one-shot: the record itself says the switch must not fire again.
 */
const HANDOFF_STATES = ["pending", "attempting", "handed_off", "cancelled", "failed", "uncertain"] as const;
const HANDOFF_ACTIONS = ["arm", "handoff"] as const;

/** Payload fields that name an old session path — retained as provenance only, never authority. */
const PROVENANCE_PATH_FIELDS = ["coordinatorSessionPath"] as const;

/* ------------------------------------------------------------------------- *
 * Retained history shape
 * ------------------------------------------------------------------------- */

/** One provenance citation: the payload field that named a path, and the path as recorded. */
export type ExecutionHostHistoryProvenance = Readonly<{ field: string; path: string }>;

/**
 * The adopted-session reference a verified v2 `bind` declares, admitted by shape
 * alone. It is the record's own declaration — a lookup, never authority: the
 * mirror never interprets, resolves, compares or projects any store, epoch or
 * session value, and an epoch mismatch invalidates the reference the record
 * carries, never the user's selection.
 *
 * The view names these fields and no others: no credential, no token, no path
 * and no session-file reference is derived from, or added alongside, them.
 */
export type ExecutionHostHistoryExecutionBinding = Readonly<{
  harnessRoot: string;
  storeId: string;
  epoch: number;
  sessionId: string;
  role: string;
  planId: string | null;
}>;

/**
 * The schema generations this mirror decodes: the legacy shape everywhere, plus
 * the active producer's version-2 `bind`.
 */
export type ExecutionHostHistoryGeneration = typeof VERIFIED_GENERATION | typeof VERIFIED_BIND_GENERATION;

/**
 * The decoded advisory view of one **verified** hidden entry. Everything here is
 * derived from the payload's own declared fields — never from ledger position,
 * timestamps or another entry — and it is advisory evidence, not authority.
 */
export type ExecutionHostHistoryView = Readonly<{
  /** The verified schema generation this view was decoded under. */
  generation: ExecutionHostHistoryGeneration;
  /** The payload's declared `kind` field, verbatim (phase-2 decision records). */
  declaredKind: string | null;
  /** The payload's declared `action` field, verbatim (the handoff `arm` / `handoff`). */
  declaredAction: string | null;
  /** The payload's declared `state` field, verbatim; for `mstar:model-handoff` this is the one-shot handoff state. */
  declaredState: string | null;
  workflowId: string;
  /** Accepted checkpoint identity (`observationKey`), the restore parser's dedup and latch key. */
  checkpointId: string | null;
  /** Declared operation identity (`operationId`), e.g. a handoff attempt id. */
  operationId: string | null;
  /** The payload's own dedup identity: `operationId` when declared, otherwise `checkpointId`. */
  dedupKey: string | null;
  /** True when the payload records its own cancellation (`state: "cancelled"` or a boolean `cancelled`). */
  cancelled: boolean;
  /** Old session paths, as provenance only. */
  provenance: readonly ExecutionHostHistoryProvenance[];
  /**
   * The adopted-session reference a **verified v2 `bind`** declares, by shape
   * only; `null` for every other verified record (including the v1 `bind`, whose
   * envelope carries no such reference). It is the one nullable field the v2
   * generation adds to the view.
   */
  executionBinding: ExecutionHostHistoryExecutionBinding | null;
}>;

/**
 * One recognized hidden ledger entry, in native recorded order.
 *
 * `index` is the entry's zero-based position in the scanned ledger, so the
 * records array preserves native order without re-sorting or renumbering.
 * `payload` is the native payload exactly as read — always, even when it is not
 * admissible to the canonical form. `view` is the advisory decode and is `null`
 * whenever the entry produced a diagnostic; `sessionId` is published only for a
 * decoded record. A diagnosed entry therefore publishes no derived fact at all,
 * while its declared fields stay visible verbatim in `payload`.
 */
export type ExecutionHostHistoryRecord = Readonly<{
  index: number;
  entryId: string | null;
  type: ExecutionHostHistoryType;
  /** The declared session identity of a decoded record; `null` when the entry was retained but not decoded. */
  sessionId: string | null;
  /** Lowercase sha256 hex over the canonical form of `payload`, or `null` when the payload is not admissible. Never fabricated. */
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
  | "payload-generation-unverified"
  | "payload-record-invalid"
  | "payload-kind-invalid"
  | "payload-state-invalid"
  | "payload-action-invalid";

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

/**
 * Raised when a history cannot be exported canonically — at least one retained
 * payload is not admissible to the canonical form. The export refuses instead
 * of dropping or rewriting that evidence, and no digest is fabricated for it.
 */
export class ExecutionHostHistoryExportRefusal extends Error {
  /** Entry ids (or `#index` for an entry with no id) of the reader-marked inadmissible records. */
  readonly entryIds: readonly string[];

  constructor(entryIds: readonly string[], detail: string) {
    const named = entryIds.length === 0 ? "no reader-marked record" : entryIds.join(", ");
    super(
      `the host history cannot be exported canonically: ${entryIds.length} record payload(s) are not admissible (${named}); ` +
        `the raw payloads stay inspectable on the records (${detail})`,
    );
    this.name = "ExecutionHostHistoryExportRefusal";
    this.entryIds = entryIds;
  }
}

/* ------------------------------------------------------------------------- *
 * Decoding
 * ------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function topLevelString(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  return typeof value === "string" && value !== "" ? value : null;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
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

/** Why one record payload was rejected, with the diagnostic code that reports it. */
type RecordRefusal = Readonly<{ refused: true; code: ExecutionHostHistoryDiagnosticCode; message: string }>;

/** One payload that satisfied its producer's guard, with the identity it declares. */
type VerifiedRecord = Readonly<{
  refused: false;
  sessionId: string;
  workflowId: string;
  /** The shape-only reference a verified v2 `bind` declares; `null` for every legacy record. */
  executionBinding: ExecutionHostHistoryExecutionBinding | null;
}>;

/**
 * Shape-only admission of the `executionBinding` a v2 `bind` declares: an object
 * with `version: 1`, a non-empty `harnessRoot`, and a `session` object whose
 * `storeId` / `sessionId` / `workflowId` are non-empty strings, whose `role` is
 * `coordinator | plan-pm`, whose `planId` is `null | string` and whose `epoch` is
 * a positive safe integer. Returns the declared shape, or `null` when any of
 * those is violated.
 *
 * Nothing beyond that shape is examined: no store id, epoch or session value is
 * interpreted, resolved, compared or projected — a well-formed reference that
 * names another store, another session or a stale epoch is accepted here and
 * stays a lookup the record carries.
 */
function readExecutionBindingShape(value: unknown): ExecutionHostHistoryExecutionBinding | null {
  if (!isPlainObject(value) || value.version !== VERIFIED_GENERATION || !isNonEmptyString(value.harnessRoot)) return null;
  const session = value.session;
  if (!isPlainObject(session)) return null;
  if (!isNonEmptyString(session.storeId) || !isNonEmptyString(session.sessionId) || !isNonEmptyString(session.workflowId)) {
    return null;
  }
  if (session.role !== "coordinator" && session.role !== "plan-pm") return null;
  if (session.planId !== null && typeof session.planId !== "string") return null;
  if (typeof session.epoch !== "number" || !Number.isSafeInteger(session.epoch) || session.epoch <= 0) return null;
  return {
    harnessRoot: value.harnessRoot,
    storeId: session.storeId,
    epoch: session.epoch,
    sessionId: session.sessionId,
    role: session.role,
    planId: session.planId,
  };
}

/**
 * Mirror of the phase-2 restore guard (`isPhase2Record`): the required
 * session/workflow fields and the kind-specific ones. `version` branches inside
 * `kind: "bind"` — the active producer's v2 bind is admitted by shape, and every
 * legacy version keeps the original generation-1 guard byte for byte.
 */
function checkPhase2Record(payload: Record<string, unknown>): RecordRefusal | VerifiedRecord {
  const hostSessionId = payload.hostSessionId;
  const workflowId = payload.workflowId;
  if (!isNonEmptyString(hostSessionId) || !isNonEmptyString(workflowId)) {
    return {
      refused: true,
      code: "payload-record-invalid",
      message: "a mstar:phase2 record requires non-empty hostSessionId and workflowId",
    };
  }
  switch (payload.kind) {
    case "bind": {
      if (payload.version === VERIFIED_BIND_GENERATION) {
        const executionBinding = readExecutionBindingShape(payload.executionBinding);
        if (executionBinding === null) {
          return {
            refused: true,
            code: "payload-record-invalid",
            message:
              "a mstar:phase2 version 2 bind record requires an executionBinding shape: version 1, a non-empty harnessRoot, and a session object with non-empty storeId, sessionId and workflowId, a coordinator|plan-pm role, a null-or-string planId and a positive safe-integer epoch",
          };
        }
        return { refused: false, sessionId: hostSessionId, workflowId, executionBinding };
      }
      if (
        !isNonEmptyString(payload.coordinatorSessionPath) ||
        !isNonEmptyString(payload.coordinatorSessionId) ||
        !isNonEmptyString(payload.harnessRoot)
      ) {
        return {
          refused: true,
          code: "payload-record-invalid",
          message: "a mstar:phase2 bind record requires non-empty coordinatorSessionPath, coordinatorSessionId and harnessRoot",
        };
      }
      return { refused: false, sessionId: hostSessionId, workflowId, executionBinding: null };
    }
    case "checkpoint":
      if (!(CHECKPOINT_REASONS as readonly unknown[]).includes(payload.reason)) {
        return {
          refused: true,
          code: "payload-record-invalid",
          message: `a mstar:phase2 checkpoint record requires a reason of ${CHECKPOINT_REASONS.join("|")}, received ${JSON.stringify(payload.reason)}`,
        };
      }
      if (!(CHECKPOINT_DECISIONS as readonly unknown[]).includes(payload.decision)) {
        return {
          refused: true,
          code: "payload-record-invalid",
          message: `a mstar:phase2 checkpoint record requires a decision of ${CHECKPOINT_DECISIONS.join("|")}, received ${JSON.stringify(payload.decision)}`,
        };
      }
      if (typeof payload.note !== "string") {
        return {
          refused: true,
          code: "payload-record-invalid",
          message: `a mstar:phase2 checkpoint record requires a string note, received ${describeValue(payload.note)}`,
        };
      }
      if (payload.observationKey !== null && !isNonEmptyString(payload.observationKey)) {
        return {
          refused: true,
          code: "payload-record-invalid",
          message: `a mstar:phase2 checkpoint record requires observationKey to be null or a non-empty string, received ${describeValue(payload.observationKey)}`,
        };
      }
      return { refused: false, sessionId: hostSessionId, workflowId, executionBinding: null };
    case "reminder":
      return isNonEmptyString(payload.observationKey)
        ? { refused: false, sessionId: hostSessionId, workflowId, executionBinding: null }
        : {
            refused: true,
            code: "payload-record-invalid",
            message: "a mstar:phase2 reminder record requires a non-empty observationKey",
          };
    case "user-turn":
      return { refused: false, sessionId: hostSessionId, workflowId, executionBinding: null };
    default:
      return {
        refused: true,
        code: "payload-kind-invalid",
        message: `a mstar:phase2 record requires a kind of ${PHASE2_KINDS.join("|")}, received ${JSON.stringify(payload.kind)}`,
      };
  }
}

/** Mirror of the model-handoff restore guard (`isHandoffRecord`): `version` is checked by the caller. */
function checkHandoffRecord(payload: Record<string, unknown>): RecordRefusal | VerifiedRecord {
  const binding = payload.binding;
  if (!isPlainObject(binding) || !isNonEmptyString(binding.sessionId) || typeof binding.workflowId !== "string") {
    return {
      refused: true,
      code: "payload-record-invalid",
      message: "a mstar:model-handoff record requires an object binding with a non-empty sessionId and a string workflowId",
    };
  }
  if (!(HANDOFF_STATES as readonly unknown[]).includes(payload.state)) {
    return {
      refused: true,
      code: "payload-state-invalid",
      message: `a mstar:model-handoff record requires a state of ${HANDOFF_STATES.join("|")}, received ${JSON.stringify(payload.state)}`,
    };
  }
  if (!(HANDOFF_ACTIONS as readonly unknown[]).includes(payload.action)) {
    return {
      refused: true,
      code: "payload-action-invalid",
      message: `a mstar:model-handoff record requires an action of ${HANDOFF_ACTIONS.join("|")}, received ${JSON.stringify(payload.action)}`,
    };
  }
  if (typeof payload.operationId !== "string") {
    return {
      refused: true,
      code: "payload-record-invalid",
      message: `a mstar:model-handoff record requires a string operationId, received ${describeValue(payload.operationId)}`,
    };
  }
  for (const field of ["baselineModelChangeId", "observedModel", "reason"] as const) {
    const value = payload[field];
    if (value !== null && typeof value !== "string") {
      return {
        refused: true,
        code: "payload-record-invalid",
        message: `a mstar:model-handoff record requires ${field} to be null or a string, received ${describeValue(value)}`,
      };
    }
  }
  return { refused: false, sessionId: binding.sessionId, workflowId: binding.workflowId, executionBinding: null };
}

/**
 * The advisory view of one verified record. `check` carries the guard's own
 * findings, so the view reports the binding shape and the generation the
 * verified record actually declared instead of re-deriving either.
 */
function buildView(payload: Record<string, unknown>, check: VerifiedRecord): ExecutionHostHistoryView {
  const checkpointId = topLevelString(payload, "observationKey");
  const operationId = topLevelString(payload, "operationId");
  const declaredState = topLevelString(payload, "state");
  const provenance: ExecutionHostHistoryProvenance[] = [];
  // Only a legacy record names an envelope path; a v2 bind carries none, so its
  // view has no provenance at all.
  if (check.executionBinding === null) {
    for (const field of PROVENANCE_PATH_FIELDS) {
      const path = topLevelString(payload, field);
      if (path !== null) provenance.push({ field, path });
    }
  }
  return {
    // The verified v2 bind is the only record carrying a binding shape, and it is
    // the only one whose view reports generation 2.
    generation: check.executionBinding === null ? VERIFIED_GENERATION : VERIFIED_BIND_GENERATION,
    declaredKind: topLevelString(payload, "kind"),
    declaredAction: topLevelString(payload, "action"),
    declaredState,
    workflowId: check.workflowId,
    checkpointId,
    operationId,
    dedupKey: operationId ?? checkpointId,
    cancelled: declaredState === "cancelled" || payload.cancelled === true,
    provenance,
    executionBinding: check.executionBinding,
  };
}

/** One decoded record: its declared identity plus the advisory view. */
type DecodedRecord = Readonly<{ sessionId: string; view: ExecutionHostHistoryView }>;

function decodeVerifiedRecord(
  type: ExecutionHostHistoryType,
  payload: Record<string, unknown>,
  note: Note,
): DecodedRecord | null {
  if (type !== "mstar:phase2" && type !== "mstar:model-handoff") {
    note(
      "payload-generation-unverified",
      `no producer or historical schema exists for ${type} in this repository, so its payload is retained as raw evidence only; a legacy schema is never guessed`,
    );
    return null;
  }
  // Generation 2 is admitted for the v2 phase-2 bind alone; every other record
  // keeps refusing any generation but its own verified one.
  const v2Bind = type === "mstar:phase2" && payload.kind === "bind" && payload.version === VERIFIED_BIND_GENERATION;
  if (payload.version !== VERIFIED_GENERATION && !v2Bind) {
    note(
      "payload-generation-unverified",
      `the payload declares version ${JSON.stringify(payload.version)}, and the verified schema for ${type} is version ${VERIFIED_GENERATION}; the payload is retained as raw evidence only`,
    );
    return null;
  }
  const check = type === "mstar:phase2" ? checkPhase2Record(payload) : checkHandoffRecord(payload);
  if (check.refused) {
    note(check.code, check.message);
    return null;
  }
  return { sessionId: check.sessionId, view: buildView(payload, check) };
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

  const payloadIsRecord = isPlainObject(payload);
  if (admission.hash !== null && !payloadIsRecord) {
    note("payload-not-object", `the payload is ${describeValue(payload)}, not a record object`);
  }
  // A diagnosed entry publishes no derived fact at all — no identity, no view.
  // The payload itself stays retained verbatim, so the evidence is never lost.
  const decoded = admission.hash !== null && payloadIsRecord ? decodeVerifiedRecord(type, payload, note) : null;
  const published = decoded !== null && notes.length === 0 ? decoded : null;

  for (const pending of notes) {
    diagnostics.push({ index, type, entryId, code: pending.code, message: pending.message });
  }

  return {
    index,
    entryId,
    type,
    sessionId: published === null ? null : published.sessionId,
    payloadHash: admission.hash,
    payload,
    view: published === null ? null : published.view,
  };
}

/* ------------------------------------------------------------------------- *
 * Public surface
 * ------------------------------------------------------------------------- */

/**
 * Read the hidden history out of one session ledger.
 *
 * Entries are classified by the exact `customType` literal, and only the five
 * frozen hidden types are reported; every payload is preserved in full and
 * every recognized entry keeps its native position. A record is decoded only
 * when its producer's own schema guard accepts it — `version: 1` for everything,
 * plus the v2 `bind` the active phase-2 producer writes — and its payload is
 * admissible to the canonical form; every other recognized entry is retained
 * as raw evidence and diagnosed. Nothing is renamed, rewritten, promoted or
 * inferred — an undecoded entry publishes no session identity.
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
 * evidence, not authority: the only binding-shaped value it can carry is the
 * declared `executionBinding` shape of a verified v2 `bind` (an id-only lookup,
 * never resolved here), and it holds no credential and no session reference of
 * its own — reading it back never binds a session.
 *
 * A history that holds a payload the canonical form cannot admit is **refused**
 * (`ExecutionHostHistoryExportRefusal`) rather than exported with that evidence
 * dropped or rewritten — the raw payload stays inspectable on its record.
 */
export function exportExecutionHostHistory(history: ExecutionHostHistory): string {
  try {
    return serializeExecutionValue(history);
  } catch (error) {
    const entryIds = history.records
      .filter((record) => record.payloadHash === null)
      .map((record) => record.entryId ?? `#${record.index}`);
    throw new ExecutionHostHistoryExportRefusal(entryIds, error instanceof Error ? error.message : String(error));
  }
}
