/**
 * Engine migrate module — the PURE legacy v1 conversion the direct
 * store-upgrade importer consumes.
 *
 * `convertLegacyV1Tree(root)` reads a v1 root `status.json` tree and returns
 * the in-memory v2 workflow snapshots plus the registration identities they
 * imply. It writes nothing, and it is the only code that still reads the v1
 * root shape (`version: 1`, root `plans[]`, root `metadata`).
 *
 * The former executable v1-to-v2 file-staging writer is retired: the archive
 * copy, the snapshot/notes/register/root-v2 write phases and the root
 * `withStatusWriteLock` they ran under are gone with the pre-activation file
 * route. The supported route for a workspace that still holds legacy files is
 * `mstar store upgrade --operator <name>`, which imports recognizable v1/v2
 * sources straight into the native execution authority and leaves every legacy
 * source byte untouched (retry is the same public operation).
 *
 * Frozen conversion semantics (architect, writing-specialist-corrected,
 * observed live tree 2026-08-19):
 * - **Grouping:** every plan row lifts into exactly one snapshot — the
 * iteration whose `{ITERATION_DIR}` compass frontmatter registers its id
 * (`iterations/<id>/delivery-compass.md` files only; the
 * `delivery-compass.<role>.md` review-chain variants are NOT grouping
 * sources). Row id is read from `id` OR the legacy `plan_id` key. A
 * registered id with NO status row (compacted away — 23 observed at
 * fixture freeze 2026-08-19; the canonical frozen count lives in
 * `test/fixtures/migrate-real/status.json`) is recorded on the owning
 * snapshot's `legacy_metadata.compact_missing[]` — never fabricated as a
 * row.
 * Unregistered rows become standalone plan-type snapshots.
 * - **Snapshot status mapping:** iteration snapshot status = compass
 * frontmatter (`active|locked` -> `running`; `completed` -> `completed`);
 * standalone rows `Done` -> `completed`, `InProgress|InReview` ->
 * `running`, `Blocked` -> `paused`, `Todo` -> `paused`; nothing maps to
 * `failed|stopped` from v1 data (those states are born in the v3 runtime).
 * Row-level plan statuses stay VERBATIM inside `plans[]`.
 * - **Field lift:** root `metadata` execution-policy keys
 * (`plan_parallelism`/`worktree_mode`/`push_policy`) -> snapshot
 * `execution_policy` (first-class); `iteration_base_branch`/
 * `target_branch`/`spec_integration_branch` -> `branch`;
 * `control_worktree_path` -> `integration_worktree_path` (the v1 root
 * metadata key is consumed under its historical name; the canonical
 * snapshot field is the integration checkout);
 * `integration_merge_lease` -> top-level `integration_merge_lease`; all of
 * these land on the ACTIVE iteration snapshot (status `running`; v3.0.0
 * today). `harness_root` is dropped as redundant with a `legacy_metadata`
 * note; `metadata.updated_at` becomes the root `updated_at`; ALL other/
 * unknown root-metadata keys land in the active snapshot
 * `legacy_metadata` — nothing dropped silently.
 * - **Nothing else lifts.** Residual registers, roadmap seeds and note
 * ledgers have their own supported routes (`mstar store migrate` /
 * `mstar roadmap import` / the append log); this conversion only produces
 * execution authority, and the source bytes for every one of them stay on
 * disk untouched.
 *
 * No fs writes happen anywhere in this module: every returned path is
 * harness-relative and derived, and each lifecycle id that becomes a path
 * segment (v1 row `id`/`plan_id`, compass `iteration_id`) must pass
 * `assertSafePathComponent` or the conversion is refused BEFORE any result is
 * produced. Duplicate v1 plan ids never abort the conversion: the first row in
 * the documented stable order (plan id, then owning lifecycle id, then row
 * ordinal) survives and every later duplicate is reported in
 * `duplicatePlanIds`, so the caller can refuse it as its own skippable source
 * instead of one duplicated agent-authored row blocking every healthy sibling.
 * All timestamps derive from legacy data (deterministic, no clock reads).
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { artifactVersion, readArtifactBytes } from "./coordination-write.js";
import { parseCompassFrontmatterText } from "./iteration.js";
import { assertSafePathComponent } from "./path.js";
import {
  WORKFLOW_DELIVERY_KINDS,
  WORKFLOW_SNAPSHOT_FILE,
  assertDeliveryRegistrationCoherence,
  type WorkflowDeliveryKind,
  type WorkflowLifecycleStatus,
  type WorkflowLifecycleType,
  type WorkflowSnapshot,
} from "./workflow.js";

/** Root status file name inside `{HARNESS_DIR}` (the retained v1 input). */
export const MIGRATE_STATUS_FILE = "status.json";

