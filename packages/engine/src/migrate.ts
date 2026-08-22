/**
 * Engine migrate module — the ONLY code that reads the v1 root status.json
 * shape (plan `20260819-workflow-engine-core.md` Task 6): a pure planner
 * `migrateHarnessTree(root, opts): MigratePlan` plus the executor
 * `applyMigratePlan(plan)`.
 *
 * Frozen semantics (architect, writing-specialist-corrected, observed live
 * tree 2026-08-19):
 * - **Grouping:** every plan row lifts into exactly one snapshot — the
 *   iteration whose `{ITERATION_DIR}` compass frontmatter registers its id
 *   (`iterations/<id>/delivery-compass.md` files only; the
 *   `delivery-compass.<role>.md` review-chain variants are NOT grouping
 *   sources). Row id is read from `id` OR the legacy `plan_id` key. A
 *   registered id with NO status row (compacted away — 23 observed at
 *   fixture freeze 2026-08-19; the canonical frozen count lives in
 *   `test/fixtures/migrate-real/status.json`) is recorded on the owning
 *   snapshot's `legacy_metadata.compact_missing[]` — never fabricated as a
 *   row.
 *   Unregistered rows become standalone plan-type snapshots.
 * - **Snapshot status mapping:** iteration snapshot status = compass
 *   frontmatter (`active|locked` -> `running`; `completed` -> `completed`);
 *   standalone rows `Done` -> `completed`, `InProgress|InReview` ->
 *   `running`, `Blocked` -> `paused`, `Todo` -> `paused` + not-started
 *   note; nothing maps to `failed|stopped` from v1 data (those states are
 *   born in the v3 runtime). Row-level plan statuses stay VERBATIM inside
 *   `plans[]`.
 * - **Field lift:** root `metadata` execution-policy keys
 *   (`plan_parallelism`/`worktree_mode`/`push_policy`) -> snapshot
 *   `execution_policy` (first-class); `iteration_base_branch`/
 *   `target_branch`/`spec_integration_branch` -> `branch`;
 *   `control_worktree_path` -> `control_worktree_path`;
 *   `integration_merge_lease` -> top-level `integration_merge_lease`; all of
 *   these land on the ACTIVE iteration snapshot (status `running`; v3.0.0
 *   today). `program_roadmap` seeds `projects/<id>/roadmap.md` (its
 *   `no_intermediate_releases` / `deferred_beyond` fields are preserved in
 *   the seed body — nothing dropped silently); `harness_root` is dropped as
 *   redundant with a `legacy_metadata` note;
 *   `metadata.updated_at` folds into the v2 root `updated_at`; ALL other/
 *   unknown root-metadata keys land in the active snapshot
 *   `legacy_metadata` — nothing dropped silently.
 * - **Residuals:** open `residual_findings` entries ->
 *   `projects/<id>/residuals.json` (entries keyed by plan id, each value an
 *   ARRAY — v1 `residual_findings[plan-id]` multi-finding semantics
 *   preserved verbatim; `source_plan`/`registered_at` provenance added per
 *   entry; `lifecycle_id` added when the plan groups into an iteration).
 *   No entry is ever collapsed or skipped (QC wave-1 W-E).
 *   `archived/residuals/*.json` are legacy history — NOT lifted.
 * - **Notes:** per-plan `notes` ARRAYS -> `workflows/<id>/notes.jsonl`
 *   initial entries (one JSON line per note; string-typed `notes` stay on
 *   the row verbatim and are not lifted). Standalone Todo rows add a
 *   generated not-started note line. SSOT: the ledger is the runtime log;
 *   row `notes` is the legacy verbatim copy (see workflow.ts snapshot docs).
 * - **Ordering & idempotence:** apply steps are additive-first (archive
 *   copy, workflow dirs, project register, roadmap); the root v2
 *   replacement (`version: 2`, `updated_at`, empty `workflows[]` until
 *   re-registered) is the LAST step — the commit point; before it a failed
 *   run leaves v1 intact (recoverable by re-run). Re-run on a v2 root
 *   (`version === 2`) -> no-op with message. `dryRun` plans carry the full
 *   step list (source -> destination) and apply zero writes.
 *
 * No fs writes happen outside the harness dir: every destination is
 * harness-relative — enforced at the planner boundary (QC wave-1 W-B):
 * every lifecycle id that becomes a path segment (v1 row `id`/`plan_id`,
 * compass `iteration_id`, `opts.projectId`) must pass
 * `assertSafePathComponent` or the plan is refused BEFORE any step list is
 * produced. Duplicate v1 plan ids are likewise refused fail-loud (qc3
 * S-001) — every row must land in exactly one snapshot. All timestamps
 * derive from legacy data (deterministic, no clock reads).
 *
 * Phase-5 review fixes:
 * - F1 (custom layout): the planner resolves `{WORKFLOW_DIR}` /
 *   `{PROJECT_DIR}` from the harness root (`.mstarc` `workflow_dir` /
 *   `project_dir` win, defaults compose under the harness dir) and records
 *   them on the plan; `file` fields keep the canonical default-layout rel
 *   names, the executor writes through the resolved dirs — a custom layout
 *   migrates to the same location the v3 runtime reads.
 * - F2 (cross-class id collision): iteration snapshot ids, standalone plan
 *   ids and the project id must all be unique — an iteration id equal to a
 *   standalone plan id would plan the same `workflows/<id>/snapshot.json`
 *   twice (silent overwrite at apply); the plan is refused fail-loud with
 *   the conflict list.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readJson, writeJson } from "./core.js";
import { parseCompassFrontmatterText } from "./iteration.js";
import { withStatusWriteLock } from "./lease.js";
import { assertSafePathComponent, resolveProjectDir, resolveWorkflowDir } from "./path.js";
import { _DEFAULT_PROJECT, PROJECT_REGISTER_FILE, PROJECT_ROADMAP_FILE, validateProjectRegister, type ProjectRegisterDoc, type ProjectRegisterEntry } from "./project.js";
import {
  isOpenResidual,
  validateStatusV2,
  type StatusDoc,
  type StatusV2Doc,
} from "./status.js";
import {
  WORKFLOW_SNAPSHOT_FILE,
  writeWorkflowSnapshot,
  type WorkflowLifecycleStatus,
  type WorkflowLifecycleType,
  type WorkflowSnapshot,
} from "./workflow.js";

/** Root status file name inside `{HARNESS_DIR}` (v1 input / v2 output). */
export const MIGRATE_STATUS_FILE = "status.json";

