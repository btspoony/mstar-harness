/**
 * execution-coverage.ts — the pure coverage substrate of the execution
 * authority (architecture contract §4.1/§4.2/§5): the closed 18-surface
 * inventory, one strict codec per surface, canonical receipt hashing, the
 * manifest-row source assignment and `validateExecutionCoverage`.
 *
 * The module is pure: it opens no file, loads no driver and imports no host
 * package or build script. Evidence bytes are handed in, and every fact this
 * module reports is DECODED FROM THOSE BYTES by the codec of the surface that
 * claims them — never asserted by a receipt, never summarized by a generic
 * JSON digest standing in for semantic validation.
 *
 * The codecs implement the released producer shapes, not convenient ones:
 *
 * - `core-v1`: the v2 root register and one workflow snapshot per workflow
 *   (duplicate register ids refuse instead of being folded away).
 * - `session-v1`: the released session envelope
 *   `{schema_version:1, role, session_id, workflow_id, plan_id?, harness_root}`.
 * - `notes-v1`: the legacy `{kind:"note",ts,text}` body and the version 1
 *   `{version:1,id,workflowId,sessionId,kind:"note",ts,text}` record.
 * - `agent-flow-v2`: the six-kind workflow ledger union, the accepted-identity
 *   index `{id,d}` (with `d` recomputed from the exact line bytes) and the
 *   sealed history chunks.
 * - `selection-v1`: the versioned cursor sidecar (`{v:2,cursors:{…}}` with the
 *   `{v:1,cursors:{…:number}}` legacy form) and the engine-status snapshot
 *   (`{sv:1, entries, bindings?}`).
 * - `omp-launch-v2`: the plugin journal `{version:1, workflow_id, coordinator,
 *   intents}` with its closed intent states.
 * - `consumer-v1`: the R1 `{version, protocol, repoRoot, consumers}` manifest.
 * - `recovery-v1`: the verified recovery inventory beside its backup image.
 *
 * Two surfaces have no reviewed producer to decode yet and therefore refuse a
 * populated row instead of inventing a shape: `omp-hidden-entries` (H1's
 * export is decoded and its identities validated, but §4.2 also requires H2's
 * host-inventory / stop-adoption wrapper, which does not exist yet) and
 * `artifact-store-injectors` (no reviewed injector-inventory producer exists
 * beside R1's consumer manifest). Both stay explicitly incomplete.
 *
 * `ExecutionCoverageManifest` is this module's small manifest view, not the
 * migration module's `ExecutionManifest` (§4.1). C3 owns every piece of IO
 * around this module — safe reads, symlink and canonical-root checks, fresh
 * bytes — plus the public barrel export.
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
 * The consumer surfaces that decode R1's `consumer-v1` manifest, with the
 * consumer id and the capability R1 declares for it (contract §4.2/§7, R1
 * `scripts/execution-consumer-manifest.ts`). A row whose manifest declares any
 * other id or capability refuses.
 */
const R1_CONSUMER_CAPABILITY: Readonly<Record<string, "writer" | "read-only" | "decision-only">> = {
  engine: "writer",
  cli: "writer",
  dsh: "writer",
  omp: "writer",
  opencode: "decision-only",
  zcode: "writer",
};

/**
 * The R1 consumers each manifest surface covers. A single-consumer surface names
 * its one consumer; `copied-instructions` covers the corpus the consumers that
 * actually bundle it declare (R1 gives copies to DSh, OMP and OpenCode), so its
 * branch validates the real `copiedInstructions` records instead of an arbitrary
 * writer.
 */
const SURFACE_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  "cli-writer": ["cli"],
  "engine-cli-package": ["engine"],
  "dsh-package": ["dsh"],
  "omp-package": ["omp"],
  "opencode-plugin": ["opencode"],
  "zcode-hook": ["zcode"],
  "copied-instructions": ["dsh", "omp", "opencode"],
};

const COVERAGE_ROOTS: readonly Root[] = ["control", "sdd", "host", "package"];
const COVERAGE_DISPOSITIONS: readonly Disposition[] = ["absent", "retain", "migrate", "retire"];
const AGENT_FLOW_KINDS = ["dispatch", "settle", "subagent-link", "workflow-verdict", "workflow-run", "workflow-agent", "workflow-run-end"] as const;
const WORKFLOW_EVENT_ID_PREFIX = "wfe1:";
const AGENT_FLOW_INDEX_FILE = "agent-flow-ids.jsonl";
const AGENT_FLOW_TAIL_FILE = "agent-flow.jsonl";
const AGENT_FLOW_HISTORY_DIR = "agent-flow-history";
const CURSOR_FILE = "workflow-ledger-cursors.json";
const ENGINE_STATUS_FILE = "snapshots/engine-status.json";
const LAUNCH_JOURNAL_FILE = "omp-launches.json";
const NOTES_FILE = "notes.jsonl";
const LAUNCH_TRANSPORTS = ["herdr", "tmux"] as const;
const LAUNCH_STATES = ["reserved", "starting", "created", "submitting", "submitted", "refused", "uncertain"] as const;
const LAUNCH_IN_FLIGHT: readonly string[] = ["reserved", "starting", "created", "submitting"];
const HOST_HISTORY_KINDS = [
  "mstar:phase2",
  "mstar:phase2-continuation",
  "mstar:phase2-checkpoint",
  "mstar:phase2-launch-reservation",
  "mstar:model-handoff",
] as const;
const HOST_HISTORY_STATES = ["pending", "attempting", "handed_off", "cancelled", "failed", "uncertain"] as const;
const CONSUMER_CAPABILITIES = ["writer", "read-only", "decision-only"] as const;
const RUNTIME_TARGETS = ["node", "bun"] as const;
const RUNTIME_DECLARATIONS = ["package-engines", "canonical-floor"] as const;
const COPY_MODES = ["copy", "merge"] as const;
const SESSION_ROLES = ["coordinator", "plan-pm"] as const;
const DISPATCH_VERDICTS = ["ok", "advisory", "denied"] as const;
const SETTLE_OUTCOMES = ["ok", "error", "denied"] as const;
const WORKFLOW_TOOLS = ["workflow", "ralph"] as const;
const WORKFLOW_GATE_MODES = ["off", "warn", "ask", "hard"] as const;
const WORKFLOW_VERDICTS = ["ok", "advisory", "denied", "ask"] as const;
const WORKFLOW_STOP_REASONS = ["completed", "cancelled", "error"] as const;

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
 * The single refusal of this module. Coverage that cannot be recomputed from
 * the surface's own released format is not coverage: §5's
 * `execution.coverage-incomplete` is the same verdict whether a source is
 * missing from the inventory or a receipt disagrees with its bytes.
 */