/** Notes ledger file name inside `workflows/<id>/`. */
export const NOTES_LEDGER_FILE = "notes.jsonl";

/**
 * Date substituted for a legacy root that carries none. A fixed epoch keeps
 * the conversion reproducible (no clock read) and matches the importer's own
 * synthesized root date.
 */
const SYNTHESIZED_DATE = "1970-01-01";

/**
 * One per-lift delivery declaration (the former `migrate` declaration contract,
 * carried onto the replacement `store upgrade` producer): a v1 `plans[]` row
 * becomes a live `type: plan` lifecycle whose delivery kind is declared at
 * registration, never inferred — so each ACTIVE standalone lift names its own
 * kind and per-kind evidence (§1/§4a). `workflow` addresses exactly one lifted
 * lifecycle id.
 */
export type DeliveryLiftDeclaration = {
  /** Lifted lifecycle id this declaration describes. */
  workflow: string;
  /** Delivery kind declared for that lift; never inferred or defaulted. */
  deliveryKind: WorkflowDeliveryKind;
  /** Delivery source branch, recorded as `branch.source`. Required for `development`. */
  branchSource?: string;
  /** Delivery target branch, recorded as `branch.target`. Required for `development`. */
  branchTarget?: string;
  /** Completion policy for a `verification/report-only` lift. Required for that kind. */
  completionPolicy?: string;
};

/** One converted workflow identity (id = plan id or iteration id). */
export type MigrateSnapshot = {
  id: string;
  type: WorkflowLifecycleType;
  status: WorkflowLifecycleStatus;
  /**
   * Canonical harness-relative snapshot path, e.g. `workflows/<id>/snapshot.json`.
   * Provenance/registration display only — nothing is written there; the v3
   * runtime resolves its own layout dirs.
   */
  file: string;
  /** Provenance label (compass file / status.json row). */
  source: string;
  data: WorkflowSnapshot;
};

/** What one legacy v1 tree converts into, in memory. */
export type LegacyV1Conversion = {
  /** Root `updated_at` the native root revision records (`metadata.updated_at` wins). */
  updatedAt: string;
  snapshots: MigrateSnapshot[];
  /**
   * Every plan id several `plans[]` rows claim: the conversion keeps the first
   * row in the documented stable order (plan id, then owning lifecycle id, then
   * row ordinal) and reports each later duplicate as a lost row, so the caller
   * can refuse it as its own skippable source instead of aborting the whole
   * conversion.
   */
  duplicatePlanIds: DuplicatePlanId[];
  /** Harness-relative files the conversion read (source-digest input). */
  sources: string[];
  /** sha256 of the exact bytes read for each entry of `sources`, same order. */
  sourceHashes: Array<[string, string]>;
  /**
   * Facts the conversion could not carry verbatim, stated for the caller's
   * receipt — never a silent drop.
   */
  dispositions: string[];
};

/** One plan id several v1 `plans[]` rows claim (ordinals are positions in `plans[]`). */
export type DuplicatePlanId = {
  id: string;
  /** The lifecycle that owns this id (the compass registering it), or null when unregistered. */
  owner: string | null;
  /** Ordinal of the row that survives — the first in the documented stable order. */
  kept: number;
  /** Ordinals of the rows that are NOT converted; each is a lost duplicate. */
  dropped: number[];
};

/** The converted declaration facts one caller supplies for its ACTIVE lifts. */
export type DeliveryLiftDeclarations = readonly DeliveryLiftDeclaration[];

