/**
 * The host's half of the Projects pair, plus the one read the whole shell shares.
 *
 * Two obligations converge here:
 *
 *  - **The project list is host-supplied data.** `@mstar-harness/ui`'s README makes
 *    the host responsible for it (obligation 2), because a component cannot know how
 *    a host enumerates projects. One read feeds both consumers — the Issues filter
 *    bar and this destination — instead of each fetching its own copy.
 *  - **The project screen's default body is the milestone rollup.** It comes from
 *    the project-scoped `overview` read's `milestones` member; `milestonesArm`
 *    makes the absence judgement and the host adds nothing to it.
 */
import type { IssuePage, IterationListDTO, OverviewDTO, ProjectListDTO } from "@mstar-harness/engine";
import {
  milestonesArm,
  projectListModel,
  type Copy,
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

/** The project-scoped aggregated read the milestone body answers from. */
export function projectOverviewPath(projectId: string): string {
  return `${OVERVIEW_PATH}?project=${encodeURIComponent(projectId)}`;
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

/** What the project detail's milestone body is handed. */
export type ProjectMilestonesOutcome =
  | { kind: "loading" }
  | { kind: "ready"; milestones: Resolved<MilestonesModel> }
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
 * One project-scoped overview read, resolved to the milestone body's arm.
 *
 * The milestone rollup rides the aggregated read's `milestones` member; a
 * degraded member is the arm the shared resolver makes of it, never a
 * flattened null.
 */
export async function readProjectMilestones(
  fetchImpl: typeof fetch,
  projectId: string,
  signal?: AbortSignal,
): Promise<{ status: "ready"; milestones: Resolved<MilestonesModel> } | { status: "error"; message: string }> {
  try {
    const response = await fetchImpl(projectOverviewPath(projectId), {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<OverviewDTO>(body);
    if (envelope === null) return { status: "error", message: "The overview read answered with something that is not a read envelope." };
    // why: A gap is not an empty milestone set: the authority could not establish
    // what the project owns, so the read fails rather than claiming nothing is there.
    const gap = requiredCollaborationRefusal(envelope);
    if (gap !== null) return { status: "error", message: gap };
    return { status: "ready", milestones: milestonesArm(envelope.data.milestones) };
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
    | { status: "ready"; milestones: Resolved<MilestonesModel> }
    | { status: "error"; message: string },
): ProjectMilestonesOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "ready":
      return { kind: "ready", milestones: result.milestones };
    case "error":
      return { kind: "failed", message: result.message };
  }
}

/** The project ids the filter bar offers, from the shared list read. */
export function projectOptions(model: ProjectListModel): readonly string[] {
  return model.rows.kind === "populated" ? model.rows.value.map((row) => row.projectId) : [];
}

/** Re-exported so a screen's scoped element can be built without a second shape. */
export type { IssuePage, IterationListDTO, ProjectFeature };