function refuse(detail: string): never {
  throw new ExecutionError("execution.coverage-incomplete", detail);
}

const HEX64 = /^[0-9a-f]{64}$/;
const FLOOR = /^>=\d+\.\d+\.\d+$/;

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

/** A closed record with named optional members: missing optionals are allowed. */
function expectKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], what: string): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length === 0 && unknown.length === 0) return;
  refuse(
    `${what} must carry ${required.join(", ")}${optional.length > 0 ? ` (optionally ${optional.join(", ")})` : ""}` +
      `${missing.length > 0 ? `; it is missing ${missing.join(", ")}` : ""}` +
      `${unknown.length > 0 ? `; it carries unknown field(s) ${unknown.join(", ")}` : ""}.`,
  );
}

function expectString(value: unknown, what: string): string {
  if (!isNonEmptyString(value)) refuse(`${what} must be a nonblank string.`);
  return value;
}

function expectText(value: unknown, what: string): string {
  if (typeof value !== "string") refuse(`${what} must be a string.`);
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
    `${what} must be one of the 18 closed execution surfaces; got ${JSON.stringify(value)}. An unknown surface is not coverage.`,
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

/** The released harness path form: canonical and absolute. */
function expectAbsolutePath(value: unknown, what: string): string {
  const path = expectString(value, what);
  if (!path.startsWith("/")) refuse(`${what} (${path}) is not an absolute path; the released format records a canonical absolute path.`);
  return path;
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
    return refuse(`${what} is not UTF-8 text; a coverage source is a UTF-8 document.`);
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    return refuse(`${what} is not JSON (${(error as Error).message}); a malformed source is never re-interpreted.`);
  }
}

/**
 * A retained body decoded as a JSON object: the released legacy formats are
 * pretty-printed and are accepted as they are. Harness-produced documents use
 * `producedDocument` below, which additionally requires canonical bytes.
 */
function retainedObject(bytes: Uint8Array, what: string): Record<string, unknown> {
  return expectObject(parseJson(utf8(bytes, what), what), what);
}

/**
 * A document the harness itself produced (a consumer manifest, a host-history
 * export, a recovery inventory). These must be canonical §3.1 JSON, so the
 * bytes have exactly one meaning: a duplicated member, a reordered object or
 * any other ambiguity is refused here instead of being resolved by a parser.
 */
