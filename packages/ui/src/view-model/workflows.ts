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
  /** The projected updated time — the row's own freshness, not the envelope's. */
  updatedAt: string;
  /**
   * Where the catalog registered this workflow (`rootKind:relativePath`), or
   * `null` when the row has no catalog entry. One cell: it is what a reader types
   * to reach the record, and it is not the `{HARNESS_DIR}` identity line.
   */
  root: string | null;
  /** The catalog title, when the row has one; `null` means no catalog row. */
  title: string | null;
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
    updatedAt: formatDate(workflow.updatedAt),
    root: workflow.catalog === null ? null : `${workflow.catalog.rootKind}:${workflow.catalog.relativePath}`,
    title: workflow.catalog?.title ?? null,
    branch: branchAnchors(workflow.branch),
    executionUnavailableReason: executionUnavailableReason(workflow.badges),
  };
}

/**
 * The list state: `listed` / `empty` / `unavailable` (no valid projection), plus
 * the truncation disclosure.
 *
 * `total` is the unpaged count the store reports; the page length is not it. A
 * list that reported `items.length` as its total would silently claim a truncated
 * page is the whole store, so the disclosure is computed from `total` alone and
 * the page length only ever appears as the "showing" side.
 */
export type WorkflowListModel = {
  rows: Resolved<readonly WorkflowRow[]>;
  /** The store's unpaged count — never the page length. */
  total: number;
  /** How many rows this page actually carries. */
  shown: number;
  /** `total > shown`: the store holds more than this page. */
  truncated: boolean;
};

export function workflowListModel(read: {
  data: WorkflowListDTO;
  projection: { generation: number | null };
}): WorkflowListModel {
  const rows = resolveRead(
    { data: read.data.items, projection: read.projection },
    { whenNull: "empty", isEmpty: (items) => items.length === 0 },
  );
  const shown = rows.kind === "populated" ? rows.value.length : 0;
  return {
    rows: rows.kind === "populated" ? { kind: "populated", value: rows.value.map(workflowRow) } : rows,
    total: read.data.total,
    shown,
    truncated: read.data.total > shown,
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

/** The catalog identity of a workflow, when it has one. */
export type WorkflowCatalog = {
  title: string;
  lifecycle: string;
  /** `rootKind:relativePath` — the same one-cell form the list uses. */
  root: string;
  /** The `documentKind` the catalog row declares, or `null` when it declares none. */
  documentKind: string | null;
};

/** The detail model: execution, catalog identity, dates and the plan table. */
export type WorkflowDetailModel = {
  workflow: WorkflowRow;
  catalog: WorkflowCatalog | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** The store's own reason when the execution projection could not be read. */
  executionUnavailableReason: string | null;
  plans: readonly WorkflowPlanRow[];
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
 * The detail's own state, under the package-wide ruling: **`null` is absent, a
 * failed read is `unavailable`**. A projection with no generation is the failure;
 * a null payload means there is no such record here.
 */
export function workflowDetailModel(read: {
  data: WorkflowDTO | null;
  projection: { generation: number | null };
}): Resolved<WorkflowDetailModel> {
  if (read.projection.generation === null) {
    return { kind: "unavailable", reason: "the execution projection for this workflow could not be read" };
  }
  if (read.data === null) return { kind: "absent" };
  const workflow = read.data;
  const catalog = workflow.catalog;
  return {
    kind: "populated",
    value: {
      workflow: workflowRow(workflow),
      catalog:
        catalog === null
          ? null
          : {
              title: catalog.title,
              lifecycle: catalog.lifecycle,
              root: `${catalog.rootKind}:${catalog.relativePath}`,
              documentKind: catalog.documentKind,
            },
      startedAt: formatDate(workflow.startedAt),
      updatedAt: formatDate(workflow.updatedAt),
      endedAt: workflow.endedAt,
      executionUnavailableReason: executionUnavailableReason(workflow.badges),
      plans: workflow.plans.map(workflowPlanRow),
    },
  };
}
