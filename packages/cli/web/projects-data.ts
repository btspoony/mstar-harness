/**
 * The host's half of the Projects pair, plus the one read the whole shell shares.
 *
 * Three obligations converge here:
 *
 *  - **The project list is host-supplied data.** `@mstar-harness/ui`'s README makes
 *    the host responsible for it (obligation 2), because a component cannot know how
 *    a host enumerates projects. One read feeds both consumers — the Issues filter
 *    bar and this destination — instead of each fetching its own copy.
 *  - **`Roadmap` is the permanent default feature**, never "the first non-empty".
 *    The route model already defaults it; this module only resolves the arm for
 *    whichever feature is selected.
 *  - **A project with no roadmap authority row is `absent`**, which is a fact about
 *    the project, not an empty board and not a hidden row. `roadmapFeatureArm`
 *    makes that judgement; the host adds nothing to it.
 */
import type { IssuePage, IterationListDTO, ProjectListDTO, RoadmapDTO } from "@mstar-harness/engine";
import {
  projectIdentity,
  projectListModel,
  roadmapBody,
  roadmapFeatureArm,
  type Copy,
  type ProjectDetailCopy,
  type ProjectIdentity,
  type ProjectListModel,
  type ProjectsCopy,
  type Resolved,
  type RoadmapModel,
  type ProjectFeature,
} from "@mstar-harness/ui";

import { UNREACHABLE, asEnvelope, refusalMessage } from "./read-envelope";

/** Where the pair answers. */
export const PROJECTS_PATH = "/api/projects";

export function projectRoadmapPath(projectId: string): string {
  return `/api/roadmap?project=${encodeURIComponent(projectId)}`;
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
 * The detail screen's copy: the dictionary's own words plus the four absence arms
 * the Roadmap feature renders. The headings name the feature they belong to, so a
 * missing roadmap does not read as a missing project.
 */
export function projectDetailCopy(copy: Copy): ProjectDetailCopy {
  const heading = copy.projectDetail.features.roadmap;
  return {
    ...copy.projectDetail,
    absence: {
      absent: { ...copy.state.absent, heading },
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

/** What the project detail's roadmap feature is handed. */
export type RoadmapOutcome =
  | { kind: "loading" }
  | { kind: "ready"; roadmap: Resolved<RoadmapModel>; identity: ProjectIdentity }
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
    return { status: "ready", envelope: { data: envelope.data, projection: envelope.projection } };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}

/**
 * One roadmap read.
 *
 * The identity block comes from the same read: the roadmap's catalog identity is
 * the project's identity, so the detail head cannot disagree with the roadmap it
 * describes.
 */
export async function readRoadmap(
  fetchImpl: typeof fetch,
  projectId: string,
  signal?: AbortSignal,
): Promise<
  | { status: "ready"; roadmap: Resolved<RoadmapModel>; identity: ProjectIdentity }
  | { status: "absent" }
  | { status: "error"; message: string }
> {
  try {
    const response = await fetchImpl(projectRoadmapPath(projectId), {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 404) return { status: "absent" };
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<RoadmapDTO>(body);
    if (envelope === null) return { status: "error", message: "The roadmap read answered with something that is not a read envelope." };
    const arm = roadmapFeatureArm({ data: envelope.data, projection: envelope.projection });
    // The envelope carries the catalog row even when the roadmap authority is absent,
    // so the head is built from what the store actually said rather than from the id:
    // a synthesised title, `lifecycle: "unknown"` and a guessed path are invented
    // facts, and `projectIdentity` already derives the real `rootKind:relativePath`.
    const catalog = envelope.data?.catalog ?? null;
    if (catalog === null) {
      return { status: "ready", roadmap: arm.kind === "populated" ? roadmapBody(arm) : arm, identity: identityFor(projectId) };
    }
    return {
      status: "ready",
      roadmap: arm.kind === "populated" ? roadmapBody(arm) : arm,
      identity: projectIdentity(catalog),
    };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}

/**
 * The identity block when the read carries **no catalog row at all**.
 *
 * Only reachable for a project the store has no catalog entry for — a 404 or an
 * unreadable projection. The route still names the project, so the head says where
 * the reader is; it claims nothing else, because it knows nothing else.
 */
function identityFor(projectId: string): ProjectIdentity {
  return {
    projectId,
    title: projectId,
    description: null,
    lifecycle: "unknown",
    // An unknown record states no revision; the head omits the segment rather than
    // printing `Revision —`, which would claim the store recorded an empty one.
    revision: "",
    // The same reasoning for the two dates: an unknown record states none, and the panel
    // prints `—` rather than claiming a value.
    registeredAt: "",
    updatedAt: "",
    lifecycleTone: "neutral",
    path: projectId,
  };
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

/** The roadmap outcome for a settled read. */
export function roadmapOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; roadmap: Resolved<RoadmapModel>; identity: ProjectIdentity }
    | { status: "absent" }
    | { status: "error"; message: string },
  projectId: string,
): RoadmapOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "absent":
      return { kind: "ready", roadmap: { kind: "absent" }, identity: identityFor(projectId) };
    case "ready":
      return { kind: "ready", roadmap: result.roadmap, identity: result.identity };
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
