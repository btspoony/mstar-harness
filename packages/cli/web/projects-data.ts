/** see packages/cli/web/projects-data.ts - The host's half of the Projects pair, plus the one read the whole shell shares. Two obligations converge here: - **The project list is host-supplied data.** `@mstar-harness/ui`'s README makes the host responsible for it (obligation 2), because a component cannot know how a host enumerates projects. One read feeds both consumers — the Issues filter bar and this destination — instead of each fetching its own copy. - **The project screen's default body is the milestone rollup.** It comes from the project-scoped `overview` read's `milestones` member; `milestonesArm` makes the absence judgement and the host adds nothing to it. */
import type { IssuePage, IterationListDTO, MilestoneRead as MilestoneReadDTO, ProjectListDTO } from "@mstar-harness/engine";
import {
  ASSIGNABLE_ISSUE_LIMIT,
  createMilestoneDraftStore,
  milestoneDraftTargetKey,
  milestonesArm,
  projectIdentity,
  projectIdentityFor,
  projectListModel,
  type AssignableIssuesRead,
  type Copy,
  type MilestoneWriteSurface,
  type MilestonesModel,
  type ProjectDetailCopy,
  type ProjectFeature,
  type ProjectListModel,
  type ProjectsCopy,
  type Resolved,
} from "@mstar-harness/ui";

import { OVERVIEW_PATH } from "./overview-data";
import { UNREACHABLE, asEnvelope, refusalMessage, requiredCollaborationRefusal } from "./read-envelope";

/** Where the pair answers. */
export const PROJECTS_PATH = "/api/projects";

/** The one milestone write route; the verb rides the request body. */
export const MILESTONE_WRITE_PATH = "/api/milestones";

/** The project-scoped milestone read: the milestone body's own source, execution-free. */
export const MILESTONES_PATH = "/api/milestones";

/**
 * The C1 retry policy, host-local: one id — and the whole request it was minted
 * for — per LOGICAL write, retained across a transport-ambiguous failure so the
 * retry replays the engine's recorded receipt instead of writing twice. A
 * terminal answer (success or a refusal the store itself made) settles it.
 */
export function milestoneWriteIds(): {
  for(signature: string, request: { expectedStoreRevision: number }): { operationId: string; request: { expectedStoreRevision: number } };
  settled(): void;
} {
  let pending: { signature: string; operationId: string; request: { expectedStoreRevision: number } } | null = null;
  return {
    for(signature, request) {
      if (pending !== null && pending.signature === signature) return { operationId: pending.operationId, request: pending.request };
      pending = { signature, operationId: crypto.randomUUID(), request };
      return { operationId: pending.operationId, request: pending.request };
    },
    settled() {
      pending = null;
    },
  };
}

/** The project-scoped aggregated read the milestone body answers from. */
export function projectOverviewPath(projectId: string): string {
  return `${OVERVIEW_PATH}?project=${encodeURIComponent(projectId)}`;
}

/**
 * The project's milestone grouping on its own.
 *
 * The aggregated `overview` read joins projected execution rows, so it needs an
 * execution store; the milestone body has none of that (its facts are the milestone
 * tables and the issue membership they count), and a fresh clone or a remote-only
 * checkout would otherwise hide milestones the engine can still read.
 */
export function projectMilestonesPath(projectId: string): string {
  return `${MILESTONES_PATH}?project=${encodeURIComponent(projectId)}`;
}

/**
 * The list screen's copy: the dictionary's own words plus the three absence arms,
 * whose headings are the page title.
 */
export function projectsCopy(copy: Copy): ProjectsCopy {
  return {
    ...copy.projects,
    empty: { ...copy.state.empty, heading: copy.projects.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.projects.pageTitle },
    absent: { ...copy.state.absent, heading: copy.projects.pageTitle },
  };
}

/**
 * The detail screen's copy: the dictionary's own words plus the three absence arms
 * the milestone body renders. The headings name the body they belong to, so a
 * missing milestone set does not read as a missing project.
 */
export function projectDetailCopy(copy: Copy): ProjectDetailCopy {
  const heading = copy.projectDetail.milestones.milestonesHeading;
  return {
    ...copy.projectDetail,
    absence: {
      empty: { ...copy.state.empty, heading },
      unavailable: { ...copy.state.unavailable, heading },
      "not-applicable": { ...copy.state["not-applicable"], heading },
    },
  };
}

/** What the list is handed. */
export type ProjectsOutcome =
  | { kind: "loading" }
  | { kind: "ready"; model: ProjectListModel }
  | { kind: "failed"; message: string };

