/**
 * store-read.ts -- the issue-store READ boundary (state-projection-contract §6).
 *
 * One request = one read handle (`withStoreRead`): an optional lazy projection
 * refresh for the views that need projected execution/roadmap rows, then every
 * view query inside ONE read transaction over committed store data. The view
 * readers return DTOs only -- no source JSON is read or parsed here, and no
 * filesystem probe happens in a view (source I/O is isolated in the projection
 * refresh boundary, `refreshProjections`).
 *
 * Why the view SQL is written out here instead of calling `listIssues` /
 * `getIssue` / `listCatalog`: those functions each open their OWN connection,
 * which would break both contract §6 requirements -- "one store handle per
 * request" and one transaction that sees issue, catalog and projection rows at
 * the same point in time. The issue readers below therefore mirror
 * `issue.ts` (`LAST_ACTIVITY_SQL`, `bindFilter`, `listIssues`, `getIssue`)
 * statement for statement, and `store-read.test.ts` pins the two readers to the
 * same answer so a future change to one side cannot drift silently.
 *
 * Refusals reuse the frozen vocabulary: `store.not-active` for a staged store,
 * the issue domain's `issue.not-found` for an absent issue, and the engine's
 * `SddScriptError(…, 2)` usage failure (the CLI's exit-2 / HTTP-400 class) for
 * a request shape the contract does not define -- an unknown view, a missing
 * required filter or an out-of-range page.
 */
import type { CatalogDocumentKind, CatalogEntityKind, CatalogLifecycle, CatalogRootKind, CatalogKey } from "./catalog.js";
import { IssueError, type Disposition, type IssueDetail, type IssueFilter, type IssueKind, type IssuePage, type Severity } from "./issue.js";
import { ProjectionError, refreshProjections, type ProjectionFreshness, type SourceDiagnostic } from "./projection.js";
import { SddScriptError } from "./sdd.js";
import { openStore, type StoreContext, type StoreDb, type StoreHandle } from "./store-db.js";

/** Refusal codes the read boundary itself raises (both already frozen). */
export type StoreReadErrorCode = "store.not-active";

/** Typed refusal for a read the store cannot serve. */
export class StoreReadError extends Error {
  readonly code: StoreReadErrorCode;

