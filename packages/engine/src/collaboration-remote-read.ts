/**
 * invariant: collaboration-remote-read.ts -- the ONE read boundary over a remote cache.
 *
 * A `remote` checkout's authority is the provider; `collaboration.db` holds only
 * verified observations. This module turns the current generation's admitted
 * snapshots into the same domain DTOs the local readers answer with, so every
 * consumer reads selected-source evidence instead of local rows:
 *
 * - A required read refuses (`remote.unavailable`,
 *   `collaboration.observation-incomplete`, `collaboration.observation-stale`)
 *   rather than answering zero rows / zero totals from an empty local table.
 * - Only MStar subjects carry findings semantics. A provider-only issue is
 *   visible as `kind:"provider-only"` and is never counted, grouped by
 *   disposition/severity, closed or adopted by its title or native status.
 * - Nothing here writes, refreshes, or opens a local-authority lane, and no
 *   provider call happens: an observation is a trusted-host assertion.
 */
import {
  openRemoteCache,
  readCollaborationBinding,
  ISSUE_REF_PATTERN,
  type CollaborationObservation,
  type CollaborationProviderScope,
  type CollaborationScope,
} from "./collaboration-store.js";
import { resolveCollaborationLocation, assertSelectionUnchanged, type CollaborationLocation } from "./collaboration-identity.js";
import {
  conflictMerged,
  REMOTE_SCOPE_TTL_MS,
  type ProviderProjectScope,
  type RemoteIssue,
  type RemoteSnapshot,
} from "./collaboration-remote.js";
import {
  IssueError,
  type Disposition,
  type IssueDetail,
  type IssueFilter,
  type IssueKind,
  type IssuePage,
  type IssueSummary,
  type ProviderOnlyIssue,
  type Severity,
} from "./issue.js";
import type { CatalogDocumentKind } from "./catalog.js";
import { MilestoneError, type MilestoneRead, type ProjectMilestoneDTO } from "./milestone-store.js";
import { StoreError, type StoreContext } from "./store-db.js";

/** note: A provider issue id is an immutable Linear UUID, never a display identifier such as ENG-42. */
const PROVIDER_ISSUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEVERITY_RANK: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, nit: 1 };
const TERMINAL = new Set<Disposition>(["resolved", "waived", "duplicate", "superseded", "obsolete"]);

/**
 * note: The read's sample-to-snapshot gap seam: a regression binds a successor between the
 * captured `{location,binding}` pair and the SQLite snapshot. Production runs without a callback.
 */
let remoteReadSampleGapForTest: (() => void | Promise<void>) | undefined;
export function setRemoteReadSampleGapForTest(callback: (() => void | Promise<void>) | undefined): void {
  remoteReadSampleGapForTest = callback;
}

// ---------------------------------------------------------------------------
// note: Admitted project evidence for one read
// ---------------------------------------------------------------------------

/** note: One selected project as this cache serves it, or why it cannot serve. */
export type RemoteProjectEvidence = Readonly<{
  projectId: string;
  scope: ProviderProjectScope;
  journalIssueId: string;
  revision: number;
  asOf: string | null;
  completeness: "complete" | "partial" | "unavailable";
  code: string | null;
  freshness: "fresh" | "expired" | "incomplete";
  /** note: The provider traversal started inside the freshness window (a second clock from the access check). */
  asOfFresh: boolean;
  snapshot: RemoteSnapshot | null;
}>;

/** note: The current generation's evidence, loaded once per read request. */
export type RemoteReadView = Readonly<{
  repoKey: string;
  storeId: string;
  epoch: number;
  selectorCommit: string;
  generation: number;
  phase: "active" | "draining";
  /** note: The declared contributing projects this view loaded; never another selected project. */
  projectIds: readonly string[];
  projects: ReadonlyMap<string, RemoteProjectEvidence>;
  /** note: Aggregate snapshot counters: both move whenever any project's observation is replaced. */
  revision: number;
  catalogRevision: number;
}>;

type StoredEvidenceRow = {
  project_key: string;
  workspace_id: string;
  team_id: string;
  provider_project_id: string;
  journal_issue_id: string;
  verified_at: string;
  verification_json: string;
  revision: number | null;
  as_of: string | null;
  completeness: string | null;
  code: string | null;
  snapshot_json: string | null;
};

/**
 * `remote read`: load this generation's admitted evidence for the DECLARED
 * contributing projects into memory. A narrowed query passes its project set, so
 * an unrelated project's missing, partial, expired or unparseable snapshot never
 * refuses or contributes to it; an unfiltered read declares every selected
 * project. The cache is opened read-only and closed before the caller's view
 * work; the rows loaded are ONE deferred snapshot of the lane.
 *
 * A missing/unbound checkout keeps the store's own refusal
 * (`collaboration.stale-binding`); the returned view is only built from the
 * exact generation the checkout is bound to.
 *
 * A project with an unresolved outbox fork is served as `unavailable`
 * (`remote.effect-conflict`), so no count, rollup or gate decides on a base a
 * recorded conflict still disputes.
 *
 * A caller that has already resolved this checkout's location passes it in, so
 * one request resolves the published selector ONCE and the cache lane is opened
 * for that same checked location and binding.
 */
