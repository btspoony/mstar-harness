/**
 * Workflows list + detail transforms.
 *
 * IA §8.2: the list carries id, type, status, phase, plan `done/total`, started
 * and the branch anchors the row has; the detail carries the four anchors, the
 * dates, the plan table **and the catalog-pin badges**. The badges are returned because
 * the prototype's workflow list has a `Join badges` column and the prototype is this
 * interface's acceptance criterion; IA §8.1 had excluded them as join bookkeeping,
 * which described a different goal. Leases and adoption rows stay out — no screen has
 * a place for them. (Originally:) — a plan's
 * status already says whether it is being worked.
 *
 * The one badge that survives is `execution-unavailable`, because it is the
 * *reason* a state reads `unavailable`, not a log line. It travels as a reason
 * string, never as a decorative chip.
 */
import type { WorkflowDTO, WorkflowListDTO, WorkflowPlanDTO } from "@mstar-harness/engine";

import type { Resolved } from "./state.ts";
import { resolveRead, resolveRecord } from "./state.ts";
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
  /** Whether the store still counts this workflow in the active registry. The detail
   *  head's chip asserts it, so an inactive workflow must not claim it. */
  activeRegistration: boolean;
  /** The join badges the store attached (`catalog-missing`, `catalog-pin-conflict`).
   *  The list's `Join badges` column renders them. */
  badges: readonly string[];
};

/** Workflow status → tone: a paused workflow is not an error. */
export function workflowStatusTone(status: string): Tone {
  switch (status) {
    // The prototype's `.tone-running` is `--ms-accent`; `neutral` made a live workflow's dot
    // the same grey as a stopped one.
    case "running":
      return "accent";
    case "paused":
      return "warning";
    // The prototype's `.tone-completed` and `.tone-terminal` are both `--ms-purple`.
    case "completed":
      return "purple";
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
    activeRegistration: workflow.activeRegistration,
    badges: workflow.badges,
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
/** The filters the workflow list offers, mirroring the prototype's row. */
export type WorkflowFilters = {
  status: string;
  type: string;
  q: string;
};

export const DEFAULT_WORKFLOW_FILTERS: WorkflowFilters = { status: "", type: "", q: "" };

export function isDefaultWorkflowFilters(filters: WorkflowFilters): boolean {
  return filters.status === "" && filters.type === "" && filters.q.trim() === "";
}

export type WorkflowListModel = {
  rows: Resolved<readonly WorkflowRow[]>;
  /** The store's unpaged count — never the page length. */
  total: number;
  /** How many rows this page actually carries. */
  shown: number;
  /**
   * Active registrations in the store's rows, before the filters narrow them: the head's
   * count states the store, not the current filter result.
   */
  active: number;
  /** `total > shown`: the store holds more than this page. */
  truncated: boolean;
  /** The status/type values the current rows carry, for the two selects. */
  options: { status: readonly string[]; type: readonly string[] };
  /** The rows the filters leave, before paging. */
  filtered: number;
  /** A status or type seen on a row the filters have hidden: the way back to it. */
  hiddenByFilters: number;
  /** Terminal workflows the active registry does not carry — the prototype's footer. */
  terminalUnregistered: number;
  /** Terminal workflows adopted into the registry. */
  terminalAdopted: number;
};

export function workflowListModel(read: {
  data: WorkflowListDTO;
  projection: { generation: number | null };
  filters?: WorkflowFilters;
}): WorkflowListModel {
  const rows = resolveRead(
    { data: read.data.items, projection: read.projection },
    // The rows come from the execution projection: without a generation they cannot
    // be trusted, and the veto must stay.
    { whenNull: "empty", isEmpty: (items) => items.length === 0, requiresProjection: true },
  );
  const mapped = rows.kind === "populated" ? rows.value.map(workflowRow) : [];
  const filters = read.filters ?? DEFAULT_WORKFLOW_FILTERS;
  const q = filters.q.trim().toLowerCase();
  const kept = mapped.filter(
    (row) =>
      (filters.status === "" || row.status === filters.status) &&
      (filters.type === "" || row.type === filters.type) &&
      (q === "" || row.id.toLowerCase().includes(q) || (row.title ?? "").toLowerCase().includes(q)),
  );
  const options = {
    status: [...new Set(mapped.map((row) => row.status))].sort(),
    type: [...new Set(mapped.map((row) => row.type))].sort(),
  };
  const shown = kept.length;
  return {
    rows: rows.kind === "populated" ? { kind: "populated", value: kept } : rows,
    total: read.data.total,
    shown,
    active: mapped.filter((row) => row.activeRegistration).length,
    truncated: read.data.total > shown,
    options,
    filtered: kept.length,
    hiddenByFilters: mapped.length - kept.length,
    terminalUnregistered: read.data.terminalUnregistered?.length ?? 0,
    terminalAdopted: read.data.terminalAdoptions?.length ?? 0,
  };
}

/** One plan row of a workflow detail's plan table. */
/** One lease row of the prototype's Leases card. */
export type WorkflowLeaseRow = {
  planId: string;
  kind: string;
  holder: string;
  worktreePath: string;
  expiresAt: string;
};

export type WorkflowPlanRow = {
  planId: string;
  title: string | null;
  status: string | null;
  statusTone: Tone;
  /** The plan's recorded progress note — never a derived "next step". */
  progress: string | null;
  phase: string | null;
  doneAt: string | null;
  /**
   * The prototype's `Pin` column: the catalog revision this plan is pinned to, or `null`
   * when it is not pinned. It has been on the DTO since the read was written and no row
   * carried it.
   */
  pin: string | null;
};

/** The catalog identity of a workflow, when it has one. */
export type WorkflowCatalog = {
  title: string;
  lifecycle: string;
  /** `rootKind:relativePath` — the same one-cell form the list uses. */
  root: string;
  /** The `documentKind` the catalog row declares, or `null` when it declares none. */
  documentKind: string | null;
  /** The catalog's own revision counter and the two dates it records. */
  revision: number;
  registeredAt: string;
  updatedAt: string;
  /** The row's description, or `null` when it has none. */
  description: string | null;
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
  /** The leases the projection holds across this workflow's plans — the prototype's
   *  Leases card. A plan's lease is what keeps its worktree checked out. */
  leases: readonly WorkflowLeaseRow[];
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
    pin: plan.catalogPinRevision === null ? null : String(plan.catalogPinRevision),
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
  const arm = resolveRecord(read, {
    unavailableReason: "the execution projection for this workflow could not be read",
    requiresProjection: true,
  });
  if (arm.kind !== "populated") return arm;
  const workflow = arm.value;
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
              revision: catalog.revision,
              registeredAt: formatDate(catalog.registeredAt),
              updatedAt: formatDate(catalog.updatedAt),
              description: catalog.description,
              documentKind: catalog.documentKind,
            },
      startedAt: formatDate(workflow.startedAt),
      updatedAt: formatDate(workflow.updatedAt),
      endedAt: workflow.endedAt,
      executionUnavailableReason: executionUnavailableReason(workflow.badges),
      plans: workflow.plans.map(workflowPlanRow),
      // The prototype's Leases card reads across this workflow's plans: a lease belongs
      // to a plan, and the card states which one.
      leases: workflow.plans.flatMap((plan) =>
        plan.leases.map((lease) => ({
          planId: plan.planId,
          kind: lease.kind,
          // A lease row says "not recorded" rather than dropping the column: an
          // empty cell reads as a rendering bug.
          holder: lease.holder ?? "—",
          worktreePath: lease.worktreePath ?? "—",
          expiresAt: lease.expiresAt ?? "—",
        })),
      ),
    },
  };
}