/** Legacy v1 root copy written by migration (never deleted without it). */
export const ARCHIVED_STATUS_V1_FILE = "archived/status.v1.json";

/** Notes ledger file name inside `workflows/<id>/` (schema v1 event kinds). */
export const NOTES_LEDGER_FILE = "notes.jsonl";

/** One planned apply step (kind + source -> destination labels for dry-run). */
export type MigrateStep = {
  kind: "archive-status-v1" | "write-snapshot" | "write-notes" | "write-register" | "write-roadmap" | "replace-root-v2";
  source: string;
  destination: string;
};

/** One planned workflow snapshot (id = plan id or iteration id). */
export type MigrateSnapshot = {
  id: string;
  type: WorkflowLifecycleType;
  status: WorkflowLifecycleStatus;
  /**
   * Canonical (default-layout) harness-relative snapshot path, e.g.
   * `workflows/<id>/snapshot.json`. The actual write target derives from
   * `MigratePlan.workflowDir` (Phase-5 F1 — a `.mstarc` custom
   * `workflow_dir` is honored by the executor); this field keeps the
   * default-layout rel name for display/provenance.
   */
  file: string;
  /** Provenance label (compass file / status.json row). */
  source: string;
  data: WorkflowSnapshot;
};

/** One planned notes ledger (`workflows/<id>/notes.jsonl`). */
export type MigrateNotesFile = {
  /** Canonical (default-layout) rel path; actual target = `plan.workflowDir` + the suffix. */
  file: string;
  source: string;
  /** Serialized JSON lines (each ends with `\n` when joined). */
  lines: string[];
};

/** One planned project register document (`projects/<id>/residuals.json`). */
export type MigrateRegister = {
  /** Canonical (default-layout) rel path; actual target = `plan.projectDir` + the suffix. */
  file: string;
  source: string;
  data: ProjectRegisterDoc;
};

/** One planned roadmap seed (`projects/<id>/roadmap.md`). */
export type MigrateRoadmap = {
  /** Canonical (default-layout) rel path; actual target = `plan.projectDir` + the suffix. */
  file: string;
  source: string;
  content: string;
};

/** The root v2 replacement (commit point; empty `workflows[]` until re-registered). */
export type MigrateRootV2 = {
  file: string;
  data: StatusV2Doc;
};

/** Planner options (plan Task 6 — `--dry-run` returns steps, zero writes). */
export type MigrateOptions = {
  dryRun?: boolean;
  /** Project id for the register/roadmap home (default `_default`). */
  projectId?: string;
};

