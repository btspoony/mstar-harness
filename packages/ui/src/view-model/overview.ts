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
 *  - the projection state.
 *
 * Deliberately absent, per IA §8.1: the issue-flow trend (a dated series is a
 * trace, not a state), the identity line's version and `{HARNESS_DIR}`, and every
 * counter (`storeRevision`, `catalogRevision`, `builtAt`, `checkedAt`). The
 * aggregate DTO still carries `issueFlow` — the read model is unchanged — and
 * this module **never reads it**, so no screen can render it by accident.
 */
import type { OverviewRead, ResidualCounts } from "./contracts.ts";
import type { Resolved } from "./state.ts";
import { resolveMember } from "./state.ts";
import { SEVERITIES, gateStepPosition, gateSteps, severityTone, type GateStepId, type GateStepPosition, type Tone } from "./status.ts";
import { projectionState, type ProjectionState } from "./format.ts";
import type { WorkflowRow } from "./workflows.ts";
import { workflowRow, workflowStatusTone } from "./workflows.ts";
import { iterationGateStep } from "./iterations.ts";
import type { IterationGateStep } from "./contracts.ts";

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
export type OverviewModel = {
  workflows: Resolved<readonly OverviewWorkflowRow[]>;
  residuals: Resolved<ResidualModel>;
  milestones: Resolved<readonly MilestoneRow[]>;
  /** `null` when the project has no iteration yet — the `empty` arm. */
  latestIteration: Resolved<OverviewIteration | null>;
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
  read: OverviewRead,
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

  return {
    workflows:
      workflows.kind === "populated"
        ? { kind: "populated", value: workflows.value.items.map(overviewWorkflowRow) }
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
    projection: projectionState(options.projection),
  };
}

/** Compass status → tone, kept local so the overview model owns its own mapping. */
function compassStatusToneOf(status: string | null): Tone {
  return status === "completed" ? "success" : "neutral";
}
