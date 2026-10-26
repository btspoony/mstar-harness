/**
 * `Overview` — the project's landing view model.
 *
 * Fact set, fixed by IA §8.2 (and nothing else):
 *
 *  - **all** active workflows, one compact row each (id, kind, phase,
 *    `done/total`, status);
 *  - open residuals by severity: **five rows always**, zeros included, with a
 *    reconciling total;
 *  - **up to three** milestones (status, target, progress, open count);
 *  - the latest iteration (id, compass status, plan count, the five gate steps
 *    with the current one marked);
 *  - the issue-flow series: cumulative captured and retired per dated bucket, the
 *    dated open count beside the store's recorded open, and the undated-event count;
 *  - the projection state.
 *
 * The flow series is mapped, not recomputed: every number comes from
 * `overview.issueFlow` (contract §6), including the "dated history closes at N" gap.
 *
 * Deliberately absent, per IA §8.1: the identity line's version and
 * `{HARNESS_DIR}`, and every counter (`storeRevision`, `catalogRevision`,
 * `builtAt`, `checkedAt`).
 */
import type { IssueFlow, IterationGateStep, OverviewDTO, ResidualCounts } from "@mstar-harness/engine";
import type { Resolved } from "./state.ts";
import { resolveMember } from "./state.ts";
import { SEVERITIES, gateStepPosition, gateSteps, severityTone, type GateStepId, type GateStepPosition, type Tone } from "./status.ts";
import { UNKNOWN_DATE, formatShortDate, projectionState, type ProjectionState } from "./format.ts";
import type { WorkflowRow } from "./workflows.ts";
import { workflowPlanRow, workflowRow, workflowStatusTone, type BranchAnchors } from "./workflows.ts";
import { iterationGateStep } from "./iterations.ts";

/** How many milestones the landing view shows. IA §3.1: up to three. */
export const OVERVIEW_MILESTONE_LIMIT = 3;

/** One severity row of the residual panel. */
export type ResidualRow = {
  severity: string;
  tone: Tone;
  /** Always a number: `0` means the read succeeded and there are none. */
  count: number;
  emphasised: boolean;
};

/** The residual panel: five rows and their reconciling total. */
export type ResidualModel = {
  rows: readonly ResidualRow[];
  /** The total the rows sum to — never a second read. */
  total: number;
};

/**
 * Build the five rows. Every severity is present even at `0`: a panel that hid a
 * zero would make "no critical issues" and "critical not read" look the same.
 */
export function residualModel(bySeverity: ResidualCounts): ResidualModel {
  const rows = SEVERITIES.map((severity) => ({
    severity,
    tone: severityTone(severity),
    count: bySeverity[severity] ?? 0,
    emphasised: severity === "critical" || severity === "high",
  }));
  return { rows, total: rows.reduce((sum, row) => sum + row.count, 0) };
}

/** One dated bucket of the flow series, as the chart and the table read it. */
export type IssueFlowPoint = {
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly captured: number;
  readonly retired: number;
  /** The cumulative open difference at this bucket. */
  readonly open: number;
  readonly origin: string;
};

/** The flow series the trend card draws. Every number is the read's own. */
export type IssueFlowSeries = {
  readonly points: readonly IssueFlowPoint[];
  readonly firstDate: string;
  /**
   * The axis's middle label, or `null` when the series is too short to have a distinct
   * one: with two buckets the prototype's own `floor((n - 1) / 2)` picks the first
   * again, and an axis reading first, first, last states one date twice.
   */
  readonly middleDate: string | null;
  readonly lastDate: string;
  /** What the dated history closes at, beside the store's recorded open count. */
  readonly datedOpen: number;
  readonly recordedOpen: number;
  /** Captures and closures with no usable stored date: counted, never placed. */
  readonly undatedEvents: number;
};

/**
 * Map the read's buckets into the series the card draws, or `null` when there is no
 * series to draw: a line needs two dated buckets, and a one-point line is a dot
 * pretending to be a trend.
 *
 * The guard lives here, not at the call site, so every caller degrades the same way and
 * the lookups below are narrowed by it rather than asserted past it.
 */
export function flowModel(flow: IssueFlow): IssueFlowSeries | null {
  if (flow.buckets.length < 2) return null;
  const points: IssueFlowPoint[] = flow.buckets.map((bucket) => ({
    date: bucket.date,
    captured: bucket.capturedCumulative,
    retired: bucket.retiredCumulative,
    open: bucket.openDifference,
    origin: bucket.origin,
  }));
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  const middle = points[Math.floor((points.length - 1) / 2)];
  return {
    points,
    firstDate: first.date,
    // Below three buckets the middle index is the first one again; the axis drops it.
    middleDate: points.length < 3 || middle === undefined ? null : middle.date,
    lastDate: last.date,
    datedOpen: last.open,
    recordedOpen: flow.currentOpen,
    undatedEvents: flow.unknownCaptureDates + flow.unknownClosureDates,
  };
}