export async function openRemoteReadView(
  context: StoreContext,
  projectIds?: readonly string[],
  resolvedLocation?: CollaborationLocation,
): Promise<RemoteReadView> {
  const location = resolvedLocation ?? resolveCollaborationLocation(context);
  if (location.mode !== "remote" || location.selection === undefined) {
    throw new StoreError(
      "collaboration.stale-binding",
      "This checkout does not resolve a trusted remote selector, so it has no remote evidence lane to read. Nothing was read.",
    );
  }
  const binding = readCollaborationBinding(context);
  if (binding === null || binding.version !== 3 || binding.state !== "active") {
    throw new StoreError(
      "collaboration.stale-binding",
      "This checkout holds no finalized remote binding, so it cannot be proven to belong to the selector generation. " +
        'Run the reviewed remote bind ("mstar store collaboration remote bind --input <file|->"); nothing was read.',
    );
  }
  const selection = location.selection;
  const requested = projectIds ?? selection.projects.map((project) => project.localProjectId);
  for (const projectId of requested) {
    if (!selection.projects.some((project) => project.localProjectId === projectId)) {
      throw new StoreError(
        "remote.scope-mismatch",
        `Project ${projectId} is not one of the selected remote projects, so this cache has no evidence for it. Nothing was read.`,
      );
    }
  }
  // note: The sample the caller took is re-observed at the boundary: a regression binds a
  // successor in this window, so a matching pair alone is not proof the lane stood still.
  await remoteReadSampleGapForTest?.();
  // note: ONE sample: the lane is admitted for the location and binding this view reads and
  // stamps itself with, so a concurrent rebind never labels rows with another generation.
  const handle = await openRemoteCache(context, "read", { location, binding });
  try {
    handle.db.exec("begin");
    // invariant: The row snapshot must belong to the SAME selector generation the pair named.
    // A successor committed before this transaction began leaves the predecessor's rows in
    // place, so a bound-generation-stable read could otherwise satisfy the successor's gate.
    const latest = handle.db
      .prepare("select max(generation) as generation from remote_bindings")
      .get() as { generation?: unknown } | undefined;
    if (latest?.generation !== binding.generation) {
      throw new StoreError(
        "collaboration.stale-binding",
        `This read sampled selector commit ${selection.commit} generation ${String(binding.generation)}, but the cache ` +
          `lane has since committed generation ${String(latest?.generation ?? "none")}; the sampled generation is ` +
          `inspection-only. Re-run the read against the current scope; nothing was returned from the predecessor.`,
      );
    }
    const rows = handle.db
      .prepare(
        "select b.project_key, b.workspace_id, b.team_id, b.provider_project_id, b.journal_issue_id, b.verified_at, " +
          "b.verification_json, o.revision, o.as_of, o.completeness, o.code, o.snapshot_json " +
          "from remote_bindings b left join remote_observations o on o.generation = b.generation and o.project_key = b.project_key " +
          `where b.generation = ? and b.project_key in (${requested.map(() => "?").join(", ")})`,
      )
      .all(binding.generation, ...requested) as StoredEvidenceRow[];
    // invariant: Q1: a recorded fork closes required reads until its LIVE `resolved_by` chain
    // reaches a confirmed terminal repair; a nominally complete traversal of the same competing
    // heads proves the rows, never that the fork settled.
    const outbox = handle.db
      .prepare(
        "select operation_id, project_key, state, resolved_by from remote_outbox " +
          `where generation = ? and project_key in (${requested.map(() => "?").join(", ")})`,
      )
      .all(binding.generation, ...requested) as Array<{
      operation_id?: unknown;
      project_key?: unknown;
      state?: unknown;
      resolved_by?: unknown;
    }>;
    handle.db.exec("commit");
    // invariant: The admitted selector commit is re-proved on the live ref at the read
    // boundary: a moved ref refuses instead of answering a superseded generation's rows.
    assertSelectionUnchanged(context, location);
    const byProject = new Map(rows.map((row) => [row.project_key, row]));
    const links = new Map<string, { projectId: string; state: string; resolvedBy: string | null }>();
    for (const entry of outbox) {
      if (typeof entry.operation_id !== "string" || typeof entry.project_key !== "string" || typeof entry.state !== "string") {
        continue;
      }
      links.set(entry.operation_id, {
        projectId: entry.project_key,
        state: entry.state,
        resolvedBy: typeof entry.resolved_by === "string" ? entry.resolved_by : null,
      });
    }
    // invariant: Q1: a recorded fork closes required reads until its LIVE `resolved_by` chain
    // reaches a confirmed terminal repair AND the observation shows that fork merged. A nominally
    // complete traversal of the same competing heads proves the rows, never that the fork settled.
    const unresolvedForks = new Set<string>();
    for (const [operationId, link] of links) {
      if (link.state !== "conflict") continue;
      const raw = byProject.get(link.projectId)?.snapshot_json;
      let snapshot: RemoteSnapshot | null = null;
      if (typeof raw === "string") {
        try {
          snapshot = JSON.parse(raw) as RemoteSnapshot;
        } catch {
          snapshot = null;
        }
      }
      if (!conflictMerged(handle.db, links, operationId, snapshot)) unresolvedForks.add(link.projectId);
    }
    const now = Date.now();
    const projects = new Map<string, RemoteProjectEvidence>();
    for (const selected of selection.projects) {
      if (!requested.includes(selected.localProjectId)) continue;
      const row = byProject.get(selected.localProjectId);
      if (row === undefined || unresolvedForks.has(selected.localProjectId)) {
        projects.set(
          selected.localProjectId,
          unavailableEvidence(selected.localProjectId, selected, row === undefined ? undefined : "remote.effect-conflict"),
        );
        continue;
      }
      const completeness =
        row.completeness === "complete" || row.completeness === "partial" || row.completeness === "unavailable"
          ? row.completeness
          : "unavailable";
      const verified = outcomeLabel(row.verification_json) === "verified";
      const current = verified && Math.abs(now - Date.parse(row.verified_at)) <= REMOTE_SCOPE_TTL_MS;
      const asOfAt = row.as_of === null ? Number.NaN : Date.parse(row.as_of);
      projects.set(selected.localProjectId, {
        projectId: selected.localProjectId,
        scope: {
          provider: "linear",
          workspaceId: row.workspace_id,
          teamId: row.team_id,
          projectId: row.provider_project_id,
        },
        journalIssueId: row.journal_issue_id,
        revision: typeof row.revision === "number" ? row.revision : 0,
        asOf: row.as_of,
        completeness,
        code: row.code,
        // note: Freshness is the ACCESS check's currency, not the snapshot's coverage:
        // an expired check means no read may serve this scope, complete or not.
        freshness: current ? (completeness === "complete" ? "fresh" : "incomplete") : "expired",
        asOfFresh: Number.isFinite(asOfAt) && Math.abs(now - asOfAt) <= REMOTE_SCOPE_TTL_MS,
        // note: A partial observation carries its verified rows; required reads refuse it before serving,
        // but the observation still discloses its real asOf instead of masquerading as absent.
        snapshot: completeness === "unavailable" ? null : snapshotOf(row.snapshot_json, selected.localProjectId),
      });
    }
    const evidence = [...projects.values()];
    return {
      repoKey: handle.authority.repoKey,
      storeId: handle.authority.storeId,
      epoch: handle.authority.epoch,
      selectorCommit: selection.commit,
      generation: selection.generation,
      phase: selection.phase,
      projectIds: requested,
      projects,
      revision: evidence.reduce((sum, entry) => sum + entry.revision, 0),
      catalogRevision: evidence.reduce((sum, entry) => sum + entry.revision, 0),
    };
  } finally {
    handle.close();
  }
}