  constructor(code: StoreReadErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "StoreReadError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Envelope and request shapes (contract §6)
// ---------------------------------------------------------------------------

/** The projection health block every read envelope discloses. */
export type ReadProjection = {
  generation: number | null;
  freshness: ProjectionFreshness;
  builtAt: string | null;
  checkedAt: string;
  /** Named source problems only: source key, reason, safe message. */
  diagnostics: SourceDiagnostic[];
};

/** Contract §6 read envelope: the view DTO plus the revisions it was read at. */
export type ReadEnvelope<T> = {
  data: T;
  storeRevision: number;
  catalogRevision: number;
  projection: ReadProjection;
};

/**
 * One request's view work. `run` executes inside the single read transaction,
 * so every reader it uses sees one consistent snapshot; `needsProjection`
 * says whether the view consumes projected execution/roadmap rows and
 * therefore needs the lazy refresh first.
 */
export type StoreReadQuery<T> = {
  view: string;
  needsProjection: boolean;
  run(handle: StoreHandle): T;
};

/** Contract §6 dashboard views. */
export type DashboardView =
  | "issues"
  | "issue-detail"
  | "workflows"
  | "workflow-detail"
  | "iterations"
  | "iteration-detail"
  | "roadmap"
  | "issue-flow";

/**
 * Request filters. Only the fields a view needs are read: `id` for the three
 * detail views, `issue` for the issue list, `projectId` for the project-scoped
 * views (required by `roadmap`), and `limit`/`offset` for the three lists.
 */
export type DashboardFilters = {
  id?: string;
  projectId?: string;
  issue?: IssueFilter;
  limit?: number;
  offset?: number;
};

// ---------------------------------------------------------------------------
// DTOs (contract §6: plain data, no raw HTML/Markdown, no filesystem probe)
// ---------------------------------------------------------------------------

/**
 * Catalog identity as disclosed on a dashboard DTO. Deliberately NOT the
 * catalog domain's `CatalogEntity`: that DTO carries a resolved absolute path
 * and an `existsSync` result, and source I/O belongs to the projection refresh,
 * not to a view read.
 */
export type CatalogIdentityDTO = {
  kind: CatalogEntityKind;
  id: string;
  title: string;
  description: string | null;
  rootKind: CatalogRootKind;
  relativePath: string;
  documentKind: CatalogDocumentKind | null;
  lifecycle: CatalogLifecycle;
  revision: number;
  registeredAt: string;
  updatedAt: string;
};

/**
 * Explicit join disclosure (contract §6: "missing catalog links/execution pins
 * are explicit unavailable/conflict badges, not guessed joins").
 */
export type DashboardBadge =
  | "catalog-missing"
  | "catalog-pin-missing"
  | "catalog-pin-conflict"
  | "execution-unavailable";

export type MilestoneDTO = { milestone: string; target: string | null; status: string | null };
export type GoalDTO = { text: string; checked: boolean };

export type CompassDTO = {
  iterationId: string;
  summary: string | null;
  milestones: MilestoneDTO[];
  startedAt: string | null;
  endedAt: string | null;
  status: string | null;
};

export type LeaseDTO = {
  workflowId: string;
  planId: string;
  kind: "execution" | "integration-merge";
  holder: string | null;
  worktreePath: string | null;
  expiresAt: string | null;
};

export type WorkflowPlanDTO = {
  workflowId: string;
  planId: string;
  status: string | null;
  progress: string | null;
  phase: string | null;
  doneAt: string | null;
  catalogPinRevision: number | null;
  catalog: CatalogIdentityDTO | null;
  leases: LeaseDTO[];
  badges: DashboardBadge[];
};

/** One workflow: the execution projection joined to its catalog identity by id. */
export type WorkflowDTO = {
  id: string;
  type: string;
  status: string;
  phase: string | null;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string | null;
  branch: {
    base: string | null;
    source: string | null;
    integration: string | null;
    target: string | null;
  };
  activeRegistration: boolean;
  catalog: CatalogIdentityDTO | null;
  plans: WorkflowPlanDTO[];
  badges: DashboardBadge[];
};

export type WorkflowListDTO = { items: WorkflowDTO[]; total: number };

export type IterationPlanDTO = {
  planId: string;
  catalog: CatalogIdentityDTO | null;
  /** The projection's plan row, when a workflow carries one for this plan. */
  execution: {
    workflowId: string;
    status: string | null;
    progress: string | null;
    phase: string | null;
    doneAt: string | null;
  } | null;
  catalogPinRevision: number | null;
  badges: DashboardBadge[];
};

/**
 * One iteration. Membership comes from the catalog -- plan and document
 * membership is disclosed even before any workflow starts -- and the execution
 * projection only adds the compass and the plan execution overlay.
 */
export type IterationDTO = {
  iterationId: string;
  catalog: CatalogIdentityDTO | null;
  compass: CompassDTO | null;
  workflow: { id: string; status: string; phase: string | null; activeRegistration: boolean } | null;
  plans: IterationPlanDTO[];
  documents: CatalogIdentityDTO[];
  badges: DashboardBadge[];
};

export type IterationListDTO = { items: IterationDTO[]; total: number };

export type RoadmapDTO = {
  projectId: string;
  catalog: CatalogIdentityDTO | null;
  direction: string | null;
  goals: GoalDTO[];
  /** Roadmap frontmatter milestone names, in document order. */
  milestones: string[];
  badges: DashboardBadge[];
};

export type IssueFlowBucket = {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  capturedCumulative: number;
  retiredCumulative: number;
  openDifference: number;
  /**
   * `register-history` only when EVERY event contributing to this day came
   * from an imported record (`occurrences.imported` / `issue_transitions.imported`);
   * a day with any locally recorded event is `store`.
   */
  origin: "register-history" | "store";
};

/**
 * Dated issue history (contract §6). Only recorded timestamps contribute;
 * an absent historical date stays absent and is counted, never imputed, and
 * the authoritative current open count is reported separately so a
 * partial history never reads as a total gap.
 */
export type IssueFlow = {
  buckets: IssueFlowBucket[];
  unknownCaptureDates: number;
  unknownClosureDates: number;
  currentOpen: number;
  /** True while at least one recorded event carries no usable date. */
  incompleteHistory: boolean;
};

/** The DTO each dashboard view answers with. */
export type DashboardViewData = {
  issues: IssuePage;
  "issue-detail": IssueDetail;
  workflows: WorkflowListDTO;
  "workflow-detail": WorkflowDTO | null;
  iterations: IterationListDTO;
  "iteration-detail": IterationDTO | null;
  roadmap: RoadmapDTO | null;
  "issue-flow": IssueFlow;
};

/** Which views read projected execution/roadmap rows (contract §6 refresh rule). */
const DASHBOARD_VIEWS: Record<DashboardView, { needsProjection: boolean }> = {
  issues: { needsProjection: false },
  "issue-detail": { needsProjection: false },
  workflows: { needsProjection: true },
  "workflow-detail": { needsProjection: true },
  iterations: { needsProjection: true },
  "iteration-detail": { needsProjection: true },
  roadmap: { needsProjection: true },
  "issue-flow": { needsProjection: false },
};

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usage(message: string): never {
  throw new SddScriptError(message, 2);
}

/** Issue contract §5 paging defaults, shared by every list view. */
function paging(limit: number | undefined, offset: number | undefined): { limit: number; offset: number } {
  const resolvedLimit = limit ?? 50;
  const resolvedOffset = offset ?? 0;
  if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1 || resolvedLimit > 200) {
    usage("limit must be an integer between 1 and 200");
  }
  if (!Number.isInteger(resolvedOffset) || resolvedOffset < 0) usage("offset must be a nonnegative integer");
  return { limit: resolvedLimit, offset: resolvedOffset };
}

function requireId(filters: DashboardFilters, view: DashboardView): string {
  const id = text(filters.id);
  if (id === null) usage(`the ${view} view requires filters.id`);
  return id;
}

/** JSON text a projection column carries; a malformed value is empty, never a crash. */
function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Store metadata
// ---------------------------------------------------------------------------

type ReadMeta = { authorityState: string; storeRevision: number; catalogRevision: number };

function readMeta(db: StoreDb): ReadMeta {
  const row = db
    .prepare("select authority_state, revision, catalog_revision from store_meta where id = 1")
    .get() as { authority_state?: unknown; revision?: unknown; catalog_revision?: unknown } | undefined;
  if (!row || typeof row.revision !== "number" || typeof row.catalog_revision !== "number") {
    throw new StoreReadError("store.not-active", "store_meta is missing; the store cannot serve reads");
  }
  return {
    authorityState: typeof row.authority_state === "string" ? row.authority_state : "",
    storeRevision: row.revision,
    catalogRevision: row.catalog_revision,
  };
}

/** Last-refresh diagnostics: `projection_meta.last_error_json.sources` (P5's shape). */
function readProjectionBlock(db: StoreDb): ReadProjection {
  const row = db
    .prepare("select generation, built_at, checked_at, freshness, last_error_json from projection_meta where id = 1")
    .get() as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new ProjectionError("projection.schema-outdated", "projection_meta has no current row; the store schema is incomplete");
  }
  const freshness = text(row.freshness);
  let diagnostics: SourceDiagnostic[] = [];
  const lastError = text(row.last_error_json);
  if (lastError !== null) {
    try {
      const parsed = JSON.parse(lastError) as { sources?: unknown };
      if (Array.isArray(parsed.sources)) {
        diagnostics = parsed.sources.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return [];
          const source = entry as Record<string, unknown>;
          const sourceKey = text(source.sourceKey);
          const reason = text(source.reason);
          const message = text(source.message);
          return sourceKey !== null && reason !== null && message !== null ? [{ sourceKey, reason, message }] : [];
        });
      }
    } catch {
      diagnostics = [];
    }
  }
  return {
    generation: integer(row.generation),
    freshness: freshness === "current" || freshness === "stale" ? freshness : "unavailable",
    builtAt: text(row.built_at),
    checkedAt: text(row.checked_at) ?? "",
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Entry points (contract §6)
// ---------------------------------------------------------------------------

/**
 * Open one read handle, refresh the projection when the view needs it, and run
 * the view inside ONE read transaction. A store that cannot be opened (missing,
 * corrupt, below-floor runtime, newer schema) or that is not active fails here
 * -- it never degrades into an empty result set.
 */
export async function withStoreRead<T>(context: StoreContext, query: StoreReadQuery<T>): Promise<ReadEnvelope<T>> {
  if (typeof query?.run !== "function" || typeof query.view !== "string") {
    usage("withStoreRead requires a view query built by queryDashboard/queryIssueFlow");
  }
  // The single source-I/O boundary (contract §5/§6). It may write derived
  // projection rows and health; issue/catalog and execution authority are
  // never touched by it, and a refused refresh leaves the last good generation.
  if (query.needsProjection) await refreshProjections(context);

  const handle = await openStore(context, "read");
  try {
    const db = handle.db;
    db.exec("begin deferred");
    try {
      const meta = readMeta(db);
      if (meta.authorityState !== "active") {
        throw new StoreReadError(
          "store.not-active",
          `The store is ${meta.authorityState === "" ? "unreadable" : meta.authorityState}; a staged store is not read authority ` +
            "(contract \u00a72: no ordinary reads serve staged data). Nothing was read.",
        );
      }
      // Every envelope discloses projection health, so a store that predates
      // migration 3 is refused with the same actionable upgrade refusal the
      // projection module raises (never an empty view).
      const projectionTable = db
        .prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'projection_meta'")
        .get() as { n?: number } | undefined;
      if (!projectionTable?.n) {
        throw new ProjectionError(
          "projection.schema-outdated",
          `The store at schema version ${handle.schemaVersion} has no projection tables (migration 3 "execution-projections"). ` +
            "Apply the pending migrations through the store upgrade path (mstar store upgrade) and retry; nothing was read.",
        );
      }
      const projection = readProjectionBlock(db);
      const data = query.run(handle);
      db.exec("commit");
      return { data, storeRevision: meta.storeRevision, catalogRevision: meta.catalogRevision, projection };
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // connection-level failure during rollback -- nothing was committed
      }
      throw error;
    }
  } finally {
    handle.close();
  }
}

