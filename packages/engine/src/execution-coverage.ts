/**
 * execution-coverage.ts — the pure coverage substrate of the execution
 * authority (architecture contract §4.1/§4.2): the closed 18-surface
 * inventory, the per-surface byte codecs, canonical receipt hashing and the
 * exact-set/witness validation of a coverage set against a frozen manifest.
 *
 * The module is deliberately pure: it opens no file, loads no driver and
 * imports no host package. Evidence bytes are handed in, and every fact this
 * module reports is DECODED FROM THOSE BYTES. A receipt never asserts its own
 * result: `resultHash` covers the surface identity, the disposition and the
 * normalized result this module recomputed, so a producer that invents facts —
 * or reuses a self-consistent hash over a fabricated document — is refused.
 *
 * Byte formats this module really decodes, and the only ones it accepts:
 *
 * - `core-v1`: the v2 root register (`{version:2, workflows:[{id,…}]}`) and the
 *   workflow snapshots (`{schema_version:1, id,…}`) whose `id` is the workflow.
 * - `session-v1`: retained session envelopes, decoded for their `session_id`
 *   (and their `workflowId` when the envelope carries one).
 * - `notes-v1` / `agent-flow-v2`: retained JSONL ledgers, decoded line by line
 *   (exact line order, per-line digest; a record's own `workflowId`/`eventId`
 *   are validated when present).
 * - `selection-v1` / `omp-launch-v2`: retained JSON documents, decoded member
 *   by member (member digest) with a `workflowId` member bound to the row.
 * - `omp-hidden-v1`: the canonical host-history export H1 owns
 *   (`{version:1, document:"execution-host-history", records, diagnostics}`),
 *   including native order, per-record `payloadHash` recomputed from the
 *   published payload, and the record's decoded workflow.
 * - `retained-body-v1`: retained SDD evidence bodies, summarized by digest and
 *   byte length.
 * - `consumer-v1` / `recovery-v1`: a canonical producer manifest / recovery
 *   inventory (the row's evidence document) whose recorded digests must equal
 *   the hashed source bytes it describes.
 *
 * Everything else fails closed: an unknown document shape, an unknown record
 * field, a diagnostic-bearing host export or a missing byte is a refusal, never
 * a silent re-interpretation.
 *
 * `ExecutionCoverageManifest` is this module's small manifest view, not the
 * migration module's `ExecutionManifest` (§4.1). The root task compiles without
 * a type cycle, and C3 builds this view from the version-2 manifest it hashed.
 * C3 owns every piece of IO around this module — safe reads, symlink and
 * canonical-root checks, fresh bytes — plus the public barrel export.
 *
 * Receipt identity is `(surface, workflowId)`. Workflow-scoped surfaces repeat
 * for every discovered workflow, so one global receipt can never hide a sibling
 * workflow; root-scoped surfaces carry a null `workflowId` and are refused if
 * they claim one. The manifest is a CLOSED inventory too: every root-scoped
 * surface once, every workflow-scoped surface once per discovered workflow, so a
 * surface with nothing discovered is an `absent` row rather than an omission.
 */
import { createHash } from "node:crypto";
import { isNonEmptyString, isPlainObject } from "./coordination-write.js";
import { ExecutionError, serializeExecutionValue } from "./execution-store.js";

// ---------------------------------------------------------------------------
// The closed inventory (§4.1)
// ---------------------------------------------------------------------------

/** The closed 18-surface inventory, in canonical order. */
export const EXECUTION_COVERAGE_SURFACES = [
  "core-execution",
  "workflow-session-envelopes",
  "workflow-notes-ledger",
  "workflow-agent-flow-ledger",
  "workflow-ledger-cursors",
  "engine-status-snapshot",
  "workflow-omp-launch-journal",
  "omp-hidden-entries",
  "sdd-evidence",
  "artifact-store-injectors",
  "cli-writer",
  "engine-cli-package",
  "dsh-package",
  "omp-package",
  "opencode-plugin",
  "zcode-hook",
  "copied-instructions",
  "backup-recovery",
] as const;

export type ExecutionSurface = (typeof EXECUTION_COVERAGE_SURFACES)[number];

/** A witness is a root-relative path plus the sha256 of the exact bytes handed in. */
export type CoverageWitness = Readonly<{
  root: "control" | "sdd" | "host" | "package";
  path: string;
  sha256: string;
}>;

export type ExecutionCoverageReceipt = Readonly<{
  version: 1;
  surface: ExecutionSurface;
  workflowId: string | null;
  manifestId: string;
  manifestHash: string;
  storeId: string;
  epoch: number;
  disposition: "absent" | "retain" | "migrate" | "retire";
  protocol:
    | "session-v1"
    | "notes-v1"
    | "agent-flow-v2"
    | "selection-v1"
    | "omp-launch-v2"
    | "omp-hidden-v1"
    | "retained-body-v1"
    | "consumer-v1"
    | "recovery-v1"
    | "core-v1";
  sources: readonly CoverageWitness[];
  evidence: readonly CoverageWitness[];
  resultHash: string;
}>;

export type ExecutionCoverageSet = Readonly<{
  version: 1;
  manifestId: string;
  manifestHash: string;
  receipts: readonly ExecutionCoverageReceipt[];
  digest: string;
}>;

export type ExecutionCoverageManifest = Readonly<{
  manifestId: string;
  manifestHash: string;
  storeId: string;
  epoch: number;
  /**
   * The discovered surface identities. Each row carries the sources C3's
   * canonical discovery assigned to it, so a source witness is bound to exactly
   * one `(surface, workflowId)` — or, where the hashed manifest assigns the same
   * byte to two rows, to those two and no others.
   */
  surfaces: readonly Readonly<{
    surface: ExecutionSurface;
    workflowId: string | null;
    sources: readonly CoverageWitness[];
  }>[];
  sources: readonly CoverageWitness[];
}>;

/** Evidence bytes keyed by `${root}:${path}` — the only proof a validator accepts. */
export type ExecutionCoverageEvidence = ReadonlyMap<string, Uint8Array>;

type Disposition = ExecutionCoverageReceipt["disposition"];
type Protocol = ExecutionCoverageReceipt["protocol"];
type Root = CoverageWitness["root"];
type Capability = "writer" | "read-only" | "decision-only" | "body-only";

/** The workflow-scoped surfaces; every other surface is root-scoped (§4.1). */
const WORKFLOW_SCOPED_SURFACES: readonly ExecutionSurface[] = [
  "workflow-session-envelopes",
  "workflow-notes-ledger",
  "workflow-agent-flow-ledger",
  "workflow-ledger-cursors",
  "workflow-omp-launch-journal",
  "omp-hidden-entries",
  "sdd-evidence",
];

/** The 18 surfaces, each pinned to the one protocol that validates it. */
const SURFACE_PROTOCOLS: Readonly<Record<ExecutionSurface, Protocol>> = {
  "core-execution": "core-v1",
  "workflow-session-envelopes": "session-v1",
  "workflow-notes-ledger": "notes-v1",
  "workflow-agent-flow-ledger": "agent-flow-v2",
  "workflow-ledger-cursors": "selection-v1",
  "engine-status-snapshot": "selection-v1",
  "workflow-omp-launch-journal": "omp-launch-v2",
  "omp-hidden-entries": "omp-hidden-v1",
  "sdd-evidence": "retained-body-v1",
  "artifact-store-injectors": "consumer-v1",
  "cli-writer": "consumer-v1",
  "engine-cli-package": "consumer-v1",
  "dsh-package": "consumer-v1",
  "omp-package": "consumer-v1",
  "opencode-plugin": "consumer-v1",
  "zcode-hook": "consumer-v1",
  "copied-instructions": "consumer-v1",
  "backup-recovery": "recovery-v1",
};