type CompassInfo = {
  id: string;
  file: string;
  /** sha256 of the exact bytes this scan read (source-digest input). */
  hash: string;
  status: unknown;
  plans: string[];
  startDate?: string;
  endDate?: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Root-metadata keys lifted to FIRST-CLASS fields on the active iteration
 * snapshot. `harness_root` is deliberately NOT here: it is note-only
 * (`legacy_metadata.harness_root_note`, value dropped as redundant) — see
 * `applyRootMetadataLift`.
 */
const ROOT_METADATA_LIFT_KEYS: Record<string, true> = {
  plan_parallelism: true,
  worktree_mode: true,
  push_policy: true,
  iteration_base_branch: true,
  target_branch: true,
  spec_integration_branch: true,
  control_worktree_path: true,
  updated_at: true,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dateString(value: unknown): string | undefined {
  return typeof value === "string" && DATE_RE.test(value) ? value : undefined;
}

function rowIdOf(row: Record<string, unknown>): string | null {
  if (typeof row.id === "string" && row.id.trim() !== "") return row.id;
  if (typeof row.plan_id === "string" && row.plan_id.trim() !== "") return row.plan_id;
  return null;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Scan the canonical compasses under `iterations/` (files named exactly
 * `delivery-compass.md` inside iteration dirs — the
 * `delivery-compass.<role>.md` review-chain variants are NOT grouping
 * sources). A malformed compass (unreadable/unsupported frontmatter or
 * unknown status) fails loud — a conversion must never misgroup silently.
 */
function scanCompasses(harnessDir: string): CompassInfo[] {
  const iterationsDir = join(harnessDir, "iterations");
  const out: CompassInfo[] = [];
  let entries;
  try {
    entries = readdirSync(iterationsDir, { withFileTypes: true });
  } catch {
    return out; // no iterations dir -> no registered iteration lifecycles
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const compassPath = join(iterationsDir, entry.name, "delivery-compass.md");
    let bytes: Buffer;
    // A canonical compass is read through ONE bounded, no-follow descriptor: a
    // linked, special or otherwise non-regular leaf refuses by name before any
    // byte is read (a blocking open on a writer-less FIFO never returns, so the
    // old path read could hang `store upgrade` with no recovery), while a leaf
    // that simply cannot be read keeps the established "not an iteration"
    // treatment.
    let info;
    try { info = lstatSync(compassPath); } catch { continue; } // missing: not an iteration
    // One refusal text for every non-regular shape (static or raced), naming both
    // supported continuations plus the route that skips legacy imports entirely.
    const refusalPath = JSON.stringify(compassPath);
    const notRegular = (): Error => new Error(
      `refusing to convert: compass ${refusalPath} is not a regular in-root file (a linked or special path is never read); replace it with a regular file to keep this iteration's grouping, or remove it to convert those plans as standalone rows, then rerun store upgrade. To explicitly start WITHOUT any legacy imports, use \`store init --harness <new-empty-control-root>\`; existing stores and all legacy bytes remain untouched.`,
    );
    if (info.isSymbolicLink() || !info.isFile()) throw notRegular();
    let fd: number | undefined;
    try {
      fd = openSync(compassPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw notRegular();
      // Same-descriptor identity: the descriptor must be the file the probe saw,
      // so a leaf swapped for another regular file cannot contribute its bytes.
      if (opened.dev !== info.dev || opened.ino !== info.ino) throw notRegular();
      bytes = readFileSync(fd);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("refusing to convert")) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      // A link raced into the open window refuses exactly like a static one; a
      // leaf that vanished after the probe is a changed source, not an absent
      // one. Other read errors keep the established "not an iteration" treatment.
      if (code === "ELOOP") throw notRegular();
      if (code === "ENOENT") {
        throw new Error(
          `refusing to convert: compass ${refusalPath} changed between the probe and its read (ENOENT); rerun store upgrade once the legacy tree is stable`,
        );
      }
      continue; // an unreadable compass is still not an iteration
    } finally { if (fd !== undefined) closeSync(fd); }
    const content = bytes.toString("utf8");
    const doc = parseCompassFrontmatterText(content, compassPath);
    const status = doc.status;
    if (status !== "active" && status !== "locked" && status !== "completed") {
      throw new Error(
        `refusing to convert: compass ${JSON.stringify(compassPath)} has unsupported status ${JSON.stringify(status)} (expected active | locked | completed)`,
      );
    }
    const plans = Array.isArray(doc.plans) ? doc.plans.filter((p): p is string => typeof p === "string" && p !== "") : [];
    out.push({
      id: typeof doc.iteration_id === "string" && doc.iteration_id !== "" ? doc.iteration_id : entry.name,
      file: compassPath,
      // Hashed where it is read: the caller's digest then covers the bytes this
      // conversion actually consumed instead of re-reading the same path.
      hash: createHash("sha256").update(bytes).digest("hex"),
      status,
      plans,
      startDate: dateString(doc.start_date),
      endDate: dateString(doc.end_date),
    });
  }
  out.sort((a, b) => compareIds(a.id, b.id));
  return out;
}

/** Deterministic max/min over candidate legacy dates (ignores undefined). */
function pickDate(preferred: (string | undefined)[], fallback: string): string {
  for (const candidate of preferred) {
    if (candidate !== undefined) return candidate;
  }
  return fallback;
}

/** Group rows by their owning iteration (compass SSOT); unowned rows -> standalone. */
function groupRows(
  rows: Record<string, unknown>[],
  compasses: CompassInfo[],
): { byPlan: Map<string, CompassInfo>; rowById: Map<string, Record<string, unknown>> } {
  const rowById = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = rowIdOf(row);
    if (id !== null && !rowById.has(id)) rowById.set(id, row);
  }
  const byPlan = new Map<string, CompassInfo>();
  for (const compass of compasses) {
    for (const planId of compass.plans) {
      if (!byPlan.has(planId)) byPlan.set(planId, compass);
    }
  }
  return { byPlan, rowById };
}

/** Build one iteration snapshot (compass status mapping + compact_missing record). */
function buildIterationSnapshot(
  compass: CompassInfo,
  rowById: Map<string, Record<string, unknown>>,
  rootUpdatedAt: string,
): MigrateSnapshot {
  const rows = compass.plans
    .map((planId) => rowById.get(planId))
    .filter((row): row is Record<string, unknown> => row !== undefined);
  rows.sort((a, b) => compareIds(rowIdOf(a) ?? "", rowIdOf(b) ?? ""));

  const rowDates = rows.flatMap((row) => [
    dateString(row.created_at),
    dateString(row.updated_at),
    dateString(row.done_at),
  ]);
  const startedAt = pickDate([compass.startDate, ...rowDates], rootUpdatedAt);
  const endedAt = pickDate([compass.endDate, ...rowDates], rootUpdatedAt);
  const status: WorkflowLifecycleStatus = compass.status === "completed" ? "completed" : "running";
  const compactMissing = compass.plans.filter((planId) => !rowById.has(planId)).sort();

  const snapshot: WorkflowSnapshot = {
    schema_version: 1,
    id: compass.id,
    type: "iteration",
    status,
    started_at: startedAt,
    ...(status === "completed" ? { ended_at: endedAt } : {}),
    updated_at: status === "completed" ? endedAt : startedAt,
    plans: rows,
    compass_ref: `iterations/${compass.id}/delivery-compass.md`,
  };

  const legacyMetadata: Record<string, unknown> = {};
  if (compactMissing.length > 0) legacyMetadata.compact_missing = compactMissing;
  if (Object.keys(legacyMetadata).length > 0) snapshot.legacy_metadata = legacyMetadata;

  return {
    id: compass.id,
    type: "iteration",
    status,
    file: join("workflows", compass.id, WORKFLOW_SNAPSHOT_FILE),
    source: join("iterations", compass.id, "delivery-compass.md"),
    data: snapshot,
  };
}

/**
 * Write one caller declaration onto the snapshot it addresses, using the SAME
 * shape the former `migrate` producer wrote and the catalog registration
 * producers write (§1/§4a): the declared kind plus its per-kind evidence. The
 * coherence rule is the shared one, so a `development` without anchors or a
 * `verification/report-only` without its completion policy refuses before any
 * native registration commits.
 */
function applyDeliveryLiftDeclaration(snapshot: WorkflowSnapshot, declaration: DeliveryLiftDeclaration): void {
  snapshot.delivery_kind = declaration.deliveryKind;
  if (declaration.branchSource !== undefined || declaration.branchTarget !== undefined) {
    snapshot.branch = {
      ...(declaration.branchSource !== undefined ? { source: declaration.branchSource } : {}),
      ...(declaration.branchTarget !== undefined ? { target: declaration.branchTarget } : {}),
    };
  }
  if (declaration.completionPolicy !== undefined) snapshot.completion_policy = declaration.completionPolicy;
}

/**
 * A refused delivery declaration for one ACTIVE standalone v1 lift: missing,
 * duplicated, addressing no such lift, off-enum, or incoherent for its kind.
 * Carried as a distinct type so the import producer can raise it as the
 * discoverable same-entry usage refusal instead of a generic migration failure.
 */
export class DeliveryDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryDeclarationError";
  }
}