function unavailableEvidence(
  projectId: string,
  selected: { workspaceId: string; teamId: string; projectId: string; journalIssueId: string },
  code = "remote.unavailable",
): RemoteProjectEvidence {
  return {
    projectId,
    scope: {
      provider: "linear",
      workspaceId: selected.workspaceId,
      teamId: selected.teamId,
      projectId: selected.projectId,
    },
    journalIssueId: selected.journalIssueId,
    revision: 0,
    asOf: null,
    completeness: "unavailable",
    code,
    freshness: "incomplete",
    asOfFresh: false,
    snapshot: null,
  };
}

/** note: The binding's latest check verdict, as status and serving freshness read it. */
function outcomeLabel(verificationJson: string): string {
  try {
    const parsed: unknown = JSON.parse(verificationJson);
    if (parsed !== null && typeof parsed === "object" && "outcome" in parsed) {
      const outcome = parsed.outcome;
      if (outcome !== null && typeof outcome === "object" && "kind" in outcome && typeof outcome.kind === "string") {
        return outcome.kind;
      }
    }
  } catch {
    // note: A damaged verification document is unavailable evidence, never a guess.
  }
  return "unavailable";
}

/** note: A stored snapshot was validated at ingest; a row that no longer parses is a corrupt cache. */
function snapshotOf(raw: string | null, projectId: string): RemoteSnapshot | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoreError(
      "collaboration.unreadable",
      `The stored observation for project ${projectId} is not valid JSON; this cache cannot serve it. Nothing was read.`,
    );
  }
  const issues = parsed !== null && typeof parsed === "object" && "issues" in parsed ? parsed.issues : undefined;
  const project = parsed !== null && typeof parsed === "object" && "project" in parsed ? parsed.project : undefined;
  if (!Array.isArray(issues) || project === null || typeof project !== "object") {
    throw new StoreError(
      "collaboration.unreadable",
      `The stored observation for project ${projectId} is not a complete project snapshot; this cache cannot serve it. Nothing was read.`,
    );
  }
  // note: The shape was validated on ingest; the cast only restores the type of that validated document.
  return parsed as RemoteSnapshot;
}

// ---------------------------------------------------------------------------
// note: Required-source admission and the collaboration observation
// ---------------------------------------------------------------------------

/** The exact project set one scope needs; a repository/plan scope needs every selected project. */
export function remoteScopeProjectIds(view: RemoteReadView, scope: CollaborationScope): readonly string[] {
  if (scope.kind === "project") return [scope.key];
  if (scope.kind === "milestone") return [scope.key.split(":")[0] ?? scope.key];
  return view.projectIds;
}

/**
 * invariant: The required-source gate. A selected project whose evidence is missing,
 * partial, unavailable or stale refuses with its own code - a required view never
 * answers placeholder rows or a zero total from it.
 */
export function requireRemoteProjects(
  view: RemoteReadView | null,
  projectIds?: readonly string[],
): readonly RemoteProjectEvidence[] {
  if (view === null) {
    throw new StoreError(
      "remote.unavailable",
      "This view requires the remote authority, which this request could not open. Nothing was read.",
    );
  }
  const ids = projectIds ?? view.projectIds;
  return ids.map((projectId) => {
    const evidence = view.projects.get(projectId);
    if (evidence === undefined) {
      throw new StoreError(
        "remote.scope-mismatch",
        `Project ${projectId} is not one of the selected remote projects, so this cache has no evidence for it. Nothing was read.`,
      );
    }
    if (evidence.snapshot === null || evidence.completeness === "unavailable") {
      throw new StoreError(
        "remote.unavailable",
        `No complete observation is stored for project ${projectId}${evidence.code === null ? "" : ` (${evidence.code})`}. ` +
          "Reverify with the host and submit a complete observation; this read never answers an empty result instead.",
        { projectId, code: evidence.code },
      );
    }
    if (evidence.completeness === "partial") {
      throw new StoreError(
        "collaboration.observation-incomplete",
        `The stored observation for project ${projectId} is partial` +
          `${evidence.code === null ? "" : ` (${evidence.code})`}; a required read never exposes unverified rows. ` +
          "Refresh all required streams with a complete observation.",
        { projectId, code: evidence.code },
      );
    }
    if (evidence.freshness !== "fresh") {
      throw new StoreError(
        "collaboration.observation-stale",
        `The access check for project ${projectId} is no longer current, so its data cannot serve a required read. ` +
          "Reverify the scope and resubmit the observation.",
        { projectId },
      );
    }
    // invariant: The traversal clock is separate from the access check: a check made now over a
    // traversal started outside the window still cannot satisfy a count, rollup or gate.
    if (!evidence.asOfFresh) {
      throw new StoreError(
        "collaboration.observation-stale",
        `The observation for project ${projectId} started its provider traversal at ` +
          `${evidence.asOf ?? "an unrecorded time"}, outside the ${String(REMOTE_SCOPE_TTL_MS / 1000)}-second freshness ` +
          `window, so it cannot serve a required read even though its access check is current. Re-observe the scope.`,
        { projectId },
      );
    }
    return evidence;
  });
}

/**
 * The remote arm of one scoped observation, from the evidence of exactly the
 * projects the read contributes. A caller that narrowed a query to one project
 * passes that set; every stamp (provider scopes, `asOf`, revisions) covers only
 * those projects, so an unrelated project's gap never taints this read and no
 * complete stamp is claimed over an expired access check.
 */