/**
 * The dispositions each surface may declare. The core authority is imported
 * into the database and the session envelopes are associated (or already
 * archived), so those two surfaces never claim `absent`; every retained file,
 * host ledger, package and inventory surface may be `retain` or `absent`.
 */
const SURFACE_DISPOSITIONS: Readonly<Record<ExecutionSurface, readonly Disposition[]>> = {
  "core-execution": ["migrate", "retain"],
  "workflow-session-envelopes": ["migrate", "retire", "absent"],
  "workflow-notes-ledger": ["retain", "absent"],
  "workflow-agent-flow-ledger": ["retain", "absent"],
  "workflow-ledger-cursors": ["retain", "absent"],
  "engine-status-snapshot": ["retain", "absent"],
  "workflow-omp-launch-journal": ["retain", "absent"],
  "omp-hidden-entries": ["retain", "absent"],
  "sdd-evidence": ["retain", "absent"],
  "artifact-store-injectors": ["retain", "absent"],
  "cli-writer": ["retain", "absent"],
  "engine-cli-package": ["retain", "absent"],
  "dsh-package": ["retain", "absent"],
  "omp-package": ["retain", "absent"],
  "opencode-plugin": ["retain", "absent"],
  "zcode-hook": ["retain", "absent"],
  "copied-instructions": ["retain", "absent"],
  "backup-recovery": ["retain", "absent"],
};

/**
 * The authority each consumer surface is REQUIRED to expose (§4.2): a
 * package/instruction row is not coverage when it declares some other
 * capability — the writer rows write, the hook rows only decide, the copied
 * instructions only read, and a deployed store injection is body-only storage.
 */
const SURFACE_CAPABILITY: Readonly<Record<ExecutionSurface, Capability>> = {
  "core-execution": "read-only",
  "workflow-session-envelopes": "read-only",
  "workflow-notes-ledger": "read-only",
  "workflow-agent-flow-ledger": "read-only",
  "workflow-ledger-cursors": "read-only",
  "engine-status-snapshot": "read-only",
  "workflow-omp-launch-journal": "read-only",
  "omp-hidden-entries": "read-only",
  "sdd-evidence": "read-only",
  "artifact-store-injectors": "body-only",
  "cli-writer": "writer",
  "engine-cli-package": "writer",
  "dsh-package": "writer",
  "omp-package": "writer",
  "opencode-plugin": "decision-only",
  "zcode-hook": "decision-only",
  "copied-instructions": "read-only",
  "backup-recovery": "read-only",
};

const COVERAGE_ROOTS: readonly Root[] = ["control", "sdd", "host", "package"];
const COVERAGE_DISPOSITIONS: readonly Disposition[] = ["absent", "retain", "migrate", "retire"];
const CAPABILITIES: readonly Capability[] = ["writer", "read-only", "decision-only", "body-only"];
const RUNTIME_TARGETS = ["node", "bun"] as const;
const HOST_HISTORY_KINDS = [
  "mstar:phase2",
  "mstar:phase2-continuation",
  "mstar:phase2-checkpoint",
  "mstar:phase2-launch-reservation",
  "mstar:model-handoff",
] as const;
const HOST_HISTORY_STATES = ["pending", "attempting", "handed_off", "cancelled", "failed", "uncertain"] as const;

/** The scope of one surface: a root-scoped row is inventoried once, never per workflow. */
export function executionCoverageSurfaceScope(surface: ExecutionSurface): "root" | "workflow" {
  return (WORKFLOW_SCOPED_SURFACES as readonly string[]).includes(surface) ? "workflow" : "root";
}

/** The evidence-map key of a witness: one configured root plus its relative path. */
export function coverageWitnessKey(root: Root, path: string): string {
  return `${root}:${path}`;
}

// ---------------------------------------------------------------------------
// Refusals and typed predicates
// ---------------------------------------------------------------------------

/**
 * The single refusal of this module. Coverage that cannot be recomputed is not
 * coverage: §5's `execution.coverage-incomplete` is the same verdict whether a
 * source is missing from the inventory or a receipt disagrees with its bytes.
 */
function refuse(detail: string): never {
  throw new ExecutionError("execution.coverage-incomplete", detail);
}

const HEX64 = /^[0-9a-f]{64}$/;

function expectObject(value: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(value)) refuse(`${what} must be a plain JSON object; free-text or scalar evidence is never accepted.`);
  return value;
}

function expectExactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const expected = new Set(keys);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length === 0 && unknown.length === 0) return;
  refuse(
    `${what} must carry exactly ${keys.join(", ")}` +
      `${missing.length > 0 ? `; it is missing ${missing.join(", ")}` : ""}` +
      `${unknown.length > 0 ? `; it carries unknown field(s) ${unknown.join(", ")}` : ""}. ` +
      `A coverage document is a closed schema, never an open-ended assertion.`,
  );
}

function expectString(value: unknown, what: string): string {
  if (!isNonEmptyString(value)) refuse(`${what} must be a nonblank string.`);
  return value;
}

function expectNullableString(value: unknown, what: string): string | null {
  if (value === null) return null;
  return expectString(value, what);
}

