/** see packages/ui/src/view-model/projects.ts - Projects list + detail transforms. IA §8.2: the list carries id/title, description, lifecycle and the open-issue count; the detail's identity block carries the same facts from the same list read, so the head cannot disagree with the row the reader opened. The project screen's default body is the milestone rollup (the `overview` view's project-scoped `milestones` member); the two list features (Issues / Iterations) are fixed by IA §4. This module only orders them and names the arm each one starts in; the rows come from the issue and iteration transforms. */
import type { MilestoneRead, OverviewMember, ProjectListDTO } from "@mstar-harness/engine";

import type { Resolved } from "./state.ts";
import { resolveMember, resolveRead } from "./state.ts";
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
    lifecycle: project.lifecycle ?? "",
    lifecycleTone: lifecycleTone(project.lifecycle ?? ""),
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

/** One milestone of the project screen's board. */
export type Milestone = {
  milestoneId: string;
  name: string;
  status: string | null;
  effortSessions: number | null;
  ordinal: number;
  progress: { done: number; total: number } | null;
  openIssues: number;
  /** The four tallies the prototype's board row prints. */
  counts: { open: number; resolved: number; retired: number; total: number };
  /** The issues assigned to this milestone: id, title, disposition, revision. */
  issues: readonly { id: string; title: string; disposition: string; revision: number }[];
};

/**
 * The project screen's milestone body: the board plus the unassigned count.
 * Everything here comes from the milestone rollup (`MilestoneRead`), which is
 * the one authority for milestone work.
 */
export type MilestonesModel = {
  milestones: readonly Milestone[];
  /** Issues with no milestone: a count, and the reason they are not on the board. */
  unassignedIssues: number;
};

/** Build the milestone body from the rollup. */
export function milestonesModel(read: MilestoneRead): MilestonesModel {
  return {
    milestones: read.milestones.map((milestone) => ({
      milestoneId: milestone.milestoneId,
      name: milestone.name,
      status: milestone.status,
      effortSessions: milestone.effortSessions,
      ordinal: milestone.ordinal,
      progress: milestone.totalIssues === 0 ? null : { done: milestone.resolvedIssues, total: milestone.totalIssues },
      openIssues: milestone.openIssues,
      counts: {
        open: milestone.openIssues,
        resolved: milestone.resolvedIssues,
        retired: milestone.otherRetiredIssues,
        total: milestone.totalIssues,
      },
      issues: read.issues
        .filter((issue) => issue.milestoneId === milestone.milestoneId)
        .map((issue) => ({ id: issue.id, title: issue.title, disposition: issue.disposition, revision: issue.revision })),
    })),
    unassignedIssues: read.unassignedIssues,
  };
}

/**
 * The arm the milestone body renders, from the `overview` read's project-scoped
 * `milestones` member.
 *
 * A read that answered with no milestones and no unassigned issues is `empty` —
 * the concept is declared and the set happens to be empty, and the create form
 * is still offered. `not-applicable` means no project resolved for the read;
 * `unavailable` carries the store's own reason. There is no `absent` arm: with
 * the roadmap document gone, no project "declares no milestones".
 */
export function milestonesArm(member: OverviewMember<MilestoneRead>): Resolved<MilestonesModel> {
  const arm = resolveMember(member, {
    whenNull: "empty",
    isEmpty: (read) => read.milestones.length === 0 && read.unassignedIssues === 0,
  });
  return arm.kind === "populated" ? { kind: "populated", value: milestonesModel(arm.value) } : arm;
}

/** A project's identity block — the facts the project list read answers. */
export type ProjectIdentity = {
  projectId: string;
  title: string;
  description: string | null;
  lifecycle: string;
  lifecycleTone: Tone;
};

/** The identity block from the project list's row — the same read the list renders. */
export function projectIdentity(row: ProjectRow): ProjectIdentity {
  return {
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    lifecycle: row.lifecycle,
    lifecycleTone: row.lifecycleTone,
  };
}

/**
 * The identity block when the list carries no row for the project. The route
 * still names the project, so the head says where the reader is; it claims
 * nothing else, because it knows nothing else.
 */
export function projectIdentityFor(projectId: string): ProjectIdentity {
  return { projectId, title: projectId, description: null, lifecycle: "unknown", lifecycleTone: "neutral" };
}

/**
 * A project's list features, in the fixed order of IA §4. The tab set is not
 * configurable, because a project that dropped a feature would silently answer
 * a different question. The milestone rollup is the screen's default body, not
 * a tab.
 */
export const PROJECT_FEATURES = ["issues", "iterations"] as const;
export type ProjectFeature = (typeof PROJECT_FEATURES)[number];

/** The feature a project detail opens on. */
export const DEFAULT_PROJECT_FEATURE: ProjectFeature = "issues";