/** Full migration plan: every write is described; the executor applies it. */
export type MigratePlan = {
  /** Resolved harness dir. */
  root: string;
  /**
   * Resolved `{WORKFLOW_DIR}` (Phase-5 F1): the `.mstarc` `[config]
   * workflow_dir` declaration wins, else `{HARNESS_DIR}/workflows`. The
   * snapshot/notes `file` fields below keep the canonical default-layout
   * rel names for display/provenance; the executor derives the actual
   * write targets from this dir so a custom layout lands where the v3
   * runtime reads.
   */
  workflowDir: string;
  /**
   * Resolved `{PROJECT_DIR}` (Phase-5 F1): the `.mstarc` `[config]
   * project_dir` declaration wins, else `{HARNESS_DIR}/projects`. Same
   * canonical-`file`-vs-actual-target split as `workflowDir` for the
   * register/roadmap writes.
   */
  projectDir: string;
  dryRun: boolean;
  /** Root status.json already at `version: 2` -> nothing to plan/apply. */
  alreadyMigrated: boolean;
  /** Human message (no-op reason when `alreadyMigrated`). */
  message: string;
  snapshots: MigrateSnapshot[];
  notesFiles: MigrateNotesFile[];
  register: MigrateRegister | null;
  roadmap: MigrateRoadmap | null;
  rootV2: MigrateRootV2;
  archive: { file: string; source: string };
  /** Informational notes surfaced in dry-run output (never silent drops). */
  migrationNotes: string[];
  /** Ordered apply steps (additive-first; root v2 replacement last). */
  steps: MigrateStep[];
};