function expectInteger(value: unknown, what: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    refuse(`${what} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function expectHex64(value: unknown, what: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) {
    refuse(`${what} must be a lowercase 64-hex sha256; a digest is never trimmed, coerced or abbreviated.`);
  }
  return value;
}

function expectArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) refuse(`${what} must be an array.`);
  return value;
}

function expectEnum<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  refuse(`${what} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}.`);
}

function expectSurface(value: unknown, what: string): ExecutionSurface {
  if (typeof value === "string" && (EXECUTION_COVERAGE_SURFACES as readonly string[]).includes(value)) {
    return value as ExecutionSurface;
  }
  refuse(
    `${what} must be one of the 18 closed execution surfaces (${EXECUTION_COVERAGE_SURFACES.join(", ")}); ` +
      `got ${JSON.stringify(value)}. An unknown surface is not coverage.`,
  );
}

function expectProtocol(value: unknown, what: string): Protocol {
  const known: readonly string[] = Object.values(SURFACE_PROTOCOLS);
  if (typeof value === "string" && known.includes(value)) return value as Protocol;
  refuse(
    `${what} must be one of the closed validator versions ${[...new Set(known)].join(", ")}; got ${JSON.stringify(value)}. ` +
      `An unknown protocol never validates coverage.`,
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function expectScope(surface: ExecutionSurface, workflowId: string | null, what: string): void {
  const scope = executionCoverageSurfaceScope(surface);
  if (scope === "workflow" && workflowId === null) {
    refuse(`${what} carries ${surface} with a null workflowId; that surface is workflow-scoped and every discovered workflow owns its own row.`);
  }
  if (scope === "root" && workflowId !== null) {
    refuse(`${what} carries the root-scoped surface ${surface} under workflow ${workflowId}; a root-scoped surface is inventoried once, never per workflow.`);
  }
}

/** A root-relative, canonical, traversal-free witness path. */
function expectWitnessPath(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") refuse(`${what} must be the nonblank root-relative path of the witness.`);
  if (value.startsWith("/")) refuse(`${what} (${value}) is absolute; a witness path is relative to its configured root.`);
  if (value.includes("\\")) refuse(`${what} (${value}) contains a backslash; a witness path is a canonical POSIX relative path.`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    refuse(`${what} (${value}) is not canonical or escapes its configured root; a witness never traverses upward or repeats a separator.`);
  }
  return value;
}

function expectWitness(value: unknown, what: string): CoverageWitness {
  const record = expectObject(value, what);
  expectExactKeys(record, ["root", "path", "sha256"], what);
  return {
    root: expectEnum(record.root, COVERAGE_ROOTS, `${what}.root`),
    path: expectWitnessPath(record.path, `${what}.path`),
    sha256: expectHex64(record.sha256, `${what}.sha256`),
  };
}

function compareWitness(left: CoverageWitness, right: CoverageWitness): number {
  return compareText(left.root, right.root) || compareText(left.path, right.path);
}

function expectWitnessList(value: unknown, what: string): readonly CoverageWitness[] {
  const items = expectArray(value, what).map((entry, index) => expectWitness(entry, `${what}[${index}]`));
  for (let index = 1; index < items.length; index++) {
    const order = compareWitness(items[index - 1], items[index]);
    if (order > 0) refuse(`${what} is not in canonical order; witnesses sort by root then path, so an unchanged inventory always reads back identically.`);
    if (order === 0) refuse(`${what} repeats the witness ${coverageWitnessKey(items[index].root, items[index].path)}; duplicates refuse.`);
  }
  return items;
}

/** The §3.1 canonical value digest used for every result, payload and set hash. */
function digestOf(value: unknown): string {
  return createHash("sha256").update(serializeExecutionValue(value), "utf8").digest("hex");
}

function bytesDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Byte decoding
// ---------------------------------------------------------------------------

function utf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse(`${what} is not UTF-8 text; a coverage source is a canonical UTF-8 document.`);
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    return refuse(`${what} is not JSON (${(error as Error).message}); a malformed source is never re-interpreted.`);
  }
}

/** A JSON object decoded from real bytes: any member shape is acceptable, the object itself is not optional. */
function jsonObject(bytes: Uint8Array, what: string): Record<string, unknown> {
  return expectObject(parseJson(utf8(bytes, what), what), what);
}

/**
 * A document the harness itself produced (a producer manifest, a recovery
 * inventory, a host-history export). These must be canonical §3.1 JSON, so the
 * bytes have exactly one meaning: a duplicated member, a reordered object or
 * any other ambiguity is refused here instead of being resolved by a parser.
 * Retained bodies are NOT canonical and are decoded with `jsonObject` above.
 */
function canonicalDocument(bytes: Uint8Array, what: string): Record<string, unknown> {
  const text = utf8(bytes, what);
  const parsed = parseJson(text, what);
  if (serializeExecutionValue(parsed) !== text) {
    refuse(
      `${what} is not canonical JSON with one terminal LF; a produced coverage document is byte-stable, so an ambiguous or duplicated ` +
        `member is refused rather than resolved by the reader.`,
    );
  }
  return expectObject(parsed, what);
}

/** The retained JSONL records of one file, in exact line order. */
type JsonlFile = Readonly<{
  root: Root;
  path: string;
  sha256: string;
  count: number;
  records: readonly Readonly<{ line: number; sha256: string; workflowId: string | null; eventId: string | null }>[];
}>;

function jsonlFile(witness: CoverageWitness, bytes: Uint8Array, context: RowContext): JsonlFile {
  const text = utf8(bytes, `${context.label} file ${witness.path}`);
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const eventIds = new Set<string>();
  const records = lines.map((line, index) => {
    if (line.trim() === "") {
      refuse(`${context.label}: ${witness.path} line ${index + 1} is blank; a retained ledger line is an accepted record, never padding.`);
    }
    const record = expectObject(parseJson(line, `${context.label}: ${witness.path} line ${index + 1}`), `${context.label}: ${witness.path} line ${index + 1}`);
    const workflowId = record.workflowId === undefined || record.workflowId === null ? null : expectString(record.workflowId, `${witness.path} line ${index + 1}.workflowId`);
    if (workflowId !== null && workflowId !== context.workflowId) {
      refuse(
        `${context.label}: ${witness.path} line ${index + 1} names workflow ${workflowId}, not ${String(context.workflowId)}; a retained record is ` +
          `never attributed to a sibling workflow.`,
      );
    }
    const eventId = record.eventId === undefined || record.eventId === null ? null : expectString(record.eventId, `${witness.path} line ${index + 1}.eventId`);
    if (eventId !== null) {
      if (eventIds.has(eventId)) refuse(`${context.label}: ${witness.path} records the event id ${eventId} twice; a duplicated record is not an accepted record.`);
      eventIds.add(eventId);
    }
    return { line: index, sha256: bytesDigest(new TextEncoder().encode(line)), workflowId, eventId };
  });
  return { root: witness.root, path: witness.path, sha256: witness.sha256, count: records.length, records };
}

/** The retained JSON document members of one file, in canonical key order. */
type JsonFile = Readonly<{
  root: Root;
  path: string;
  sha256: string;
  count: number;
  entries: readonly Readonly<{ key: string; digest: string }>[];
}>;

function jsonFile(witness: CoverageWitness, bytes: Uint8Array, context: RowContext): JsonFile {
  const document = jsonObject(bytes, `${context.label} file ${witness.path}`);
  const declared = document.workflowId;
  if (declared !== undefined && declared !== null && expectString(declared, `${witness.path}.workflowId`) !== context.workflowId) {
    refuse(`${context.label}: ${witness.path} declares workflow ${String(declared)}, not ${String(context.workflowId)}; a retained document is never attributed to a sibling workflow.`);
  }
  for (const key of Object.keys(document)) {
    const member = document[key];
    const nested = isPlainObject(member) ? [member] : Array.isArray(member) ? member.filter(isPlainObject) : [];
    for (const entry of nested) {
      const declaredWorkflow = entry.workflowId;
      if (declaredWorkflow === undefined || declaredWorkflow === null) continue;
      if (expectString(declaredWorkflow, `${witness.path}.${key}.workflowId`) !== context.workflowId) {
        refuse(`${context.label}: ${witness.path} carries ${key}.workflowId ${String(declaredWorkflow)}, not ${String(context.workflowId)}.`);
      }
    }
  }
  const entries = Object.keys(document)
    .sort(compareText)
    .map((key) => ({ key, digest: digestOf(document[key]) }));
  return { root: witness.root, path: witness.path, sha256: witness.sha256, count: entries.length, entries };
}

// ---------------------------------------------------------------------------
// Per-surface codecs (§4.2)
// ---------------------------------------------------------------------------

type RowContext = Readonly<{
  surface: ExecutionSurface;
  workflowId: string | null;
  sources: readonly CoverageWitness[];
  evidence: readonly CoverageWitness[];
  bytesOf: (witness: CoverageWitness) => Uint8Array;
  label: string;
}>;

type Codec = (context: RowContext) => unknown;

function sourceRefs(context: RowContext): unknown[] {
  return context.sources.map((witness) => ({ root: witness.root, path: witness.path, sha256: witness.sha256 }));
}

/** `core-v1`: the root register plus one workflow snapshot per discovered workflow. */
function coreCodec(context: RowContext): unknown {
  const registers: Array<Readonly<{ path: string; sha256: string; workflows: readonly string[] }>> = [];
  const snapshots: Array<Readonly<{ path: string; sha256: string; workflowId: string }>> = [];
  for (const witness of context.sources) {
    const document = jsonObject(context.bytesOf(witness), `${context.label} source ${witness.path}`);
    if (document.schema_version === 1) {
      snapshots.push({
        path: witness.path,
        sha256: witness.sha256,
        workflowId: expectString(document.id, `${context.label} snapshot ${witness.path}.id`),
      });
      continue;
    }
    if (document.version === 2 && Array.isArray(document.workflows)) {
      const workflows = document.workflows.map((entry, index) =>
        expectString(expectObject(entry, `${context.label} register ${witness.path} workflows[${index}]`).id, `${witness.path} workflows[${index}].id`),
      );
      registers.push({ path: witness.path, sha256: witness.sha256, workflows: [...new Set(workflows)].sort(compareText) });
      continue;
    }
    refuse(
      `${context.label}: the core source ${witness.path} is neither a v2 root register nor a workflow snapshot; an unknown core document is not ` +
        `coverage of the core authority.`,
    );
  }
  if (registers.length !== 1) {
    refuse(`${context.label} carries ${registers.length} root registers; the core authority is one v2 register plus its snapshots.`);
  }
  if (snapshots.length === 0) refuse(`${context.label} carries no workflow snapshot; the discovered workflow set is not provable from these bytes.`);
  const workflows = snapshots.map((snapshot) => snapshot.workflowId).sort(compareText);
  for (let index = 1; index < workflows.length; index++) {
    if (workflows[index] === workflows[index - 1]) {
      refuse(`${context.label} carries two snapshots for workflow ${workflows[index]}; a duplicated discovery is not coverage.`);
    }
  }
  const missing = registers[0].workflows.filter((workflowId) => !workflows.includes(workflowId));
  if (missing.length > 0) {
    refuse(
      `${context.label}: the root register names workflow(s) ${missing.join(", ")} with no snapshot witness; the register and the snapshots must ` +
        `describe the same discovered authority.`,
    );
  }
  return { sources: sourceRefs(context), format: "core-v2", workflows };
}

/** `session-v1`: retained envelopes, decoded for the session identity they carry. */
function sessionCodec(context: RowContext): unknown {
  const owners = new Set<string>();
  const envelopes = context.sources.map((witness) => {
    const document = jsonObject(context.bytesOf(witness), `${context.label} envelope ${witness.path}`);
    const sessionId = expectString(document.session_id, `${context.label} envelope ${witness.path}.session_id`);
    const declared = document.workflowId;
    if (declared !== undefined && declared !== null && expectString(declared, `${witness.path}.workflowId`) !== context.workflowId) {
      refuse(`${context.label}: envelope ${witness.path} names workflow ${String(declared)}, not ${String(context.workflowId)}.`);
    }
    if (owners.has(sessionId)) refuse(`${context.label} carries two envelopes for session ${sessionId}; a duplicated association is not coverage.`);
    owners.add(sessionId);
    return { root: witness.root, path: witness.path, sha256: witness.sha256, sessionId };
  });
  return { sources: sourceRefs(context), format: "session-envelope", envelopes };
}

/** `notes-v1` / `agent-flow-v2`: retained JSONL ledgers, decoded line by line. */
function ledgerCodec(context: RowContext): unknown {
  const files = context.sources.map((witness) => jsonlFile(witness, context.bytesOf(witness), context));
  return { sources: sourceRefs(context), format: "jsonl", files };
}

/** `selection-v1` / `omp-launch-v2`: retained JSON documents, decoded member by member. */
function selectionCodec(context: RowContext): unknown {
  const files = context.sources.map((witness) => jsonFile(witness, context.bytesOf(witness), context));
  return { sources: sourceRefs(context), format: "json", files };
}

/**
 * `omp-hidden-v1`: the canonical host-history export (H1's
 * `execution-history.ts` shape). Native order is the array order and the
 * per-record `payloadHash` is recomputed from the published payload, so a
 * relabelled or reordered history cannot pass. A diagnosed export publishes no
 * derived fact for the entry it could not decode, so it is refused instead of
 * being counted as complete coverage.
 */
function hiddenCodec(context: RowContext): unknown {
  if (context.evidence.length > 0) {
    refuse(
      `${context.label} carries ${context.evidence.length} evidence witness(es); the host-history export is the row's source, and no separate ` +
        `host-inventory attestation document exists for the engine to decode yet.`,
    );
  }
  const files = context.sources.map((witness) => {
    const what = `${context.label} host-history export ${witness.path}`;
    const document = canonicalDocument(context.bytesOf(witness), what);
    expectExactKeys(document, ["version", "document", "records", "diagnostics"], what);
    if (document.version !== 1 || document.document !== "execution-host-history") {
      refuse(`${what} is not a version 1 execution-host-history export; an unknown host document is not coverage.`);
    }
    const diagnostics = expectArray(document.diagnostics, `${what}.diagnostics`);
    if (diagnostics.length > 0) {
      refuse(
        `${what} carries ${diagnostics.length} diagnostic(s); an entry the exporter could not decode publishes no derived fact, so a diagnosed ` +
          `history is not a complete inventory.`,
      );
    }
    const records = expectArray(document.records, `${what}.records`).map((entry, index) => {
      const record = expectObject(entry, `${what}.records[${index}]`);
      expectExactKeys(record, ["index", "entryId", "type", "sessionId", "payloadHash", "payload", "view"], `${what}.records[${index}]`);
      if (record.index !== index) refuse(`${what}.records[${index}].index must be ${index}; the native ledger order is the published order.`);
      const type = expectEnum(record.type, HOST_HISTORY_KINDS, `${what}.records[${index}].type`);
      const entryId = expectNullableString(record.entryId, `${what}.records[${index}].entryId`);
      const sessionId = expectNullableString(record.sessionId, `${what}.records[${index}].sessionId`);
      const payloadHash = expectHex64(record.payloadHash, `${what}.records[${index}].payloadHash`);
      const recomputed = digestOf(record.payload);
      if (payloadHash !== recomputed) {
        refuse(
          `${what}.records[${index}].payloadHash ${payloadHash} does not hash the payload it publishes (${recomputed}); a payload digest is recomputed ` +
            `from the bytes, never carried on trust.`,
        );
      }
      const view = expectObject(record.view, `${what}.records[${index}].view`);
      expectExactKeys(
        view,
        ["generation", "declaredKind", "declaredAction", "declaredState", "workflowId", "checkpointId", "operationId", "dedupKey", "cancelled", "provenance"],
        `${what}.records[${index}].view`,
      );
      if (view.generation !== 1) refuse(`${what}.records[${index}].view.generation must be 1; generation 1 is the only decoded generation.`);
      const recordWorkflow = expectString(view.workflowId, `${what}.records[${index}].view.workflowId`);
      if (recordWorkflow !== context.workflowId) {
        refuse(
          `${what}.records[${index}] belongs to workflow ${recordWorkflow}, not ${String(context.workflowId)}; a hidden-history record is never ` +
            `attributed to a sibling workflow.`,
        );
      }
      const declaredState = expectEnum(view.declaredState, HOST_HISTORY_STATES, `${what}.records[${index}].view.declaredState`);
      if (typeof view.cancelled !== "boolean") refuse(`${what}.records[${index}].view.cancelled must be a boolean.`);
      const checkpointId = expectNullableString(view.checkpointId, `${what}.records[${index}].view.checkpointId`);
      const operationId = expectNullableString(view.operationId, `${what}.records[${index}].view.operationId`);
      const dedupKey = expectNullableString(view.dedupKey, `${what}.records[${index}].view.dedupKey`);
      if (dedupKey !== (operationId ?? checkpointId)) {
        refuse(`${what}.records[${index}].view.dedupKey must be the operation id or the checkpoint id it dedups on.`);
      }
      expectArray(view.provenance, `${what}.records[${index}].view.provenance`).forEach((item, position) => {
        const where = `${what}.records[${index}].view.provenance[${position}]`;
        const field = expectObject(item, where);
        expectExactKeys(field, ["field", "path"], where);
        expectString(field.field, `${where}.field`);
        expectString(field.path, `${where}.path`);
      });
      return { index, entryId, type, sessionId, payloadHash, workflowId: recordWorkflow, declaredState, cancelled: view.cancelled, checkpointId, dedupKey };
    });
    const sessions = [...new Set(records.map((record) => record.sessionId).filter((sessionId): sessionId is string => sessionId !== null))].sort(compareText);
    if (sessions.length === 0) {
      refuse(`${what} names no decoded native session; a hidden-history row covers the sessions its export publishes, so an empty export is an absent row.`);
    }
    return { root: witness.root, path: witness.path, sha256: witness.sha256, document: "execution-host-history", count: records.length, sessions, records };
  });
  return { sources: sourceRefs(context), format: "host-history-v1", files };
}

