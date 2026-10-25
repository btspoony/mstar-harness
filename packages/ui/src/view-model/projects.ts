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
import type { ProjectListDTO, RoadmapContent, RoadmapDTO } from "@mstar-harness/engine";

import type { Resolved } from "./state.ts";
import { resolveRead, resolveRecord } from "./state.ts";
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

export type ProjectListModel = { rows: Resolved<readonly ProjectRow[]>; total: number };

/** The list state. The catalog does not depend on the projection. */
export function projectListModel(read: {
  data: ProjectListDTO;
  projection: { generation: number | null };
}): ProjectListModel {
  const rows = resolveRead(
    { data: read.data.items, projection: read.projection },
    { whenNull: "empty", isEmpty: (items) => items.length === 0 },
  );
  return {
    rows: rows.kind === "populated" ? { kind: "populated", value: rows.value.map(projectRow) } : rows,
    total: read.data.total,
  };
}

/**
 * One row of a {@link RoadmapModel}'s goal list: a goal's title and whether it is
 * checked, plus its depth so a sub-goal reads as one without a second list.
 */
export type RoadmapGoal = {
  ordinal: number;
  /** 0 for a top-level goal; 1 for a goal under one. */
  depth: number;
  checked: boolean;
  title: string;
};

/** One milestone of the roadmap board. */
export type RoadmapMilestone = {
  milestoneId: string;
  name: string;
  status: string | null;
  target: string | null;
  progress: { done: number; total: number } | null;
  openIssues: number;
  /** The issues assigned to this milestone: id, title, disposition. */
  issues: readonly { id: string; title: string; disposition: string }[];
};

/**
 * The Roadmap feature's body.
 *
 * `direction` and `goals` come from the stored Markdown; the milestone board comes
 * from the milestone read, which is authoritative and independent of the file
 * (`RoadmapDTO` §4: a project with milestones and no content answers
 * `content: null` and still carries them). A project with neither is the
 * `absent` arm and never reaches this model.
 */
export type RoadmapModel = {
  direction: string | null;
  goals: readonly RoadmapGoal[];
  milestones: readonly RoadmapMilestone[];
  /** Issues with no milestone: a count, and the reason they are not on the board. */
  unassignedIssues: number;
  /** The stored Markdown, for the collapsed disclosure. */
  markdown: string | null;
};

/**
 * Build the roadmap body.
 *
 * `depth` is derived from `parentOrdinal` because the board renders a flat list
 * with an indent: a nested list would make a sub-goal's check state read as its
 * parent's, and the stored document is flat with parent references.
 */
export function roadmapModel(read: RoadmapDTO, content: RoadmapContent | null): RoadmapModel {
  const parents = new Set((content?.goals ?? []).map((goal) => goal.ordinal));
  return {
    direction: content?.direction ?? null,
    goals: (content?.goals ?? []).map((goal) => ({
      ordinal: goal.ordinal,
      depth: goal.parentOrdinal !== null && parents.has(goal.parentOrdinal) ? 1 : 0,
      checked: goal.checked,
      title: goal.title,
    })),
    milestones: read.milestones.milestones.map((milestone) => ({
      milestoneId: milestone.milestoneId,
      name: milestone.name,
      status: milestone.status,
      target: milestone.target,
      progress: milestone.totalIssues === 0 ? null : { done: milestone.resolvedIssues, total: milestone.totalIssues },
      openIssues: milestone.openIssues,
      issues: read.milestones.issues
        .filter((issue) => issue.milestoneId === milestone.milestoneId)
        .map((issue) => ({ id: issue.id, title: issue.title, disposition: issue.disposition })),
    })),
    unassignedIssues: read.milestones.unassignedIssues,
    markdown: content?.contentMarkdown ?? null,
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
 * Two different zeroes, and IA §4 says they must never collapse:
 *
 *  - a project with **no roadmap authority row** (`_default` is the real case) is
 *    `absent` — no direction, no goals, no milestone set, and no empty board or
 *    zero-width bar to imply otherwise;
 *  - a roadmap that exists with an empty milestone set is `empty` — the concept is
 *    declared and the set happens to be empty.
 *
 * `null` here means absent, not unreadable: a failed read answers `unavailable`
 * through `projection`/the transport, so a `null` payload cannot be a failure.
 */
export function roadmapFeatureArm(read: {
  data: RoadmapDTO | null;
  projection: { generation: number | null };
}): Resolved<RoadmapDTO> {
  const arm = resolveRecord(read, { unavailableReason: "the roadmap read could not be completed" });
  if (arm.kind !== "populated") return arm;
  // Domain judgement on top of the resolved arm: the project has a catalog row
  // but no roadmap authority row, so the concept is undeclared.
  if (arm.value.authority.state === "absent") return { kind: "absent" };
  return arm;
}

/**
 * The Roadmap feature's arm, resolving one level further than the read.
 *
 * `empty` is reserved for a roadmap with **nothing at all to show** — no
 * milestones, no goals, no direction and no stored markdown. An earlier version
 * tested only the first two, which hid an existing direction and a stored
 * document behind "the roadmap has no milestones": content the reader can act on,
 * declared empty. Anything that exists is rendered.
 */
export function roadmapBody(raw: Resolved<RoadmapDTO>): Resolved<RoadmapModel> {
  if (raw.kind !== "populated") return raw;
  const model = roadmapModel(raw.value, raw.value.content);
  const hasContent =
    model.milestones.length > 0 ||
    model.goals.length > 0 ||
    model.direction !== null ||
    model.markdown !== null ||
    model.unassignedIssues > 0;
  return hasContent ? { kind: "populated", value: model } : { kind: "empty" };
}
