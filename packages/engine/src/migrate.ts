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
 * produced. Duplicate v1 plan ids are likewise refused fail-loud: every row
 * must land in exactly one snapshot. All timestamps derive from legacy data
 * (deterministic, no clock reads).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { readArtifactBytes } from "./coordination-write.js";
import { parseCompassFrontmatterText } from "./iteration.js";
import { assertSafePathComponent } from "./path.js";
import {
  WORKFLOW_SNAPSHOT_FILE,
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
  /** Harness-relative files the conversion read (source-digest input). */
  sources: string[];
  /**
   * Facts the conversion could not carry verbatim, stated for the caller's
   * receipt — never a silent drop.
   */
  dispositions: string[];
};

type CompassInfo = {
  id: string;
  file: string;
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
  integration_merge_lease: true,
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
    let content: string;
    try {
      content = readFileSync(compassPath, "utf8");
    } catch {
      continue; // dir without a canonical compass is not an iteration
    }
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
  if (isPlainObject(metadata.integration_merge_lease)) {
    data.integration_merge_lease = metadata.integration_merge_lease as WorkflowSnapshot["integration_merge_lease"];
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
 * A v2 root is not this function's input: the store-upgrade importer reads a
 * `version: 2` tree natively (`isLegacyV1Root` gates the two routes).
 */
export function convertLegacyV1Tree(root: string): LegacyV1Conversion {
  const statusPath = join(root, MIGRATE_STATUS_FILE);
  const source = readArtifactBytes(statusPath);
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
  const rows = Array.isArray(legacy.plans) ? legacy.plans.filter(isPlainObject) : [];
  if (Array.isArray(legacy.plans)) {
    // Fail-loud lift guards: every row must land in exactly one snapshot — a
    // row without id/plan_id is unliftable, an id that is not a single safe
    // path component could traverse out of the harness dir (it becomes
    // `workflows/<id>/...`), and duplicate ids would silently drop/overwrite a
    // sibling row.
    const unLiftable: unknown[] = [];
    const idCounts = new Map<string, number>();
    for (const row of legacy.plans) {
      if (!isPlainObject(row) || rowIdOf(row) === null) {
        unLiftable.push(row);
        continue;
      }
      const id = rowIdOf(row)!;
      assertSafePathComponent(id, "plan id");
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    if (unLiftable.length > 0) {
      throw new Error(
        `refusing to convert: ${unLiftable.length} plans[] row(s) cannot be lifted (missing id/plan_id or not an object) \u2014 every v1 row must land in exactly one snapshot`,
      );
    }
    const duplicates = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    if (duplicates.length > 0) {
      throw new Error(
        `refusing to convert: ${duplicates.length} duplicate plan id(s) (${duplicates.join(", ")}) \u2014 every v1 row must land in exactly one snapshot`,
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
  const { byPlan, rowById } = groupRows(rows, compasses);

  // 1. Iteration snapshots (every canonical compass; zero-plan compasses
  // still produce an empty terminal snapshot).
  const snapshots: MigrateSnapshot[] = compasses.map((compass) => buildIterationSnapshot(compass, rowById, rootUpdatedAt));

  // 2. Standalone snapshots for unregistered rows.
  for (const row of rows) {
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

  return {
    updatedAt,
    snapshots,
    sources: compasses.map((compass) => relative(root, compass.file).split(/[\\/]+/).join("/")),
    dispositions,
  };
}