/** One plan under a workflow: what the plan table's five columns read. */
export type OverviewPlanRow = {
  planId: string;
  /** The plan's catalog title, or null when it has no catalog row. */
  title: string | null;
  status: string | null;
  statusTone: Tone;
  phase: string | null;
  /**
   * `3/6` when the store's own progress note IS a fraction, else null.
   *
   * The engine records the note as free text (`coordination.progress.summary`), so a
   * fraction is the one case where a done/total pair is really there to draw. Nothing
   * is invented from `status`: a plan with three of six steps done and no note shows
   * the note's absence, not a bar.
   */
  progress: { done: number; total: number } | null;
  /** The store's note when it is not a fraction: the fact, not a substitute. */
  progressNote: string | null;
  /** The done timestamp, month-day as the prototype prints it (`10-19`). */
  doneAt: string | null;
};

/** One overview workflow: the header line, its branch chain, and its plan table. */
export type OverviewWorkflowRow = {
  id: string;
  type: string;
  phase: string | null;
  status: string;
  statusTone: Tone;
  plansDone: number;
  plansTotal: number;
  /** The four anchors, each `null` when the workflow records none. */
  branch: BranchAnchors;
  /** Every plan the DTO carries, in the store's order. */
  plans: readonly OverviewPlanRow[];
};

/** One milestone row. */
export type MilestoneRow = {
  milestoneId: string;
  name: string;
  status: string | null;
  target: string | null;
  /** `done` of `total`, where done is the resolved count. */
  progress: { done: number; total: number } | null;
  openIssues: number;
};

/** The latest iteration's summary. */
export type OverviewIteration = {
  iterationId: string;
  title: string | null;
  compassStatus: string | null;
  compassTone: Tone;
  planCount: number;
  gateStep: IterationGateStep | null;
  gatePosition: { step: number; of: 5 } | null;
  steps: Array<{ step: number; id: GateStepId; position: GateStepPosition }>;
};

/** The landing view model. */
/**
 * The workflows member, with the truncation fact.
 *
 * The engine caps this member at 50. Mapping straight to rows dropped `total`, so a
 * truncated overview looked like the whole set — the same defect the workflows list
 * avoids by carrying `total` and `truncated` beside its rows.
 */
export type OverviewWorkflows = {
  readonly kind: "populated";
  readonly value: readonly OverviewWorkflowRow[];
  readonly total: number;
  readonly shown: number;
  readonly truncated: boolean;
};

export type OverviewModel = {
  workflows: OverviewWorkflows | Exclude<Resolved<readonly OverviewWorkflowRow[]>, { kind: "populated" }>;
  residuals: Resolved<ResidualModel>;
  milestones: Resolved<readonly MilestoneRow[]>;
  /** `null` when the project has no iteration yet — the `empty` arm. */
  latestIteration: Resolved<OverviewIteration | null>;
  /**
   * The dated history. `empty` when the store has fewer than two dated buckets: a
   * one-point line is a dot pretending to be a trend, so the shared empty arm says so.
   */
  issueFlow: Resolved<IssueFlowSeries>;
  projection: ProjectionState;
};

/** `3/6` from a progress note that is exactly that; `null` for prose or nonsense. */
function planStepProgress(note: string | null): { done: number; total: number } | null {
  const match = note === null ? null : /^(\d{1,4})\/(\d{1,4})$/.exec(note.trim());
  if (match === null) return null;
  const done = Number(match[1]);
  const total = Number(match[2]);
  return total > 0 && done <= total ? { done, total } : null;
}

/** The prototype's Done cell: month-day, with the full timestamp on the title. */
function doneDay(value: string | null): string | null {
  if (value === null) return null;
  const short = formatShortDate(value);
  return short === UNKNOWN_DATE ? null : short.slice(0, 5);
}

/** One plan row from the DTO. */
function overviewPlanRow(plan: Parameters<typeof workflowPlanRow>[0]): OverviewPlanRow {
  const row = workflowPlanRow(plan);
  return {
    planId: row.planId,
    title: row.title,
    status: row.status,
    statusTone: row.statusTone,
    phase: row.phase,
    progress: planStepProgress(row.progress),
    progressNote: planStepProgress(row.progress) === null ? row.progress : null,
    doneAt: doneDay(row.doneAt),
  };
}