/** What the project detail's milestone body is handed, plus the revision a write guards on. */
export type ProjectMilestonesOutcome =
  | { kind: "loading" }
  | {
      kind: "ready";
      milestones: Resolved<MilestonesModel>;
      /** see packages/cli/web/projects-data.ts - The store revision of the SAME overview read that produced the arm. A write hashes it into its request, so a stale observation is refused (`milestone.revision-conflict`) instead of overwriting another writer. `null` when the collaboration observation carries no revision — the forms are read-only then, because there is nothing honest to hash. */
      storeRevision: number | null;
    }
  | { kind: "failed"; message: string };

/** One list read. */
export async function readProjects(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ status: "ready"; envelope: Parameters<typeof projectListModel>[0] } | { status: "error"; message: string }> {
  try {
    const response = await fetchImpl(PROJECTS_PATH, {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<ProjectListDTO>(body);
    if (envelope === null) return { status: "error", message: "The project list answered with something that is not a read envelope." };
    const gap = requiredCollaborationRefusal(envelope);
    if (gap !== null) return { status: "error", message: gap };
    return { status: "ready", envelope: { data: envelope.data, projection: envelope.projection } };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}

/**
 * One project-scoped milestone read, resolved to the milestone body's arm.
 *
 * Reads the milestone view, not the aggregated `overview`: the milestone body's facts
 * are collaboration data, so this read must not require an execution store. A degraded
 * member is the arm the shared resolver makes of it, never a flattened null.
 */
export async function readProjectMilestones(
  fetchImpl: typeof fetch,
  projectId: string,
  signal?: AbortSignal,
): Promise<
  { status: "ready"; milestones: Resolved<MilestonesModel>; storeRevision: number | null } | { status: "error"; message: string }
> {
  try {
    const response = await fetchImpl(projectMilestonesPath(projectId), {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<MilestoneReadDTO>(body);
    if (envelope === null) return { status: "error", message: "The milestone read answered with something that is not a read envelope." };
    // see packages/cli/web/projects-data.ts - // why: A gap is not an empty milestone set: the authority could not establish
    // what the project owns, so the read fails rather than claiming nothing is there.
    const gap = requiredCollaborationRefusal(envelope);
    if (gap !== null) return { status: "error", message: gap };
    // see packages/ui/src/view-model/projects.ts - the arm resolves this read as a `read` member.
    return {
      status: "ready",
      milestones: milestonesArm({ state: "read", data: envelope.data }),
      storeRevision: envelope.storeRevision,
    };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}

/** The list outcome for a settled read. */
export function projectsOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; envelope: Parameters<typeof projectListModel>[0] }
    | { status: "error"; message: string },
): ProjectsOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "ready":
      return { kind: "ready", model: projectListModel(result.envelope) };
    case "error":
      return { kind: "failed", message: result.message };
  }
}

/** The milestone body outcome for a settled read. */
export function projectMilestonesOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; milestones: Resolved<MilestonesModel>; storeRevision: number | null }
    | { status: "error"; message: string },
): ProjectMilestonesOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "ready":
      return { kind: "ready", milestones: result.milestones, storeRevision: result.storeRevision };
    case "error":
      return { kind: "failed", message: result.message };
  }
}

/** One milestone mutation the dashboard posts. */
export type MilestoneMutationRequest =
  | { verb: "create"; projectId: string; input: { name: string; effortSessions: number | null; ordinal: number } }
  | { verb: "update"; projectId: string; milestoneId: string; patch: { name?: string; effortSessions?: number | null; status?: string } }
  | { verb: "remove"; projectId: string; milestoneId: string }
  | { verb: "assign"; projectId: string; issueId: string; milestoneId: string | null; issueRevision: number };

/**
 * One milestone write through the dashboard's own route, carrying the observed
 * store revision from the read that rendered the forms. A refusal is the
 * store's own code and message, verbatim — the caller surfaces it and, for
 * `milestone.revision-conflict`, re-reads.
 */
export async function writeMilestone(
  fetchImpl: typeof fetch,
  request: MilestoneMutationRequest & { expectedStoreRevision: number; operationId: string },
): Promise<{ status: "ok"; receipt: unknown } | { status: "refused"; code: string; message: string }> {
  try {
    const response = await fetchImpl(MILESTONE_WRITE_PATH, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const refusal = body as { error?: { code?: unknown; message?: unknown } } | null;
      return {
        status: "refused",
        code: typeof refusal?.error?.code === "string" ? refusal.error.code : "dashboard-write",
        message: typeof refusal?.error?.message === "string" ? refusal.error.message : refusalMessage(body, response.status),
      };
    }
    const receipt = body as { data?: unknown } | null;
    return { status: "ok", receipt: receipt?.data ?? null };
  } catch {
    return { status: "refused", code: "transport-error", message: UNREACHABLE };
  }
}