export function remoteCollaborationObservation(
  view: RemoteReadView,
  scope: CollaborationScope,
  projectIds?: readonly string[],
): CollaborationObservation {
  const ids = projectIds ?? remoteScopeProjectIds(view, scope);
  const evidence = ids.map((projectId) => view.projects.get(projectId)).filter(
    (entry): entry is RemoteProjectEvidence => entry !== undefined,
  );
  const providerScopes: CollaborationProviderScope[] = evidence.map((entry) => ({
    projectId: entry.projectId,
    scope: entry.scope,
    completeness: entry.completeness,
    asOf: entry.asOf,
    revision: entry.revision,
  }));
  const base = {
    scope,
    source: "remote" as const,
    selectorCommit: view.selectorCommit,
    generation: view.generation,
    providerScopes,
  };
  const unavailable = (code: string): CollaborationObservation => ({
    ...base,
    completeness: "unavailable",
    asOf: null,
    authority: null,
    code,
  });
  if (evidence.length !== ids.length) {
    return unavailable(evidence.length === 0 ? "remote.unavailable" : "collaboration.observation-incomplete");
  }
  const absent = evidence.find((entry) => entry.snapshot === null || entry.completeness === "unavailable" || entry.asOf === null);
  if (absent !== undefined) return unavailable(absent.code ?? "remote.unavailable");
  // note: An expired check cannot support any claim, complete or partial.
  if (evidence.some((entry) => entry.freshness === "expired")) return unavailable("collaboration.observation-stale");
  // note: A traversal started outside the window is stale even under a current check: an optional
  // view discloses that instead of a complete stamp, and no gate or count can decide on it.
  if (evidence.some((entry) => !entry.asOfFresh)) return unavailable("collaboration.observation-stale");
  // note: The aggregate instant is the OLDEST contributing observation, so a reader never
  // understates age by picking the freshest stream.
  const asOf = evidence.map((entry) => entry.asOf as string).sort()[0] as string;
  const revision = evidence.reduce((sum, entry) => sum + entry.revision, 0);
  const gap = evidence.find((entry) => entry.completeness !== "complete");
  if (gap !== undefined) {
    return {
      ...base,
      completeness: "partial",
      asOf,
      authority: { repoKey: view.repoKey, mode: "remote", storeId: view.storeId, epoch: view.epoch },
      revision,
      catalogRevision: revision,
      code: gap.code ?? "collaboration.observation-incomplete",
    };
  }
  return {
    ...base,
    completeness: "complete",
    asOf,
    authority: { repoKey: view.repoKey, mode: "remote", storeId: view.storeId, epoch: view.epoch },
    revision,
    catalogRevision: revision,
  };
}

// ---------------------------------------------------------------------------
// note: MStar subject accessors
// ---------------------------------------------------------------------------

type Subject = NonNullable<RemoteIssue["mstar"]>;

function subjectOf(issue: RemoteIssue): Subject | null {
  return issue.mstar;
}

function unreadable(projectId: string, detail: string): never {
  throw new StoreError(
    "collaboration.unreadable",
    `The stored observation for project ${projectId} does not carry ${detail}; this read cannot serve it. Nothing was read.`,
  );
}

function fieldsOf(projectId: string, issue: RemoteIssue): Record<string, unknown> {
  const subject = subjectOf(issue);
  if (subject === null) unreadable(projectId, "an MStar subject");
  return subject.fields;
}

function textField(projectId: string, issue: RemoteIssue, key: string): string {
  const value = fieldsOf(projectId, issue)[key];
  if (typeof value !== "string") unreadable(projectId, `fields.${key}`);
  return value;
}

function nullableTextField(projectId: string, issue: RemoteIssue, key: string): string | null {
  const value = fieldsOf(projectId, issue)[key];
  if (value !== null && typeof value !== "string") unreadable(projectId, `fields.${key}`);
  return value;
}

function numberField(projectId: string, issue: RemoteIssue, key: string): number {
  const value = fieldsOf(projectId, issue)[key];
  if (typeof value !== "number" || !Number.isInteger(value)) unreadable(projectId, `fields.${key}`);
  return value;
}

function subjectField<T>(projectId: string, issue: RemoteIssue, key: keyof Subject): T {
  const subject = subjectOf(issue);
  if (subject === null) unreadable(projectId, "an MStar subject");
  return subject[key] as T;
}

function severityOf(projectId: string, issue: RemoteIssue): Severity {
  const value = textField(projectId, issue, "severity");
  if (!Object.hasOwn(SEVERITY_RANK, value)) unreadable(projectId, "fields.severity");
  return value as Severity;
}

function dispositionOf(projectId: string, issue: RemoteIssue): Disposition {
  const value = textField(projectId, issue, "disposition");
  if (value !== "open" && !TERMINAL.has(value as Disposition)) unreadable(projectId, "fields.disposition");
  return value as Disposition;
}

function lastActivityOf(projectId: string, issue: RemoteIssue): string | null {
  const subject = subjectOf(issue);
  if (subject === null) return issue.providerUpdatedAt;
  const stamps: Array<string | null> = [nullableTextField(projectId, issue, "registeredAt")];
  for (const occurrence of subject.occurrences) {
    const value = occurrence.discoveredAt;
    stamps.push(typeof value === "string" ? value : null);
  }
  for (const transition of subject.transitions) {
    const value = transition.occurredAt;
    stamps.push(typeof value === "string" ? value : null);
  }
  const present = stamps.filter((value): value is string => typeof value === "string" && value !== "");
  return present.length === 0 ? null : present.sort().at(-1) as string;
}

// ---------------------------------------------------------------------------
// note: Issue reads
// ---------------------------------------------------------------------------

/** note: The page-bounds rule shared with the local reader. */
function pageBounds(filter: IssueFilter): { limit: number; offset: number } {
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
    throw new IssueError("issue.scope-refused", "limit must be 1..200 and offset must be nonnegative");
  }
  return { limit, offset };
}

function queryMatches(issue: RemoteIssue, query: string): boolean {
  const needle = query.toLowerCase();
  const subject = subjectOf(issue);
  if (subject === null) return issue.nativeTitle.toLowerCase().includes(needle);
  if (String(subject.fields.title).toLowerCase().includes(needle)) return true;
  return subject.occurrences.some((occurrence) => {
    const evidence = Array.isArray(occurrence.evidence) ? occurrence.evidence.join("\n") : "";
    return [occurrence.observedBehavior, evidence, occurrence.location].some(
      (value) => typeof value === "string" && value.toLowerCase().includes(needle),
    );
  });
}