/** Compact one workflow: its header facts, its branch chain, and its plans. */
function overviewWorkflowRow(workflow: Parameters<typeof workflowRow>[0]): OverviewWorkflowRow {
  const row: WorkflowRow = workflowRow(workflow);
  return {
    id: row.id,
    type: row.type,
    phase: row.phase,
    status: row.status,
    statusTone: workflowStatusTone(row.status),
    plansDone: row.plansDone,
    plansTotal: row.plansTotal,
    branch: row.branch,
    plans: workflow.plans.map(overviewPlanRow),
  };
}

/** One milestone row; progress is resolved-over-total so `0` is a real zero. */
function milestoneRow(milestone: {
  milestoneId: string;
  name: string;
  status: string | null;
  target: string | null;
  totalIssues: number;
  resolvedIssues: number;
  openIssues: number;
}): MilestoneRow {
  return {
    milestoneId: milestone.milestoneId,
    name: milestone.name,
    status: milestone.status,
    target: milestone.target,
    progress: milestone.totalIssues === 0 ? null : { done: milestone.resolvedIssues, total: milestone.totalIssues },
    openIssues: milestone.openIssues,
  };
}

/**
 * Build the overview model.
 *
 * `phase` is the transport's read phase: while it is `loading` every member
 * resolves to `loading` and none of them claims `empty`.
 */
export function overviewModel(
  read: OverviewDTO,
  options: {
    projection: Parameters<typeof projectionState>[0];
    phase?: "loading" | "loaded";
    milestoneLimit?: number;
  },
): OverviewModel {
  const phase = options.phase ?? "loaded";
  const limit = options.milestoneLimit ?? OVERVIEW_MILESTONE_LIMIT;

  const workflows = resolveMember(read.workflows, {
    phase,
    whenNull: "empty",
    isEmpty: (list) => list.items.length === 0,
  });

  const residuals = resolveMember(read.residuals, { phase, whenNull: "absent" });

  const milestones = resolveMember(read.milestones, {
    phase,
    whenNull: "absent",
    isEmpty: (milestoneRead) => milestoneRead.milestones.length === 0,
  });

  const latestIteration = resolveMember(read.latestIteration, { phase, whenNull: "empty" });

  // No `isEmpty` here: "fewer than two buckets" is `flowModel`'s guard, and a second
  // copy of the rule in this call would be the one that drifts.
  const issueFlow = resolveMember(read.issueFlow, { phase, whenNull: "empty" });

  // The member read succeeded; the mapper decides whether there is a series to draw.
  const flowSeries = issueFlow.kind === "populated" ? flowModel(issueFlow.value) : null;

  return {
    workflows:
      workflows.kind === "populated"
        ? {
            kind: "populated",
            value: workflows.value.items.map(overviewWorkflowRow),
            total: workflows.value.total,
            shown: workflows.value.items.length,
            truncated: workflows.value.total > workflows.value.items.length,
          }
        : workflows,
    residuals:
      residuals.kind === "populated"
        ? { kind: "populated", value: residualModel(residuals.value.bySeverity) }
        : residuals,
    milestones:
      milestones.kind === "populated"
        ? { kind: "populated", value: milestones.value.milestones.slice(0, limit).map(milestoneRow) }
        : milestones,
    latestIteration:
      latestIteration.kind === "populated"
        ? {
            kind: "populated",
            value:
              latestIteration.value === null
                ? null
                : (() => {
                    const iteration = latestIteration.value;
                    const step = iterationGateStep(iteration);
                    return {
                      iterationId: iteration.iterationId,
                      title: iteration.catalog?.title ?? null,
                      compassStatus: iteration.compass?.status ?? null,
                      compassTone: compassStatusToneOf(iteration.compass?.status ?? null),
                      planCount: iteration.plans.length,
                      gateStep: step,
                      gatePosition: gateStepPosition(step),
                      steps: gateSteps(step),
                    } satisfies OverviewIteration;
                  })(),
          }
        : latestIteration,
    issueFlow:
      issueFlow.kind !== "populated"
        ? issueFlow
        : flowSeries === null
          ? { kind: "empty" }
          : { kind: "populated", value: flowSeries },
    projection: projectionState(options.projection),
  };
}

/** Compass status → tone, kept local so the overview model owns its own mapping. */
function compassStatusToneOf(status: string | null): Tone {
  return status === "completed" ? "success" : "neutral";
}