/** One dashboard view (contract §6) as a request the read boundary can serve. */
export function queryDashboard<V extends DashboardView>(
  view: V,
  filters: DashboardFilters = {},
): StoreReadQuery<DashboardViewData[V]> {
  if (!Object.hasOwn(DASHBOARD_VIEWS, view)) {
    usage(`unknown dashboard view ${JSON.stringify(String(view))}`);
  }
  return {
    view,
    needsProjection: DASHBOARD_VIEWS[view].needsProjection,
    run: (handle) => dashboardView(view, handle, filters) as DashboardViewData[V],
  };
}

/**
 * The dated issue history (contract §6). Issue-only: it never reads the
 * projection, so it needs no refresh -- a closure-gate or rollup consumer can
 * ask it directly.
 */
export function queryIssueFlow(projectId?: string): StoreReadQuery<IssueFlow> {
  const scoped = projectId === undefined ? undefined : text(projectId);
  if (projectId !== undefined && scoped === null) usage("projectId must be a non-empty id");
  return {
    view: "issue-flow",
    needsProjection: false,
    run: (handle) => readIssueFlow(handle.db, scoped ?? undefined),
  };
}

function dashboardView(view: DashboardView, handle: StoreHandle, filters: DashboardFilters): unknown {
  switch (view) {
    case "issues":
      return readIssuePage(handle.db, filters.issue ?? {});
    case "issue-detail":
      return readIssueDetail(handle.db, requireId(filters, "issue-detail"));
    case "workflows":
      return readWorkflowList(handle.db, filters);
    case "workflow-detail":
      return readWorkflowDetail(handle.db, filters);
    case "iterations":
      return readIterationList(handle.db, filters);
    case "iteration-detail":
      return readIterationDetail(handle.db, filters);
    case "roadmap":
      return readRoadmap(handle.db, filters);
    case "issue-flow":
      return readIssueFlow(handle.db, text(filters.projectId) ?? undefined);
  }
}

// ---------------------------------------------------------------------------
// Issue views (mirror of issue.ts listIssues/getIssue, same transaction)
// ---------------------------------------------------------------------------

const ISSUE_KINDS: Record<string, true> = {
  bug: true,
  risk: true,
  improvement: true,
  request: true,
  decision: true,
  "review-obligation": true,
};
const ISSUE_SEVERITIES: Record<string, true> = { critical: true, high: true, medium: true, low: true, info: true };
const ISSUE_DISPOSITIONS: Record<string, true> = {
  open: true,
  resolved: true,
  waived: true,
  duplicate: true,
  superseded: true,
};

/** issue.ts `LAST_ACTIVITY_SQL`: max nonnull registration / discovery / transition date. */
const ISSUE_LAST_ACTIVITY_SQL = `(select max(ts) from (
  select issues.registered_at as ts
  union all select o.discovered_at from occurrences o where o.issue_id = issues.id
  union all select t.occurred_at from issue_transitions t where t.issue_id = issues.id
))`;