/**
 * What one settled milestone write does to the open page.
 *
 * The page's whole conflict contract is this function's output, so it is asserted
 * without a DOM:
 *
 *  - an ACCEPTED write moved the store: the overview read re-issues (the forms must
 *    re-arm on the new revision) and the operator's draft is cleared;
 *  - `milestone.revision-conflict` also moved the store: the read re-issues so the
 *    next submission carries the fresh revision — and the draft is KEPT, because
 *    the text the operator typed is theirs and only an accepted write replaces it;
 *  - an input refusal or any other terminal refusal wrote nothing: no re-read (a
 *    reload would unmount the forms mid-edit for no fact) and the draft stays;
 *  - an ambiguous transport failure (`transport-error`) is not a verdict: nothing
 *    re-reads and the draft stays, so a retry replays the engine's receipt;
 *  - an assignment moves an ISSUE as well, so the scoped list/picker re-read too.
 */
export type MilestoneWriteFollowUp = {
  /** see packages/cli/web/projects-data.ts - Re-issue the overview read (the forms' revision and the milestone body). */
  readonly reloadOverview: boolean;
  /** see packages/cli/web/projects-data.ts - Re-issue the scoped Issues list and the assign picker. */
  readonly refreshIssues: boolean;
  /** see packages/cli/web/projects-data.ts - Keep the operator's typed draft (`false` clears it after an accepted write). */
  readonly keepDraft: boolean;
  /** see packages/cli/web/projects-data.ts - Surface this refusal message, or `null` after an accepted write. */
  readonly refusal: string | null;
  /** see packages/cli/web/projects-data.ts - Keep the logical write's operation id/revision for a retry of the same intent. */
  readonly retainOperation: boolean;
};

/** The page's conflict/idempotency policy for one settled milestone write. */
export function milestoneWriteFollowUp(
  request: { readonly verb: MilestoneMutationRequest["verb"] },
  result: { status: "ok"; receipt: unknown } | { status: "refused"; code: string; message: string },
): MilestoneWriteFollowUp {
  const accepted = result.status === "ok";
  const ambiguous = result.status === "refused" && result.code === "transport-error";
  const conflict = result.status === "refused" && result.code === "milestone.revision-conflict";
  const reloadOverview = accepted || conflict;
  return {
    reloadOverview,
    refreshIssues: reloadOverview && request.verb === "assign",
    keepDraft: !accepted,
    refusal: result.status === "refused" ? result.message : null,
    retainOperation: ambiguous,
  };
}

/** The page state one settled milestone write can move. */
export type MilestonePageState = {
  /** see packages/cli/web/projects-data.ts - The overview read's reload token (the forms' revision and the milestone body). */
  readonly overviewReloadToken: number;
  /** see packages/cli/web/projects-data.ts - The scoped Issues list / assign picker refresh token. */
  readonly issuesRefreshToken: number;
  /** see packages/cli/web/projects-data.ts - What the write surface renders: busy, the store's message, and the draft verdict. */
  readonly writes: { readonly busy: boolean; readonly refusal: string | null; readonly keepDraft: boolean | undefined };
  /** see packages/cli/web/projects-data.ts - Whether the logical write's id/revision is retained (a replays-able ambiguous attempt). */
  readonly operationPending: boolean;
};

/** The page state with one write in flight: busy, no verdict yet, its operation armed. */
export function milestoneWriteStarted(state: MilestonePageState): MilestonePageState {
  return { ...state, writes: { busy: true, refusal: null, keepDraft: undefined }, operationPending: true };
}

/**
 * Apply one settled write's policy to the page state — the transition `main.tsx`
 * performs, pure and asserted:
 *
 *  - `reloadOverview` bumps the overview token (accepted, or the conflict's re-read);
 *  - `refreshIssues` bumps the issues/picker token;
 *  - `writes.keepDraft` is the follow-up's verdict, with `busy` cleared and the
 *    store's message surfaced verbatim;
 *  - `retainOperation` keeps the logical write armed; a terminal answer settles it.
 */
export function applyMilestoneFollowUp(state: MilestonePageState, followUp: MilestoneWriteFollowUp): MilestonePageState {
  return {
    overviewReloadToken: state.overviewReloadToken + (followUp.reloadOverview ? 1 : 0),
    issuesRefreshToken: state.issuesRefreshToken + (followUp.refreshIssues ? 1 : 0),
    writes: { busy: false, refusal: followUp.refusal, keepDraft: followUp.keepDraft },
    operationPending: followUp.retainOperation,
  };
}

/** The project ids the filter bar offers, from the shared list read. */
export function projectOptions(model: ProjectListModel): readonly string[] {
  return model.rows.kind === "populated" ? model.rows.value.map((row) => row.projectId) : [];
}

/** Re-exported so a screen's scoped element can be built without a second shape. */
export {
  ASSIGNABLE_ISSUE_LIMIT,
  createMilestoneDraftStore,
  milestoneDraftTargetKey,
  projectIdentity,
  projectIdentityFor,
  type AssignableIssuesRead,
  type MilestoneWriteSurface,
};
export type { IssuePage, IterationListDTO, MilestoneReadDTO, ProjectFeature };