/** `retained-body-v1`: retained evidence bodies, summarized from their exact bytes. */
function retainedBodyCodec(context: RowContext): unknown {
  const bodies = context.sources.map((witness) => {
    const bytes = context.bytesOf(witness);
    return { root: witness.root, path: witness.path, sha256: witness.sha256, size: bytes.byteLength };
  });
  bodies.sort((left, right) => compareText(left.path, right.path));
  return { sources: sourceRefs(context), format: "retained-body", bodies };
}

const CONSUMER_MANIFEST_KEYS = ["version", "document", "surface", "entries"] as const;

/**
 * `consumer-v1`: one producer manifest (the row's evidence document) whose
 * recorded digests must equal the hashed source bytes it describes, and whose
 * declared capability must be the authority its surface is required to expose.
 */
function consumerCodec(context: RowContext): unknown {
  const required = SURFACE_CAPABILITY[context.surface];
  if (context.evidence.length !== 1) {
    refuse(`${context.label} carries ${context.evidence.length} evidence document(s); a package/instruction row carries exactly one producer manifest.`);
  }
  const document = canonicalDocument(context.bytesOf(context.evidence[0]), `${context.label} producer manifest`);
  expectExactKeys(document, CONSUMER_MANIFEST_KEYS, `${context.label} producer manifest`);
  if (document.version !== 1 || document.document !== "consumer-manifest") {
    refuse(`${context.label} producer manifest must be a version 1 consumer-manifest document.`);
  }
  const declaredSurface = expectSurface(document.surface, `${context.label} producer manifest.surface`);
  if (declaredSurface !== context.surface) {
    refuse(`${context.label} producer manifest describes ${declaredSurface}; a manifest is never reused for another surface.`);
  }
  const claimed = new Set<string>();
  const claim = (path: string, sha256: string, what: string): CoverageWitness => {
    const witness = context.sources.find((candidate) => candidate.path === path && candidate.sha256 === sha256);
    if (witness === undefined) {
      refuse(`${what} (${path}) is not a source witness of this receipt; a manifest digest that names no supplied byte proves nothing.`);
    }
    const key = coverageWitnessKey(witness.root, witness.path);
    if (claimed.has(key)) refuse(`${what} (${path}) is claimed twice; one retained byte is described by one manifest entry.`);
    claimed.add(key);
    return witness;
  };
  const entries = expectArray(document.entries, `${context.label} producer manifest.entries`).map((entry, index) => {
    const what = `${context.label} producer manifest.entries[${index}]`;
    const item = expectObject(entry, what);
    expectExactKeys(item, ["path", "sha256", "capability", "entrypoint", "runtime", "generated"], what);
    const path = expectWitnessPath(item.path, `${what}.path`);
    const sha256 = expectHex64(item.sha256, `${what}.sha256`);
    const capability = expectEnum(item.capability, CAPABILITIES, `${what}.capability`);
    if (capability !== required) {
      refuse(
        `${what} declares capability ${capability} while ${context.surface} is required to expose ${required}; a consumer receipt cannot relabel the ` +
          `authority it provides.`,
      );
    }
    const entrypoint = item.entrypoint === null ? null : expectString(item.entrypoint, `${what}.entrypoint`);
    const runtime = item.runtime === null ? null : expectEnum(item.runtime, RUNTIME_TARGETS, `${what}.runtime`);
    const generated = item.generated === null ? null : expectObject(item.generated, `${what}.generated`);
    const generatedRef =
      generated === null
        ? null
        : (() => {
            expectExactKeys(generated, ["path", "sha256"], `${what}.generated`);
            const generatedPath = expectWitnessPath(generated.path, `${what}.generated.path`);
            const generatedSha = expectHex64(generated.sha256, `${what}.generated.sha256`);
            const witness = claim(
              generatedPath,
              generatedSha,
              `${what}.generated`,
            );
            return { root: witness.root, path: generatedPath, sha256: generatedSha };
          })();
    if (generatedRef !== null && runtime === null) {
      refuse(`${what} names a generated artifact without its runtime target; a built artifact declares the runtime it was built for.`);
    }
    const witness = claim(path, sha256, what);
    return { root: witness.root, path, sha256, capability, entrypoint, runtime, generated: generatedRef };
  });
  const unclaimed = context.sources.filter((witness) => !claimed.has(coverageWitnessKey(witness.root, witness.path)));
  if (unclaimed.length > 0) {
    refuse(
      `${context.label} pins source witness(es) ${unclaimed.map((witness) => witness.path).join(", ")} that its producer manifest does not describe; ` +
        `every retained byte of the row is accounted for.`,
    );
  }
  return { sources: sourceRefs(context), format: "consumer-manifest-v1", entries };
}