/**
 * The issue page over admitted snapshots. `items`/`total`/`projectCount` are MStar
 * findings only; `providerIssues` makes an unmarked native issue visible without
 * giving it a disposition, severity or count. Both lists answer the SAME stable
 * `limit`/`offset` page: the provider list is ordered by provider update, project
 * and provider id, so output size is bounded by the requested page.
 */
export function remoteIssuePage(view: RemoteReadView, filter: IssueFilter): IssuePage {
  const { limit, offset } = pageBounds(filter);
  const projectIds = filter.projectId === undefined ? view.projectIds : [filter.projectId];
  const evidence = requireRemoteProjects(view, projectIds);
  const disposition = filter.disposition ?? "open";
  const matched: Array<{ issue: RemoteIssue; projectId: string; evidence: RemoteProjectEvidence }> = [];
  for (const entry of evidence) {
    for (const issue of entry.snapshot?.issues ?? []) {
      if (issue.mstar === null) continue;
      if (dispositionOf(entry.projectId, issue) !== disposition) continue;
      if (filter.kind !== undefined && textField(entry.projectId, issue, "kind") !== filter.kind) continue;
      if (filter.severity !== undefined && severityOf(entry.projectId, issue) !== filter.severity) continue;
      if (filter.query !== undefined && filter.query !== "" && !queryMatches(issue, filter.query)) continue;
      matched.push({ issue, projectId: entry.projectId, evidence: entry });
    }
  }
  matched.sort((left, right) => {
    const rank = SEVERITY_RANK[severityOf(left.projectId, left.issue)] - SEVERITY_RANK[severityOf(right.projectId, right.issue)];
    if (rank !== 0) return -rank;
    const leftAt = lastActivityOf(left.projectId, left.issue);
    const rightAt = lastActivityOf(right.projectId, right.issue);
    if (leftAt !== rightAt) {
      if (leftAt === null) return 1;
      if (rightAt === null) return -1;
      return leftAt < rightAt ? 1 : -1;
    }
    return subjectField<string>(left.projectId, left.issue, "issueRef") < subjectField<string>(right.projectId, right.issue, "issueRef") ? -1 : 1;
  });
  const items: IssueSummary[] = matched.slice(offset, offset + limit).map(({ issue, projectId }) => ({
    id: subjectField<string>(projectId, issue, "issueRef"),
    issueRef: subjectField<string>(projectId, issue, "issueRef"),
    projectId,
    title: textField(projectId, issue, "title"),
    kind: textField(projectId, issue, "kind") as IssueKind,
    severity: severityOf(projectId, issue),
    disposition: dispositionOf(projectId, issue),
    registeredAt: nullableTextField(projectId, issue, "registeredAt"),
    lastActivity: lastActivityOf(projectId, issue),
    revision: numberField(projectId, issue, "revision"),
    milestoneId: nullableTextField(projectId, issue, "milestoneId"),
    nativeStatus: issue.nativeStatus,
  }));
  const providerIssues: ProviderOnlyIssue[] =
    disposition === "open"
      ? evidence
          .flatMap((entry) =>
            (entry.snapshot?.issues ?? [])
              .filter((issue) => issue.mstar === null)
              .filter((issue) => filter.query === undefined || filter.query === "" || queryMatches(issue, filter.query))
              .map((issue) => ({ projectId: entry.projectId, issue })),
          )
          // note: The page contract needs a TOTAL order: newest provider update first, then
          // project and the immutable provider id, so `offset` names the same rows on a re-read.
          // The input accepts whole-second and fractional UTC spellings for one instant, so
          // the key is the parsed instant, never the text.
          .sort((left, right) => {
            const leftAt = Date.parse(left.issue.providerUpdatedAt);
            const rightAt = Date.parse(right.issue.providerUpdatedAt);
            if (leftAt !== rightAt) return rightAt - leftAt;
            if (left.projectId !== right.projectId) return left.projectId < right.projectId ? -1 : 1;
            const leftId = left.issue.identity.issueId;
            const rightId = right.issue.identity.issueId;
            return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
          })
          .slice(offset, offset + limit)
          .map(({ projectId, issue }) => providerOnly(projectId, issue))
      : [];
  return {
    items,
    total: matched.length,
    projectCount: new Set(matched.map((entry) => entry.projectId)).size,
    storeRevision: view.revision,
    ...(providerIssues.length === 0 ? {} : { providerIssues }),
  };
}

function providerOnly(projectId: string, issue: RemoteIssue): ProviderOnlyIssue {
  return {
    kind: "provider-only",
    issueRef: null,
    projectId,
    title: issue.nativeTitle,
    nativeStatus: issue.nativeStatus,
    providerUpdatedAt: issue.providerUpdatedAt,
    identity: issue.identity,
  };
}

/** The answer of one issue read: an MStar subject, or a visible unmarked native issue. */
export type RemoteIssueRead =
  | Readonly<{ kind: "mstar"; detail: IssueDetail }>
  | Readonly<{ kind: "native"; detail: ProviderOnlyIssue }>;

/**
 * `issue show` against admitted snapshots. An `IssueRef` resolves the portable
 * key across every selected project; a native issue is addressed ONLY by its
 * exact provider id plus the local project it belongs to. A display id such as
 * `I-000001`, a label, a URL, or a guessed project never resolves.
 */