function producedDocument(bytes: Uint8Array, what: string): Record<string, unknown> {
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

/** The exact JSONL lines of one retained file, in order. */
function jsonlLines(bytes: Uint8Array, what: string): string[] {
  const lines = utf8(bytes, what).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  lines.forEach((line, index) => {
    if (line.trim() === "") refuse(`${what} line ${index + 1} is blank; a retained ledger line is an accepted record, never padding.`);
  });
  return lines;
}

/** One line decoded as an object with its exact byte digest. */
function jsonlRecord(line: string, what: string): Readonly<{ record: Record<string, unknown>; sha256: string }> {
  return { record: retainedObject(new TextEncoder().encode(line), what), sha256: bytesDigest(new TextEncoder().encode(line)) };
}

function basenameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

// ---------------------------------------------------------------------------
// Per-surface codecs
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

/** `core-v1`: the v2 root register plus one workflow snapshot per discovered workflow. */
function coreCodec(context: RowContext): unknown {
  const registers: Array<Readonly<{ path: string; sha256: string; workflows: readonly string[] }>> = [];
  const snapshots: Array<Readonly<{ path: string; sha256: string; workflowId: string }>> = [];
  for (const witness of context.sources) {
    const document = retainedObject(context.bytesOf(witness), `${context.label} source ${witness.path}`);
    if (document.schema_version === 1) {
      snapshots.push({
        path: witness.path,
        sha256: witness.sha256,
        workflowId: expectString(document.id, `${context.label} snapshot ${witness.path}.id`),
      });
      continue;
    }
    if (document.version === 2 && Array.isArray(document.workflows)) {
      const declared = document.workflows.map((entry, index) =>
        expectString(expectObject(entry, `${context.label} register ${witness.path} workflows[${index}]`).id, `${witness.path} workflows[${index}].id`),
      );
      const seen = new Set<string>();
      for (const workflowId of declared) {
        if (seen.has(workflowId)) {
          refuse(
            `${context.label}: the root register names workflow ${workflowId} twice; a duplicated authority row is refused, never folded into one ` +
              `discovered workflow.`,
          );
        }
        seen.add(workflowId);
      }
      registers.push({ path: witness.path, sha256: witness.sha256, workflows: [...declared].sort(compareText) });
      continue;
    }
    refuse(
      `${context.label}: the core source ${witness.path} is neither a v2 root register nor a workflow snapshot; an unknown core document is not ` +
        `coverage of the core authority.`,
    );
  }
  if (registers.length !== 1) refuse(`${context.label} carries ${registers.length} root registers; the core authority is one v2 register plus its snapshots.`);
  if (snapshots.length === 0) refuse(`${context.label} carries no workflow snapshot; the discovered workflow set is not provable from these bytes.`);
  const workflows = snapshots.map((snapshot) => snapshot.workflowId).sort(compareText);
  for (let index = 1; index < workflows.length; index++) {
    if (workflows[index] === workflows[index - 1]) refuse(`${context.label} carries two snapshots for workflow ${workflows[index]}; a duplicated discovery is not coverage.`);
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

/** `session-v1`: the released session envelope, bound to its workflow and role. */
function sessionCodec(context: RowContext): unknown {
  const owners = new Set<string>();
  const envelopes = context.sources.map((witness) => {
    const what = `${context.label} envelope ${witness.path}`;
    const document = retainedObject(context.bytesOf(witness), what);
    expectKeys(document, ["schema_version", "role", "session_id", "workflow_id", "harness_root"], ["plan_id"], what);
    if (document.schema_version !== 1) refuse(`${what}.schema_version must be 1; the released envelope is versioned, never guessed.`);
    const role = expectEnum(document.role, SESSION_ROLES, `${what}.role`);
    const sessionId = expectString(document.session_id, `${what}.session_id`);
    const workflowId = expectString(document.workflow_id, `${what}.workflow_id`);
    if (workflowId !== context.workflowId) {
      refuse(`${what} belongs to workflow ${workflowId}, not ${String(context.workflowId)}; a session envelope is never attributed to a sibling workflow.`);
    }
    const hasPlan = Object.prototype.hasOwnProperty.call(document, "plan_id");
    if (role === "coordinator" && hasPlan) refuse(`${what} is a coordinator envelope carrying plan_id ${JSON.stringify(document.plan_id)}; a coordinator association carries no plan.`);
    if (role === "plan-pm" && !hasPlan) refuse(`${what} is a plan-pm envelope with no plan_id; a plan association is never inferred.`);
    const planId = hasPlan ? expectString(document.plan_id, `${what}.plan_id`) : null;
    const harnessRoot = expectAbsolutePath(document.harness_root, `${what}.harness_root`);
    if (basenameOf(witness.path) !== `${role}-${sessionId}.json`) {
      refuse(
        `${what} is named ${basenameOf(witness.path)}, but the released envelope for ${role} session ${sessionId} is ` +
          `<role>-<session_id>.json; the envelope identity and its path must agree.`,
      );
    }
    if (owners.has(sessionId)) refuse(`${context.label} carries two envelopes for session ${sessionId}; a duplicated association is not coverage.`);
    owners.add(sessionId);
    return { root: witness.root, path: witness.path, sha256: witness.sha256, role, sessionId, planId, workflowId, harnessRoot };
  });
  return { sources: sourceRefs(context), format: "session-envelope", envelopes };
}

/** `notes-v1`: the legacy note body and the version 1 note record. */
function notesCodec(context: RowContext): unknown {
  const files = context.sources.map((witness) => {
    const what = `${context.label} notes file ${witness.path}`;
    if (basenameOf(witness.path) !== NOTES_FILE) {
      refuse(`${what} is not ${NOTES_FILE}; the notes surface pins its one retained ledger, never an unknown companion.`);
    }
    const file = bytesDigest(context.bytesOf(witness));
    const ids = new Set<string>();
    const records = jsonlLines(context.bytesOf(witness), what).map((line, index) => {
      const { record, sha256 } = jsonlRecord(line, `${what} line ${index + 1}`);
      const what_ = `${what} line ${index + 1}`;
      if (record.version === 1) {
        expectExactKeys(record, ["version", "id", "workflowId", "sessionId", "kind", "ts", "text"], what_);
        if (record.kind !== "note") refuse(`${what_}.kind must be "note"; an unknown record kind is not a retained note.`);
        const id = expectString(record.id, `${what_}.id`);
        const workflowId = expectString(record.workflowId, `${what_}.workflowId`);
        if (workflowId !== context.workflowId) {
          refuse(`${what_} names workflow ${workflowId}, not ${String(context.workflowId)}; a retained record is never attributed to a sibling workflow.`);
        }
        if (ids.has(id)) refuse(`${context.label}: note id ${id} is recorded twice; a duplicated accepted record is not coverage.`);
        ids.add(id);
        return {
          line: index,
          sha256,
          format: "notes-v1",
          id,
          sessionId: expectString(record.sessionId, `${what_}.sessionId`),
          ts: expectString(record.ts, `${what_}.ts`),
        };
      }
      expectExactKeys(record, ["kind", "ts", "text"], what_);
      if (record.kind !== "note") refuse(`${what_}.kind must be "note"; an unknown record kind is not a retained note.`);
      return {
        line: index,
        sha256,
        format: "notes-legacy",
        id: null,
        sessionId: null,
        ts: expectString(record.ts, `${what_}.ts`),
      };
    });
    return { root: witness.root, path: witness.path, sha256: witness.sha256, fileSha256: file, count: records.length, records };
  });
  return { sources: sourceRefs(context), format: "notes-jsonl", files };
}

/** One agent-flow ledger line validated against the released record union. */
function agentFlowRecord(line: string, what: string): Readonly<{ sha256: string; durable: boolean }> {
  const { record, sha256 } = jsonlRecord(line, what);
  if (record.v !== 1) refuse(`${what}.v must be 1; the ledger is versioned, never guessed.`);
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) refuse(`${what}.ts must be a finite number.`);
  const kind = expectEnum(record.kind, AGENT_FLOW_KINDS, `${what}.kind`);
  if (kind === "dispatch") {
    expectKeys(record, ["v", "ts", "kind", "role", "verdict", "hard"], ["agent", "planId", "taskId", "taskCategory"], what);
    expectText(record.role, `${what}.role`);
    expectEnum(record.verdict, DISPATCH_VERDICTS, `${what}.verdict`);
    if (typeof record.hard !== "boolean") refuse(`${what}.hard must be a boolean.`);
  } else if (kind === "settle") {
    expectKeys(record, ["v", "ts", "kind", "outcome"], ["agent", "durationMs", "role", "planId", "taskId", "childId", "taskRef"], what);
    expectEnum(record.outcome, SETTLE_OUTCOMES, `${what}.outcome`);
    if (record.durationMs !== undefined) expectInteger(record.durationMs, `${what}.durationMs`, 0);
  } else if (kind === "subagent-link") {
    expectKeys(record, ["v", "ts", "kind", "childId", "label", "role"], ["agent", "planId", "taskId", "taskRef"], what);
    expectString(record.childId, `${what}.childId`);
    expectText(record.label, `${what}.label`);
    expectText(record.role, `${what}.role`);
  } else if (kind === "workflow-verdict") {
    expectKeys(record, ["v", "ts", "kind", "tool", "mode", "verdict"], ["agent", "workflow", "objective", "code"], what);
    expectEnum(record.tool, WORKFLOW_TOOLS, `${what}.tool`);
    expectEnum(record.mode, WORKFLOW_GATE_MODES, `${what}.mode`);
    expectEnum(record.verdict, WORKFLOW_VERDICTS, `${what}.verdict`);
  } else if (kind === "workflow-run") {
    expectKeys(record, ["v", "ts", "kind", "runId", "name"], ["agent"], what);
    expectString(record.runId, `${what}.runId`);
    expectString(record.name, `${what}.name`);
  } else if (kind === "workflow-agent") {
    expectKeys(record, ["v", "ts", "kind", "runId", "seq", "label", "childId"], ["phase"], what);
    expectString(record.runId, `${what}.runId`);
    expectInteger(record.seq, `${what}.seq`, 1);
    expectString(record.label, `${what}.label`);
    expectString(record.childId, `${what}.childId`);
  } else {
    expectKeys(record, ["v", "ts", "kind", "runId", "stopReason"], [], what);
    expectString(record.runId, `${what}.runId`);
    expectEnum(record.stopReason, WORKFLOW_STOP_REASONS, `${what}.stopReason`);
  }
  if (record.agent !== undefined && record.agent !== "") expectString(record.agent, `${what}.agent`);
  return { sha256, durable: kind.startsWith("workflow-") };
}

/**
 * The workflow dir a canonical root-relative ledger companion belongs to, or
 * `null` when the path is none of the released companions. The tail and the
 * identity index sit directly in the workflow dir; a sealed history chunk sits
 * in its `agent-flow-history/` subdirectory. Configured roots only prepend
 * path segments, so the released level is recognized from the tail of the path.
 */
function agentFlowDirOf(path: string, name: string): string | null {
  if (name === AGENT_FLOW_TAIL_FILE || name === AGENT_FLOW_INDEX_FILE) {
    return path === name ? "" : path.slice(0, path.length - name.length - 1);
  }
  if (!/^chunk-\d{6}\.jsonl$/.test(name)) return null;
  const segments = path.split("/");
  return segments.length >= 3 && segments[segments.length - 2] === AGENT_FLOW_HISTORY_DIR ? segments.slice(0, -2).join("/") : null;
}

function agentFlowCodec(context: RowContext): unknown {
  let tail: Readonly<{ path: string; sha256: string; count: number; records: readonly unknown[] }> | null = null;
  let index: Readonly<{ path: string; sha256: string; count: number; entries: readonly unknown[] }> | null = null;
  const chunks: Array<Readonly<{ path: string; sha256: string; count: number; records: readonly unknown[] }>> = [];

  const dirs = new Set<string>();
  for (const witness of context.sources) {
    const name = basenameOf(witness.path);
    const what = `${context.label} ledger file ${witness.path}`;
    const dir = agentFlowDirOf(witness.path, name);
    if (dir === null) {
      refuse(
        `${context.label} assigns ${witness.path}, which is not the released agent-flow tail, its accepted-identity index or a sealed history chunk; ` +
          `an unknown companion of the ledger is never coverage.`,
      );
    }
    dirs.add(dir);
    if (name === AGENT_FLOW_TAIL_FILE) {
      if (tail !== null) refuse(`${context.label} assigns two live tails (${tail.path}, ${witness.path}); one workflow dir owns one tail.`);
      const records = jsonlLines(context.bytesOf(witness), what).map((line, position) => agentFlowRecord(line, `${what} line ${position + 1}`));
      tail = { path: witness.path, sha256: witness.sha256, count: records.length, records };
      continue;
    }
    if (name === AGENT_FLOW_INDEX_FILE) {
      if (index !== null) refuse(`${context.label} assigns two identity indexes (${index.path}, ${witness.path}); the dedup authority is one file.`);
      const entries = jsonlLines(context.bytesOf(witness), what).map((line, position) => {
        const entry_ = `${what} line ${position + 1}`;
        const { record } = jsonlRecord(line, entry_);
        expectExactKeys(record, ["id", "d"], entry_);
        const id = expectString(record.id, `${entry_}.id`);
        if (!id.startsWith(WORKFLOW_EVENT_ID_PREFIX)) {
          refuse(`${entry_}.id ${id} is not a durable workflow-event identity (${WORKFLOW_EVENT_ID_PREFIX}\u2026); live tool-call rows are never indexed.`);
        }
        const d = expectString(record.d, `${entry_}.d`);
        if (!/^[0-9a-f]{32}$/.test(d)) refuse(`${entry_}.d must be the first 32 lowercase hex characters of the line digest.`);
        return { id, d };
      });
      const seen = new Map<string, string>();
      for (const entry of entries) {
        const prior = seen.get(entry.id);
        if (prior === undefined) {
          seen.set(entry.id, entry.d);
          continue;
        }
        if (prior !== entry.d) {
          refuse(
            `${context.label}: identity index entry ${entry.id} appears with two different digests (${prior}, ${entry.d}); a reused identity with ` +
              `different bytes is a refusal, never a silent second accepted row.`,
          );
        }
      }
      index = { path: witness.path, sha256: witness.sha256, count: entries.length, entries };
      continue;
    }
    const records = jsonlLines(context.bytesOf(witness), what).map((line, position) => agentFlowRecord(line, `${what} line ${position + 1}`));
    chunks.push({ path: witness.path, sha256: witness.sha256, count: records.length, records });
  }
  if (dirs.size !== 1) {
    refuse(
      `${context.label}: the agent-flow tail, its accepted-identity index and its sealed history chunks live in ONE workflow dir, but the assignment ` +
        `names ${[...dirs].sort(compareText).join(", ")}; companions of different workflow dirs are never one retained ledger.`,
    );
  }

  if (tail === null && chunks.length === 0 && index === null) {
    refuse(`${context.label} assigns no ledger file at all; an agent-flow row without its retained bytes is not coverage.`);
  }
  const durableRows = [
    ...(tail === null ? [] : tail.records),
    ...chunks.flatMap((chunk) => chunk.records),
  ].filter((record) => (record as { durable: boolean }).durable) as ReadonlyArray<{ sha256: string }>;
  const indexedDigests = index === null ? [] : [...new Set((index.entries as ReadonlyArray<{ id: string; d: string }>).map((entry) => entry.d))];
  if (index === null && durableRows.length > 0) {
    refuse(
      `${context.label} retains ${durableRows.length} durable ledger row(s) but assigns no ${AGENT_FLOW_INDEX_FILE}; a missing identity index is ` +
        `never an empty history, and the dedup authority is required input.`,
    );
  }
  if (index !== null) {
    for (const digit of indexedDigests) {
      if (!durableRows.some((record) => record.sha256.startsWith(digit))) {
        refuse(
          `${context.label}: identity index digest ${digit} names no retained durable row in the assigned tail or history chunks; an index entry whose ` +
            `row is missing means the retained set is incomplete.`,
        );
      }
    }
    for (const chunk of chunks) {
      for (const record of chunk.records) {
        if (!(record as { durable: boolean }).durable) continue;
        const digest = (record as { sha256: string }).sha256;
        if (!indexedDigests.some((digit) => digest.startsWith(digit))) {
          refuse(
            `${context.label}: an archived durable row of ${chunk.path} has no identity-index entry; an unindexed row that left the live dedup window ` +
              `is not complete coverage.`,
          );
        }
      }
    }
  }
  return { sources: sourceRefs(context), format: "agent-flow-v2", tail, index, history: chunks };
}

/** `selection-v1` for `workflow-ledger-cursors`: the versioned cursor sidecar. */
function cursorCodec(context: RowContext): unknown {
  const files = context.sources.map((witness) => {
    const what = `${context.label} cursor sidecar ${witness.path}`;
    if (basenameOf(witness.path) !== CURSOR_FILE) {
      refuse(`${what} is not ${CURSOR_FILE}; the cursor surface pins its one versioned sidecar, never an unknown companion.`);
    }
    const document = retainedObject(context.bytesOf(witness), what);
    expectExactKeys(document, ["v", "cursors"], what);
    const version = document.v;
    if (version !== 1 && version !== 2) refuse(`${what}.v must be 1 or 2; any other version is unreadable, never a scan bound.`);
    const entries = expectObject(document.cursors, `${what}.cursors`);
    const cursors = Object.keys(entries)
      .sort(compareText)
      .map((sessionId) => {
        if (sessionId === "") refuse(`${what}.cursors carries an empty session key.`);
        const value = entries[sessionId];
        if (version === 1) {
          return { sessionId, next: expectInteger(value, `${what}.cursors.${sessionId}`, 1), stream: null };
        }
        const entry = expectObject(value, `${what}.cursors.${sessionId}`);
        expectKeys(entry, ["next"], ["stream"], `${what}.cursors.${sessionId}`);
        const stream = entry.stream === undefined ? null : expectString(entry.stream, `${what}.cursors.${sessionId}.stream`);
        return { sessionId, next: expectInteger(entry.next, `${what}.cursors.${sessionId}.next`, 1), stream };
      });
    return { root: witness.root, path: witness.path, sha256: witness.sha256, version, count: cursors.length, cursors };
  });
  return { sources: sourceRefs(context), format: "ledger-cursors", files };
}

/** `selection-v1` for `engine-status-snapshot`: the durable snapshot envelope. */
function engineStatusCodec(context: RowContext): unknown {
  const files = context.sources.map((witness) => {
    const what = `${context.label} engine-status snapshot ${witness.path}`;
    if (witness.path !== ENGINE_STATUS_FILE) {
      refuse(`${what} is not ${ENGINE_STATUS_FILE}; the status surface pins its one durable snapshot envelope.`);
    }
    const document = retainedObject(context.bytesOf(witness), what);
    expectKeys(document, ["sv", "entries"], ["bindings"], what);
    if (document.sv !== 1) refuse(`${what}.sv must be 1; an unrecognized envelope version is unavailable, never parsed.`);
    const entries = expectObject(document.entries, `${what}.entries`);
    const sessions = Object.keys(entries)
      .sort(compareText)
      .map((sessionId) => ({
        sessionId,
        entries: expectArray(entries[sessionId], `${what}.entries.${sessionId}`).map((entry, position) => {
          const where = `${what}.entries.${sessionId}[${position}]`;
          const record = expectObject(entry, where);
          expectExactKeys(record, ["rv", "cwd", "at", "turn", "payload"], where);
          if (record.rv !== 1) refuse(`${where}.rv must be 1; an unknown entry version is unavailable, never parsed.`);
          return {
            rv: 1,
            cwd: expectAbsolutePath(record.cwd, `${where}.cwd`),
            at: expectString(record.at, `${where}.at`),
            turn: expectInteger(record.turn, `${where}.turn`, 0),
            payload: expectObject(record.payload, `${where}.payload`),
          };
        }),
      }));
    const bindings = expectObject(document.bindings, `${what}.bindings`);
    const selections = Object.keys(bindings)
      .sort(compareText)
      .map((sessionId) => {
        const where = `${what}.bindings.${sessionId}`;
        const binding = expectObject(bindings[sessionId], where);
        expectExactKeys(binding, ["cwd", "selectedWorkflowId", "excludedBeforeSeq"], where);
        return {
          sessionId,
          cwd: expectAbsolutePath(binding.cwd, `${where}.cwd`),
          selectedWorkflowId: expectString(binding.selectedWorkflowId, `${where}.selectedWorkflowId`),
          excludedBeforeSeq: expectInteger(binding.excludedBeforeSeq, `${where}.excludedBeforeSeq`, 0),
        };
      });
    return { root: witness.root, path: witness.path, sha256: witness.sha256, sessions, selections };
  });
  return { sources: sourceRefs(context), format: "engine-status-v1", files };
}

/** `omp-launch-v2`: the plugin transport journal and its closed intent states. */
function launchJournalCodec(context: RowContext): unknown {
  const files = context.sources.map((witness) => {
    const what = `${context.label} launch journal ${witness.path}`;
    if (basenameOf(witness.path) !== LAUNCH_JOURNAL_FILE) {
      refuse(`${what} is not ${LAUNCH_JOURNAL_FILE}; the launch surface pins its one transport journal.`);
    }
    const document = retainedObject(context.bytesOf(witness), what);
    expectExactKeys(document, ["version", "workflow_id", "coordinator", "intents"], what);
    if (document.version !== 1) refuse(`${what}.version must be 1; a journal this build cannot trust is never coverage.`);
    const workflowId = expectString(document.workflow_id, `${what}.workflow_id`);
    if (workflowId !== context.workflowId) {
      refuse(`${what} belongs to workflow ${workflowId}, not ${String(context.workflowId)}; a launch journal is inventoried under the workflow that owns it.`);
    }
    const coordinator = expectObject(document.coordinator, `${what}.coordinator`);
    expectExactKeys(coordinator, ["session_id", "session_file"], `${what}.coordinator`);
    const coordinatorSessionId = expectString(coordinator.session_id, `${what}.coordinator.session_id`);
    const coordinatorSessionFile = expectAbsolutePath(coordinator.session_file, `${what}.coordinator.session_file`);
    const intents = expectArray(document.intents, `${what}.intents`).map((entry, position) => {
      const where = `${what}.intents[${position}]`;
      const intent = expectObject(entry, where);
      expectKeys(
        intent,
        ["id", "workflowId", "coordinatorSessionId", "planId", "preparedHash", "assignmentPath", "worktreePath", "transport", "state", "evidencePaths"],
        ["target"],
        where,
      );
      const intentWorkflow = expectString(intent.workflowId, `${where}.workflowId`);
      if (intentWorkflow !== context.workflowId) {
        refuse(`${where}.workflowId ${intentWorkflow} is not ${String(context.workflowId)}; an intent belongs to the workflow that recorded it.`);
      }
      return {
        id: expectString(intent.id, `${where}.id`),
        planId: expectString(intent.planId, `${where}.planId`),
        coordinatorSessionId: expectString(intent.coordinatorSessionId, `${where}.coordinatorSessionId`),
        preparedHash: expectString(intent.preparedHash, `${where}.preparedHash`),
        assignmentPath: expectAbsolutePath(intent.assignmentPath, `${where}.assignmentPath`),
        worktreePath: expectAbsolutePath(intent.worktreePath, `${where}.worktreePath`),
        transport: expectEnum(intent.transport, LAUNCH_TRANSPORTS, `${where}.transport`),
        state: expectEnum(intent.state, LAUNCH_STATES, `${where}.state`),
        target: intent.target === undefined ? null : expectString(intent.target, `${where}.target`),
        evidencePaths: expectArray(intent.evidencePaths, `${where}.evidencePaths`).map((path, index) =>
          expectAbsolutePath(path, `${where}.evidencePaths[${index}]`),
        ),
      };
    });
    const ids = new Set<string>();
    const inFlight = new Set<string>();
    for (const intent of intents) {
      if (ids.has(intent.id)) refuse(`${context.label}: launch intent ${intent.id} is recorded twice; a duplicated intent is not coverage.`);
      ids.add(intent.id);
      if (intent.coordinatorSessionId !== coordinatorSessionId) {
        refuse(`${context.label}: launch intent ${intent.id} names coordinator ${intent.coordinatorSessionId}, but the journal belongs to ${coordinatorSessionId}.`);
      }
      if (LAUNCH_IN_FLIGHT.includes(intent.state)) {
        if (inFlight.has(intent.planId)) {
          refuse(
            `${context.label}: plan ${intent.planId} holds two in-flight launch intents; the released journal admits one owner per plan, so a second ` +
              `live owner is not coverage.`,
          );
        }
        inFlight.add(intent.planId);
      }
    }
    return {
      root: witness.root,
      path: witness.path,
      sha256: witness.sha256,
      workflowId,
      coordinator: { sessionId: coordinatorSessionId, sessionFile: coordinatorSessionFile },
      count: intents.length,
      intents,
    };
  });
  return { sources: sourceRefs(context), format: "omp-launch-v1", files };
}

/**
 * `omp-hidden-v1`: H1's canonical host-history export is decoded and its
 * identities validated, but §4.2 requires the explicit host inventory and the
 * stop/adoption attestation that H2's evidence-file wrapper carries. That
 * wrapper does not exist yet, so a populated row refuses instead of presenting
 * the export alone as complete retain coverage.
 */
function hiddenCodec(context: RowContext): unknown {
  const files = context.sources.map((witness) => {
    const what = `${context.label} host-history export ${witness.path}`;
    const document = producedDocument(context.bytesOf(witness), what);
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
    const entryIds = new Set<string>();
    const dedupKeys = new Set<string>();
    const records = expectArray(document.records, `${what}.records`).map((entry, index) => {
      const where = `${what}.records[${index}]`;
      const record = expectObject(entry, where);
      expectExactKeys(record, ["index", "entryId", "type", "sessionId", "payloadHash", "payload", "view"], where);
      if (record.index !== index) refuse(`${where}.index must be ${index}; the native ledger order is the published order.`);
      const type = expectEnum(record.type, HOST_HISTORY_KINDS, `${where}.type`);
      const entryId = expectString(record.entryId, `${where}.entryId`);
      if (entryIds.has(entryId)) refuse(`${context.label}: host-history entry id ${entryId} is recorded twice; a duplicated native entry is not coverage.`);
      entryIds.add(entryId);
      const sessionId = expectString(record.sessionId, `${where}.sessionId`);
      const payloadHash = expectHex64(record.payloadHash, `${where}.payloadHash`);
      const recomputed = digestOf(record.payload);
      if (payloadHash !== recomputed) {
        refuse(
          `${where}.payloadHash ${payloadHash} does not hash the payload it publishes (${recomputed}); a payload digest is recomputed from the bytes, ` +
            `never carried on trust.`,
        );
      }
      const view = expectObject(record.view, `${where}.view`);
      expectExactKeys(
        view,
        ["generation", "declaredKind", "declaredAction", "declaredState", "workflowId", "checkpointId", "operationId", "dedupKey", "cancelled", "provenance"],
        `${where}.view`,
      );
      if (view.generation !== 1) refuse(`${where}.view.generation must be 1; generation 1 is the only decoded generation.`);
      const recordWorkflow = expectString(view.workflowId, `${where}.view.workflowId`);
      if (recordWorkflow !== context.workflowId) {
        refuse(`${where} belongs to workflow ${recordWorkflow}, not ${String(context.workflowId)}; a hidden-history record is never attributed to a sibling workflow.`);
      }
      const declaredState = expectEnum(view.declaredState, HOST_HISTORY_STATES, `${where}.view.declaredState`);
      if (typeof view.cancelled !== "boolean") refuse(`${where}.view.cancelled must be a boolean.`);
      const checkpointId = view.checkpointId === null ? null : expectString(view.checkpointId, `${where}.view.checkpointId`);
      const operationId = view.operationId === null ? null : expectString(view.operationId, `${where}.view.operationId`);
      const dedupKey = view.dedupKey === null ? null : expectString(view.dedupKey, `${where}.view.dedupKey`);
      if (dedupKey !== (operationId ?? checkpointId)) refuse(`${where}.view.dedupKey must be the operation id or the checkpoint id it dedups on.`);
      if (declaredState === "handed_off" && dedupKey === null) {
        refuse(`${where} records a one-shot handoff with neither an operation id nor a checkpoint id; the handoff has no dedup identity.`);
      }
      if (dedupKey !== null) {
        if (dedupKeys.has(dedupKey)) refuse(`${context.label}: hidden-history dedup identity ${dedupKey} is recorded twice; a replayed native entry is not coverage.`);
        dedupKeys.add(dedupKey);
      }
      for (const item of expectArray(view.provenance, `${where}.view.provenance`)) {
        const field = expectObject(item, `${where}.view.provenance[]`);
        expectExactKeys(field, ["field", "path"], `${where}.view.provenance[]`);
        expectString(field.field, `${where}.view.provenance[].field`);
        expectString(field.path, `${where}.view.provenance[].path`);
      }
      return { index, entryId, type, sessionId, payloadHash, workflowId: recordWorkflow, declaredState, cancelled: view.cancelled, checkpointId, dedupKey };
    });
    const sessions = [...new Set(records.map((record) => record.sessionId))].sort(compareText);
    if (sessions.length === 0) {
      refuse(`${what} names no decoded native session; a hidden-history row covers the sessions its export publishes, so an empty export is an absent row.`);
    }
    return { root: witness.root, path: witness.path, sha256: witness.sha256, document: "execution-host-history", count: records.length, sessions, records };
  });
  refuse(
    `${context.label} cannot be populated yet: the retained host export is decoded, but \u00a74.2 also requires the explicit host session inventory and the ` +
      `stop/adoption attestation, which H2's evidence-file wrapper carries and which no reviewed producer publishes yet. The H1 export alone is not ` +
      `complete retain coverage.`,
  );
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

/** One R1 artifact closure (`sources` / `generated`). */
type ArtifactSet = Readonly<{
  trees: ReadonlyArray<Readonly<{ root: string; files: number; sha256: string }>>;
  files: ReadonlyArray<Readonly<{ path: string; sha256: string }>>;
}>;

function expectArtifactSet(value: unknown, what: string): ArtifactSet {
  const record = expectObject(value, what);
  expectExactKeys(record, ["trees", "files"], what);
  return {
    trees: expectArray(record.trees, `${what}.trees`).map((entry, index) => {
      const where = `${what}.trees[${index}]`;
      const tree = expectObject(entry, where);
      expectExactKeys(tree, ["root", "files", "sha256"], where);
      return {
        root: expectWitnessPath(tree.root, `${where}.root`),
        files: expectInteger(tree.files, `${where}.files`, 0),
        sha256: expectHex64(tree.sha256, `${where}.sha256`),
      };
    }),
    files: expectArray(record.files, `${what}.files`).map((entry, index) => {
      const where = `${what}.files[${index}]`;
      const file = expectObject(entry, where);
      expectExactKeys(file, ["path", "sha256"], where);
      return { path: expectWitnessPath(file.path, `${where}.path`), sha256: expectHex64(file.sha256, `${where}.sha256`) };
    }),
  };
}

/** The R1 `ExecutionConsumerEntry` of one consumer manifest, decoded as written. */
type ConsumerEntry = Readonly<{
  path: string;
  sha256: string;
  id: string;
  packageRoot: string;
  capability: string;
  capabilityNote: string | null;
  entrypoint: string;
  runtime: Readonly<{ target: string; floor: string; declaration: string }>;
  sources: ArtifactSet;
  generated: ArtifactSet;
  copiedInstructions: ReadonlyArray<Readonly<{ sourceRoot: string; targetRoot: string; mode: string; files: number; sha256: string }>>;
}>;

/** A repo-relative layout path: R1 records `.` for the repository root. */
function expectLayoutPath(value: unknown, what: string): string {
  if (value === ".") return ".";
  return expectWitnessPath(value, what);
}

function expectConsumerManifest(context: RowContext, witness: CoverageWitness): ConsumerEntry {
  const what = `${context.label} consumer manifest ${witness.path}`;
  const manifest = producedDocument(context.bytesOf(witness), what);
  expectExactKeys(manifest, ["version", "protocol", "repoRoot", "consumers"], what);
  if (manifest.version !== 1) refuse(`${what}.version must be 1.`);
  if (manifest.protocol !== "consumer-v1") refuse(`${what}.protocol must be consumer-v1; this module decodes no other consumer manifest protocol.`);
  expectString(manifest.repoRoot, `${what}.repoRoot`);
  const consumers = expectArray(manifest.consumers, `${what}.consumers`);
  if (consumers.length !== 1) {
    refuse(`${what} carries ${consumers.length} consumer entries; the producer writes one manifest per consumer, so one entry is the released shape.`);
  }
  const entry = expectObject(consumers[0], `${what}.consumers[0]`);
  expectExactKeys(
    entry,
    ["id", "packageRoot", "capability", "capabilityNote", "entrypoint", "runtime", "sources", "generated", "copiedInstructions"],
    `${what}.consumers[0]`,
  );
  const runtime = expectObject(entry.runtime, `${what}.consumers[0].runtime`);
  expectExactKeys(runtime, ["target", "floor", "declaration"], `${what}.consumers[0].runtime`);
  const floor = expectString(runtime.floor, `${what}.consumers[0].runtime.floor`);
  if (!FLOOR.test(floor)) refuse(`${what}.consumers[0].runtime.floor must be an exact >=x.y.z floor; got ${JSON.stringify(floor)}.`);
  const copiedInstructions = expectArray(entry.copiedInstructions, `${what}.consumers[0].copiedInstructions`).map((item, index) => {
    const where = `${what}.consumers[0].copiedInstructions[${index}]`;
    const copy = expectObject(item, where);
    expectExactKeys(copy, ["sourceRoot", "targetRoot", "mode", "files", "sha256"], where);
    return {
      sourceRoot: expectWitnessPath(copy.sourceRoot, `${where}.sourceRoot`),
      targetRoot: expectWitnessPath(copy.targetRoot, `${where}.targetRoot`),
      mode: expectEnum(copy.mode, COPY_MODES, `${where}.mode`),
      files: expectInteger(copy.files, `${where}.files`, 0),
      sha256: expectHex64(copy.sha256, `${where}.sha256`),
    };
  });
  return {
    path: witness.path,
    sha256: witness.sha256,
    id: expectString(entry.id, `${what}.consumers[0].id`),
    packageRoot: expectLayoutPath(entry.packageRoot, `${what}.consumers[0].packageRoot`),
    capability: expectEnum(entry.capability, CONSUMER_CAPABILITIES, `${what}.consumers[0].capability`),
    capabilityNote: entry.capabilityNote === null ? null : expectString(entry.capabilityNote, `${what}.consumers[0].capabilityNote`),
    entrypoint: expectWitnessPath(entry.entrypoint, `${what}.consumers[0].entrypoint`),
    runtime: {
      target: expectEnum(runtime.target, RUNTIME_TARGETS, `${what}.consumers[0].runtime.target`),
      floor,
      declaration: expectEnum(runtime.declaration, RUNTIME_DECLARATIONS, `${what}.consumers[0].runtime.declaration`),
    },
    sources: expectArtifactSet(entry.sources, `${what}.consumers[0].sources`),
    generated: expectArtifactSet(entry.generated, `${what}.consumers[0].generated`),
    copiedInstructions,
  };
}

/**
 * `consumer-v1`: R1's reviewed consumer manifest, decoded as R1 writes it. The
 * manifest records the source/generated closures and digests; the assigned
 * source witnesses must be exactly the bytes those closures name, and the
 * declared capability must be the one R1 declares for this surface.
 */
function consumerCodec(context: RowContext): unknown {
  const allowed = SURFACE_CONSUMERS[context.surface];
  if (allowed === undefined) refuse(`${context.label} is not an R1 consumer surface.`);
  if (context.evidence.length !== 1) {
    refuse(`${context.label} carries ${context.evidence.length} evidence document(s); a consumer surface carries exactly one R1 producer manifest.`);
  }
  const manifest = expectConsumerManifest(context, context.evidence[0]);
  if (!allowed.includes(manifest.id)) {
    refuse(`${context.label} carries the manifest of consumer ${manifest.id}; this surface covers ${allowed.join(", ")}, and a manifest is never reused.`);
  }
  const requiredCapability = R1_CONSUMER_CAPABILITY[manifest.id];
  if (manifest.capability !== requiredCapability) {
    refuse(
      `${context.label} declares capability ${manifest.capability} while R1 declares ${requiredCapability} for consumer ${manifest.id}; a consumer ` +
        `receipt cannot relabel the authority it provides.`,
    );
  }
  if (manifest.capability !== "writer" && manifest.capabilityNote === null) {
    refuse(`${context.label} declares ${manifest.capability} without a capability note; the released manifest explains every non-writer capability.`);
  }
  if (context.surface === "copied-instructions" && manifest.copiedInstructions.length === 0) {
    refuse(`${context.label} declares no copied-instruction tree; the copied-instruction surface covers the corpus a consumer actually bundles.`);
  }
  const claimed = new Set<string>();
  const claimFile = (path: string, sha256: string, what: string): void => {
    const witness = context.sources.find((candidate) => candidate.path === path && candidate.sha256 === sha256);
    if (witness === undefined) {
      refuse(`${what} (${path}) is not an assigned source witness of this receipt; a manifest digest that names no supplied byte proves nothing.`);
    }
    claimed.add(coverageWitnessKey(witness.root, witness.path));
  };
  for (const set of [manifest.sources, manifest.generated]) {
    for (const file of set.files) claimFile(file.path, file.sha256, `${context.label} manifest file`);
  }
  const entrypoint = [...manifest.sources.files, ...manifest.generated.files].find((file) => file.path === manifest.entrypoint);
  if (entrypoint === undefined) {
    refuse(`${context.label} records entrypoint ${manifest.entrypoint}, which appears in no source or generated file entry; the entry artifact must be inventoried.`);
  }
  claimFile(entrypoint.path, entrypoint.sha256, `${context.label} manifest entrypoint`);
  const uncovered = context.sources.filter((witness) => {
    if (claimed.has(coverageWitnessKey(witness.root, witness.path))) return false;
    const roots = [...manifest.sources.trees, ...manifest.generated.trees].map((tree) => tree.root);
    return !roots.some((root) => root === "." || witness.path.startsWith(`${root}/`));
  });
  if (uncovered.length > 0) {
    refuse(
      `${context.label} assigns source witness(es) ${uncovered.map((witness) => witness.path).join(", ")} that the consumer manifest describes in no ` +
        `file entry and no declared closure tree; the assignment and the manifest must describe the same bytes.`,
    );
  }
  return { sources: sourceRefs(context), format: "consumer-v1", manifest };
}

/** `consumer-v1` for the injected store inventory: no reviewed producer exists yet. */
function injectorCodec(context: RowContext): unknown {
  refuse(
    `${context.label} cannot be populated yet: no reviewed injector-inventory producer exists beside R1's consumer manifest, and \u00a74.2's deployed ` +
      `injector inventory is not a shape this module may invent.`,
  );
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
  const document = producedDocument(context.bytesOf(context.evidence[0]), `${context.label} recovery inventory`);
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
  "workflow-notes-ledger": notesCodec,
  "workflow-agent-flow-ledger": agentFlowCodec,
  "workflow-ledger-cursors": cursorCodec,
  "engine-status-snapshot": engineStatusCodec,
  "workflow-omp-launch-journal": launchJournalCodec,
  "omp-hidden-entries": hiddenCodec,
  "sdd-evidence": retainedBodyCodec,
  "artifact-store-injectors": injectorCodec,
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
 * receipt's result is RECOMPUTED from the bytes it names through the codec of
 * its own surface, so a self-consistent hash over an invented document proves
 * nothing.
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