const RECOVERY_INVENTORY_KEYS = ["version", "document", "backup", "schemaVersion", "integrity", "coverageDigest", "recoveryGeneration"] as const;

/** `recovery-v1`: a verified recovery point described by its own inventory document. */
function recoveryCodec(context: RowContext): unknown {
  if (context.evidence.length !== 1) {
    refuse(`${context.label} carries ${context.evidence.length} evidence document(s); a recovery point carries exactly one verified inventory.`);
  }
  if (context.sources.length !== 1) {
    refuse(`${context.label} carries ${context.sources.length} source witnesses; a recovery point is one backup image plus its verified inventory.`);
  }
  const document = canonicalDocument(context.bytesOf(context.evidence[0]), `${context.label} recovery inventory`);
  expectExactKeys(document, RECOVERY_INVENTORY_KEYS, `${context.label} recovery inventory`);
  if (document.version !== 1 || document.document !== "recovery-inventory") {
    refuse(`${context.label} recovery inventory must be a version 1 recovery-inventory document.`);
  }
  const backup = expectObject(document.backup, `${context.label} recovery inventory.backup`);
  expectExactKeys(backup, ["path", "sha256"], `${context.label} recovery inventory.backup`);
  const path = expectWitnessPath(backup.path, `${context.label} recovery inventory.backup.path`);
  const sha256 = expectHex64(backup.sha256, `${context.label} recovery inventory.backup.sha256`);
  const image = context.sources[0];
  if (image.path !== path || image.sha256 !== sha256) {
    refuse(
      `${context.label} recovery inventory describes ${path}, which is not the pinned backup image ${image.path}; the inventory and the image must be ` +
        `the same recovery point.`,
    );
  }
  if (document.integrity !== "verified") {
    refuse(`${context.label} recovery inventory declares integrity ${JSON.stringify(document.integrity)}; only a verified backup is a recovery point.`);
  }
  return {
    sources: sourceRefs(context),
    format: "recovery-inventory-v1",
    backup: { root: image.root, path, sha256 },
    schemaVersion: expectInteger(document.schemaVersion, `${context.label} recovery inventory.schemaVersion`, 1),
    integrity: "verified",
    coverageDigest: expectHex64(document.coverageDigest, `${context.label} recovery inventory.coverageDigest`),
    recoveryGeneration: expectInteger(document.recoveryGeneration, `${context.label} recovery inventory.recoveryGeneration`, 0),
  };
}