const ISSUE_ORDER_SQL = `order by case issues.severity
    when 'critical' then 5 when 'high' then 4 when 'medium' then 3 when 'low' then 2 when 'info' then 1 else 0 end desc,
  case when (${ISSUE_LAST_ACTIVITY_SQL}) is null then 1 else 0 end asc,
  (${ISSUE_LAST_ACTIVITY_SQL}) desc,
  issues.id asc`;

function bindIssueFilter(filter: IssueFilter): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId !== undefined) {
    if (text(filter.projectId) === null) usage("projectId must be a non-empty id");
    clauses.push("issues.project_id = ?");
    params.push(filter.projectId);
  }
  const disposition = filter.disposition ?? "open";
  if (!Object.hasOwn(ISSUE_DISPOSITIONS, disposition)) usage("disposition is not a contract vocabulary value");
  clauses.push("issues.disposition = ?");
  params.push(disposition);
  if (filter.kind !== undefined) {
    if (!Object.hasOwn(ISSUE_KINDS, filter.kind)) usage("kind is not a contract vocabulary value");
    clauses.push("issues.kind = ?");
    params.push(filter.kind);
  }
  if (filter.severity !== undefined) {
    if (!Object.hasOwn(ISSUE_SEVERITIES, filter.severity)) usage("severity is not a contract vocabulary value");
    clauses.push("issues.severity = ?");
    params.push(filter.severity);
  }
  if (filter.query !== undefined && filter.query !== "") {
    // Literal substring: bound parameter, never a LIKE/GLOB pattern.
    clauses.push(
      "(instr(lower(issues.title), lower(?)) > 0 or exists (select 1 from occurrences o where o.issue_id = issues.id and instr(lower(o.observed_behavior || char(10) || o.evidence_json || char(10) || o.location), lower(?)) > 0))",
    );
    params.push(filter.query, filter.query);
  }
  return { where: clauses.length ? `where ${clauses.join(" and ")}` : "", params };
}

function readIssuePage(db: StoreDb, filter: IssueFilter): IssuePage {
  const { limit, offset } = paging(filter.limit, filter.offset);
  const { where, params } = bindIssueFilter(filter);
  const storeRevision = readMeta(db).storeRevision;
  const totalRow = db.prepare(`select count(*) as n from issues ${where}`).get(...params) as { n: number };
  const rows = db
    .prepare(
      `select issues.id, issues.project_id as projectId, issues.title, issues.kind, issues.severity, issues.disposition,
              issues.registered_at as registeredAt, issues.revision,
              (${ISSUE_LAST_ACTIVITY_SQL}) as lastActivity
       from issues ${where} ${ISSUE_ORDER_SQL} limit ? offset ?`,
    )
    .all(...params, limit, offset) as Array<{
    id: string;
    projectId: string;
    title: string;
    kind: IssueKind;
    severity: Severity;
    disposition: Disposition;
    registeredAt: string | null;
    revision: number;
    lastActivity: string | null;
  }>;
  return {
    items: rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      kind: row.kind,
      severity: row.severity,
      disposition: row.disposition,
      registeredAt: row.registeredAt,
      lastActivity: row.lastActivity,
      revision: row.revision,
    })),
    total: totalRow.n,
    storeRevision,
  };
}