export function remoteIssueRead(view: RemoteReadView, id: string, projectId?: string): RemoteIssueRead {
  if (ISSUE_REF_PATTERN.test(id)) {
    const evidence = requireRemoteProjects(view);
    const found: Array<{ issue: RemoteIssue; projectId: string }> = [];
    for (const entry of evidence) {
      for (const issue of entry.snapshot?.issues ?? []) {
        if (issue.mstar !== null && issue.mstar.issueRef === id) found.push({ issue, projectId: entry.projectId });
      }
    }
    if (found.length === 0) throw new IssueError("issue.not-found", `Issue ${id} does not exist in the observed remote scope.`);
    if (found.length > 1) {
      throw new StoreError(
        "remote.scope-mismatch",
        `Issue reference ${id} appears in more than one observed project, so this read cannot pick one. ` +
          "Reconcile the duplicate reference in the provider; nothing was read.",
        { issueRef: id, projects: found.map((entry) => entry.projectId) },
      );
    }
    return {
      kind: "mstar",
      detail: mstarDetail(
        found[0]!.projectId,
        found[0]!.issue,
        view,
        evidence.map((entry) => entry.projectId),
      ),
    };
  }
  if (projectId === undefined || projectId.trim() === "") {
    throw new IssueError(
      "issue.scope-refused",
      `Native provider issue ${JSON.stringify(id)} requires the local project it belongs to: ` +
        "mstar issue show --id <provider-issue-id> --project <local-project-id>. A project is never guessed and a display " +
        "issue number is not a provider id.",
    );
  }
  if (!PROVIDER_ISSUE_ID.test(id)) {
    throw new IssueError(
      "issue.scope-refused",
      `Native issue detail addresses the exact provider id (an immutable Linear UUID), not ${JSON.stringify(id)}. ` +
        "Use the stable mstar:issue:<uuid> reference or the provider's UUID.",
    );
  }
  const evidence = requireRemoteProjects(view, [projectId]);
  const issue = (evidence[0]!.snapshot?.issues ?? []).find((entry) => entry.identity.issueId === id);
  if (issue === undefined) {
    throw new IssueError("issue.not-found", `Provider issue ${id} does not exist in the observed scope of project ${projectId}.`);
  }
  return issue.mstar === null
    ? { kind: "native", detail: providerOnly(projectId, issue) }
    : { kind: "mstar", detail: mstarDetail(projectId, issue, view, [projectId]) };
}

function mstarDetail(
  projectId: string,
  issue: RemoteIssue,
  view: RemoteReadView,
  projectIds: readonly string[],
): IssueDetail {
  const subject = subjectOf(issue);
  if (subject === null) unreadable(projectId, "an MStar subject");
  const issueRef = subject.issueRef;
  const occurrences = subject.occurrences.map((row, index) => ({
    id: index + 1,
    eventId: typeof row.eventId === "string" ? row.eventId : undefined,
    occurrenceKey: String(row.occurrenceKey),
    sourceKind: String(row.sourceKind),
    sourceIdentity: String(row.sourceIdentity),
    rootCauseKey: String(row.rootCauseKey),
    acceptanceKey: String(row.acceptanceKey),
    location: String(row.location),
    observedBehavior: String(row.observedBehavior),
    evidence: Array.isArray(row.evidence) ? row.evidence.filter((value): value is string => typeof value === "string") : [],
    discoveredAt: typeof row.discoveredAt === "string" ? row.discoveredAt : null,
    recordedAt: String(row.recordedAt),
    imported: row.imported === true,
  }));
  const transitions = subject.transitions.map((row, index) => ({
    id: index + 1,
    eventId: typeof row.eventId === "string" ? row.eventId : undefined,
    fromDisposition: String(row.fromDisposition),
    toDisposition: String(row.toDisposition),
    actor: typeof row.actor === "string" ? row.actor : null,
    occurredAt: typeof row.occurredAt === "string" ? row.occurredAt : null,
    recordedAt: String(row.recordedAt),
    reason: String(row.reason),
    evidence: row.evidence,
    imported: row.imported === true,
    issueRevision: typeof row.issueRevision === "number" ? row.issueRevision : 0,
  }));
  const relations = subject.relations.map((row) => ({
    fromIssue: issueRef,
    relation: String(row.relation),
    toIssue: String(row.target),
    title: titleOfRef(view, String(row.target), projectIds),
  }));
  const provenance = subject.provenance.map((row, index) => ({
    id: index + 1,
    eventId: typeof row.eventId === "string" ? row.eventId : undefined,
    kind: String(row.kind),
    target: String(row.target),
    sourceHash: String(row.sourceHash),
    origin: row.origin === "unscoped" ? ("unscoped" as const) : ("scoped" as const),
    legacyProject: typeof row.legacyProject === "string" ? row.legacyProject : null,
    legacyBucket: typeof row.legacyBucket === "string" ? row.legacyBucket : null,
    legacyEntryId: typeof row.legacyEntryId === "string" ? row.legacyEntryId : null,
    legacyJson: row.legacyRecord === null || row.legacyRecord === undefined ? null : JSON.stringify(row.legacyRecord),
    importedAt: typeof row.importedAt === "string" ? row.importedAt : null,
  }));
  const projectMoves = subject.projectMoves.map((row) => ({
    fromProject: String(row.fromProject),
    toProject: String(row.toProject),
    actor: String(row.actor),
    reason: String(row.reason),
    occurredAt: String(row.occurredAt),
    issueRevision: typeof row.issueRevision === "number" ? row.issueRevision : 0,
  }));
  return {
    id: issueRef,
    issueRef,
    projectId,
    title: textField(projectId, issue, "title"),
    kind: textField(projectId, issue, "kind") as IssueKind,
    severity: severityOf(projectId, issue),
    disposition: dispositionOf(projectId, issue),
    impact: textField(projectId, issue, "impact"),
    acceptance: textField(projectId, issue, "acceptance"),
    owner: nullableTextField(projectId, issue, "owner"),
    registeredAt: nullableTextField(projectId, issue, "registeredAt"),
    closedAt: nullableTextField(projectId, issue, "closedAt"),
    closureNote: nullableTextField(projectId, issue, "closureNote"),
    createdAt: textField(projectId, issue, "createdAt"),
    updatedAt: textField(projectId, issue, "updatedAt"),
    revision: numberField(projectId, issue, "revision"),
    provider: "linear",
    externalId: issue.identity.issueId,
    url: null,
    identityKey: issueRef,
    milestoneId: nullableTextField(projectId, issue, "milestoneId"),
    occurrences,
    transitions,
    relations,
    provenance,
    projectMoves,
    nativeTitle: issue.nativeTitle,
    nativeStatus: issue.nativeStatus,
    providerIdentity: issue.identity,
  };
}