const CODECS: Readonly<Record<ExecutionSurface, Codec>> = {
  "core-execution": coreCodec,
  "workflow-session-envelopes": sessionCodec,
  "workflow-notes-ledger": ledgerCodec,
  "workflow-agent-flow-ledger": ledgerCodec,
  "workflow-ledger-cursors": selectionCodec,
  "engine-status-snapshot": selectionCodec,
  "workflow-omp-launch-journal": selectionCodec,
  "omp-hidden-entries": hiddenCodec,
  "sdd-evidence": retainedBodyCodec,
  "artifact-store-injectors": consumerCodec,
  "cli-writer": consumerCodec,
  "engine-cli-package": consumerCodec,
  "dsh-package": consumerCodec,
  "omp-package": consumerCodec,
  "opencode-plugin": consumerCodec,
  "zcode-hook": consumerCodec,
  "copied-instructions": consumerCodec,
  "backup-recovery": recoveryCodec,
};

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

const RECEIPT_KEYS = [
  "version",
  "surface",
  "workflowId",
  "manifestId",
  "manifestHash",
  "storeId",
  "epoch",
  "disposition",
  "protocol",
  "sources",
  "evidence",
  "resultHash",
] as const;

function expectReceiptShape(value: unknown, what: string): ExecutionCoverageReceipt {
  const record = expectObject(value, what);
  expectExactKeys(record, RECEIPT_KEYS, what);
  if (record.version !== 1) refuse(`${what}.version must be 1; a coverage receipt is versioned, never guessed.`);
  const surface = expectSurface(record.surface, `${what}.surface`);
  const workflowId = expectNullableString(record.workflowId, `${what}.workflowId`);
  expectScope(surface, workflowId, what);
  const disposition = expectEnum(record.disposition, COVERAGE_DISPOSITIONS, `${what}.disposition`);
  const allowed = SURFACE_DISPOSITIONS[surface];
  if (!allowed.includes(disposition)) {
    refuse(`${what} declares disposition ${disposition} for ${surface}; that surface allows ${allowed.join(", ")}.`);
  }
  const protocol = expectProtocol(record.protocol, `${what}.protocol`);
  if (SURFACE_PROTOCOLS[surface] !== protocol) {
    refuse(`${what} declares protocol ${protocol}, but ${surface} is validated by ${SURFACE_PROTOCOLS[surface]}; a receipt never picks its own validator.`);
  }
  return {
    version: 1,
    surface,
    workflowId,
    manifestId: expectString(record.manifestId, `${what}.manifestId`),
    manifestHash: expectHex64(record.manifestHash, `${what}.manifestHash`),
    storeId: expectString(record.storeId, `${what}.storeId`),
    epoch: expectInteger(record.epoch, `${what}.epoch`, 1),
    disposition,
    protocol,
    sources: expectWitnessList(record.sources, `${what}.sources`),
    evidence: expectWitnessList(record.evidence, `${what}.evidence`),
    resultHash: expectHex64(record.resultHash, `${what}.resultHash`),
  };
}

function compareReceiptIdentity(
  left: Readonly<{ surface: ExecutionSurface; workflowId: string | null }>,
  right: Readonly<{ surface: ExecutionSurface; workflowId: string | null }>,
): number {
  const bySurface = EXECUTION_COVERAGE_SURFACES.indexOf(left.surface) - EXECUTION_COVERAGE_SURFACES.indexOf(right.surface);
  if (bySurface !== 0) return bySurface < 0 ? -1 : 1;
  if (left.workflowId === right.workflowId) return 0;
  if (left.workflowId === null) return -1;
  if (right.workflowId === null) return 1;
  return compareText(left.workflowId, right.workflowId);
}

function assertReceiptOrder(
  receipts: readonly Readonly<{ surface: ExecutionSurface; workflowId: string | null }>[],
  what: string,
): void {
  for (let index = 1; index < receipts.length; index++) {
    const order = compareReceiptIdentity(receipts[index - 1], receipts[index]);
    if (order > 0) refuse(`${what} is not sorted by surface/workflow; a canonical receipt list is a function of its content, never of discovery order.`);
    if (order === 0) {
      refuse(`${what} carries two receipts for the same surface identity (${identityLabel(receipts[index].surface, receipts[index].workflowId)}); duplicates refuse.`);
    }
  }
}

function identityKey(surface: ExecutionSurface, workflowId: string | null): string {
  return `${surface}|${workflowId ?? ""}`;
}

function identityLabel(surface: ExecutionSurface, workflowId: string | null): string {
  return workflowId === null ? surface : `${surface} of workflow ${workflowId}`;
}

type ReceiptInput = Readonly<{
  surface: ExecutionSurface;
  workflowId: string | null;
  disposition: Disposition;
  manifestId: string;
  manifestHash: string;
  storeId: string;
  epoch: number;
  sources: readonly CoverageWitness[];
  evidence?: readonly CoverageWitness[];
}>;

/**
 * Validate a row identity and its witness lists against the closed tables, and
 * RECOMPUTE the row's result from the bytes of every witness (hashing each byte
 * as it is read). Returns the canonical receipt plus the decoded facts, which
 * are never carried by the receipt itself.
 */
