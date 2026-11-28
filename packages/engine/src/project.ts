/** see packages/engine/src/project.ts - Engine project module — project layer (conventions: mstar-conventions/references/artifact-storage-paths.md § project layer; project register validator. This module is the only register validator; the register re-hosts the residual entry schema from `status.ts` via import — no copy. Spec sources (each export cites the plan/compass section it enforces): - Register file `projects/<id>/residuals.json` shape `{ entries: { [key]: (ResidualEntry & { source_plan, registered_at, lifecycle_id? })[] } }` ( ) — entries keyed by plan id, each value an ARRAY of entries (v1 `residual_findings[plan-id]` semantics preserved verbatim: a plan may hold 2+ open residuals); entry validation delegates verbatim to `validateResidual` (status.ts), so the severity enum + lifecycle semantics are preserved at the new address. - `_DEFAULT_PROJECT` fallback for project-less flows (compass ruling 2). - Theme-scoped research corpus `projects/<id>/references/`: engine owns `PROJECT_REFERENCES_DIR` + `listProjectReferenceFiles` — directory metadata only (`readdirSync` with `withFileTypes`), never file bodies, never a markdown schema; placement semantics are skills prose, not engine validation. - Project-register consumers: `findingsCleanupGate` (findings-cleanup modes; issue-governance cutover G2a — it consumes the authoritative open issues linked to the plan in `store.db`, never the legacy register) lives HERE. The legacy register rollup (`techDebtRollup`) is deleted (plan QC fix wave FW-5): the register authority is retired and the findings rollup computes from the issue store (`readIssueRollup`), so the register-walking reader had no supported caller left. status.ts no longer imports this module (the former module cycle stays broken). */
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { type GateResult, type Severity, type ValidationResult } from "./core.js";
import { isPlainObject } from "./coordination-write.js";
import { createHash } from "node:crypto";
import { openStore, readStoreAuthority, StoreError, type StoreContext, type StoreDb } from "./store-db.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import {
  openCollaborationStore,
  readCollaborationObservation,
  withCollaborationWrite,
  type CollaborationObservation,
  type CollaborationStamp,
  type CompleteCollaborationObservation,
} from "./collaboration-store.js";
import {
  normalizeSeverity,
  validateResidual,
  type ResidualEntry,
} from "./status.js";

/** Theme-scoped research directory name inside `projects/<id>/`. */
export const PROJECT_REFERENCES_DIR = "references";

/** Project register file name inside `projects/<id>/` (). */
export const PROJECT_REGISTER_FILE = "residuals.json";

/** Fallback project id for project-less flows ( — compass ruling 2). */
export const _DEFAULT_PROJECT = "_default";


/** One register entry: the v1 residual entry verbatim + register provenance. */
export type ProjectRegisterEntry = ResidualEntry & {
  source_plan: string;
  registered_at: string;
  lifecycle_id?: string;
};

/**
 * Register document shape (`projects/<id>/residuals.json`(;
 * `entries` keyed by plan id, each value an ARRAY of
 * register entries — v1 `residual_findings[plan-id] = entries[]`
 * multi-finding semantics preserved verbatim (a plan can hold 2+ open
 * residuals). `migration_notes[]` (the old single-entry collapse record)
 * is gone: no entries are ever skipped.
 */
export type ProjectRegisterDoc = {
  entries?: Record<string, ProjectRegisterEntry[]>;
  [key: string]: unknown;
};


/** Findings cleanup policy mirror of Assignment `Findings cleanup`. */
export type FindingsCleanupMode = "zero-residual" | "allow-residual";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

function validateNonEmptyString(
  violations: ValidationResult[],
  value: unknown,
  field: string,
  missingCode: string,
  invalidCode: string,
): void {
  if (value === undefined) {
    violations.push(violation("high", missingCode, `missing required field: ${field}`));
  } else if (typeof value !== "string" || value.trim() === "") {
    violations.push(violation("medium", invalidCode, `${field} must be a non-empty string`));
  }
}

/**
 * Validate a project register document (`projects/<id>/residuals.json`,
 *  `{ entries: { [key]: entry[] } }` keyed by
 * plan id, each value an ARRAY of entries (v1 `residual_findings[plan-id]`
 * multi-finding semantics preserved — a plan may hold 2+ open residuals).
 * Each entry is validated by the v1 `validateResidual` verbatim (severity
 * enum + lifecycle semantics preserved — the register re-hosts, never
 * copies) plus the register provenance fields `source_plan` (must match its
 * entries key) and `registered_at` (YYYY-MM-DD), and the optional
 * `lifecycle_id`.
 */
