/**
 * Projects list + detail transforms.
 *
 * IA §8.2: the list carries id/title, description, lifecycle and the open-issue
 * count; the detail's identity block carries title, description, lifecycle and
 * the `{HARNESS_DIR}`-relative path. The path stays because it *is* the record's
 * identity — one cell, and what a developer types to reach the project. The
 * catalog revision and the registered/updated dates are **not** returned (IA
 * §8.1: churn metadata).
 *
 * The three features of a project (Roadmap / Issues / Iterations) are fixed by
 * IA §4. This module only orders them and names the arm each one starts in; the
 * rows come from the issue and iteration transforms.
 */
import type { ProjectListDTO, RoadmapDTO } from "@mstar-harness/engine";

import type { Resolved } from "./state.ts";
import { resolveRead } from "./state.ts";
import { lifecycleTone, type Tone } from "./status.ts";
import { countText } from "./format.ts";

/** One project list row. */
export type ProjectRow = {
  projectId: string;
  title: string;
  description: string | null;
  lifecycle: string;
  lifecycleTone: Tone;
  openIssues: number;
  /** `N open issues`, singular-aware. */
  openIssuesText: string;
};

/** One row from the list DTO. */
export function projectRow(item: ProjectListDTO["items"][number]): ProjectRow {
  const project = item.project;
  return {
    projectId: project.id,
    title: project.title,
    description: project.description,
    lifecycle: project.lifecycle,
    lifecycleTone: lifecycleTone(project.lifecycle),
    openIssues: item.openIssues,
    openIssuesText: countText(item.openIssues, "open issue"),
  };
}

/** The list state. The catalog does not depend on the projection. */
export function projectListModel(read: {
  data: ProjectListDTO;
  projection: { generation: number | null };
}): { rows: Resolved<readonly ProjectRow[]>; total: number } {
  const rows = resolveRead(
    { data: read.data.items, projection: read.projection },
    { whenNull: "empty", isEmpty: (items) => items.length === 0 },
  );
  return {
    rows: rows.kind === "populated" ? { kind: "populated", value: rows.value.map(projectRow) } : rows,
    total: read.data.total,
  };
}

/** A project's identity block — the whole of what IA §8.2 allows here. */
export type ProjectIdentity = {
  projectId: string;
  title: string;
  description: string | null;
  lifecycle: string;
  lifecycleTone: Tone;
  /** `{HARNESS_DIR}`-relative location, e.g. `projects/engine`. */
  path: string;
};

/** The identity block from the roadmap's catalog identity. */
export function projectIdentity(catalog: RoadmapDTO["catalog"]): ProjectIdentity {
  return {
    projectId: catalog.id,
    title: catalog.title,
    description: catalog.description,
    lifecycle: catalog.lifecycle,
    lifecycleTone: lifecycleTone(catalog.lifecycle),
    path: `${catalog.rootKind}:${catalog.relativePath}`,
  };
}

/**
 * A project's features, in the fixed order of IA §4. The project detail defaults
 * to `roadmap`; the tab set is not configurable, because a project that dropped a
 * feature would silently answer a different question.
 */
export const PROJECT_FEATURES = ["roadmap", "issues", "iterations"] as const;
export type ProjectFeature = (typeof PROJECT_FEATURES)[number];

/** The feature a project detail opens on. */
export const DEFAULT_PROJECT_FEATURE: ProjectFeature = "roadmap";

/**
 * The arm a feature's body starts in, given the roadmap read.
 *
 * `absent` is the case IA §5 cares about: a project with **no roadmap authority
 * row** says so instead of rendering an empty board. A roadmap that exists with
 * no milestones is `empty`, not `absent` — the concept is declared.
 */
export function roadmapFeatureArm(read: {
  data: RoadmapDTO | null;
  projection: { generation: number | null };
}): Resolved<RoadmapDTO> {
  if (read.projection.generation === null) {
    return { kind: "unavailable", reason: "the roadmap read could not be completed" };
  }
  if (read.data === null) return { kind: "absent" };
  if (read.data.authority.state === "absent") return { kind: "absent" };
  return { kind: "populated", value: read.data };
}
