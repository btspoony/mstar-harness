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
import { projectionState, type ProjectionState } from "./format.ts";
import type { WorkflowRow } from "./workflows.ts";
import { workflowRow, workflowStatusTone } from "./workflows.ts";
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
  /** The three labels the axis carries: first, middle, last. */
  readonly firstDate: string;
  readonly middleDate: string;
  readonly lastDate: string;
  /** The cumulative totals the legend states — the last bucket's, not a re-sum. */
  readonly capturedTotal: number;
  readonly retiredTotal: number;
  /** What the dated history closes at, beside the store's recorded open count. */
  readonly datedOpen: number;
  readonly recordedOpen: number;
  /** Captures and closures with no usable stored date: counted, never placed. */
  readonly undatedEvents: number;
};

/**
 * Map the read's buckets. The caller guarantees at least two points (a line needs
 * two), so the first/last/middle lookups cannot miss.
 */
export function flowModel(flow: IssueFlow): IssueFlowSeries {
  const points: IssueFlowPoint[] = flow.buckets.map((bucket) => ({
    date: bucket.date,
    captured: bucket.capturedCumulative,
    retired: bucket.retiredCumulative,
    open: bucket.openDifference,
    origin: bucket.origin,
  }));
  const last = points[points.length - 1] as IssueFlowPoint;
  const middle = points[Math.floor((points.length - 1) / 2)] as IssueFlowPoint;
  return {
    points,
    firstDate: points[0]?.date ?? "",
    middleDate: middle.date,
    lastDate: last.date,
    capturedTotal: last.captured,
    retiredTotal: last.retired,
    datedOpen: last.open,
    recordedOpen: flow.currentOpen,
    undatedEvents: flow.unknownCaptureDates + flow.unknownClosureDates,
  };
}

/** One overview workflow row: the compact form of `WorkflowRow`. */
export type OverviewWorkflowRow = {
  id: string;
  type: string;
  phase: string | null;
  status: string;
  statusTone: Tone;
  plansDone: number;
  plansTotal: number;
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

/** Compact one workflow. */
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

  const issueFlow = resolveMember(read.issueFlow, {
    phase,
    whenNull: "empty",
    isEmpty: (flow) => flow.buckets.length < 2,
  });

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
      issueFlow.kind === "populated" ? { kind: "populated", value: flowModel(issueFlow.value) } : issueFlow,
    projection: projectionState(options.projection),
  };
}

/** Compass status → tone, kept local so the overview model owns its own mapping. */
function compassStatusToneOf(status: string | null): Tone {
  return status === "completed" ? "success" : "neutral";
}