/** Executor result. */
export type MigrateResult = {
  applied: boolean;
  message: string;
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
  program_roadmap: true,
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

/** Local calendar date `YYYY-MM-DD` (fallback only; fixtures always carry dates). */
function todayString(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Scan the canonical compasses under `iterations/` (files named exactly
 * `delivery-compass.md` inside iteration dirs — the
 * `delivery-compass.<role>.md` review-chain variants are NOT grouping
 * sources). A malformed compass (unreadable/unsupported frontmatter or
 * unknown status) fails loud — migration must never misgroup silently.
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
        `refusing to migrate: compass ${JSON.stringify(compassPath)} has unsupported status ${JSON.stringify(status)} (expected active | locked | completed)`,
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

/** Build one standalone plan snapshot (row status mapping; Todo -> paused + note). */
function buildStandaloneSnapshot(
  row: Record<string, unknown>,
  rootUpdatedAt: string,
  migrationNotes: string[],
): MigrateSnapshot {
  const id = rowIdOf(row) ?? "<unnamed>";
  const statusValue = row.status;
  let status: WorkflowLifecycleStatus;
  if (statusValue === "Done") status = "completed";
  else if (statusValue === "InProgress" || statusValue === "InReview") status = "running";
  else if (statusValue === "Todo" || statusValue === "Blocked") status = "paused";
  else {
    status = "paused";
    migrationNotes.push(
      `row ${JSON.stringify(id)} has unrecognized v1 status ${JSON.stringify(statusValue)} \u2014 snapshot status defaults to paused (row status stays verbatim)`,
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
  migrationNotes: string[],
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

  if (typeof metadata.control_worktree_path === "string" && metadata.control_worktree_path !== "") {
    data.control_worktree_path = metadata.control_worktree_path;
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
    legacyMetadata.harness_root_note = `dropped as redundant (v2 harness dir derives from status.json location): ${String(metadata.harness_root)}`;
  }
  if (Object.keys(legacyMetadata).length > 0) data.legacy_metadata = legacyMetadata;

  if (activeIterations > 1) {
    migrationNotes.push(
      `${activeIterations} active iterations present \u2014 root-metadata lifts applied to ${JSON.stringify(snapshot.id)} only`,
    );
  }
}

/**
 * Build `projects/<id>/roadmap.md` seeds from `metadata.program_roadmap`.
 * Decision (fix round 1, M-1): the roadmap's internal fields
 * `no_intermediate_releases` / `deferred_beyond` are preserved in the seed
 * BODY (Direction section) — not in `legacy_metadata` — because they are
 * roadmap content the user reads in `roadmap.md`; nothing dropped silently.
 */
function buildRoadmap(programRoadmap: Record<string, unknown>, projectId: string, migratedAt: string): string {
  const title = typeof programRoadmap.title === "string" && programRoadmap.title !== "" ? programRoadmap.title : "Program roadmap";
  const doc = typeof programRoadmap.doc === "string" ? programRoadmap.doc : "";
  const completionVersion = typeof programRoadmap.completion_version === "string" ? programRoadmap.completion_version : "";
  const branch = typeof programRoadmap.branch === "string" ? programRoadmap.branch : "";
  const milestones = Array.isArray(programRoadmap.slices)
    ? programRoadmap.slices.map((slice) => String(slice)).filter((slice) => slice !== "")
    : [];
  const deferred = Array.isArray(programRoadmap.deferred_beyond)
    ? programRoadmap.deferred_beyond.map((item) => String(item)).filter((item) => item !== "")
    : [];

  const lines: string[] = [
    "---",
    `project_id: ${projectId}`,
    `title: ${title}`,
    "status: active",
    `created_at: ${migratedAt}`,
  ];
  if (milestones.length > 0) {
    lines.push("milestones:");
    for (const milestone of milestones) lines.push(`  - ${milestone}`);
  }
  lines.push("residuals_ref: residuals.json", "---", "", "# Roadmap", "", "## Direction");
  const provenance = [doc !== "" ? `doc: ${doc}` : "", completionVersion !== "" ? `completion_version: ${completionVersion}` : "", branch !== "" ? `branch: ${branch}` : ""]
    .filter((part) => part !== "")
    .join(", ");
  lines.push(`Migrated from legacy status.json \`metadata.program_roadmap\`${provenance !== "" ? ` (${provenance})` : ""}.`);
  if (programRoadmap.no_intermediate_releases !== undefined) {
    lines.push(`no_intermediate_releases: ${String(programRoadmap.no_intermediate_releases)}`);
  }
  if (deferred.length > 0) {
    lines.push("", "### Deferred beyond", ...deferred.map((item) => `- ${item}`));
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the project register from v1 `residual_findings` (open entries
 * only). QC wave-1 W-E: entries are keyed by plan id, each value an ARRAY
 * of ALL open residuals of that plan (v1 `residual_findings[plan-id]`
 * multi-finding semantics preserved verbatim — no collapse, no skip, no
 * `migration_notes`).
 */
function buildRegister(
  residualFindings: Record<string, unknown>,
  byPlan: Map<string, CompassInfo>,
  projectId: string,
  migratedAt: string,
): MigrateRegister | null {
  const entries: Record<string, ProjectRegisterEntry[]> = {};
  const planKeys = Object.keys(residualFindings).sort();
  for (const planId of planKeys) {
    const raw = residualFindings[planId];
    if (!Array.isArray(raw)) continue;
    const open = raw
      .filter((entry): entry is Record<string, unknown> => isPlainObject(entry) && isOpenResidual(entry))
      .sort((a, b) => {
        const aId = typeof a.id === "string" ? a.id : "";
        const bId = typeof b.id === "string" ? b.id : "";
        return compareIds(aId, bId);
      });
    if (open.length === 0) continue;
    const owner = byPlan.get(planId);
    entries[planId] = open.map((entry) => ({
      ...entry,
      source_plan: planId,
      registered_at: migratedAt,
      ...(owner !== undefined ? { lifecycle_id: owner.id } : {}),
    }));
  }
  if (Object.keys(entries).length === 0) return null;
  const doc: ProjectRegisterDoc = { entries };
  return {
    file: join("projects", projectId, PROJECT_REGISTER_FILE),
    source: "status.json residual_findings",
    data: doc,
  };
}

function collectNotesFiles(snapshots: MigrateSnapshot[]): MigrateNotesFile[] {
  const out: MigrateNotesFile[] = [];
  for (const snapshot of snapshots) {
    const lines: string[] = [];
    let source = "";
    for (const row of snapshot.data.plans) {
      if (Array.isArray(row.notes)) {
        source = "status.json plans[].notes arrays";
        for (const note of row.notes) {
          if (typeof note !== "string") continue;
          lines.push(JSON.stringify({ kind: "note", ts: snapshot.data.updated_at, text: note }));
        }
      }
    }
    if (snapshot.type === "plan" && snapshot.status === "paused") {
      const row = snapshot.data.plans[0];
      if (row !== undefined && row.status === "Todo") {
        source = source === "" ? "status.json plans[] Todo rows (not-started note)" : source;
        const noteText =
          typeof row.id === "string"
            ? `${row.id} not started (v1 row status Todo mapped to snapshot status paused)`
            : "not started (v1 row status Todo mapped to snapshot status paused)";
        lines.push(JSON.stringify({ kind: "note", ts: snapshot.data.updated_at, text: noteText }));
      }
    }
    if (lines.length === 0) continue;
    out.push({
      file: join(dirname(snapshot.file), NOTES_LEDGER_FILE),
      source,
      lines,
    });
  }
  return out;
}

/**
 * Pure migration planner (plan Task 6): reads the v1 tree under `root` and
 * returns the full v2 migration plan — snapshots, notes ledgers, project
 * register, roadmap seeds, the archived v1 copy and the root v2
 * replacement — with an ordered step list (source -> destination). ZERO
 * writes; the caller applies via `applyMigratePlan`.
 *
 * A v2 root (`status.json` `version === 2`) yields an `alreadyMigrated`
 * plan with no steps (idempotence); `opts.dryRun` marks the plan so apply
 * is a no-op too.
 */
export function migrateHarnessTree(root: string, opts: MigrateOptions = {}): MigratePlan {
  const harnessDir = resolve(root);
  // Phase-5 F1: resolve the v3 layout dirs from the harness root once — a
  // `.mstarc` `[config] workflow_dir` / `project_dir` declaration wins
  // (relative values resolve against the config file's directory, absolute
  // allowed; discovery never passes the harness dir's parent), otherwise
  // the defaults compose under the harness dir. Every planned write target
  // derives from these, so a custom layout migrates to the SAME location
  // the v3 runtime readers/writers resolve (cli `resolveSnapshotPath`,
  // hooks, tools).
  const workflowDir = resolveWorkflowDir(harnessDir, { harnessDir });
  const projectDir = resolveProjectDir(harnessDir, { harnessDir });
  const projectId = opts.projectId ?? _DEFAULT_PROJECT;
  const statusPath = join(harnessDir, MIGRATE_STATUS_FILE);
  const legacy = readJson(statusPath) as StatusDoc;

  if (legacy.version === 2) {
    const updatedAt = typeof legacy.updated_at === "string" && legacy.updated_at !== "" ? legacy.updated_at : "1970-01-01";
    return {
      root: harnessDir,
      workflowDir,
      projectDir,
      dryRun: opts.dryRun === true,
      alreadyMigrated: true,
      message: `no-op: ${statusPath} is already at schema version 2 (migrated) \u2014 nothing to do`,
      snapshots: [],
      notesFiles: [],
      register: null,
      roadmap: null,
      rootV2: { file: MIGRATE_STATUS_FILE, data: { version: 2, updated_at: updatedAt, workflows: [] } },
      archive: { file: ARCHIVED_STATUS_V1_FILE, source: MIGRATE_STATUS_FILE },
      migrationNotes: [],
      steps: [],
    };
  }
  if (legacy.version !== undefined && legacy.version !== 1) {
    throw new Error(
      `refusing to migrate: ${statusPath} has unrecognized schema version ${JSON.stringify(legacy.version)} (expected 1)`,
    );
  }
  if (legacy.version === undefined) {
    throw new Error(`refusing to migrate: no v1 status.json found at ${statusPath} (nothing to migrate)`);
  }

  const rows = Array.isArray(legacy.plans) ? legacy.plans.filter(isPlainObject) : [];
  if (Array.isArray(legacy.plans)) {
    // Fail-loud lift guards (QC wave-1 W-B / qc3 S-001): every row must
    // land in exactly one snapshot — a row without id/plan_id is
    // unliftable, an id that is not a single safe path component could
    // traverse out of the harness dir (it becomes `workflows/<id>/…`),
    // and duplicate ids would silently drop/overwrite a sibling row.
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
        `refusing to migrate: ${unLiftable.length} plans[] row(s) cannot be lifted (missing id/plan_id or not an object) \u2014 every v1 row must land in exactly one snapshot`,
      );
    }
    const duplicates = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    if (duplicates.length > 0) {
      throw new Error(
        `refusing to migrate: ${duplicates.length} duplicate plan id(s) (${duplicates.join(", ")}) \u2014 every v1 row must land in exactly one snapshot`,
      );
    }
  }
  const metadata = isPlainObject(legacy.metadata) ? legacy.metadata : {};
  const rootUpdatedAt =
    dateString(legacy.updated_at) ?? dateString(metadata.updated_at) ?? todayString();
  const migratedAt = dateString(metadata.updated_at) ?? rootUpdatedAt;

  const migrationNotes: string[] = [];
  const compasses = scanCompasses(harnessDir);
  // QC wave-1 W-B: compass iteration ids become `workflows/<id>/…` path
  // segments (and `compass_ref` values) — refuse unsafe ids fail-loud.
  for (const compass of compasses) {
    assertSafePathComponent(compass.id, "iteration id");
  }
  // QC wave-1 W-B: the project id becomes `projects/<id>/…` segments.
  assertSafePathComponent(projectId, "projectId");
  const { byPlan, rowById } = groupRows(rows, compasses);

  // 1. Iteration snapshots (every canonical compass; zero-plan compasses
  //    still produce an empty terminal snapshot).
  const snapshots: MigrateSnapshot[] = compasses.map((compass) => buildIterationSnapshot(compass, rowById, rootUpdatedAt));

  // 2. Standalone snapshots for unregistered rows.
  for (const row of rows) {
    const id = rowIdOf(row);
    if (id !== null && !byPlan.has(id)) snapshots.push(buildStandaloneSnapshot(row, rootUpdatedAt, migrationNotes));
  }

  // 2b. Cross-class lifecycle-id uniqueness (Phase-5 F2, Greptile P1):
  // plan rows are unique within plans[] (guard above) and compass ids are
  // unique by directory, but an iteration id may still equal a STANDALONE
  // plan id (a row registered in no compass) — both would plan the same
  // `workflows/<id>/snapshot.json` and the apply loop would silently
  // overwrite the earlier snapshot. The project id joins the same set
  // (register/roadmap live under `projects/<projectId>/`; under a custom
  // `.mstarc` layout the workflow and project dirs may even coincide).
  // Refuse fail-loud with the conflict list — never a silent double-write.
  const lifecycleSources = new Map<string, string[]>();
  for (const snapshot of snapshots) {
    const sources = lifecycleSources.get(snapshot.id) ?? [];
    sources.push(snapshot.type === "iteration" ? "iteration" : "standalone plan");
    lifecycleSources.set(snapshot.id, sources);
  }
  const projectSources = lifecycleSources.get(projectId) ?? [];
  projectSources.push("project");
  lifecycleSources.set(projectId, projectSources);
  const collisions = [...lifecycleSources.entries()].filter(([, sources]) => sources.length > 1);
  if (collisions.length > 0) {
    throw new Error(
      `refusing to migrate: ${collisions.length} lifecycle id collision(s) (${collisions
        .map(([id, sources]) => `${JSON.stringify(id)} shared by ${sources.join(" + ")}`)
        .join("; ")}) \u2014 every id must be unique across iterations, standalone plans and the project id (each id becomes a workflow/project dir segment)`,
    );
  }
  snapshots.sort((a, b) => compareIds(a.id, b.id));

  // 3. Root-metadata lift -> the active iteration snapshot (v3.0.0 today).
  // Lift-target rule (qc wave-1 S-g, documented): sorted-first by snapshot
  // id — deterministic, but arbitrary when 2+ iterations run concurrently;
  // revisit with a locked-compass preference when the multi-active case
  // becomes real.
  const activeIterations = snapshots.filter((snapshot) => snapshot.status === "running" && snapshot.type === "iteration");
  if (activeIterations.length > 0) {
    applyRootMetadataLift(activeIterations[0]!, metadata, migrationNotes, activeIterations.length);
  } else if (Object.keys(metadata).length > 0) {
    migrationNotes.push(
      "no active iteration snapshot found \u2014 root metadata execution-policy/branch keys have no lift home and stay unmapped (visible here, not silently dropped)",
    );
  }

  // 4. Notes ledgers (row notes arrays + not-started notes).
  const notesFiles = collectNotesFiles(snapshots);

  // 5. Project register (open residual_findings only; all open entries per
  // plan — v1 multi-finding semantics, no collapse).
  const residualFindings = isPlainObject(legacy.residual_findings) ? legacy.residual_findings : {};
  const register = buildRegister(residualFindings, byPlan, projectId, migratedAt);

  // 6. Roadmap seeds (QC wave-1 S-d: the frontmatter title is sanitized —
  //    line breaks would break the flat-subset YAML parse).
  const programRoadmap = isPlainObject(metadata.program_roadmap) ? metadata.program_roadmap : null;
  let roadmap: MigrateRoadmap | null = null;
  if (programRoadmap) {
    const rawTitle = typeof programRoadmap.title === "string" && programRoadmap.title !== "" ? programRoadmap.title : "Program roadmap";
    const sanitizedTitle = rawTitle.replace(/[\r\n]+/g, " ").trim();
    if (sanitizedTitle !== rawTitle) {
      migrationNotes.push(
        `roadmap title sanitized for frontmatter (line breaks replaced with spaces): ${JSON.stringify(rawTitle)}`,
      );
    }
    roadmap = {
      file: join("projects", projectId, PROJECT_ROADMAP_FILE),
      source: "status.json metadata.program_roadmap",
      content: buildRoadmap({ ...programRoadmap, title: sanitizedTitle }, projectId, migratedAt),
    };
  }

  // 7. Root v2 replacement (commit point; workflows[] empty until re-registered).
  const rootV2: MigrateRootV2 = {
    file: MIGRATE_STATUS_FILE,
    data: { version: 2, updated_at: migratedAt, workflows: [] },
  };
  const archive = { file: ARCHIVED_STATUS_V1_FILE, source: MIGRATE_STATUS_FILE };

  // 8. Ordered step list (additive-first; root v2 replacement LAST).
  const steps: MigrateStep[] = [
    { kind: "archive-status-v1", source: archive.source, destination: archive.file },
    ...snapshots.map((snapshot) => ({
      kind: "write-snapshot" as const,
      source: snapshot.source,
      destination: snapshot.file,
    })),
    ...notesFiles.map((notes) => ({
      kind: "write-notes" as const,
      source: notes.source,
      destination: notes.file,
    })),
  ];
  if (register !== null) steps.push({ kind: "write-register", source: register.source, destination: register.file });
  if (roadmap !== null) steps.push({ kind: "write-roadmap", source: roadmap.source, destination: roadmap.file });
  steps.push({ kind: "replace-root-v2", source: `${MIGRATE_STATUS_FILE} (v1)`, destination: `${MIGRATE_STATUS_FILE} (v2)` });

  return {
    root: harnessDir,
    workflowDir,
    projectDir,
    dryRun: opts.dryRun === true,
    alreadyMigrated: false,
    message: `planned migration of ${snapshots.length} lifecycles (${steps.length} steps)`,
    snapshots,
    notesFiles,
    register,
    roadmap,
    rootV2,
    archive,
    migrationNotes,
    steps,
  };
}

/**
 * Execute a migration plan (plan Task 6). Additive-first ordering: the v1
 * root is archived, workflow snapshots/notes, the project register and the
 * roadmap are written BEFORE the root v2 replacement — the LAST step, the
 * commit point. A failure before it leaves the v1 tree intact (re-run
 * applies the same deterministic plan). Re-running on a v2 root, or with a
 * `dryRun` plan, is a no-op. Every destination stays inside the harness
 * dir; every snapshot is validated fail-closed inside `writeWorkflowSnapshot`
 * — the writer is the authoritative validator, so the apply loop does not
 * pre-validate (qc wave-1 S-h: a gate here would run the same O(rows) pass
 * twice per snapshot).
 */
export async function applyMigratePlan(plan: MigratePlan): Promise<MigrateResult> {
  if (plan.dryRun) {
    return { applied: false, message: `dry-run: ${plan.steps.length} steps planned (source \u2192 destination), zero writes` };
  }
  const statusPath = join(plan.root, MIGRATE_STATUS_FILE);
  const current = readJson(statusPath);
  if (current.version === 2) {
    return { applied: false, message: "no-op: status.json already at schema version 2 (migrated) \u2014 nothing to do" };
  }

  // Phase-5 F1: actual write targets derive from the RESOLVED layout dirs
  // recorded on the plan (`.mstarc` `workflow_dir` / `project_dir`, else
  // defaults under the harness dir) — the canonical `file` fields stay the
  // default-layout rel names (display/provenance), the resolved dirs are
  // where a custom layout must land. `relative("workflows"|"projects", …)`
  // strips the canonical prefix and re-joins under the resolved dir.
  const harnessRoot = resolve(plan.root);
  const workflowRoot = resolve(plan.workflowDir);
  const projectRoot = resolve(plan.projectDir);
  if (!isAbsolute(plan.workflowDir) || !isAbsolute(plan.projectDir)) {
    throw new Error(
      `refusing to apply migration: plan workflowDir/projectDir must be absolute (got ${JSON.stringify(plan.workflowDir)} / ${JSON.stringify(plan.projectDir)})`,
    );
  }
  const workflowTargetOf = (canonicalFile: string): string => join(workflowRoot, relative("workflows", canonicalFile));
  const projectTargetOf = (canonicalFile: string): string => join(projectRoot, relative("projects", canonicalFile));

  // QC wave-1 W-B (defense-in-depth at the write boundary, Phase-5 F1
  // extended): the planner already refuses unsafe ids via
  // assertSafePathComponent, but apply is a public API — re-enforce the
  // module invariant ("no fs writes outside the harness dir or the
  // resolved workflow/project dirs") on every planned destination so a
  // hand-built plan can never escape `plan.root` via a relative path.
  const allDestinations = [
    plan.archive.file,
    ...plan.snapshots.map((snapshot) => snapshot.file),
    ...plan.notesFiles.map((notes) => notes.file),
    ...(plan.register !== null ? [plan.register.file] : []),
    ...(plan.roadmap !== null ? [plan.roadmap.file] : []),
  ];
  for (const destination of allDestinations) {
    const resolvedDest = resolve(join(plan.root, destination));
    const inside = (dir: string): boolean => resolvedDest === dir || resolvedDest.startsWith(`${dir}${sep}`);
    if (!inside(harnessRoot) && !inside(workflowRoot) && !inside(projectRoot)) {
      throw new Error(
        `refusing to apply migration: destination escapes the harness dir (${JSON.stringify(destination)}) \u2014 every write must stay under ${JSON.stringify(plan.root)}, the workflow dir (${JSON.stringify(plan.workflowDir)}) or the project dir (${JSON.stringify(plan.projectDir)})`,
      );
    }
  }

  // 1. Archive the v1 root BEFORE anything else touches it (never deleted
  //    without that copy).
  mkdirSync(join(plan.root, dirname(plan.archive.file)), { recursive: true });
  copyFileSync(statusPath, join(plan.root, plan.archive.file));

  // 2. Workflow snapshots (additive). Validation happens inside
  // writeWorkflowSnapshot — the writer fails closed before any write, so
  // there is no apply-loop gate (qc wave-1 S-h: writer validation is
  // authoritative; a pre-write gate here would run the same O(rows) pass
  // twice per snapshot).
  for (const snapshot of plan.snapshots) {
    await writeWorkflowSnapshot(snapshot.data, dirname(workflowTargetOf(snapshot.file)));
  }

  // 3. Notes ledgers (additive).
  for (const notes of plan.notesFiles) {
    const filePath = workflowTargetOf(notes.file);
    mkdirSync(dirname(filePath), { recursive: true });
    const content = notes.lines.length > 0 ? `${notes.lines.join("\n")}\n` : "";
    writeFileSync(filePath, content, "utf8");
  }

  // 4. Project register (additive; validated before the write).
  if (plan.register !== null) {
    const gate = validateProjectRegister(plan.register.data);
    if (!gate.ok) {
      throw new Error(
        `refusing to apply migration: invalid project register: ${gate.violations.map((v) => v.message).join("; ")}`,
      );
    }
    // Zero entries -> no register file (audit-20260821-f3): the planner
    // already returns `register: null` when there are no open residuals,
    // but a hand-built plan may carry a gate-passing empty `{ entries: {} }`
    // — writing an empty register would orphan an empty file. Validate
    // FIRST so an invalid doc (e.g. missing `entries`) still throws.
    if (Object.keys(plan.register.data.entries ?? {}).length > 0) {
      const filePath = projectTargetOf(plan.register.file);
      mkdirSync(dirname(filePath), { recursive: true });
      writeJson(filePath, plan.register.data as unknown as Record<string, unknown>);
    }
  }

  // 5. Roadmap seeds (additive).
  if (plan.roadmap !== null) {
    const filePath = projectTargetOf(plan.roadmap.file);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, plan.roadmap.content, "utf8");
  }

  // 6. Root v2 replacement — the COMMIT POINT (last step), serialized with
  // the root writers (`registerWorkflow`/`unregisterWorkflow`) under the
  // root-file `withStatusWriteLock` (qc wave-1 W-A: a bare writeJson here
  // could clobber a concurrent register that landed after the pre-check
  // below). The version re-check INSIDE the lock turns a stale plan (a
  // concurrent migrate committed first) into a no-op instead of an
  // overwrite of a root that may already hold registered workflows.
  const rootGate = validateStatusV2(plan.rootV2.data, { harnessDir: plan.root });
  if (!rootGate.ok) {
    throw new Error(`refusing to apply migration: invalid v2 root: ${rootGate.violations.map((v) => v.message).join("; ")}`);
  }
  return withStatusWriteLock(statusPath, () => {
    const latest = readJson(statusPath) as { version?: unknown };
    if (latest.version === 2) {
      return {
        applied: false,
        message: "no-op: status.json already at schema version 2 (migrated) \u2014 nothing to do",
      };
    }
    writeJson(statusPath, plan.rootV2.data as unknown as Record<string, unknown>);
    return {
      applied: true,
      message: `migrated ${plan.snapshots.length} lifecycles into workflows/, project layer seeded, root status.json replaced (v1 archived to ${plan.archive.file})`,
    };
  });
}