function computeRow(
  input: unknown,
  evidence: ExecutionCoverageEvidence,
  what: string,
): { receipt: ExecutionCoverageReceipt; facts: unknown } {
  const record = expectObject(input, what);
  const surface = expectSurface(record.surface, `${what}.surface`);
  const workflowId = expectNullableString(record.workflowId, `${what}.workflowId`);
  expectScope(surface, workflowId, what);
  const disposition = expectEnum(record.disposition, COVERAGE_DISPOSITIONS, `${what}.disposition`);
  const allowed = SURFACE_DISPOSITIONS[surface];
  if (!allowed.includes(disposition)) {
    refuse(`${what} declares disposition ${disposition} for ${surface}; that surface allows ${allowed.join(", ")}.`);
  }
  const sources = expectWitnessList(record.sources, `${what}.sources`);
  const witnesses = expectWitnessList(record.evidence ?? [], `${what}.evidence`);
  const manifestId = expectString(record.manifestId, `${what}.manifestId`);
  const manifestHash = expectHex64(record.manifestHash, `${what}.manifestHash`);
  const storeId = expectString(record.storeId, `${what}.storeId`);
  const epoch = expectInteger(record.epoch, `${what}.epoch`, 1);
  const label = `receipt ${identityLabel(surface, workflowId)}`;

  const bytesOf = (witness: CoverageWitness): Uint8Array => {
    const key = coverageWitnessKey(witness.root, witness.path);
    const bytes = evidence.get(key);
    if (bytes === undefined) {
      refuse(`${label} names witness ${key}, whose bytes were not supplied; coverage is recomputed from bytes, never from a path alone.`);
    }
    if (!(bytes instanceof Uint8Array)) refuse(`${label} witness ${key} is not handed in as bytes.`);
    if (bytesDigest(bytes) !== witness.sha256) {
      refuse(`${label} witness ${key} does not hash to ${witness.sha256}; the bytes changed since the receipt was written, so the receipt is stale.`);
    }
    return bytes;
  };

  let facts: unknown;
  let resultHash: string;
  if (disposition === "absent") {
    if (sources.length > 0 || witnesses.length > 0) {
      refuse(`${label} is absent yet names witnesses; an absent surface has no bytes to witness, and a populated surface is never reported absent.`);
    }
    resultHash = digestOf({ surface, workflowId, disposition: "absent" });
  } else {
    if (sources.length === 0) {
      refuse(
        `${label} is populated but names no source witness; every populated surface has retained bytes, and a result is recomputed from bytes, never ` +
          `from a row identity alone.`,
      );
    }
    // Every named byte is hashed before any decoding: a witness whose bytes were
    // not supplied, were replaced or do not hash to the receipt is refused even
    // when the codec would never have read it.
    for (const witness of [...sources, ...witnesses]) bytesOf(witness);
    facts = CODECS[surface]({ surface, workflowId, sources, evidence: witnesses, bytesOf, label });
    resultHash = digestOf({ surface, workflowId, disposition, facts });
  }
  return {
    receipt: {
      version: 1,
      surface,
      workflowId,
      manifestId,
      manifestHash,
      storeId,
      epoch,
      disposition,
      protocol: SURFACE_PROTOCOLS[surface],
      sources,
      evidence: witnesses,
      resultHash,
    },
    facts,
  };
}

/**
 * Build the canonical receipt for one row from its bytes. This is the single
 * producer entry point: C3 decodes, hashes and receives exactly the receipt
 * `validateExecutionCoverage` recomputes later, so a producer cannot drift from
 * the validator's schema or invent a result of its own.
 */
export function buildExecutionCoverageReceipt(
  input: Readonly<{
    surface: ExecutionSurface;
    workflowId: string | null;
    disposition: "absent" | "retain" | "migrate" | "retire";
    manifestId: string;
    manifestHash: string;
    storeId: string;
    epoch: number;
    sources: readonly CoverageWitness[];
    evidence?: readonly CoverageWitness[];
  }>,
  evidence: ExecutionCoverageEvidence,
): ExecutionCoverageReceipt {
  if (evidence === null || typeof evidence.get !== "function") {
    refuse("the evidence map must supply bytes per `${root}:${path}` key; a coverage claim without bytes is an assertion, not evidence.");
  }
  return computeRow(input, evidence, "a coverage receipt request").receipt;
}

/**
 * Canonical receipt digest (§4.1). The list must already carry the closed
 * receipt shape in canonical order — a digest over an unordered or duplicated
 * list would not be a function of the covered set.
 */
export function executionCoverageDigest(receipts: readonly ExecutionCoverageReceipt[]): string {
  const list = expectArray(receipts, "coverage receipts").map((entry, index) => expectReceiptShape(entry, `coverage receipts[${index}]`));
  assertReceiptOrder(list, "coverage receipts");
  return digestOf(list);
}

// ---------------------------------------------------------------------------
// Manifest and coverage set
// ---------------------------------------------------------------------------

const MANIFEST_KEYS = ["manifestId", "manifestHash", "storeId", "epoch", "surfaces", "sources"] as const;

type ManifestSurface = Readonly<{ surface: ExecutionSurface; workflowId: string | null; sources: readonly CoverageWitness[] }>;

function expectManifestSurface(value: unknown, what: string): ManifestSurface {
  const record = expectObject(value, what);
  expectExactKeys(record, ["surface", "workflowId", "sources"], what);
  const surface = expectSurface(record.surface, `${what}.surface`);
  const workflowId = expectNullableString(record.workflowId, `${what}.workflowId`);
  expectScope(surface, workflowId, what);
  return { surface, workflowId, sources: expectWitnessList(record.sources, `${what}.sources`) };
}

/**
 * The frozen manifest. Its inventory is closed in both directions: every
 * root-scoped surface appears exactly once with a null workflowId, every
 * workflow-scoped surface appears once per discovered workflow, and a workflow
 * named by one workflow-scoped row must carry all seven of them. A manifest
 * that silently narrows the inventory is refused instead of producing a
 * coverage set that looks complete.
 */
function expectManifest(value: unknown): ExecutionCoverageManifest {
  const record = expectObject(value, "the coverage manifest");
  expectExactKeys(record, MANIFEST_KEYS, "the coverage manifest");
  const manifestId = expectString(record.manifestId, "the coverage manifest.manifestId");
  const manifestHash = expectHex64(record.manifestHash, "the coverage manifest.manifestHash");
  const storeId = expectString(record.storeId, "the coverage manifest.storeId");
  const epoch = expectInteger(record.epoch, "the coverage manifest.epoch", 1);
  const surfaces = expectArray(record.surfaces, "the coverage manifest.surfaces").map((entry, index) =>
    expectManifestSurface(entry, `the coverage manifest.surfaces[${index}]`),
  );
  assertReceiptOrder(surfaces, "the coverage manifest.surfaces");
  const sources = expectWitnessList(record.sources, "the coverage manifest.sources");

  const known = new Set(surfaces.map((row) => identityKey(row.surface, row.workflowId)));
  for (const surface of EXECUTION_COVERAGE_SURFACES) {
    if (executionCoverageSurfaceScope(surface) === "root" && !known.has(identityKey(surface, null))) {
      refuse(
        `the coverage manifest does not carry the root-scoped surface ${surface}; the closed 18-row inventory is never narrowed by omission, ` +
          `so a surface with nothing discovered is an absent row instead.`,
      );
    }
  }
  const workflows = [...new Set(surfaces.filter((row) => row.workflowId !== null).map((row) => row.workflowId as string))].sort(compareText);
  for (const workflowId of workflows) {
    for (const surface of WORKFLOW_SCOPED_SURFACES) {
      if (!known.has(identityKey(surface, workflowId))) {
        refuse(
          `the coverage manifest carries ${surface} for another workflow but not for ${workflowId}; workflow-scoped rows repeat for every ` +
            `discovered workflow, so a sibling workflow is never omitted.`,
        );
      }
    }
  }
  return { manifestId, manifestHash, storeId, epoch, surfaces, sources };
}

const SET_KEYS = ["version", "manifestId", "manifestHash", "receipts", "digest"] as const;

