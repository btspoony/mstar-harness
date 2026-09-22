/**
 * execution-coverage.ts — the pure coverage substrate of the execution
 * authority (architecture contract §4.1): the closed 18-surface inventory, the
 * per-surface protocol validators, canonical receipt hashing and the
 * exact-set/witness validation of a coverage set against a frozen manifest.
 *
 * The module is deliberately pure: it opens no file, loads no driver and
 * imports no host package. Evidence bytes are handed in; the validator hashes
 * them, decodes the bounded evidence document and RECOMPUTES the facts a
 * receipt claims. A self-consistent hash alone therefore proves nothing: a
 * fabricated boolean acknowledgement has no closed schema to satisfy, and a
 * receipt whose facts disagree with the bytes it names is refused.
 *
 * `ExecutionCoverageManifest` is this module's small manifest view, not the
 * migration module's `ExecutionManifest` (§4.1). The root task compiles without
 * a type cycle, and C3 builds this view from the version-2 manifest it just
 * hashed. C3 owns every piece of IO around this module — safe reads, symlink
 * and canonical-root checks, fresh bytes — plus the public barrel export.
 *
 * Receipt identity is `(surface, workflowId)`. Workflow-scoped surfaces repeat
 * for every discovered workflow, so one global receipt can never hide a sibling
 * workflow; root-scoped surfaces carry a null `workflowId` and are refused if
 * they claim one. The manifest is a CLOSED inventory too: it carries every
 * root-scoped surface once and every workflow-scoped surface once per
 * discovered workflow, so a surface is never dropped by omission — a surface
 * with nothing discovered is an `absent` row.
 *
 * `protocol` is a closed validator-version mapping, one version per surface
 * group. A receipt does not choose its validator: the surface does, and an
 * unknown value refuses.
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

/** The closed validator versions (§4.1). */
export const EXECUTION_COVERAGE_PROTOCOLS = [
  "session-v1",
  "notes-v1",
  "agent-flow-v2",
  "selection-v1",
  "omp-launch-v2",
  "omp-hidden-v1",
  "retained-body-v1",
  "consumer-v1",
  "recovery-v1",
  "core-v1",
] as const;

export type CoverageProtocol = (typeof EXECUTION_COVERAGE_PROTOCOLS)[number];

export type CoverageDisposition = "absent" | "retain" | "migrate" | "retire";

/** The configured roots a witness path is relative to. */
export type CoverageRoot = "control" | "sdd" | "host" | "package";

export type CoverageWitness = Readonly<{ root: CoverageRoot; path: string; sha256: string }>;

export type ExecutionCoverageReceipt = Readonly<{
  version: 1;
  surface: ExecutionSurface;
  workflowId: string | null;
  manifestId: string;
  manifestHash: string;
  storeId: string;
  epoch: number;
  disposition: CoverageDisposition;
  protocol: CoverageProtocol;
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
  surfaces: readonly Readonly<{ surface: ExecutionSurface; workflowId: string | null }>[];
  sources: readonly CoverageWitness[];
}>;

/** Evidence bytes keyed by `${root}:${path}` — the only proof a validator accepts. */
export type ExecutionCoverageEvidence = ReadonlyMap<string, Uint8Array>;

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
const SURFACE_PROTOCOLS: Readonly<Record<ExecutionSurface, CoverageProtocol>> = {
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
const SURFACE_DISPOSITIONS: Readonly<Record<ExecutionSurface, readonly CoverageDisposition[]>> = {
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

const COVERAGE_ROOTS: readonly CoverageRoot[] = ["control", "sdd", "host", "package"];
const COVERAGE_DISPOSITIONS: readonly CoverageDisposition[] = ["absent", "retain", "migrate", "retire"];
const ENVELOPE_ROLES = ["coordinator", "plan-pm"] as const;
const ENVELOPE_STATES = ["suspended", "revoked"] as const;
const ENVELOPE_ARCHIVE = ["pending", "archived"] as const;
const LAUNCH_STATES = ["reserved", "occupied", "settled", "reconciled"] as const;
const PACKAGE_CAPABILITIES = ["writer", "read-only", "decision-only", "body-only"] as const;
const RUNTIME_TARGETS = ["node", "bun"] as const;
const HIDDEN_ENTRY_NAMES = [
  "mstar:phase2",
  "mstar:phase2-continuation",
  "mstar:phase2-checkpoint",
  "mstar:phase2-launch-reservation",
  "mstar:model-handoff",
] as const;

/** The configured root a surface's witnesses are pinned to, and its scope. */
export function executionCoverageSurfaceScope(surface: ExecutionSurface): "root" | "workflow" {
  return (WORKFLOW_SCOPED_SURFACES as readonly string[]).includes(surface) ? "workflow" : "root";
}

/** The one validator version that owns a surface. */
export function executionCoverageProtocolFor(surface: ExecutionSurface): CoverageProtocol {
  return SURFACE_PROTOCOLS[surface];
}

/** The dispositions a surface may declare. */
export function executionCoverageAllowedDispositions(surface: ExecutionSurface): readonly CoverageDisposition[] {
  return SURFACE_DISPOSITIONS[surface];
}

/** The evidence-map key of a witness: one configured root plus its relative path. */
export function coverageWitnessKey(root: CoverageRoot, path: string): string {
  return `${root}:${path}`;
}

// ---------------------------------------------------------------------------
// Refusals and small typed predicates
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
  if (!isPlainObject(value)) refuse(`${what} must be a plain JSON object; free-text or scalar coverage is never accepted.`);
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
      `A coverage document is a closed schema, never free-form prose.`,
  );
}