function parseEvidenceText(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function readIssueDetail(db: StoreDb, id: string): IssueDetail {
  const issue = db
    .prepare(
      "select id, project_id, title, kind, severity, disposition, impact, acceptance, owner, registered_at, closed_at, closure_note, created_at, updated_at, revision, provider, external_id, url, identity_key from issues where id = ?",
    )
    .get(id) as
    | {
        id: string;
        project_id: string;
        title: string;
        kind: IssueKind;
        severity: Severity;
        disposition: Disposition;
        impact: string;
        acceptance: string;
        owner: string | null;
        registered_at: string | null;
        closed_at: string | null;
        closure_note: string | null;
        created_at: string;
        updated_at: string;
        revision: number;
        provider: string;
        external_id: string | null;
        url: string | null;
        identity_key: string;
      }
    | undefined;
  if (!issue) throw new IssueError("issue.not-found", `Issue ${id} does not exist`);

  const occurrences = (
    db
      .prepare(
        "select id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, discovered_at, recorded_at, imported from occurrences where issue_id = ? order by id asc",
      )
      .all(id) as Array<{
      id: number;
      occurrence_key: string;
      source_kind: string;
      source_identity: string;
      root_cause_key: string;
      acceptance_key: string;
      location: string;
      observed_behavior: string;
      evidence_json: string;
      discovered_at: string | null;
      recorded_at: string;
      imported: number;
    }>
  ).map((row) => ({
    id: row.id,
    occurrenceKey: row.occurrence_key,
    sourceKind: row.source_kind,
    sourceIdentity: row.source_identity,
    rootCauseKey: row.root_cause_key,
    acceptanceKey: row.acceptance_key,
    location: row.location,
    observedBehavior: row.observed_behavior,
    evidence: parseEvidenceText(row.evidence_json),
    discoveredAt: row.discovered_at,
    recordedAt: row.recorded_at,
    imported: row.imported === 1,
  }));

  const transitions = (
    db
      .prepare(
        "select id, from_disposition, to_disposition, actor, occurred_at, recorded_at, reason, evidence_json, imported, issue_revision from issue_transitions where issue_id = ? order by id asc",
      )
      .all(id) as Array<{
      id: number;
      from_disposition: string;
      to_disposition: string;
      actor: string | null;
      occurred_at: string | null;
      recorded_at: string;
      reason: string;
      evidence_json: string;
      imported: number;
      issue_revision: number;
    }>
  ).map((row) => ({
    id: row.id,
    fromDisposition: row.from_disposition,
    toDisposition: row.to_disposition,
    actor: row.actor,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    reason: row.reason,
    evidence: JSON.parse(row.evidence_json) as unknown,
    imported: row.imported === 1,
    issueRevision: row.issue_revision,
  }));

  const relations = db
    .prepare("select from_issue as fromIssue, relation, to_issue as toIssue from relations where from_issue = ? or to_issue = ?")
    .all(id, id) as Array<{ fromIssue: string; relation: string; toIssue: string }>;

  const provenance = (
    db
      .prepare(
        "select id, kind, target, source_hash, legacy_project, legacy_bucket, legacy_entry_id, legacy_json, imported_at from provenance where issue_id = ? order by id asc",
      )
      .all(id) as Array<{
      id: number;
      kind: string;
      target: string;
      source_hash: string;
      legacy_project: string | null;
      legacy_bucket: string | null;
      legacy_entry_id: string | null;
      legacy_json: string | null;
      imported_at: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    target: row.target,
    sourceHash: row.source_hash,
    legacyProject: row.legacy_project,
    legacyBucket: row.legacy_bucket,
    legacyEntryId: row.legacy_entry_id,
    legacyJson: row.legacy_json,
    importedAt: row.imported_at,
  }));

  return {
    id: issue.id,
    projectId: issue.project_id,
    title: issue.title,
    kind: issue.kind,
    severity: issue.severity,
    disposition: issue.disposition,
    impact: issue.impact,
    acceptance: issue.acceptance,
    owner: issue.owner,
    registeredAt: issue.registered_at,
    closedAt: issue.closed_at,
    closureNote: issue.closure_note,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    revision: issue.revision,
    provider: issue.provider,
    externalId: issue.external_id,
    url: issue.url,
    identityKey: issue.identity_key,
    occurrences,
    transitions,
    relations,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Dated history (contract §6)
// ---------------------------------------------------------------------------

/** Terminal dispositions (issue contract §4): every one counts as retired. */
const TERMINAL_DISPOSITIONS = "'resolved', 'waived', 'duplicate', 'superseded'";

/**
 * The UTC day of a recorded timestamp, or `null` when the stored lexeme has no
 * usable date -- an unknown date is counted, never imputed to the read time.
 * A date-only lexeme is already a day; a date-time is converted to UTC.
 */
function utcDay(timestamp: string | null): string | null {
  if (timestamp === null || timestamp === "") return null;
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(timestamp)) return timestamp;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function readIssueFlow(db: StoreDb, projectId: string | undefined): IssueFlow {
  const scope = projectId === undefined ? "" : "where project_id = ?";
  const scopeParams = projectId === undefined ? [] : [projectId];

  const captureRows = db
    .prepare(
      `select registered_at as at,
              exists (select 1 from occurrences o where o.issue_id = issues.id and o.imported = 1) as imported
       from issues ${scope}`,
    )
    .all(...scopeParams) as Array<{ at: string | null; imported: number }>;

  const closureRows = db
    .prepare(
      `select closed_at as at,
              exists (
                select 1 from issue_transitions t
                where t.issue_id = issues.id and t.imported = 1 and t.to_disposition = issues.disposition
              ) as imported
       from issues ${scope ? `${scope} and` : "where"} disposition in (${TERMINAL_DISPOSITIONS})`,
    )
    .all(...scopeParams) as Array<{ at: string | null; imported: number }>;

  const openRow = db
    .prepare(`select count(*) as n from issues ${scope ? `${scope} and` : "where"} disposition = 'open'`)
    .get(...scopeParams) as { n: number };

  type Day = { captured: number; retired: number; importedCaptured: number; importedRetired: number };
  const days = new Map<string, Day>();
  const dayOf = (date: string): Day => {
    const existing = days.get(date);
    if (existing !== undefined) return existing;
    const created: Day = { captured: 0, retired: 0, importedCaptured: 0, importedRetired: 0 };
    days.set(date, created);
    return created;
  };

  let unknownCaptureDates = 0;
  let unknownClosureDates = 0;
  for (const row of captureRows) {
    const date = utcDay(row.at);
    if (date === null) {
      unknownCaptureDates += 1;
      continue;
    }
    const day = dayOf(date);
    day.captured += 1;
    if (row.imported === 1) day.importedCaptured += 1;
  }
  for (const row of closureRows) {
    const date = utcDay(row.at);
    if (date === null) {
      unknownClosureDates += 1;
      continue;
    }
    const day = dayOf(date);
    day.retired += 1;
    if (row.imported === 1) day.importedRetired += 1;
  }

  const dates = [...days.keys()].sort();
  const buckets: IssueFlowBucket[] = [];
  let capturedCumulative = 0;
  let retiredCumulative = 0;
  for (const date of dates) {
    const day = days.get(date) as Day;
    capturedCumulative += day.captured;
    retiredCumulative += day.retired;
    const allImported =
      day.importedCaptured === day.captured &&
      day.importedRetired === day.retired &&
      day.importedCaptured + day.importedRetired > 0;
    buckets.push({
      date,
      capturedCumulative,
      retiredCumulative,
      openDifference: capturedCumulative - retiredCumulative,
      origin: allImported ? "register-history" : "store",
    });
  }

  return {
    buckets,
    unknownCaptureDates,
    unknownClosureDates,
    currentOpen: openRow.n,
    incompleteHistory: unknownCaptureDates > 0 || unknownClosureDates > 0,
  };
}

// ---------------------------------------------------------------------------
// Catalog joins (read-only, no filesystem probe)
// ---------------------------------------------------------------------------

const IDENTITY_COLUMNS =
  "kind, id, title, description, root_kind, relative_path, document_kind, lifecycle, revision, registered_at, updated_at";

type IdentityRow = {
  kind: CatalogEntityKind;
  id: string;
  title: string;
  description: string | null;
  root_kind: CatalogRootKind;
  relative_path: string;
  document_kind: CatalogDocumentKind | null;
  lifecycle: CatalogLifecycle;
  revision: number;
  registered_at: string;
  updated_at: string;
};

function toIdentity(row: IdentityRow): CatalogIdentityDTO {
  return {
    kind: row.kind,
    id: row.id,
    title: row.title,
    description: row.description,
    rootKind: row.root_kind,
    relativePath: row.relative_path,
    documentKind: row.document_kind,
    lifecycle: row.lifecycle,
    revision: row.revision,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

function identityToken(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

/** Catalog identities for a bounded key set, keyed by `kind\0id`. */
function catalogIdentities(db: StoreDb, keys: readonly CatalogKey[]): Map<string, CatalogIdentityDTO> {
  const found = new Map<string, CatalogIdentityDTO>();
  if (keys.length === 0) return found;
  const tuples = keys.map(() => "(?, ?)").join(", ");
  const params = keys.flatMap((key) => [key.kind, key.id]);
  const rows = db
    .prepare(`select ${IDENTITY_COLUMNS} from catalog_entities where (kind, id) in (values ${tuples})`)
    .all(...params) as IdentityRow[];
  for (const row of rows) found.set(identityToken(row.kind, row.id), toIdentity(row));
  return found;
}

/** Project membership per catalog entity (`belongs-to` → project). */
function projectMembership(db: StoreDb): Map<string, Set<string>> {
  const membership = new Map<string, Set<string>>();
  const rows = db
    .prepare("select from_kind, from_id, to_id from catalog_links where relation = 'belongs-to' and to_kind = 'project'")
    .all() as Array<{ from_kind: string; from_id: string; to_id: string }>;
  for (const row of rows) {
    const token = identityToken(row.from_kind, row.from_id);
    const projects = membership.get(token) ?? new Set<string>();
    projects.add(row.to_id);
    membership.set(token, projects);
  }
  return membership;
}

function belongsTo(
  membership: Map<string, Set<string>>,
  kind: string,
  id: string,
  projectId: string,
): boolean {
  return membership.get(identityToken(kind, id))?.has(projectId) ?? false;
}

// ---------------------------------------------------------------------------
// Projection rows (current generation)
// ---------------------------------------------------------------------------

type ProjectedWorkflowRow = {
  id: string;
  type: string;
  status: string;
  phase: string | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string | null;
  branch_base: string | null;
  branch_source: string | null;
  branch_integration: string | null;
  branch_target: string | null;
  active_registration: number;
};

type ProjectedPlanRow = {
  workflow_id: string;
  plan_id: string;
  status: string | null;
  progress: string | null;
  phase: string | null;
  done_at: string | null;
  catalog_pin_revision: number | null;
};

type ProjectedLeaseRow = {
  workflow_id: string;
  plan_id: string;
  kind: string;
  holder: string | null;
  worktree_path: string | null;
  expires_at: string | null;
};

type ProjectedCompassRow = {
  iteration_id: string;
  summary: string | null;
  milestones_json: string;
  started_at: string | null;
  ended_at: string | null;
  status: string | null;
};

type ProjectedRoadmapRow = { project_id: string; direction: string | null; goals_json: string; milestones_json: string };

type GeneratedRows = {
  generation: number | null;
  workflows: ProjectedWorkflowRow[];
  plans: ProjectedPlanRow[];
  leases: ProjectedLeaseRow[];
  compasses: ProjectedCompassRow[];
  roadmaps: ProjectedRoadmapRow[];
};

/**
 * Every projected row of the CURRENT generation, in one read. The projection is
 * disposable data: an absent generation yields empty sets and the envelope's
 * freshness block carries the honest `unavailable` disclosure.
 */
function readGeneratedRows(db: StoreDb): GeneratedRows {
  const generation = integer(
    (db.prepare("select generation from projection_meta where id = 1").get() as { generation?: unknown } | undefined)?.generation,
  );
  if (generation === null) {
    return { generation: null, workflows: [], plans: [], leases: [], compasses: [], roadmaps: [] };
  }
  return {
    generation,
    workflows: db
      .prepare(
        "select id, type, status, phase, started_at, ended_at, updated_at, branch_base, branch_source, branch_integration, branch_target, active_registration " +
          "from projection_workflows where generation = ? order by id asc",
      )
      .all(generation) as ProjectedWorkflowRow[],
    plans: db
      .prepare(
        "select workflow_id, plan_id, status, progress, phase, done_at, catalog_pin_revision from projection_plans where generation = ? " +
          "order by workflow_id asc, plan_id asc",
      )
      .all(generation) as ProjectedPlanRow[],
    leases: db
      .prepare(
        "select workflow_id, plan_id, kind, holder, worktree_path, expires_at from projection_leases where generation = ? " +
          "order by workflow_id asc, plan_id asc, kind asc",
      )
      .all(generation) as ProjectedLeaseRow[],
    compasses: db
      .prepare(
        "select iteration_id, summary, milestones_json, started_at, ended_at, status from projection_compasses where generation = ? " +
          "order by iteration_id asc",
      )
      .all(generation) as ProjectedCompassRow[],
    roadmaps: db
      .prepare("select project_id, direction, goals_json, milestones_json from projection_roadmaps where generation = ? order by project_id asc")
      .all(generation) as ProjectedRoadmapRow[],
  };
}

/** Catalog kind of a workflow's own identity: an iteration registers as one. */
function workflowCatalogKey(workflow: { id: string; type: string }): CatalogKey {
  return { kind: workflow.type === "iteration" ? "iteration" : "plan", id: workflow.id };
}

function planBadges(plan: ProjectedPlanRow, catalog: CatalogIdentityDTO | null): DashboardBadge[] {
  const badges: DashboardBadge[] = [];
  if (catalog === null) badges.push("catalog-missing");
  if (plan.catalog_pin_revision === null) badges.push("catalog-pin-missing");
  else if (catalog !== null && catalog.revision !== plan.catalog_pin_revision) badges.push("catalog-pin-conflict");
  return badges;
}

function toWorkflowDTO(
  row: ProjectedWorkflowRow,
  plans: ProjectedPlanRow[],
  leases: ProjectedLeaseRow[],
  identities: Map<string, CatalogIdentityDTO>,
): WorkflowDTO {
  const catalog = identities.get(identityToken(workflowCatalogKey(row).kind, row.id)) ?? null;
  const badges: DashboardBadge[] = catalog === null ? ["catalog-missing"] : [];
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    phase: row.phase,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
    branch: {
      base: row.branch_base,
      source: row.branch_source,
      integration: row.branch_integration,
      target: row.branch_target,
    },
    activeRegistration: row.active_registration === 1,
    catalog,
    plans: plans.map((plan) => {
      const planCatalog = identities.get(identityToken("plan", plan.plan_id)) ?? null;
      return {
        workflowId: plan.workflow_id,
        planId: plan.plan_id,
        status: plan.status,
        progress: plan.progress,
        phase: plan.phase,
        doneAt: plan.done_at,
        catalogPinRevision: plan.catalog_pin_revision,
        catalog: planCatalog,
        leases: leases
          .filter((lease) => lease.plan_id === plan.plan_id)
          .map((lease) => ({
            workflowId: lease.workflow_id,
            planId: lease.plan_id,
            kind: lease.kind === "integration-merge" ? ("integration-merge" as const) : ("execution" as const),
            holder: lease.holder,
            worktreePath: lease.worktree_path,
            expiresAt: lease.expires_at,
          })),
        badges: planBadges(plan, planCatalog),
      };
    }),
    badges,
  };
}

// ---------------------------------------------------------------------------
// Workflow views
// ---------------------------------------------------------------------------

function readWorkflowList(db: StoreDb, filters: DashboardFilters): WorkflowListDTO {
  const { limit, offset } = paging(filters.limit, filters.offset);
  const generated = readGeneratedRows(db);
  if (generated.generation === null) return { items: [], total: 0 };
  const projectId = text(filters.projectId);

  const plansByWorkflow = new Map<string, ProjectedPlanRow[]>();
  for (const plan of generated.plans) {
    const list = plansByWorkflow.get(plan.workflow_id) ?? [];
    list.push(plan);
    plansByWorkflow.set(plan.workflow_id, list);
  }

  // The projection has no project column: membership is the catalog's own
  // `belongs-to` relation, on the workflow row or on one of its plan rows.
  const membership = projectMembership(db);
  const scoped = generated.workflows.filter((workflow) => {
    if (projectId === null) return true;
    if (belongsTo(membership, workflowCatalogKey(workflow).kind, workflow.id, projectId)) return true;
    return (plansByWorkflow.get(workflow.id) ?? []).some((plan) => belongsTo(membership, "plan", plan.plan_id, projectId));
  });

  const page = scoped.slice(offset, offset + limit);
  const identities = catalogIdentities(db, [
    ...page.map(workflowCatalogKey),
    ...page.flatMap((workflow) => (plansByWorkflow.get(workflow.id) ?? []).map((plan) => ({ kind: "plan" as const, id: plan.plan_id }))),
  ]);
  return {
    items: page.map((workflow) =>
      toWorkflowDTO(workflow, plansByWorkflow.get(workflow.id) ?? [], generated.leases, identities),
    ),
    total: scoped.length,
  };
}

function readWorkflowDetail(db: StoreDb, filters: DashboardFilters): WorkflowDTO | null {
  const id = requireId(filters, "workflow-detail");
  const generated = readGeneratedRows(db);
  const workflow = generated.workflows.find((row) => row.id === id);
  if (workflow === undefined) return null;
  const plans = generated.plans.filter((plan) => plan.workflow_id === id);
  const identities = catalogIdentities(db, [
    workflowCatalogKey(workflow),
    ...plans.map((plan) => ({ kind: "plan" as const, id: plan.plan_id })),
  ]);
  return toWorkflowDTO(workflow, plans, generated.leases, identities);
}

// ---------------------------------------------------------------------------
// Iteration views
// ---------------------------------------------------------------------------

/** Catalog plan rows that belong to an iteration, keyed by iteration id. */
function iterationPlanIds(db: StoreDb): Map<string, string[]> {
  const rows = db
    .prepare(
      "select from_id as planId, to_id as iterationId from catalog_links " +
        "where relation = 'belongs-to' and from_kind = 'plan' and to_kind = 'iteration'",
    )
    .all() as Array<{ planId: string; iterationId: string }>;
  const byIteration = new Map<string, string[]>();
  for (const row of rows) {
    const list = byIteration.get(row.iterationId) ?? [];
    list.push(row.planId);
    byIteration.set(row.iterationId, list);
  }
  for (const list of byIteration.values()) list.sort();
  return byIteration;
}

/** Catalog document rows linked `documents` from an iteration, keyed by iterator id. */
function iterationDocumentIds(db: StoreDb): Map<string, string[]> {
  const rows = db
    .prepare(
      "select from_id as iterationId, to_id as documentId from catalog_links " +
        "where relation = 'documents' and from_kind = 'iteration' and to_kind = 'document'",
    )
    .all() as Array<{ iterationId: string; documentId: string }>;
  const byIteration = new Map<string, string[]>();
  for (const row of rows) {
    const list = byIteration.get(row.iterationId) ?? [];
    list.push(row.documentId);
    byIteration.set(row.iterationId, list);
  }
  for (const list of byIteration.values()) list.sort();
  return byIteration;
}

function composeIteration(
  iterationId: string,
  catalog: CatalogIdentityDTO | null,
  generated: GeneratedRows,
  planIds: readonly string[],
  documentIds: readonly string[],
  identities: Map<string, CatalogIdentityDTO>,
): IterationDTO {
  const badges: DashboardBadge[] = [];
  if (catalog === null) badges.push("catalog-missing");

  const compassRow = generated.compasses.find((row) => row.iteration_id === iterationId);
  if (generated.generation === null) badges.push("execution-unavailable");
  const workflowRow = generated.workflows.find((row) => row.id === iterationId && row.type === "iteration");

  const plans: IterationPlanDTO[] = planIds.map((planId) => {
    const planCatalog = identities.get(identityToken("plan", planId)) ?? null;
    const executionRow = generated.plans.find((plan) => plan.plan_id === planId);
    const planBadges: DashboardBadge[] = [];
    if (planCatalog === null) planBadges.push("catalog-missing");
    if (executionRow === undefined) {
      planBadges.push("execution-unavailable");
      return { planId, catalog: planCatalog, execution: null, catalogPinRevision: null, badges: planBadges };
    }
    if (executionRow.catalog_pin_revision === null) planBadges.push("catalog-pin-missing");
    else if (planCatalog !== null && planCatalog.revision !== executionRow.catalog_pin_revision) {
      planBadges.push("catalog-pin-conflict");
    }
    return {
      planId,
      catalog: planCatalog,
      execution: {
        workflowId: executionRow.workflow_id,
        status: executionRow.status,
        progress: executionRow.progress,
        phase: executionRow.phase,
        doneAt: executionRow.done_at,
      },
      catalogPinRevision: executionRow.catalog_pin_revision,
      badges: planBadges,
    };
  });

  return {
    iterationId,
    catalog,
    compass:
      compassRow === undefined
        ? null
        : {
            iterationId,
            summary: compassRow.summary,
            milestones: parseJsonArray<MilestoneDTO>(compassRow.milestones_json),
            startedAt: compassRow.started_at,
            endedAt: compassRow.ended_at,
            status: compassRow.status,
          },
    workflow:
      workflowRow === undefined
        ? null
        : {
            id: workflowRow.id,
            status: workflowRow.status,
            phase: workflowRow.phase,
            activeRegistration: workflowRow.active_registration === 1,
          },
    plans,
    documents: documentIds.flatMap((documentId) => {
      const document = identities.get(identityToken("document", documentId));
      return document === undefined ? [] : [document];
    }),
    badges,
  };
}

function readIterationList(db: StoreDb, filters: DashboardFilters): IterationListDTO {
  const { limit, offset } = paging(filters.limit, filters.offset);
  const generated = readGeneratedRows(db);
  const projectId = text(filters.projectId);
  const membership = projectMembership(db);
  const catalogRows = (
    db
      .prepare(`select ${IDENTITY_COLUMNS} from catalog_entities where kind = 'iteration' order by title asc, id asc`)
      .all() as IdentityRow[]
  ).filter((row) => projectId === null || belongsTo(membership, "iteration", row.id, projectId));

  const planIds = iterationPlanIds(db);
  const documentIds = iterationDocumentIds(db);
  const page = catalogRows.slice(offset, offset + limit);
  const identities = catalogIdentities(db, [
    ...page.map((row) => ({ kind: "iteration" as const, id: row.id })),
    ...page.flatMap((row) => (planIds.get(row.id) ?? []).map((planId) => ({ kind: "plan" as const, id: planId }))),
    ...page.flatMap((row) => (documentIds.get(row.id) ?? []).map((documentId) => ({ kind: "document" as const, id: documentId }))),
  ]);
  return {
    items: page.map((row) =>
      composeIteration(
        row.id,
        identities.get(identityToken("iteration", row.id)) ?? null,
        generated,
        planIds.get(row.id) ?? [],
        documentIds.get(row.id) ?? [],
        identities,
      ),
    ),
    total: catalogRows.length,
  };
}

function readIterationDetail(db: StoreDb, filters: DashboardFilters): IterationDTO | null {
  const iterationId = requireId(filters, "iteration-detail");
  const generated = readGeneratedRows(db);
  const planIds = iterationPlanIds(db).get(iterationId) ?? [];
  const documentIds = iterationDocumentIds(db).get(iterationId) ?? [];
  const compassRow = generated.compasses.find((row) => row.iteration_id === iterationId);
  const identities = catalogIdentities(db, [
    { kind: "iteration", id: iterationId },
    ...planIds.map((planId) => ({ kind: "plan" as const, id: planId })),
    ...documentIds.map((documentId) => ({ kind: "document" as const, id: documentId })),
  ]);
  const catalog = identities.get(identityToken("iteration", iterationId)) ?? null;
  if (catalog === null && compassRow === undefined) return null;
  return composeIteration(iterationId, catalog, generated, planIds, documentIds, identities);
}

// ---------------------------------------------------------------------------
// Roadmap view
// ---------------------------------------------------------------------------

function readRoadmap(db: StoreDb, filters: DashboardFilters): RoadmapDTO | null {
  const projectId = text(filters.projectId);
  if (projectId === null) usage("the roadmap view requires filters.projectId");
  const generated = readGeneratedRows(db);
  const row = generated.roadmaps.find((entry) => entry.project_id === projectId);
  const catalog = catalogIdentities(db, [{ kind: "project", id: projectId }]).get(identityToken("project", projectId)) ?? null;
  if (catalog === null && row === undefined) return null;
  const badges: DashboardBadge[] = [];
  if (catalog === null) badges.push("catalog-missing");
  if (row === undefined) badges.push("execution-unavailable");
  return {
    projectId,
    catalog,
    direction: row?.direction ?? null,
    goals: parseJsonArray<GoalDTO>(row?.goals_json),
    milestones: parseJsonArray<unknown>(row?.milestones_json).filter(
      (entry): entry is string => typeof entry === "string" && entry !== "",
    ),
    badges,
  };
}