function titleOfRef(view: RemoteReadView, issueRef: string, projectIds: readonly string[]): string | null {
  for (const projectId of projectIds) {
    const evidence = view.projects.get(projectId);
    // invariant: A relation title is cross-project data. Only a project this read DECLARES
    // and that is current and complete may disclose it; an unresolved title stays null
    // rather than reading an undeclared or expired snapshot.
    if (evidence === undefined || evidence.freshness !== "fresh" || !evidence.asOfFresh || evidence.snapshot === null) continue;
    for (const issue of evidence.snapshot.issues) {
      if (issue.mstar?.issueRef === issueRef) {
        const title = issue.mstar.fields.title;
        return typeof title === "string" ? title : null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// note: Findings, residuals and dated flow
// ---------------------------------------------------------------------------

/** note: A complete plan-scoped findings observation: every OPEN MStar subject linked to the plan. */
export function remotePlanFindings(view: RemoteReadView, planId: string): {
  observation: CollaborationObservation;
  open: readonly { id: string; severity: Severity }[];
} {
  const evidence = requireRemoteProjects(view);
  const open: Array<{ id: string; severity: Severity }> = [];
  for (const entry of evidence) {
    for (const issue of entry.snapshot?.issues ?? []) {
      const subject = issue.mstar;
      if (subject === null || dispositionOf(entry.projectId, issue) !== "open") continue;
      const linked = subject.provenance.some(
        (row) => row.kind === "plan" && row.target === planId && (row.origin === "scoped" || row.origin === undefined),
      );
      if (linked) open.push({ id: subject.issueRef, severity: severityOf(entry.projectId, issue) });
    }
  }
  open.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { observation: remoteCollaborationObservation(view, { kind: "plan", key: planId }), open };
}

/** note: The five closed severity literals, always all present (D20). */
export function remoteResidualCounts(
  view: RemoteReadView,
  projectId?: string,
): { open: number; bySeverity: Record<Severity, number>; byProject: Record<string, number> } {
  const evidence = requireRemoteProjects(view, projectId === undefined ? view.projectIds : [projectId]);
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, nit: 0 };
  const byProject: Record<string, number> = {};
  for (const entry of evidence) {
    let open = 0;
    for (const issue of entry.snapshot?.issues ?? []) {
      if (issue.mstar === null || dispositionOf(entry.projectId, issue) !== "open") continue;
      bySeverity[severityOf(entry.projectId, issue)] += 1;
      open += 1;
    }
    if (open > 0) byProject[entry.projectId] = open;
  }
  return { open: Object.values(bySeverity).reduce((sum, count) => sum + count, 0), bySeverity, byProject };
}

/** note: The dated history over MStar subjects only; provider-only issues carry no MStar dates. */
export function remoteIssueFlow(view: RemoteReadView, projectId?: string) {
  const evidence = requireRemoteProjects(view, projectId === undefined ? view.projectIds : [projectId]);
  type Day = { captured: number; retired: number; importedCaptured: number; importedRetired: number };
  const days = new Map<string, Day>();
  const dayOf = (date: string): Day => {
    const existing = days.get(date);
    if (existing !== undefined) return existing;
    const created: Day = { captured: 0, retired: 0, importedCaptured: 0, importedRetired: 0 };
    days.set(date, created);
    return created;
  };
  const utcDay = (timestamp: string | null): string | null => {
    if (timestamp === null || timestamp === "") return null;
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(timestamp)) return timestamp;
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  };
  let unknownCaptureDates = 0;
  let unknownClosureDates = 0;
  let currentOpen = 0;
  for (const entry of evidence) {
    for (const issue of entry.snapshot?.issues ?? []) {
      const subject = issue.mstar;
      if (subject === null) continue;
      const disposition = dispositionOf(entry.projectId, issue);
      if (disposition === "open") currentOpen += 1;
      const captured = utcDay(nullableTextField(entry.projectId, issue, "registeredAt"));
      if (captured === null) unknownCaptureDates += 1;
      else {
        const day = dayOf(captured);
        day.captured += 1;
        if (subject.occurrences.some((row) => row.imported === true)) day.importedCaptured += 1;
      }
      if (!TERMINAL.has(disposition)) continue;
      const closed = utcDay(nullableTextField(entry.projectId, issue, "closedAt"));
      if (closed === null) {
        unknownClosureDates += 1;
        continue;
      }
      const day = dayOf(closed);
      day.retired += 1;
      if (subject.transitions.some((row) => row.imported === true && row.toDisposition === disposition)) {
        day.importedRetired += 1;
      }
    }
  }
  const buckets = [];
  let capturedCumulative = 0;
  let retiredCumulative = 0;
  for (const date of [...days.keys()].sort()) {
    const day = days.get(date) as Day;
    capturedCumulative += day.captured;
    retiredCumulative += day.retired;
    const allImported =
      day.importedCaptured === day.captured && day.importedRetired === day.retired && day.importedCaptured + day.importedRetired > 0;
    buckets.push({
      date,
      capturedCumulative,
      retiredCumulative,
      openDifference: capturedCumulative - retiredCumulative,
      origin: allImported ? ("register-history" as const) : ("store" as const),
    });
  }
  return {
    buckets,
    unknownCaptureDates,
    unknownClosureDates,
    currentOpen,
    incompleteHistory: unknownCaptureDates > 0 || unknownClosureDates > 0,
  };
}

// ---------------------------------------------------------------------------
// note: Catalog, projects and milestones
// ---------------------------------------------------------------------------

/** note: The portable catalog identity a snapshot carries; checkout locations are deliberately absent. */
export type RemoteCatalogRow = Readonly<{
  kind: "project" | "iteration" | "plan" | "document";
  id: string;
  title: string;
  description: string | null;
  /** note: The catalog's own kind vocabulary: admission refuses a value outside it, so no cast remains. */
  documentKind: CatalogDocumentKind | null;
  lifecycle: "active" | "archived" | "superseded";
  revision: number;
}>;

/**
 * The union of every admitted project snapshot's portable catalog, built by key.
 * A duplicate `(kind,id)` keeps the first project's row: the identity is
 * repository-wide, and a conflicting duplicate was already refused by ingest.
 */
export function remoteCatalogRows(view: RemoteReadView, projectIds: readonly string[]): RemoteCatalogRow[] {
  const evidence = requireRemoteProjects(view, projectIds);
  const byToken = new Map<string, RemoteCatalogRow>();
  for (const entry of evidence) {
    for (const row of entry.snapshot?.project.catalogEntities ?? []) {
      const token = `${row.kind}\u0000${row.id}`;
      if (!byToken.has(token)) byToken.set(token, row as RemoteCatalogRow);
    }
  }
  return [...byToken.values()];
}

export type RemoteCatalogLinks = Readonly<{
  membership: ReadonlyMap<string, ReadonlySet<string>>;
  attribution: "present" | "absent";
  planLinks: ReadonlyMap<string, readonly string[]>;
  documentLinks: ReadonlyMap<string, readonly string[]>;
}>;

/** note: The portable catalog relations, indexed exactly as the local catalog joins index them. */
export function remoteCatalogLinks(view: RemoteReadView, projectIds: readonly string[]): RemoteCatalogLinks {
  const evidence = requireRemoteProjects(view, projectIds);
  const membership = new Map<string, Set<string>>();
  const planLinks = new Map<string, string[]>();
  const documentLinks = new Map<string, string[]>();
  let attributed = false;
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  };
  for (const entry of evidence) {
    for (const link of entry.snapshot?.project.catalogLinks ?? []) {
      if (link.relation === "belongs-to" && link.toKind === "project") {
        if (link.fromKind === "iteration") attributed = true;
        const token = `${link.fromKind}\u0000${link.fromId}`;
        const projects = membership.get(token) ?? new Set<string>();
        projects.add(link.toId);
        membership.set(token, projects);
      }
      if (link.relation === "belongs-to" && link.fromKind === "plan" && link.toKind === "iteration") {
        push(planLinks, link.toId, link.fromId);
      }
      if (link.relation === "documents" && link.fromKind === "iteration" && link.toKind === "document") {
        push(documentLinks, link.fromId, link.toId);
      }
    }
  }
  for (const list of planLinks.values()) list.sort();
  for (const list of documentLinks.values()) list.sort();
  return { membership, attribution: attributed ? "present" : "absent", planLinks, documentLinks };
}

/** note: The project roll-up over MStar subjects; an unmarked issue never counts as an open finding. */
export function remoteProjectList(view: RemoteReadView): {
  items: Array<{ project: { id: string; title: string; description: string | null; lifecycle: "active" | "archived" | "superseded" | null }; openIssues: number }>;
  total: number;
} {
  const evidence = requireRemoteProjects(view);
  const catalog = remoteCatalogRows(view, view.projectIds);
  const items = evidence.map((entry) => {
    const identity = catalog.find((row) => row.kind === "project" && row.id === entry.projectId);
    const openIssues = (entry.snapshot?.issues ?? []).filter(
      (issue) => issue.mstar !== null && dispositionOf(entry.projectId, issue) === "open",
    ).length;
    return {
      project: {
        id: entry.projectId,
        title: identity?.title ?? entry.projectId,
        description: identity?.description ?? null,
        lifecycle: identity?.lifecycle ?? null,
      },
      openIssues,
    };
  });
  items.sort((left, right) => (left.project.title < right.project.title ? -1 : left.project.title > right.project.title ? 1 : 0));
  return { items, total: items.length };
}

/** note: One project's milestone grouping and MStar membership from admitted evidence. */
export function remoteMilestones(view: RemoteReadView, projectId: string, milestoneId?: string): MilestoneRead {
  const evidence = requireRemoteProjects(view, [projectId])[0]!;
  const source = evidence.snapshot?.project.milestones ?? [];
  if (milestoneId !== undefined && !source.some((row) => row.milestoneId === milestoneId)) {
    throw new MilestoneError("milestone.not-found", `Milestone ${milestoneId} does not exist.`);
  }
  const subjects = (evidence.snapshot?.issues ?? []).flatMap((issue) =>
    issue.mstar === null ? [] : [{ issue, subject: issue.mstar }],
  );
  const milestones: ProjectMilestoneDTO[] = source
    .filter((row) => milestoneId === undefined || row.milestoneId === milestoneId)
    .sort((left, right) => left.ordinal - right.ordinal || (left.milestoneId < right.milestoneId ? -1 : 1))
    .map((row) => {
      const held = subjects.filter((entry) => nullableTextField(projectId, entry.issue, "milestoneId") === row.milestoneId);
      const dispositions = held.map((entry) => dispositionOf(projectId, entry.issue));
      return {
        milestoneId: row.milestoneId,
        projectId,
        name: row.name,
        effortSessions: row.effortSessions,
        status: row.status,
        ordinal: row.ordinal,
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        totalIssues: held.length,
        openIssues: dispositions.filter((value) => value === "open").length,
        resolvedIssues: dispositions.filter((value) => value === "resolved").length,
        otherRetiredIssues: dispositions.filter((value) => value === "open" ? false : value !== "resolved").length,
      };
    });
  const issues = subjects
    .filter((entry) => nullableTextField(projectId, entry.issue, "milestoneId") !== null)
    .filter((entry) => milestoneId === undefined || nullableTextField(projectId, entry.issue, "milestoneId") === milestoneId)
    .sort((left, right) => {
      const leftId = nullableTextField(projectId, left.issue, "milestoneId") as string;
      const rightId = nullableTextField(projectId, right.issue, "milestoneId") as string;
      return leftId < rightId ? -1 : leftId > rightId ? 1 : left.subject.issueRef < right.subject.issueRef ? -1 : 1;
    })
    .map((entry) => ({
      id: entry.subject.issueRef,
      title: textField(projectId, entry.issue, "title"),
      acceptance: textField(projectId, entry.issue, "acceptance"),
      disposition: dispositionOf(projectId, entry.issue),
      revision: numberField(projectId, entry.issue, "revision"),
      milestoneId: nullableTextField(projectId, entry.issue, "milestoneId") as string,
    }));
  const unassignedIssues = subjects.filter((entry) => nullableTextField(projectId, entry.issue, "milestoneId") === null).length;
  return { projectId, milestones, issues, unassignedIssues };
}
