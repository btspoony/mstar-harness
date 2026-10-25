/**
 * Workflows list + detail transforms.
 *
 * IA §8.2: the list carries id, type, status, phase, plan `done/total`, started
 * and the branch anchors the row has; the detail carries the four anchors, the
 * dates and the plan table. Leases, adoption rows and the catalog-pin badges are
 * **not** returned (IA §8.1) — the pin badges are join bookkeeping, and a plan's
 * status already says whether it is being worked.
 *
 * The one badge that survives is `execution-unavailable`, because it is the
 * *reason* a state reads `unavailable`, not a log line. It travels as a reason
 * string, never as a decorative chip.
 */
import type { WorkflowDTO, WorkflowListDTO, WorkflowPlanDTO } from "@mstar-harness/engine";

import type { Resolved } from "./state.ts";
import { resolveRead } from "./state.ts";
import { planStatusTone, type Tone } from "./status.ts";
import { formatDate, type ProjectionState } from "./format.ts";

/** The four branch anchors, in delivery order. */
export type BranchAnchors = {
  base: string | null;
  source: string | null;
  integration: string | null;
  target: string | null;
};

/** One workflow row. */
export type WorkflowRow = {
  id: string;
  type: string;
  status: string;
  statusTone: Tone;
  phase: string | null;
  /** Plan progress across the workflow's plans. */
  plansDone: number;
  plansTotal: number;
  startedAt: string;
  branch: BranchAnchors;
  /** The store's own reason when the execution projection could not be read. */
  executionUnavailableReason: string | null;
};

/** Workflow status → tone: a paused workflow is not an error. */
export function workflowStatusTone(status: string): Tone {
  switch (status) {
    case "paused":
      return "warning";
    case "completed":
    case "stopped":
      return "neutral";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

/** The four anchors as the DTO carries them (no second naming system). */
export function branchAnchors(branch: WorkflowDTO["branch"]): BranchAnchors {
  return {
    base: branch.base,
    // The DTO's `branch.source` is the delivery branch; it is labelled by what
    // the value means at the call site, not renamed here.
    source: branch.source,
    integration: branch.integration,
    target: branch.target,
  };
}

/** The store's reason for an unreadable execution projection, or `null`. */
export function executionUnavailableReason(badges: readonly string[]): string | null {
  return badges.includes("execution-unavailable")
    ? "the execution projection for this workflow could not be read"
    : null;
}

/** Done plans over all plans. */
function planTally(plans: readonly { status: string | null }[]): { done: number; total: number } {
  return { done: plans.filter((plan) => plan.status === "Done").length, total: plans.length };
}

/** One list row from the DTO. */
export function workflowRow(workflow: WorkflowDTO): WorkflowRow {
  const tally = planTally(workflow.plans);
  return {
    id: workflow.id,
    type: workflow.type,
    status: workflow.status,
    statusTone: workflowStatusTone(workflow.status),
    phase: workflow.phase,
    plansDone: tally.done,
    plansTotal: tally.total,
    startedAt: formatDate(workflow.startedAt),
    branch: branchAnchors(workflow.branch),
    executionUnavailableReason: executionUnavailableReason(workflow.badges),
  };
}

/** The list state: `listed` / `empty` / `unavailable` (no valid projection). */
export function workflowListModel(read: {
  data: WorkflowListDTO;
  projection: { generation: number | null };
}): { rows: Resolved<readonly WorkflowRow[]>; total: number } {
  const rows = resolveRead(
    { data: read.data.items, projection: read.projection },
    { whenNull: "empty", isEmpty: (items) => items.length === 0 },
  );
  return {
    rows: rows.kind === "populated" ? { kind: "populated", value: rows.value.map(workflowRow) } : rows,
    total: read.data.total,
  };
}

/** One plan row of a workflow detail's plan table. */
export type WorkflowPlanRow = {
  planId: string;
  title: string | null;
  status: string | null;
  statusTone: Tone;
  /** The plan's recorded progress note — never a derived "next step". */
  progress: string | null;
  phase: string | null;
  doneAt: string | null;
};

/** The detail model: anchors, dates and the plan table. */
export type WorkflowDetailModel = {
  /** `null` when the read has no valid projection (the reason rides along). */
  workflow: WorkflowRow | null;
  updatedAt: string;
  endedAt: string | null;
  plans: readonly WorkflowPlanRow[];
  projection: ProjectionState;
};

/** One plan row. */
export function workflowPlanRow(plan: WorkflowPlanDTO): WorkflowPlanRow {
  return {
    planId: plan.planId,
    title: plan.catalog?.title ?? null,
    status: plan.status,
    statusTone: planStatusTone(plan.status ?? ""),
    progress: plan.progress,
    phase: plan.phase,
    doneAt: plan.doneAt,
  };
}

/**
 * The detail's own state. `data === null` or no valid projection is
 * `unavailable` — the page reports the read, never a missing record.
 */
export function workflowDetailModel(read: {
  data: WorkflowDTO | null;
  projection: { generation: number | null };
}): Resolved<WorkflowDetailModel> {
  if (read.projection.generation === null || read.data === null) {
    return { kind: "unavailable", reason: "the execution projection for this workflow could not be read" };
  }
  const workflow = read.data;
  return {
    kind: "populated",
    value: {
      workflow: workflowRow(workflow),
      updatedAt: formatDate(workflow.updatedAt),
      endedAt: workflow.endedAt,
      plans: workflow.plans.map(workflowPlanRow),
      projection: { kind: "current" },
    },
  };
}