/**
 * Apply the caller's per-lift declarations to the ACTIVE standalone plan lifts
 * they address. A declaration describes ONE lifecycle (§1: the kind and its
 * anchors are per-workflow registration evidence), so each must address exactly
 * one lift that needs one: a duplicate, an id naming an iteration, a
 * compass-registered row or a completed lift is refused rather than silently
 * ignored. Every ACTIVE lift must be declared — one without a kind could never
 * be closed, and no later seam can supply it — and the refusal names the ids
 * plus the exact retry.
 */
function applyDeliveryDeclarations(
  snapshots: MigrateSnapshot[],
  declarations: DeliveryLiftDeclarations,
): void {
  const lifts = new Map(
    snapshots
      .filter((snapshot) => snapshot.type === "plan" && snapshot.status !== "completed")
      .map((snapshot) => [snapshot.id, snapshot]),
  );
  const retry = (ids: readonly string[]): string =>
    `rerun the same \`store upgrade\` with one --delivery <json> per active standalone plan lift` +
    `${ids.length === 0 ? "" : ` (declared so far: ${ids.join(", ")})`}` +
    ` \u2014 each entry is {"workflow": <lifted id>, "deliveryKind": "development" | "verification/report-only",` +
    ` plus "branchSource"/"branchTarget" for development or "completionPolicy" for verification/report-only`;
  const declared = new Set<string>();
  for (const declaration of declarations) {
    const snapshot = lifts.get(declaration.workflow);
    if (snapshot === undefined || declared.has(declaration.workflow)) {
      throw new DeliveryDeclarationError(
        `delivery declaration ${JSON.stringify(declaration.workflow)} addresses ${declared.has(declaration.workflow) ? "the same active standalone plan lift twice" : "no active standalone plan lift in this tree"}; ` +
          `this tree's active standalone plan lifts are ${[...lifts.keys()].sort(compareIds).join(", ") || "none"} \u2014 ${retry([...declared].sort(compareIds))}`,
      );
    }
    if (!(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(declaration.deliveryKind)) {
      throw new DeliveryDeclarationError(
        `deliveryKind for ${JSON.stringify(declaration.workflow)} must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")} \u2014 got ${JSON.stringify(declaration.deliveryKind)}; ${retry([...declared].sort(compareIds))}`,
      );
    }
    try {
      assertDeliveryRegistrationCoherence(declaration.deliveryKind, declaration, `delivery declaration for ${declaration.workflow}`);
    } catch (error) {
      throw new DeliveryDeclarationError(`${(error as Error).message}; ${retry([...declared].sort(compareIds))}`);
    }
    applyDeliveryLiftDeclaration(snapshot.data, declaration);
    declared.add(declaration.workflow);
  }
  const undeclared = [...lifts.keys()].filter((id) => !declared.has(id)).sort(compareIds);
  if (undeclared.length > 0) {
    throw new DeliveryDeclarationError(
      `${undeclared.length} active standalone v1 plan lift(s) carry no declared delivery kind (${undeclared.join(", ")}); ` +
        `a plan workflow fixes its delivery kind at registration and cannot be closed without one, so the import commits nothing until each is declared \u2014 ${retry([...declared].sort(compareIds))}`,
    );
  }
}

/**
 * Build one standalone plan snapshot (row status mapping; an unrecognized v1
 * status defaults the SNAPSHOT to `paused` and is stated as a disposition —
 * the row keeps its verbatim value).
 */
function buildStandaloneSnapshot(
  row: Record<string, unknown>,
  rootUpdatedAt: string,
  dispositions: string[],
): MigrateSnapshot {
  const id = rowIdOf(row) ?? "<unnamed>";
  const statusValue = row.status;
  let status: WorkflowLifecycleStatus;
  if (statusValue === "Done") status = "completed";
  else if (statusValue === "InProgress" || statusValue === "InReview") status = "running";
  else if (statusValue === "Todo" || statusValue === "Blocked") status = "paused";
  else {
    status = "paused";
    dispositions.push(
      `row ${JSON.stringify(id)} has unrecognized v1 status ${JSON.stringify(statusValue)} \u2014 the converted snapshot status defaults to paused (the row status stays verbatim)`,
    );
  }
  const startedAt = pickDate([dateString(row.created_at), dateString(row.updated_at)], rootUpdatedAt);
  const updatedAt = pickDate([dateString(row.updated_at), dateString(row.done_at), dateString(row.created_at)], rootUpdatedAt);
  const endedAt = pickDate([dateString(row.done_at), dateString(row.updated_at)], rootUpdatedAt);

  const snapshot: WorkflowSnapshot = {
    schema_version: 1,
    id,
    type: "plan",
    status,
    started_at: startedAt,
    ...(status === "completed" ? { ended_at: endedAt } : {}),
    updated_at: status === "completed" ? endedAt : updatedAt,
    plans: [row],
  };

  return {
    id,
    type: "plan",
    status,
    file: join("workflows", id, WORKFLOW_SNAPSHOT_FILE),
    source: "status.json plans[] row",
    data: snapshot,
  };
}

/** Root-metadata lifts -> the active (running) iteration snapshot. */
function applyRootMetadataLift(
  snapshot: MigrateSnapshot,
  metadata: Record<string, unknown>,
  dispositions: string[],
  activeIterations: number,
): void {
  const data = snapshot.data;
  const policy: Record<string, unknown> = {};
  for (const key of ["plan_parallelism", "worktree_mode", "push_policy"] as const) {
    if (metadata[key] !== undefined) policy[key] = metadata[key];
  }
  if (Object.keys(policy).length > 0) data.execution_policy = policy;

  const branch: Record<string, unknown> = {};
  const branchKeys: Array<[string, string]> = [
    ["base", "iteration_base_branch"],
    ["integration", "spec_integration_branch"],
    ["target", "target_branch"],
  ];
  for (const [target, source] of branchKeys) {
    const value = metadata[source];
    if (typeof value === "string" && value !== "") branch[target] = value;
  }
  if (Object.keys(branch).length > 0) data.branch = branch as WorkflowSnapshot["branch"];

  // v1 root metadata key keeps its historical name; the lift target is the
  // CANONICAL snapshot member (writers emit only the new shape).
  if (typeof metadata.control_worktree_path === "string" && metadata.control_worktree_path !== "") {
    data.integration_worktree_path = metadata.control_worktree_path;
  }

  const legacyMetadata: Record<string, unknown> = isPlainObject(data.legacy_metadata)
    ? { ...data.legacy_metadata }
    : {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "harness_root") continue; // note-only handling below — not a lift
    if (ROOT_METADATA_LIFT_KEYS[key] === true) continue;
    legacyMetadata[key] = value;
  }
  if (metadata.harness_root !== undefined) {
    legacyMetadata.harness_root_note = `dropped as redundant (the harness dir derives from the root file location): ${String(metadata.harness_root)}`;
  }
  if (Object.keys(legacyMetadata).length > 0) data.legacy_metadata = legacyMetadata;

  if (activeIterations > 1) {
    dispositions.push(
      `${activeIterations} active iterations present \u2014 the root metadata lifts are carried by ${JSON.stringify(snapshot.id)} only`,
    );
  }
}