function expectCoverageSet(value: unknown, manifest: ExecutionCoverageManifest): ExecutionCoverageSet {
  const record = expectObject(value, "the coverage set");
  expectExactKeys(record, SET_KEYS, "the coverage set");
  if (record.version !== 1) refuse("the coverage set.version must be 1.");
  const manifestId = expectString(record.manifestId, "the coverage set.manifestId");
  const manifestHash = expectHex64(record.manifestHash, "the coverage set.manifestHash");
  if (manifestId !== manifest.manifestId) {
    refuse(`the coverage set binds manifest ${manifestId}, but the frozen manifest is ${manifest.manifestId}; the set belongs to another discovery.`);
  }
  if (manifestHash !== manifest.manifestHash) {
    refuse(
      `the coverage set binds manifest hash ${manifestHash}, but the frozen manifest hashes to ${manifest.manifestHash}; the receipts were ` +
        `reviewed against another document.`,
    );
  }
  const receipts = expectArray(record.receipts, "the coverage set.receipts").map((entry, index) =>
    expectReceiptShape(entry, `the coverage set.receipts[${index}]`),
  );
  assertReceiptOrder(receipts, "the coverage set.receipts");
  return {
    version: 1,
    manifestId,
    manifestHash,
    receipts,
    digest: expectHex64(record.digest, "the coverage set.digest"),
  };
}

// ---------------------------------------------------------------------------
// Entry point (§4.1)
// ---------------------------------------------------------------------------

/**
 * Validate a coverage set against its frozen manifest and the evidence bytes.
 * Synchronous and pure: nothing is read from disk, nothing is written, and no
 * caller-supplied callback can substitute an assertion for bytes. Every
 * receipt's result is RECOMPUTED from the bytes it names, so a self-consistent
 * hash over an invented document proves nothing.
 *
 * Refuses `execution.coverage-incomplete` when the set is not the exact closed
 * inventory, when a receipt disagrees with its manifest binding, its assigned
 * or pinned witnesses, or its recomputed result.
 */
export function validateExecutionCoverage(
  manifest: ExecutionCoverageManifest,
  coverage: ExecutionCoverageSet,
  evidence: ExecutionCoverageEvidence,
): void {
  if (evidence === null || typeof evidence.get !== "function") {
    refuse("the evidence map must supply bytes per `${root}:${path}` key; a coverage claim without bytes is an assertion, not evidence.");
  }
  const frozen = expectManifest(manifest);
  const set = expectCoverageSet(coverage, frozen);

  const assignment = new Map<string, ManifestSurface>();
  for (const row of frozen.surfaces) assignment.set(identityKey(row.surface, row.workflowId), row);
  for (const receipt of set.receipts) {
    if (!assignment.has(identityKey(receipt.surface, receipt.workflowId))) {
      refuse(
        `the coverage set carries a receipt for ${identityLabel(receipt.surface, receipt.workflowId)}, which the frozen manifest does not list; ` +
          `a receipt never adds a surface identity of its own.`,
      );
    }
  }
  const actual = new Set(set.receipts.map((receipt) => identityKey(receipt.surface, receipt.workflowId)));
  for (const row of frozen.surfaces) {
    if (!actual.has(identityKey(row.surface, row.workflowId))) {
      refuse(
        `the coverage set omits ${identityLabel(row.surface, row.workflowId)}; every discovered surface identity owns its receipt, so an omitted ` +
          `sibling workflow is missing coverage rather than an absent row.`,
      );
    }
  }

  const digest = digestOf(set.receipts);
  if (set.digest !== digest) {
    refuse(`the coverage set digest ${set.digest} is not the canonical digest of the receipts it carries (${digest}); the set is not self-consistent.`);
  }

  const pinned = new Set(frozen.sources.map((witness) => coverageWitnessKey(witness.root, witness.path)));
  const factsBySurface = new Map<string, unknown>();
  for (const receipt of set.receipts) {
    const key = identityKey(receipt.surface, receipt.workflowId);
    const label = `receipt ${identityLabel(receipt.surface, receipt.workflowId)}`;
    const assigned = assignment.get(key);
    if (assigned === undefined) refuse(`${label} is not a surface identity of the frozen manifest.`);
    if (receipt.manifestId !== frozen.manifestId) {
      refuse(`${label} binds manifest ${receipt.manifestId}, but the frozen manifest is ${frozen.manifestId}; a receipt from another discovery is stale coverage.`);
    }
    if (receipt.manifestHash !== frozen.manifestHash) {
      refuse(`${label} binds manifest hash ${receipt.manifestHash}, but the frozen manifest hashes to ${frozen.manifestHash}.`);
    }
    if (receipt.storeId !== frozen.storeId) {
      refuse(`${label} binds store ${receipt.storeId}, but the frozen manifest belongs to store ${frozen.storeId}.`);
    }
    if (receipt.epoch !== frozen.epoch) {
      refuse(`${label} binds epoch ${receipt.epoch}, but the frozen manifest was discovered at epoch ${frozen.epoch}; a superseded epoch never authorizes coverage.`);
    }
    if (!sameWitnesses(assigned.sources, receipt.sources)) {
      refuse(
        `${label} names source witnesses ${describeWitnesses(receipt.sources)} where the frozen manifest assigns ${describeWitnesses(assigned.sources)} ` +
          `to ${identityLabel(assigned.surface, assigned.workflowId)}; a row's sources are the ones C3's discovery pinned to it, never another row's.`,
      );
    }
    for (const witness of receipt.sources) {
      const sourceKey = coverageWitnessKey(witness.root, witness.path);
      if (!pinned.has(sourceKey)) {
        refuse(`${label} names source witness ${sourceKey}, which the frozen manifest does not pin; a receipt never invents a source outside the reviewed inventory.`);
      }
    }
    const recomputed = computeRow(
      {
        surface: receipt.surface,
        workflowId: receipt.workflowId,
        disposition: receipt.disposition,
        manifestId: receipt.manifestId,
        manifestHash: receipt.manifestHash,
        storeId: receipt.storeId,
        epoch: receipt.epoch,
        sources: receipt.sources,
        evidence: receipt.evidence,
      },
      evidence,
      label,
    );
    if (recomputed.receipt.resultHash !== receipt.resultHash) {
      refuse(
        `${label} carries resultHash ${receipt.resultHash}, but the result recomputed from its bytes is ${recomputed.receipt.resultHash}; a coverage ` +
          `result is recomputed from the named bytes, never asserted by the receipt.`,
      );
    }
    factsBySurface.set(key, recomputed.facts);
  }

  const discovered = [...new Set(frozen.surfaces.filter((row) => row.workflowId !== null).map((row) => row.workflowId as string))].sort(compareText);
  const core = factsBySurface.get(identityKey("core-execution", null)) as { workflows: readonly string[] } | undefined;
  if (core === undefined) {
    refuse("the core-execution row carries no recomputed discovery; the core authority is always populated, so its discovery is always recomputed.");
  }
  if (core.workflows.length !== discovered.length || core.workflows.some((workflowId, index) => workflowId !== discovered[index])) {
    refuse(
      `the core-execution facts name the workflows ${core.workflows.join(", ") || "(none)"}, but the manifest inventories ${discovered.join(", ") || "(none)"}; ` +
        `a workflow discovered by the core authority is never omitted from the workflow-scoped inventory.`,
    );
  }
}

function sameWitnesses(left: readonly CoverageWitness[], right: readonly CoverageWitness[]): boolean {
  return (
    left.length === right.length &&
    left.every((witness, index) => witness.root === right[index].root && witness.path === right[index].path && witness.sha256 === right[index].sha256)
  );
}

function describeWitnesses(witnesses: readonly CoverageWitness[]): string {
  if (witnesses.length === 0) return "(none)";
  return witnesses.map((witness) => coverageWitnessKey(witness.root, witness.path)).join(", ");
}