function expectString(value: unknown, what: string): string {
  if (!isNonEmptyString(value)) refuse(`${what} must be a nonblank string.`);
  return value;
}

function expectNullableId(value: unknown, what: string): string | null {
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

function expectProtocol(value: unknown, what: string): CoverageProtocol {
  if (typeof value === "string" && (EXECUTION_COVERAGE_PROTOCOLS as readonly string[]).includes(value)) {
    return value as CoverageProtocol;
  }
  refuse(
    `${what} must be one of the closed validator versions ${EXECUTION_COVERAGE_PROTOCOLS.join(", ")}; ` +
      `got ${JSON.stringify(value)}. An unknown protocol never validates coverage.`,
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
    if (order > 0) refuse(`${what} is not in canonical order; sources sort by root then path, so an unchanged inventory always reads back identically.`);
    if (order === 0) refuse(`${what} repeats the witness ${coverageWitnessKey(items[index].root, items[index].path)}; duplicates refuse.`);
  }
  return items;
}

function expectList<T>(
  value: unknown,
  what: string,
  build: (entry: unknown, where: string) => T,
  compare: (left: T, right: T) => number,
  order: string,
): readonly T[] {
  const items = expectArray(value, what).map((entry, index) => build(entry, `${what}[${index}]`));
  for (let index = 1; index < items.length; index++) {
    const comparison = compare(items[index - 1], items[index]);
    if (comparison > 0) refuse(`${what} is not sorted by ${order}; a canonical list is a function of its content, never of discovery order.`);
    if (comparison === 0) refuse(`${what} repeats the same ${order} row; duplicates refuse.`);
  }
  return items;
}

/** The §3.1 canonical value digest used for every result and set hash. */
function digestOf(value: unknown): string {
  return createHash("sha256").update(serializeExecutionValue(value), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Result hashing (§4.1)
// ---------------------------------------------------------------------------

/**
 * The canonical `resultHash` of one receipt: the canonical digest of the
 * surface identity, the disposition and the surface-specific normalized facts.
 * An `absent` row has no facts — its digest covers the absence itself, so a
 * missing surface cannot borrow the result of a populated one.
 *
 * This is the single normalization point: `validateExecutionCoverage`
 * recomputes a receipt's `resultHash` through this function, and a producer
 * computes the same value from the same facts.
 */
export function executionCoverageResultHash(
  entry: Readonly<{
    surface: ExecutionSurface;
    workflowId: string | null;
    disposition: CoverageDisposition;
    facts?: unknown;
  }>,
): string {
  const record = expectObject(entry, "a coverage result");
  const unknown = Object.keys(record).filter((key) => !["surface", "workflowId", "disposition", "facts"].includes(key));
  if (unknown.length > 0) refuse(`a coverage result carries unknown field(s) ${unknown.join(", ")}; the normalized result is a closed value.`);
  const surface = expectSurface(record.surface, "a coverage result.surface");
  const workflowId = expectNullableId(record.workflowId, "a coverage result.workflowId");
  expectScope(surface, workflowId, "a coverage result");
  const disposition = expectEnum(record.disposition, COVERAGE_DISPOSITIONS, "a coverage result.disposition");
  if (disposition === "absent") {
    if (record.facts !== undefined) refuse("an absent row has no facts; only a populated row carries a result.");
    return digestOf({ surface, workflowId, disposition: "absent" });
  }
  if (record.facts === undefined) refuse("a populated row must carry the normalized facts its resultHash covers.");
  return digestOf({ surface, workflowId, disposition, facts: record.facts });
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
  const workflowId = expectNullableId(record.workflowId, `${what}.workflowId`);
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

/** Receipt identity order: surface in the contract's order, then workflowId (null first). */
function compareReceiptIdentity(
  left: Readonly<{ surface: ExecutionSurface; workflowId: string | null }>,
  right: Readonly<{ surface: ExecutionSurface; workflowId: string | null }>,
): number {
  const bySurface = (EXECUTION_COVERAGE_SURFACES as readonly string[]).indexOf(left.surface) - (EXECUTION_COVERAGE_SURFACES as readonly string[]).indexOf(right.surface);
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
    if (order === 0) refuse(`${what} carries two receipts for the same surface identity (${identityLabel(receipts[index].surface, receipts[index].workflowId)}); duplicates refuse.`);
  }
}

function identityKey(surface: ExecutionSurface, workflowId: string | null): string {
  return `${surface}|${workflowId ?? ""}`;
}

function identityLabel(surface: ExecutionSurface, workflowId: string | null): string {
  return workflowId === null ? surface : `${surface} of workflow ${workflowId}`;
}

// ---------------------------------------------------------------------------
// Manifest and coverage set
// ---------------------------------------------------------------------------

const MANIFEST_KEYS = ["manifestId", "manifestHash", "storeId", "epoch", "surfaces", "sources"] as const;

type ManifestSurface = Readonly<{ surface: ExecutionSurface; workflowId: string | null }>;

function expectManifestSurface(value: unknown, what: string): ManifestSurface {
  const record = expectObject(value, what);
  expectExactKeys(record, ["surface", "workflowId"], what);
  const surface = expectSurface(record.surface, `${what}.surface`);
  const workflowId = expectNullableId(record.workflowId, `${what}.workflowId`);
  expectScope(surface, workflowId, what);
  return { surface, workflowId };
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
        `the coverage manifest does not carry the root-scoped surface ${surface}; the closed 18-row inventory is never narrowed by ` +
          `omission, so a surface with nothing discovered is an absent row instead.`,
      );
    }
  }
  const workflows = [
    ...new Set(surfaces.filter((row) => row.workflowId !== null).map((row) => row.workflowId as string)),
  ].sort(compareText);
  for (const workflowId of workflows) {
    for (const surface of WORKFLOW_SCOPED_SURFACES) {
      if (!known.has(identityKey(surface, workflowId))) {
        refuse(
          `the coverage manifest carries ${surface} for another workflow but not for ${workflowId}; workflow-scoped rows repeat for ` +
            `every discovered workflow, so a sibling workflow is never omitted.`,
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
    refuse(`the coverage set binds manifest hash ${manifestHash}, but the frozen manifest hashes to ${manifest.manifestHash}; the receipts were reviewed against another document.`);
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
// Per-surface facts (§4.2)
// ---------------------------------------------------------------------------

type FactsContext = Readonly<{
  surface: ExecutionSurface;
  workflowId: string | null;
  disposition: CoverageDisposition;
  sources: readonly CoverageWitness[];
}>;

/** A fact about a file proves nothing unless the receipt names that exact file. */
function requireSource(context: FactsContext, path: string, sha256: string, what: string): void {
  if (!context.sources.some((witness) => witness.path === path && witness.sha256 === sha256)) {
    refuse(
      `${what} (${path}) is not carried as a source witness of this receipt; facts are recomputed from the bytes the receipt names, ` +
        `so a claim about an unnamed or changed file proves nothing.`,
    );
  }
}

function expectFileFacts(value: unknown, what: string): Readonly<{ path: string; sha256: string }> {
  const record = expectObject(value, what);
  expectExactKeys(record, ["path", "sha256"], what);
  return { path: expectWitnessPath(record.path, `${what}.path`), sha256: expectHex64(record.sha256, `${what}.sha256`) };
}

/** `core-v1`: the discovered core authority — catalog revision plus its workflows. */
function coreFacts(facts: unknown, context: FactsContext): unknown {
  const record = expectObject(facts, "core-v1 facts");
  expectExactKeys(record, ["catalogRevision", "workflows"], "core-v1 facts");
  const catalogRevision = expectInteger(record.catalogRevision, "core-v1 facts.catalogRevision", 0);
  const workflows = expectList(
    record.workflows,
    "core-v1 facts.workflows",
    (entry, what) => expectString(entry, what),
    compareText,
    "workflowId",
  );
  if (context.workflowId !== null) refuse("core-v1 facts belong to the root-scoped core-execution row, which never carries a workflow scope.");
  return { catalogRevision, workflows };
}

/** `session-v1`: the validated workflow/role/identity mapping of each envelope. */
function sessionFacts(facts: unknown, context: FactsContext): unknown {
  const record = expectObject(facts, "session-v1 facts");
  expectExactKeys(record, ["envelopes"], "session-v1 facts");
  const envelopes = expectList(
    record.envelopes,
    "session-v1 facts.envelopes",
    (entry, what) => {
      const item = expectObject(entry, what);
      expectExactKeys(item, ["path", "sha256", "role", "sessionId", "planId", "state", "archive"], what);
      return {
        path: expectWitnessPath(item.path, `${what}.path`),
        sha256: expectHex64(item.sha256, `${what}.sha256`),
        role: expectEnum(item.role, ENVELOPE_ROLES, `${what}.role`),
        sessionId: expectString(item.sessionId, `${what}.sessionId`),
        planId: expectNullableId(item.planId, `${what}.planId`),
        state: expectEnum(item.state, ENVELOPE_STATES, `${what}.state`),
        archive: expectEnum(item.archive, ENVELOPE_ARCHIVE, `${what}.archive`),
      };
    },
    (left, right) => compareText(left.path, right.path),
    "envelope path",
  );
  const owners = new Set<string>();
  for (const envelope of envelopes) {
    requireSource(context, envelope.path, envelope.sha256, `the session envelope ${envelope.path}`);
    if (envelope.role === "coordinator" && envelope.planId !== null) {
      refuse(`session-v1 facts name ${envelope.sessionId} as a coordinator envelope for plan ${envelope.planId}; a coordinator association carries no plan.`);
    }
    if (envelope.role === "plan-pm" && envelope.planId === null) {
      refuse(`session-v1 facts name ${envelope.sessionId} as a plan-pm envelope with no plan; a plan association is never inferred.`);
    }
    const owner = `${envelope.role}|${envelope.sessionId}`;
    if (owners.has(owner)) refuse(`session-v1 facts associate the ${envelope.role} session ${envelope.sessionId} twice; a duplicated association is not coverage.`);
    owners.add(owner);
    if (context.disposition === "migrate" && (envelope.state !== "suspended" || envelope.archive !== "pending")) {
      refuse(
        `session-v1 facts record ${envelope.path} as ${envelope.state}/${envelope.archive}; a migrated envelope is associated as suspended with an ` +
          `archive decision still pending.`,
      );
    }
    if (context.disposition === "retire" && (envelope.state !== "revoked" || envelope.archive !== "archived")) {
      refuse(
        `session-v1 facts record ${envelope.path} as ${envelope.state}/${envelope.archive}; only a revoked, archived envelope is retired, and no ` +
          `envelope revives authority through coverage.`,
      );
    }
  }
  return { envelopes };
}

/** `notes-v1`: the ordered accepted note records of one workflow's file. */
function notesFacts(facts: unknown, context: FactsContext): unknown {
  const record = expectObject(facts, "notes-v1 facts");
  expectExactKeys(record, ["file", "records"], "notes-v1 facts");
  const file = expectFileFacts(record.file, "notes-v1 facts.file");
  requireSource(context, file.path, file.sha256, `the notes file ${file.path}`);
  const ids = new Set<string>();
  const records = expectArray(record.records, "notes-v1 facts.records").map((entry, index) => {
    const what = `notes-v1 facts.records[${index}]`;
    const item = expectObject(entry, what);
    expectExactKeys(item, ["line", "id", "sha256"], what);
    if (item.line !== index) refuse(`${what}.line must be ${index}; retained note records are the exact ordered lines of the file, never a filtered view.`);
    const id = expectString(item.id, `${what}.id`);
    if (ids.has(id)) refuse(`notes-v1 facts record the accepted note id ${id} twice; a duplicated record is not an accepted record.`);
    ids.add(id);
    return { line: index, id, sha256: expectHex64(item.sha256, `${what}.sha256`) };
  });
  return { file, records };
}

/** `agent-flow-v2`: the ordered accepted event identities of one workflow's tail. */
function agentFlowFacts(facts: unknown, context: FactsContext): unknown {
  const record = expectObject(facts, "agent-flow-v2 facts");
  expectExactKeys(record, ["file", "records"], "agent-flow-v2 facts");
  const file = expectFileFacts(record.file, "agent-flow-v2 facts.file");
  requireSource(context, file.path, file.sha256, `the agent-flow file ${file.path}`);
  const eventIds = new Set<string>();
  const records = expectArray(record.records, "agent-flow-v2 facts.records").map((entry, index) => {
    const what = `agent-flow-v2 facts.records[${index}]`;
    const item = expectObject(entry, what);
    expectExactKeys(item, ["index", "eventId", "sessionId", "streamId", "seq", "sha256"], what);
    if (item.index !== index) refuse(`${what}.index must be ${index}; accepted events are inventoried in append order.`);
    const eventId = expectString(item.eventId, `${what}.eventId`);
    if (eventIds.has(eventId)) refuse(`agent-flow-v2 facts record the event id ${eventId} twice; separate real calls are never deduplicated into one row.`);
    eventIds.add(eventId);
    return {
      index,
      eventId,
      sessionId: expectString(item.sessionId, `${what}.sessionId`),
      streamId: expectString(item.streamId, `${what}.streamId`),
      seq: expectInteger(item.seq, `${what}.seq`, 0),
      sha256: expectHex64(item.sha256, `${what}.sha256`),
    };
  });
  return { file, records };
}

/** `selection-v1`: a durable selection/watermark file and its ordered entries. */
function selectionFacts(facts: unknown, context: FactsContext): unknown {
  const record = expectObject(facts, "selection-v1 facts");
  expectExactKeys(record, ["file", "entries"], "selection-v1 facts");
  const file = expectFileFacts(record.file, "selection-v1 facts.file");
  requireSource(context, file.path, file.sha256, `the selection file ${file.path}`);
  const entries = expectList(
    record.entries,
    "selection-v1 facts.entries",
    (entry, what) => {
      const item = expectObject(entry, what);
      expectExactKeys(item, ["key", "digest"], what);
      return { key: expectString(item.key, `${what}.key`), digest: expectHex64(item.digest, `${what}.digest`) };
    },
    (left, right) => compareText(left.key, right.key),
    "selection key",
  );
  return { file, entries };
}

/** `omp-launch-v2`: the launch intents retained for one workflow. */
function launchFacts(facts: unknown, context: FactsContext): unknown {
  const record = expectObject(facts, "omp-launch-v2 facts");
  expectExactKeys(record, ["file", "launches"], "omp-launch-v2 facts");
  const file = expectFileFacts(record.file, "omp-launch-v2 facts.file");
  requireSource(context, file.path, file.sha256, `the launch journal ${file.path}`);
  const launches = expectList(
    record.launches,
    "omp-launch-v2 facts.launches",
    (entry, what) => {
      const item = expectObject(entry, what);
      expectExactKeys(item, ["launchId", "workflowId", "planId", "state"], what);
      return {
        launchId: expectString(item.launchId, `${what}.launchId`),
        workflowId: expectString(item.workflowId, `${what}.workflowId`),
        planId: expectNullableId(item.planId, `${what}.planId`),
        state: expectEnum(item.state, LAUNCH_STATES, `${what}.state`),
      };
    },
    (left, right) => compareText(left.launchId, right.launchId),
    "launchId",
  );
  for (const launch of launches) {
    if (launch.workflowId !== context.workflowId) {
      refuse(
        `omp-launch-v2 facts carry launch ${launch.launchId} of workflow ${launch.workflowId} inside the row for ${String(context.workflowId)}; ` +
          `a launch journal is inventoried under the workflow that owns it.`,
      );
    }
  }
  return { file, launches };
}

/** `omp-hidden-v1`: one workflow's hidden entries, covering its whole host inventory. */
function hiddenFacts(facts: unknown): unknown {
  const record = expectObject(facts, "omp-hidden-v1 facts");
  expectExactKeys(record, ["inventory", "sessions"], "omp-hidden-v1 facts");
  const inventory = expectList(
    record.inventory,
    "omp-hidden-v1 facts.inventory",
    (entry, what) => expectString(entry, what),
    compareText,
    "native sessionId",
  );
  const sessions = expectList(
    record.sessions,
    "omp-hidden-v1 facts.sessions",
    (entry, what) => {
      const item = expectObject(entry, what);
      expectExactKeys(item, ["sessionId", "entries"], what);
      return {
        sessionId: expectString(item.sessionId, `${what}.sessionId`),
        entries: expectList(
          item.entries,
          `${what}.entries`,
          (nested, where) => {
            const value = expectObject(nested, where);
            expectExactKeys(value, ["entryId", "name", "sha256"], where);
            return {
              entryId: expectString(value.entryId, `${where}.entryId`),
              name: expectEnum(value.name, HIDDEN_ENTRY_NAMES, `${where}.name`),
              sha256: expectHex64(value.sha256, `${where}.sha256`),
            };
          },
          (left, right) => compareText(left.entryId, right.entryId),
          "entryId",
        ),
      };
    },
    (left, right) => compareText(left.sessionId, right.sessionId),
    "native sessionId",
  );
  const covered = sessions.map((session) => session.sessionId);
  const missing = inventory.filter((sessionId) => !covered.includes(sessionId));
  const unknown = covered.filter((sessionId) => !inventory.includes(sessionId));
  if (missing.length > 0 || unknown.length > 0) {
    refuse(
      `omp-hidden-v1 facts do not cover the explicit host inventory for this workflow` +
        `${missing.length > 0 ? `; ${missing.join(", ")} name(s) no retained history` : ""}` +
        `${unknown.length > 0 ? `; ${unknown.join(", ")} is outside the inventory` : ""}. ` +
        `A hidden-history row covers every native session the inventory names, and none it does not.`,
    );
  }
  return { inventory, sessions };
}

/** `retained-body-v1`: the retained SDD evidence bodies of one workflow. */
function retainedBodyFacts(facts: unknown, context: FactsContext): unknown {
  const record = expectObject(facts, "retained-body-v1 facts");
  expectExactKeys(record, ["plans"], "retained-body-v1 facts");
  const plans = expectList(
    record.plans,
    "retained-body-v1 facts.plans",
    (entry, what) => {
      const item = expectObject(entry, what);
      expectExactKeys(item, ["planId", "bodies"], what);
      const bodies = expectList(
        item.bodies,
        `${what}.bodies`,
        (nested, where) => expectFileFacts(nested, where),
        (left, right) => compareText(left.path, right.path),
        "body path",
      );
      for (const body of bodies) requireSource(context, body.path, body.sha256, `the SDD evidence body ${body.path}`);
      return { planId: expectString(item.planId, `${what}.planId`), bodies };
    },
    (left, right) => compareText(left.planId, right.planId),
    "planId",
  );
  return { plans };
}

/** `consumer-v1`: the package/injector inventory with its declared capability. */
function consumerFacts(facts: unknown, context: FactsContext): unknown {
  const record = expectObject(facts, "consumer-v1 facts");
  expectExactKeys(record, ["entries"], "consumer-v1 facts");
  const injector = context.surface === "artifact-store-injectors";
  const entries = expectList(
    record.entries,
    "consumer-v1 facts.entries",
    (entry, what) => {
      const item = expectObject(entry, what);
      expectExactKeys(item, ["path", "sha256", "capability", "entrypoint", "runtime", "generated"], what);
      const generated = item.generated === null ? null : expectFileFacts(item.generated, `${what}.generated`);
      const entrypoint = item.entrypoint === null ? null : expectString(item.entrypoint, `${what}.entrypoint`);
      const runtime = item.runtime === null ? null : expectEnum(item.runtime, RUNTIME_TARGETS, `${what}.runtime`);
      if (generated !== null && runtime === null) {
        refuse(`${what} names a generated artifact without its runtime target; a built artifact declares the runtime it was built for.`);
      }
      return {
        path: expectWitnessPath(item.path, `${what}.path`),
        sha256: expectHex64(item.sha256, `${what}.sha256`),
        capability: expectEnum(item.capability, PACKAGE_CAPABILITIES, `${what}.capability`),
        entrypoint,
        runtime,
        generated,
      };
    },
    (left, right) => compareText(left.path, right.path),
    "package path",
  );
  for (const entry of entries) {
    requireSource(context, entry.path, entry.sha256, `the inventoried source ${entry.path}`);
    if (entry.generated !== null) requireSource(context, entry.generated.path, entry.generated.sha256, `the generated artifact ${entry.generated.path}`);
    if (injector && entry.capability !== "body-only") {
      refuse(
        `consumer-v1 facts declare capability ${entry.capability} for the injected store ${entry.path}; a deployed ArtifactStore injector is ` +
          `inventoried as body-only storage, since the active execution authority never routes through an injection.`,
      );
    }
    if (!injector && entry.capability === "body-only") {
      refuse(`${context.surface} cannot declare body-only capability; that capability belongs to the injected ArtifactStore inventory.`);
    }
  }
  return { entries };
}

/** `recovery-v1`: a verified recovery point with populated coverage. */
function recoveryFacts(facts: unknown, context: FactsContext): unknown {
  const record = expectObject(facts, "recovery-v1 facts");
  expectExactKeys(record, ["backup", "schemaVersion", "integrity", "coverageDigest", "recoveryGeneration"], "recovery-v1 facts");
  const backup = expectFileFacts(record.backup, "recovery-v1 facts.backup");
  requireSource(context, backup.path, backup.sha256, `the backup image ${backup.path}`);
  if (record.integrity !== "verified") {
    refuse(`recovery-v1 facts declare integrity ${JSON.stringify(record.integrity)}; only a verified backup describes a recovery point.`);
  }
  return {
    backup,
    schemaVersion: expectInteger(record.schemaVersion, "recovery-v1 facts.schemaVersion", 1),
    integrity: "verified",
    coverageDigest: expectHex64(record.coverageDigest, "recovery-v1 facts.coverageDigest"),
    recoveryGeneration: expectInteger(record.recoveryGeneration, "recovery-v1 facts.recoveryGeneration", 0),
  };
}

const FACTS_VALIDATORS: Readonly<Record<CoverageProtocol, (facts: unknown, context: FactsContext) => unknown>> = {
  "core-v1": coreFacts,
  "session-v1": sessionFacts,
  "notes-v1": notesFacts,
  "agent-flow-v2": agentFlowFacts,
  "selection-v1": selectionFacts,
  "omp-launch-v2": launchFacts,
  "omp-hidden-v1": hiddenFacts,
  "retained-body-v1": retainedBodyFacts,
  "consumer-v1": consumerFacts,
  "recovery-v1": recoveryFacts,
};

// ---------------------------------------------------------------------------
// One receipt against the frozen manifest, the bytes and the schema
// ---------------------------------------------------------------------------

const EVIDENCE_DOCUMENT_KEYS = [
  "version",
  "protocol",
  "surface",
  "workflowId",
  "manifestId",
  "manifestHash",
  "storeId",
  "epoch",
  "disposition",
  "sources",
  "facts",
] as const;

function expectEvidenceBytes(
  evidence: ExecutionCoverageEvidence,
  witness: CoverageWitness,
  what: string,
): Uint8Array {
  const key = coverageWitnessKey(witness.root, witness.path);
  const bytes = evidence.get(key);
  if (bytes === undefined) {
    refuse(`${what} names witness ${key}, whose bytes were not supplied; coverage is recomputed from bytes, never from a path alone.`);
  }
  if (!(bytes instanceof Uint8Array)) refuse(`${what} witness ${key} is not handed in as bytes.`);
  if (createHash("sha256").update(bytes).digest("hex") !== witness.sha256) {
    refuse(`${what} witness ${key} does not hash to ${witness.sha256}; the bytes changed since the receipt was written, so the receipt is stale.`);
  }
  return bytes;
}

function decodeEvidenceDocument(bytes: Uint8Array, what: string): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse(`${what} is not UTF-8 text; a coverage evidence document is a canonical JSON document.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return refuse(`${what} is not JSON (${(error as Error).message}); free-form evidence never substitutes for facts.`);
  }
  return expectObject(parsed, what);
}

/**
 * One receipt: witness bytes, manifest pins, the closed evidence document and
 * the recomputed result. Returns the normalized facts (undefined for an absent
 * row) so the caller can cross-check facts across rows.
 */
function validateReceipt(
  receipt: ExecutionCoverageReceipt,
  manifest: ExecutionCoverageManifest,
  evidence: ExecutionCoverageEvidence,
  pinned: ReadonlySet<string>,
): unknown {
  const label = `receipt ${identityLabel(receipt.surface, receipt.workflowId)}`;
  if (receipt.manifestId !== manifest.manifestId) {
    refuse(`${label} binds manifest ${receipt.manifestId}, but the frozen manifest is ${manifest.manifestId}; a receipt from another discovery is stale coverage.`);
  }
  if (receipt.manifestHash !== manifest.manifestHash) {
    refuse(`${label} binds manifest hash ${receipt.manifestHash}, but the frozen manifest hashes to ${manifest.manifestHash}; the receipt was not written against this document.`);
  }
  if (receipt.storeId !== manifest.storeId) {
    refuse(`${label} binds store ${receipt.storeId}, but the frozen manifest belongs to store ${manifest.storeId}.`);
  }
  if (receipt.epoch !== manifest.epoch) {
    refuse(`${label} binds epoch ${receipt.epoch}, but the frozen manifest was discovered at epoch ${manifest.epoch}; a superseded epoch never authorizes coverage.`);
  }

  for (const witness of [...receipt.sources, ...receipt.evidence]) {
    expectEvidenceBytes(evidence, witness, label);
  }
  for (const witness of receipt.sources) {
    const key = coverageWitnessKey(witness.root, witness.path);
    if (!pinned.has(key)) {
      refuse(`${label} names source witness ${key}, which the frozen manifest does not pin; a receipt never invents a source outside the reviewed inventory.`);
    }
  }

  if (receipt.disposition === "absent") {
    if (receipt.sources.length > 0 || receipt.evidence.length > 0) {
      refuse(`${label} is absent yet names witnesses; an absent surface has no bytes to witness, and a populated surface is never reported absent.`);
    }
    const expected = executionCoverageResultHash({ surface: receipt.surface, workflowId: receipt.workflowId, disposition: "absent" });
    if (receipt.resultHash !== expected) {
      refuse(`${label} is absent but its resultHash is not the digest of an absent result (${expected}); a missing surface never borrows a populated result.`);
    }
    return undefined;
  }

  if (receipt.evidence.length !== 1) {
    refuse(`${label} carries ${receipt.evidence.length} evidence witnesses; a populated row carries exactly one bounded evidence document, and an operator acknowledgement is not one.`);
  }
  const documentBytes = expectEvidenceBytes(evidence, receipt.evidence[0], label);
  const document = decodeEvidenceDocument(documentBytes, `${label}'s evidence document`);
  expectExactKeys(document, EVIDENCE_DOCUMENT_KEYS, `${label}'s evidence document`);
  if (document.version !== 1) refuse(`${label}'s evidence document does not declare version 1.`);
  const documentProtocol = expectProtocol(document.protocol, `${label}'s evidence document.protocol`);
  if (documentProtocol !== receipt.protocol) {
    refuse(`${label}'s evidence document was written by ${documentProtocol}, not by ${receipt.protocol}; the bytes and the receipt must describe the same validator.`);
  }
  const documentSurface = expectSurface(document.surface, `${label}'s evidence document.surface`);
  const documentWorkflow = expectNullableId(document.workflowId, `${label}'s evidence document.workflowId`);
  if (documentSurface !== receipt.surface || documentWorkflow !== receipt.workflowId) {
    refuse(`${label}'s evidence document describes ${identityLabel(documentSurface, documentWorkflow)}; evidence is never reused across surfaces or workflows.`);
  }
  if (document.manifestId !== receipt.manifestId || document.manifestHash !== receipt.manifestHash) {
    refuse(`${label}'s evidence document was produced against another manifest; the facts it carries belong to a different discovery.`);
  }
  if (document.storeId !== receipt.storeId || document.epoch !== receipt.epoch) {
    refuse(`${label}'s evidence document belongs to another store epoch; superseded evidence never validates coverage.`);
  }
  const documentDisposition = expectEnum(document.disposition, COVERAGE_DISPOSITIONS, `${label}'s evidence document.disposition`);
  if (documentDisposition !== receipt.disposition) {
    refuse(`${label}'s evidence document declares disposition ${documentDisposition} while the receipt declares ${receipt.disposition}.`);
  }
  const documentSources = expectWitnessList(document.sources, `${label}'s evidence document.sources`);
  if (documentSources.length !== receipt.sources.length || documentSources.some((witness, index) => {
    const source = receipt.sources[index];
    return witness.root !== source.root || witness.path !== source.path || witness.sha256 !== source.sha256;
  })) {
    refuse(`${label}'s evidence document source witnesses are not the receipt's sources; the facts must be recomputed from the very bytes the receipt names.`);
  }
  const context: FactsContext = {
    surface: receipt.surface,
    workflowId: receipt.workflowId,
    disposition: receipt.disposition,
    sources: receipt.sources,
  };
  const facts = FACTS_VALIDATORS[receipt.protocol](document.facts, context);
  const expected = executionCoverageResultHash({
    surface: receipt.surface,
    workflowId: receipt.workflowId,
    disposition: receipt.disposition,
    facts,
  });
  if (receipt.resultHash !== expected) {
    refuse(
      `${label}'s resultHash ${receipt.resultHash} is not the digest of the facts recomputed from its evidence bytes (${expected}); ` +
        `a self-consistent hash over a fabricated document proves nothing.`,
    );
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Entry point (§4.1)
// ---------------------------------------------------------------------------

/**
 * Validate a coverage set against its frozen manifest and the evidence bytes.
 * Synchronous and pure: nothing is read from disk, nothing is written, and no
 * caller-supplied callback can substitute an assertion for bytes.
 *
 * Refuses `execution.coverage-incomplete` when the set is not the exact closed
 * inventory, when a receipt disagrees with its manifest binding, its pinned
 * witnesses or its recomputed facts, or when the canonical digest does not
 * cover the receipts it claims.
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

  const expected = new Set(frozen.surfaces.map((row) => identityKey(row.surface, row.workflowId)));
  for (const receipt of set.receipts) {
    const key = identityKey(receipt.surface, receipt.workflowId);
    if (!expected.has(key)) {
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
    const facts = validateReceipt(receipt, frozen, evidence, pinned);
    if (facts !== undefined) factsBySurface.set(identityKey(receipt.surface, receipt.workflowId), facts);
  }

  const discovered = [
    ...new Set(frozen.surfaces.filter((row) => row.workflowId !== null).map((row) => row.workflowId as string)),
  ].sort(compareText);
  const core = factsBySurface.get(identityKey("core-execution", null)) as { workflows: readonly string[] } | undefined;
  if (core === undefined) {
    refuse("the core-execution row carries no validated facts; the core authority is always populated, so its discovery is always recomputed.");
  }
  if (core.workflows.length !== discovered.length || core.workflows.some((workflowId, index) => workflowId !== discovered[index])) {
    refuse(
      `the core-execution facts name the workflows ${core.workflows.join(", ") || "(none)"}, but the manifest inventories ${discovered.join(", ") || "(none)"}; ` +
        `a workflow discovered by the core authority is never omitted from the workflow-scoped inventory.`,
    );
  }
}