/**
 * Pure conversion of one v1 root tree: reads `{HARNESS_DIR}/status.json`
 * (`version: 1`) plus the iteration compasses and returns the in-memory v2
 * workflow snapshots, the harness-relative files it read and the dispositions
 * for facts it could not carry verbatim. ZERO writes; every refusal names the
 * source fact that blocked the conversion.
 *
 * `declarations` carries the caller's per-lift delivery declarations (the
 * former `migrate` declaration contract): every ACTIVE standalone plan lift
 * needs one, and an addressed id that is not such a lift is refused rather than
 * silently ignored. `deliveryDeclarationsRequired` reports the ACTIVE lifts
 * still undeclared, so the import refuses before any native registration
 * commits. Terminal (completed) lifts never require one.
 *
 * A v2 root is not this function's input: the store-upgrade importer reads a
 * `version: 2` tree natively (`isLegacyV1Root` gates the two routes).
 *
 * `verifiedStatusBytes` is the caller's already-verified read of the same
 * status file: the direct importer reads it through one no-follow descriptor
 * for classification, and passing those bytes keeps the conversion from
 * re-acquiring the path (a leaf replaced between the two reads would otherwise
 * decide the classification from one inode and the rows from another). Callers
 * without a prior read (the standalone conversion entry) keep the path read.
 */