export function validateProjectRegister(doc: unknown): GateResult {
  const violations: ValidationResult[] = [];
  if (!isPlainObject(doc)) {
    return {
      ok: false,
      violations: [violation("high", "project.register.invalid", "project register must be an object")],
    };
  }

  if (doc.entries === undefined) {
    violations.push(violation("high", "project.register.missing-entries", "missing required field: entries"));
  } else if (!isPlainObject(doc.entries)) {
    violations.push(violation("high", "project.register.invalid-entries", "entries must be an object keyed by plan id"));
  } else {
    for (const [key, entries] of Object.entries(doc.entries)) {
      if (key.trim() === "") {
        violations.push(violation("medium", "project.register.invalid-key", "entries keys must be non-empty plan ids"));
      }
      if (!Array.isArray(entries)) {
        violations.push(
          violation(
            "high",
            "project.register.invalid-entry-list",
            `entries[${JSON.stringify(key)}] must be an array of residual entries (one entry per residual; v1 multi-finding semantics)`,
          ),
        );
        continue;
      }
      for (const entry of entries) {
 // Residual entry shape/semantics verbatim (severity enum + lifecycle
 // states — the register re-hosts them at the new address).
        violations.push(...validateResidual(entry).violations);
        if (!isPlainObject(entry)) continue;

        validateNonEmptyString(
          violations,
          entry.source_plan,
          "source_plan",
          "project.register.missing-source-plan",
          "project.register.invalid-source-plan",
        );
        if (entry.registered_at === undefined) {
          violations.push(violation("high", "project.register.missing-registered-at", "missing required field: registered_at"));
        } else if (typeof entry.registered_at !== "string" || !DATE_RE.test(entry.registered_at)) {
          violations.push(violation("medium", "project.register.invalid-registered-at", "registered_at must be YYYY-MM-DD"));
        }
        if (entry.lifecycle_id !== undefined && (typeof entry.lifecycle_id !== "string" || entry.lifecycle_id.trim() === "")) {
          violations.push(violation("medium", "project.register.invalid-lifecycle-id", "lifecycle_id must be a non-empty string"));
        }
 // The register is keyed by plan id (), so a mismatched
 // source_plan is corrupted provenance.
        if (typeof entry.source_plan === "string" && entry.source_plan.trim() !== "" && entry.source_plan !== key) {
          violations.push(
            violation(
              "medium",
              "project.register.mismatched-source-plan",
              `source_plan ${JSON.stringify(entry.source_plan)} does not match the entries key ${JSON.stringify(key)} \u2014 entries are keyed by plan id`,
            ),
          );
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * The collaboration read contract types are owned by `collaboration-store.ts`
 * (beside the handle that builds them) and re-exported here for the existing
 * domain imports.
 */
export type { CollaborationObservation, CollaborationProviderScope, CollaborationScope } from "./collaboration-store.js";

/** A complete plan-scoped findings observation: the open local issues it read. */
export type FindingsObservation = Extract<CollaborationObservation, { completeness: "complete" }> &
  Readonly<{ open: readonly { id: string; severity: Severity }[] }>;

/**
 * One complete plan-local findings observation (contract §Read/Completeness and
 * Gates): every OPEN **local** issue linked to the plan through `provenance`
 * (`kind='plan'`, `target=<plan-id>`, `origin='scoped'`; historical rows retain
 * the scoped default), read from the collaboration lane in ONE snapshot.
 *
 * Fail-closed: a missing (`collaboration.not-initialized`), corrupt
 * (`collaboration.unreadable`) or staged (`collaboration.not-active`) authority
 * refuses — an unreadable lane is never "no findings". A mirrored external row
 * is not a local finding; the gate counts the work this repo owes.
 */
export async function observePlanFindings(context: StoreContext, planId: string): Promise<FindingsObservation> {
  if (typeof planId !== "string" || planId.trim() === "") {
    throw new Error("observePlanFindings requires a non-empty plan id");
  }
  if (resolveCollaborationLocation(context).mode === "remote") {
    const { openRemoteReadView, remotePlanFindings } = await import("./collaboration-remote-read.js");
    const view = await openRemoteReadView(context);
    const { observation, open } = remotePlanFindings(view, planId);
    if (observation.completeness !== "complete") {
      throw new StoreError(
        "collaboration.observation-incomplete",
        `The remote findings scope for plan ${planId} is ${observation.completeness}; a findings decision needs one complete observation of every selected project.`,
        { planId },
      );
    }
    return { ...observation, open };
  }
  const handle = await openCollaborationStore(context, "read");
  try {
    const db = handle.db;
    db.exec("begin");
    try {
      const observation = readCollaborationObservation(handle, { kind: "plan", key: planId });
      const rows = db
        .prepare(
          "select issues.id as id, issues.severity as severity from issues " +
            "join provenance on provenance.issue_id = issues.id and provenance.kind = 'plan' and provenance.target = ? and provenance.origin = 'scoped' " +
            "where issues.disposition = 'open' and issues.provider = 'local' order by issues.id asc",
        )
        .all(planId) as Array<{ id: string; severity: string }>;
      return {
        ...observation,
        open: rows.map((row) => ({ id: row.id, severity: normalizeSeverity(row.severity) as Severity })),
      };
    } finally {
      db.exec("commit");
    }
  } finally {
    handle.close();
  }
}

function findingsGateDecision(
  observation: FindingsObservation,
  mode: FindingsCleanupMode,
): GateResult {
  const violations: ValidationResult[] = [];
  for (const row of observation.open) {
    const label = row.id;
    if (row.severity === "critical") {
      violations.push(
        mode === "zero-residual"
          ? violation(
              "high",
              "findings.zero-residual-critical",
              `${label}: unresolved critical blocks approval under zero-residual \u2014 fix now or close via explicit risk acceptance`,
            )
          : violation("high", "findings.allow-residual-critical", `${label}: unresolved critical blocks Approve with residuals`),
      );
    } else if (mode === "zero-residual") {
      violations.push(
        violation(
          "medium",
          "findings.zero-residual-open-issue",
          `${label}: an open issue cannot remain under zero-residual \u2014 close it through the authorized disposition path before handoff`,
        ),
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Findings cleanup gate (status-and-residuals.md § Findings cleanup modes;
 * issue-governance cutover G2a): the authoritative input is the collaboration
 * lane's issue rows. The gate returns the complete observation it decided on so
 * a consumer (completion evidence) can record the accepted scope, stamp,
 * revision and snapshot time; the legacy register is never consulted at
 * runtime (`validateProjectRegister` remains a migration-only validator).
 *
 * An unreadable, missing or staged authority refuses through
 * `observePlanFindings` — a mismatched or unavailable lane is never an empty
 * findings list.
 */
export async function findingsCleanupGate(
  context: StoreContext,
  planId: string,
  opts?: { mode?: FindingsCleanupMode },
): Promise<GateResult & { collaboration: FindingsObservation }> {
  const observation = await observePlanFindings(context, planId);
  const decision = findingsGateDecision(observation, opts?.mode ?? "allow-residual");
  return { ...decision, collaboration: observation };
}

/**
 * The two named findings-evidence refusals (contract §Operator commands and
 * refusals): the required scope was not fully proved, or the preflight
 * observation no longer applies.
 */
export type FindingsEvidenceCode = "collaboration.observation-incomplete" | "collaboration.observation-stale";

/**
 * A findings decision could not be re-proved against current scope. `details`
 * names the scope and both snapshots, so the caller repeats the same gate
 * against current scope instead of retrying the stale one.
 */
export class FindingsEvidenceError extends Error {
  readonly code: FindingsEvidenceCode;
  readonly details: Record<string, unknown>;

  constructor(code: FindingsEvidenceCode, message: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${message}`);
    this.name = "FindingsEvidenceError";
    this.code = code;
    this.details = details;
  }
}

/**
 * The pre-commit applicability re-sample of one findings decision: the complete
 * observation a gate decided on must still name the same plan scope, authority
 * stamp and revision. The recorded evidence is untrusted input here (a stored
 * completion record is re-read, not re-observed), so a scope this repo cannot
 * re-observe refuses as `observation-incomplete`; a moved lane refuses as
 * `observation-stale` and names both snapshots. The evidence itself is never
 * rewritten — the caller repeats the same gate against current scope.
 */
export async function assertPlanFindingsCurrent(
  context: StoreContext,
  observed: FindingsObservation,
): Promise<void> {
  const { scope } = observed;
  if (scope.kind !== "plan" || scope.key.trim() === "") {
    throw new FindingsEvidenceError(
      "collaboration.observation-incomplete",
      `The findings evidence names ${scope.kind} scope ${JSON.stringify(scope.key)}, which this gate cannot re-observe as a plan. Repeat the gate with the plan id it was decided for.`,
      { scope },
    );
  }
  const current = await observePlanFindings(context, scope.key);
  const { repoKey, mode, storeId, epoch } = observed.authority;
  const authority = current.authority;
  const selectionDrift =
    observed.source !== current.source ||
    observed.selectorCommit !== current.selectorCommit ||
    observed.generation !== current.generation;
  if (
    authority.repoKey !== repoKey ||
    authority.mode !== mode ||
    authority.storeId !== storeId ||
    authority.epoch !== epoch ||
    current.revision !== observed.revision ||
    selectionDrift
  ) {
    throw new FindingsEvidenceError(
      "collaboration.observation-stale",
      "The collaboration findings observation changed after the preflight gate; repeat the same gate against current scope so it is judged against a current complete observation.",
      {
        plan_id: scope.key,
        observed: {
          asOf: observed.asOf,
          authority: observed.authority,
          revision: observed.revision,
          selectorCommit: observed.selectorCommit ?? null,
          generation: observed.generation ?? null,
        },
        current: {
          asOf: current.asOf,
          authority: current.authority,
          revision: current.revision,
          selectorCommit: current.selectorCommit ?? null,
          generation: current.generation ?? null,
        },
      },
    );
  }
}

/**
 * List theme-scoped research files under `<projectDir>/references/`
 * (compass ruling 1): top-level
 * files plus files exactly one subdirectory deep; deeper nesting ignored;
 * directories never listed; regular files only (`Dirent.isFile()`). Returns
 * paths relative to the references root with `/` separators, sorted by code
 * unit. Strays named exactly `residuals.json` at the references **root**
 * are excluded — project-layer filenames are never research rows. `projectDir` is the **per-project** directory (the caller
 * resolves `join(resolveProjectDir(startDir), projectId)`; `_DEFAULT_PROJECT`
 * is the fallback id), never the projects root. Missing or unreadable
 * `references/` → `[]`; never throws; never opens a file body.
 */
export function listProjectReferenceFiles(projectDir: string): string[] {
  const root = join(projectDir, PROJECT_REFERENCES_DIR);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === PROJECT_REGISTER_FILE) continue;
    if (entry.isFile()) {
      files.push(entry.name);
    } else if (entry.isDirectory()) {
      let nested: Dirent[];
      try {
        nested = readdirSync(join(root, entry.name), { withFileTypes: true });
      } catch {
        continue; // unreadable subdirectory contributes nothing
      }
      for (const child of nested) {
        if (child.isFile()) files.push(`${entry.name}/${child.name}`);
      }
    }
  }
  return files.sort();
}

// ---------------------------------------------------------------------------
// Provider correspondence (binding-config plan Task 5)
// ---------------------------------------------------------------------------

/** Refusal vocabulary for the project↔provider correspondence. */
export type BindingErrorCode =
  | "linear.project-unregistered"
  | "linear.rebind-refused"
  | "linear.binding-invalid"
  | "linear.binding-absent"
  | "linear.revision-conflict"
  | "linear.binding-conflict"
  | "store.operation-conflict"
  | "store.not-active";

export class BindingError extends Error {
  readonly code: BindingErrorCode;

  constructor(code: BindingErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "BindingError";
    this.code = code;
  }
}

/** One stored correspondence row (`project_bindings`, migration 15). */
export type ProjectBinding = {
  projectId: string;
  provider: string;
  workspace: string;
  team: string;
  /** The external project this store project mirrors. */
  remoteProject: string;
  revision: number;
  updatedAt: string;
};

/** What the caller supplies: the connection facts come from `.mstarc`. */
export type ProjectBindingTarget = {
  provider: string;
  workspace: string;
  team: string;
  remoteProject: string;
};

export type ProjectBindingMutation = { operationId: string; expectedStoreRevision?: number };

/** `bound` or a NAMED absence — never a silent null. */
export type ProjectBindingRead =
  | { kind: "bound"; binding: ProjectBinding }
  | { kind: "absent"; code: "linear.binding-absent"; message: string };

export type ProjectBindingReceipt = {
  projectId: string;
  provider: string;
  remoteProject: string;
  revision: number;
  storeRevision: number;
  /** False when the identical pair was already recorded (the no-op success). */
  changed: boolean;
};

function bindingWrite<T>(context: StoreContext, fn: (db: StoreDb) => T): Promise<T> {
  return withCollaborationWrite(context, (handle) => fn(handle.db));
}

function bindingRow(db: StoreDb, projectId: string): ProjectBinding | null {
  const row = db
    .prepare("select project_id, provider, workspace, team, remote_project, revision, updated_at from project_bindings where project_id = ?")
    .get(projectId) as
    | { project_id: string; provider: string; workspace: string; team: string; remote_project: string; revision: number; updated_at: string }
    | undefined;
  if (row === undefined) return null;
  return {
    projectId: row.project_id,
    provider: row.provider,
    workspace: row.workspace,
    team: row.team,
    remoteProject: row.remote_project,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

/**
 * The Linear project a store project mirrors, or the named absence
 * `linear.binding-absent` (plan Task 5 read path). Read-only: no projection
 * refresh, no mutation, so a dashboard or import entry can ask it freely.
 */
export async function readProjectBinding(
  context: StoreContext,
  projectId: string,
): Promise<ProjectBindingRead & { collaboration: CompleteCollaborationObservation }> {
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new BindingError("linear.binding-invalid", "A non-empty project id is required.");
  }
  const id = projectId.trim();
  if (resolveCollaborationLocation(context).mode === "remote") {
    const { openRemoteReadView, remoteCollaborationObservation, requireRemoteProjects } = await import(
      "./collaboration-remote-read.js"
    );
    const view = await openRemoteReadView(context, [id]);
    const evidence = requireRemoteProjects(view, [id])[0]!;
    const collaboration = remoteCollaborationObservation(view, { kind: "project", key: id });
    if (collaboration.completeness !== "complete") {
      throw new StoreError(
        "collaboration.observation-incomplete",
        `The remote binding for project ${id} is not a complete, current observation.`,
        { projectId: id },
      );
    }
    return {
      kind: "bound",
      binding: {
        projectId: id,
        provider: "linear",
        workspace: evidence.scope.workspaceId,
        team: evidence.scope.teamId,
        remoteProject: evidence.scope.projectId,
        revision: Math.max(1, evidence.revision),
        updatedAt: evidence.asOf ?? "",
      },
      collaboration,
    };
  }
  const handle = await openCollaborationStore(context, "read");
  try {
    const db = handle.db;
    db.exec("begin");
    const collaboration = readCollaborationObservation(handle, { kind: "project", key: projectId.trim() });
    const binding = bindingRow(db, projectId.trim());
    db.exec("commit");
    if (binding !== null) return { kind: "bound", binding, collaboration };
    return {
      kind: "absent",
      code: "linear.binding-absent",
      message: `Project ${projectId.trim()} mirrors no external project yet. Bind one with \`mstar project bind --project ${projectId.trim()} --provider linear --remote-project <name-or-id> --operation <id>\`.`,
      collaboration,
    };
  } catch (error) {
    try {
      handle.db.exec("rollback");
    } catch {
    }
    throw error;
  } finally {
    handle.close();
  }
}

/**
 * Record (or re-confirm) the external project a store project mirrors.
 *
 * - an unregistered catalog project → `linear.project-unregistered`
 * - a project already mirroring a DIFFERENT remote project → `linear.rebind-refused`
 * - the identical pair → a no-op success (`changed: false`), never a refusal
 *
 * `workspace`/`team` are the `.mstarc` connection facts supplied by the
 * caller; this module never reads configuration. One collaboration write
 * transaction per call (house transaction ownership), with the row mutation
 * and its `collaboration_operations` receipt committing together.
 */
export function bindProject(
  context: StoreContext,
  projectId: string,
  target: ProjectBindingTarget,
  mutation: ProjectBindingMutation,
): Promise<ProjectBindingReceipt> {
  if (typeof projectId !== "string" || projectId.trim() === "") {
    return Promise.reject(new BindingError("linear.binding-invalid", "A non-empty project id is required."));
  }
  const id = projectId.trim();
  const clean = (value: unknown, label: string): string => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new BindingError("linear.binding-invalid", `${label} must be a non-empty string.`);
    }
    return value.trim();
  };
  if (target === undefined || target === null) {
    return Promise.reject(new BindingError("linear.binding-invalid", "A binding target is required."));
  }
  if (typeof mutation?.operationId !== "string" || mutation.operationId.trim() === "") {
    return Promise.reject(new BindingError("linear.binding-invalid", "A non-empty operationId is required."));
  }
  return bindingWrite(context, (db) => {
    const provider = clean(target.provider, "provider");
    const workspace = clean(target.workspace, "workspace");
    const team = clean(target.team, "team");
    const remoteProject = clean(target.remoteProject, "remoteProject");
    const hash = createHash("sha256")
      .update(JSON.stringify({ domain: "project-binding", projectId: id, provider, workspace, team, remoteProject }))
      .digest("hex");
    const prior = db.prepare("select request_hash, result_json from collaboration_operations where key_space = 'standalone' and operation_id = ?").get(mutation.operationId.trim()) as
      | { request_hash: string; result_json: string }
      | undefined;
    if (prior !== undefined) {
      if (prior.request_hash !== hash) {
        throw new BindingError("store.operation-conflict", "operationId was reused for a different binding request.");
      }
      return JSON.parse(prior.result_json) as ProjectBindingReceipt;
    }

    const state = db.prepare("select authority_state from collaboration_meta where id = 1").get() as { authority_state?: unknown } | undefined;
    if (state?.authority_state !== "active") {
      throw new BindingError("store.not-active", "Project binding requires an active collaboration authority.");
    }
    if (db.prepare("select 1 from catalog_entities where kind = 'project' and id = ?").get(id) === undefined) {
      throw new BindingError(
        "linear.project-unregistered",
        `Project ${id} is not registered in the catalog. Register it with \`mstar catalog register\` (or reconcile the catalog) before binding it to ${provider}.`,
      );
    }
    const current = db.prepare("select revision from collaboration_meta where id = 1").get() as { revision: number };
    const storeRevision = current.revision;
    if (mutation.expectedStoreRevision !== undefined && storeRevision !== mutation.expectedStoreRevision) {
      throw new BindingError("linear.revision-conflict", `Store revision changed since ${mutation.expectedStoreRevision} was observed (now ${storeRevision}).`);
    }

    const now = new Date().toISOString();
    const existing = bindingRow(db, id);
    let revision: number;
    let changed = true;
    if (existing === null) {
      // The unique index is per (provider, workspace, remote_project): one
      // external project can back only one store project.
      const taken = db
        .prepare("select project_id from project_bindings where provider = ? and workspace = ? and remote_project = ?")
        .get(provider, workspace, remoteProject) as { project_id: string } | undefined;
      if (taken !== undefined) {
        throw new BindingError(
          "linear.binding-conflict",
          `${provider} project ${remoteProject} in workspace ${workspace} already backs store project ${taken.project_id}; one external project can back one store project.`,
        );
      }
      revision = 1;
      db.prepare(
        "insert into project_bindings(project_id, provider, workspace, team, remote_project, revision, updated_at) values (?,?,?,?,?,?,?)",
      ).run(id, provider, workspace, team, remoteProject, revision, now);
    } else if (existing.provider === provider && existing.workspace === workspace && existing.remoteProject === remoteProject) {
      // The identical pair is a success, never a refusal (plan Task 5). `team`
      // may differ — it follows the `.mstarc` connection block, not identity.
      revision = existing.revision;
      changed = false;
      if (existing.team !== team) {
        revision = existing.revision + 1;
        changed = true;
        db.prepare("update project_bindings set team = ?, revision = ?, updated_at = ? where project_id = ?").run(team, revision, now, id);
      }
    } else {
      throw new BindingError(
        "linear.rebind-refused",
        `Project ${id} already mirrors ${existing.provider} project ${existing.remoteProject} (workspace ${existing.workspace}); re-binding it to ${remoteProject} is refused. Bind the intended remote project to its own store project instead.`,
      );
    }
    if (changed) db.prepare("update collaboration_meta set revision = revision + 1 where id = 1").run();
    const revisionRow = db.prepare("select revision from collaboration_meta where id = 1").get() as { revision: number };
    const currentStoreRevision = revisionRow.revision;
    const receipt: ProjectBindingReceipt = { projectId: id, provider, remoteProject, revision, storeRevision: currentStoreRevision, changed };
    db.prepare("insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) values ('standalone', ?, ?, ?, ?)").run(
      mutation.operationId.trim(),
      hash,
      JSON.stringify(receipt),
      now,
    );
    return receipt;
  });
}