export function convertLegacyV1Tree(root: string, declarations: DeliveryLiftDeclarations = [], verifiedStatusBytes?: Buffer): LegacyV1Conversion {
  const statusPath = join(root, MIGRATE_STATUS_FILE);
  const source = verifiedStatusBytes === undefined
    ? readArtifactBytes(statusPath)
    : { payload: JSON.parse(verifiedStatusBytes.toString("utf8")) as unknown, version: artifactVersion(verifiedStatusBytes) };
  if (source === undefined) {
    throw new Error(
      `refusing to convert: no legacy ${MIGRATE_STATUS_FILE} at ${statusPath}; a workspace without a legacy root has nothing to import`,
    );
  }
  const legacy: Record<string, unknown> = isPlainObject(source.payload) ? source.payload : {};
  if (legacy.version !== 1) {
    throw new Error(
      `refusing to convert: ${statusPath} has unrecognized schema version ${JSON.stringify(legacy.version ?? null)} (expected 1); a v2 root is imported directly by \`mstar store upgrade --operator <name>\``,
    );
  }

  const dispositions: string[] = [];
  // Root `residual_findings` is a v1 FILE field. The native issue store reads its
  // findings from a project register document or the issue verbs, so this
  // conversion cannot carry them: report the exact loss and the supported route
  // instead of dropping them silently.
  const residual = isPlainObject(legacy.residual_findings) ? legacy.residual_findings : undefined;
  if (residual !== undefined) {
    const buckets = Object.entries(residual).filter(([, value]) => Array.isArray(value) && value.length > 0);
    if (buckets.length > 0) {
      const count = buckets.reduce((total, [, value]) => total + (value as unknown[]).length, 0);
      dispositions.push(
        `root status.json residual_findings (${count} entr${count === 1 ? "y" : "ies"} across ${buckets.length} plan bucket(s)) are NOT imported by store upgrade: native findings come from the issue store, which reads a project register document (projects/<id>/residuals.json) or the mstar issue verbs. Move those entries into that register, or capture them with the issue verbs, before retiring the legacy file; this conversion leaves the legacy field untouched.`,
      );
    }
  }
  const rows = Array.isArray(legacy.plans) ? legacy.plans.filter(isPlainObject) : [];
  if (Array.isArray(legacy.plans)) {
    // Fail-loud lift guards: every row must land in exactly one snapshot — a
    // row without id/plan_id is unliftable, and an id that is not a single safe
    // path component could traverse out of the harness dir (it becomes
    // `workflows/<id>/...`). Duplicated ids are classified below instead of
    // refusing, because one duplicated agent-authored row must not abort every
    // healthy sibling source.
    const unLiftable: unknown[] = [];
    for (const row of legacy.plans) {
      if (!isPlainObject(row) || rowIdOf(row) === null) {
        unLiftable.push(row);
        continue;
      }
      assertSafePathComponent(rowIdOf(row)!, "plan id");
    }
    if (unLiftable.length > 0) {
      throw new Error(
        `refusing to convert: ${unLiftable.length} plans[] row(s) cannot be lifted (missing id/plan_id or not an object) \u2014 every v1 row must land in exactly one snapshot`,
      );
    }
  }
  const metadata = isPlainObject(legacy.metadata) ? legacy.metadata : {};
  const rootUpdatedAt = dateString(legacy.updated_at) ?? dateString(metadata.updated_at) ?? SYNTHESIZED_DATE;
  const updatedAt = dateString(metadata.updated_at) ?? rootUpdatedAt;

  const compasses = scanCompasses(root);
  // Compass iteration ids become `workflows/<id>/...` path segments (and
  // `compass_ref` values) — refuse unsafe ids fail-loud.
  for (const compass of compasses) {
    assertSafePathComponent(compass.id, "iteration id");
  }
  // Duplicate plan ids: several `plans[]` rows may claim one id, and one
  // agent-authored duplicate must not abort every healthy sibling source. The
  // competing rows are ordered by plan id, then by the lifecycle that owns that
  // id (the compass registering it; empty for an unregistered id), then by their
  // ordinal in `plans[]`. Both leading keys are constant for one id, so the row
  // ordinal decides: the first row survives and every later duplicate is
  // reported, never converted and never silently dropped.
  const owners = new Map<string, string>();
  for (const compass of compasses) {
    for (const planId of compass.plans) {
      if (!owners.has(planId)) owners.set(planId, compass.id);
    }
  }
  const candidateOrdinals = new Map<string, number[]>();
  for (const [ordinal, row] of rows.entries()) {
    const id = rowIdOf(row)!;
    const ordinals = candidateOrdinals.get(id);
    if (ordinals === undefined) candidateOrdinals.set(id, [ordinal]);
    else ordinals.push(ordinal);
  }
  const duplicatePlanIds: DuplicatePlanId[] = [];
  const droppedOrdinals = new Set<number>();
  for (const [id, ordinals] of candidateOrdinals) {
    if (ordinals.length < 2) continue;
    duplicatePlanIds.push({ id, owner: owners.get(id) ?? null, kept: ordinals[0]!, dropped: ordinals.slice(1) });
    for (const ordinal of ordinals.slice(1)) droppedOrdinals.add(ordinal);
  }
  duplicatePlanIds.sort((a, b) => compareIds(a.id, b.id));
  const keptRows = rows.filter((_, ordinal) => !droppedOrdinals.has(ordinal));
  const { byPlan, rowById } = groupRows(keptRows, compasses);

  // 1. Iteration snapshots (every canonical compass; zero-plan compasses
  // still produce an empty terminal snapshot).
  const snapshots: MigrateSnapshot[] = compasses.map((compass) => buildIterationSnapshot(compass, rowById, rootUpdatedAt));

  // 2. Standalone snapshots for unregistered rows.
  for (const row of keptRows) {
    const id = rowIdOf(row);
    if (id !== null && !byPlan.has(id)) snapshots.push(buildStandaloneSnapshot(row, rootUpdatedAt, dispositions));
  }

  // 2b. Cross-class lifecycle-id uniqueness: plan rows are unique within
  // plans[] (guard above) and compass ids are unique by directory, but an
  // iteration id may still equal a STANDALONE plan id (a row registered in no
  // compass) — both would convert to the same `workflows/<id>` identity and a
  // later snapshot would silently overwrite the earlier one. Refuse fail-loud
  // with the conflict list — never a silent double-identity import.
  const lifecycleSources = new Map<string, string[]>();
  for (const snapshot of snapshots) {
    const sources = lifecycleSources.get(snapshot.id) ?? [];
    sources.push(snapshot.type === "iteration" ? "iteration" : "standalone plan");
    lifecycleSources.set(snapshot.id, sources);
  }
  const collisions = [...lifecycleSources.entries()].filter(([, sources]) => sources.length > 1);
  if (collisions.length > 0) {
    throw new Error(
      `refusing to convert: ${collisions.length} lifecycle id collision(s) (${collisions
        .map(([id, sources]) => `${JSON.stringify(id)} shared by ${sources.join(" + ")}`)
        .join("; ")}) \u2014 every id must be unique across iterations and standalone plans (each id becomes a workflow identity)`,
    );
  }
  snapshots.sort((a, b) => compareIds(a.id, b.id));

  // 2c. Carry the caller's per-lift delivery declarations onto the ACTIVE
  // standalone lifts they address (the former `migrate` declaration contract):
  // those lifts become live `type: plan` lifecycles whose close consultation
  // requires a registered kind, and no later seam can supply one. An undeclared
  // lift refuses the whole conversion; terminal lifts are exempt.
  applyDeliveryDeclarations(snapshots, declarations);

  // 3. Root-metadata lift -> the active iteration snapshot (v3.0.0 today).
  // Lift-target rule (documented): sorted-first by snapshot id — deterministic,
  // but arbitrary when 2+ iterations run concurrently; the disposition names it.
  const activeIterations = snapshots.filter((snapshot) => snapshot.status === "running" && snapshot.type === "iteration");
  if (activeIterations.length > 0) {
    applyRootMetadataLift(activeIterations[0]!, metadata, dispositions, activeIterations.length);
  } else if (Object.keys(metadata).length > 0) {
    dispositions.push(
      "no active iteration snapshot found \u2014 root metadata execution-policy/branch keys have no lift home and stay unconverted (the legacy root file keeps them)",
    );
  }
  if (activeIterations.length === 0 && metadata.program_roadmap !== undefined) {
    dispositions.push(
      "root metadata program_roadmap was not imported because no active iteration exists to carry it as workflow metadata; status.json is preserved. Recover through the supported project-roadmap authoring path (`mstar roadmap import` preview/review/apply or revision-guarded `mstar roadmap replace`), using `_default` when no project is identified",
    );
  }
  if (activeIterations.length === 0 && metadata.integration_merge_lease !== undefined) {
    dispositions.push(
      "root metadata integration_merge_lease is historical data only and is not converted to a live store lease; the direct store-upgrade import leaves status.json unchanged, and future integration ownership uses the native serial lease operation",
    );
  }

  return {
    updatedAt,
    snapshots,
    duplicatePlanIds,
    sources: compasses.map((compass) => relative(root, compass.file).split(/[\\/]+/).join("/")),
    sourceHashes: compasses.map((compass) => [
      relative(root, compass.file).split(/[\\/]+/).join("/"),
      compass.hash,
    ]),
    dispositions,
  };
}
