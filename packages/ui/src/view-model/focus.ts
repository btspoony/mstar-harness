/**
 * `Focus` — the dsh Sidebar's session landing view model.
 *
 * Fact set, fixed by IA §8.2 (and nothing else):
 *
 *  - the binding line (session id, and the bound workflow's id, kind, phase,
 *    branch chain), or the picker when unbound;
 *  - the plan board grouped by status with `done/total`;
 *  - per `InProgress` plan, its **recorded progress**; the **blocked reason** for
 *    a `Blocked` plan; the `absent` line when neither is recorded;
 *  - the delivery line: the iteration id and its `gateStep` of five, or
 *    `No iteration` when the session's plans are delivered standalone;
 *  - the enforcement flag.
 *
 * Deliberately absent, per IA §8.1: the knowledge rollup and the harness digest
 * beyond the enforcement flag. The digest the transport supplies still carries
 * `knowledge`; this module never reads it.
 *
 * The three project-scoped panels (open residuals, milestones, the latest
 * iteration) ride ONE optional `overview` read (plan
 * the dashboard alignment change, contract C3); the session facts above do
 * not depend on it.
 *
 * The progress line is the plan's recorded note — never "the first uncompleted
 * step", because the store carries no checklist (contract §5).
 */
import type { SessionBinding } from "./session.ts";
import type { Resolved } from "./state.ts";
import { resolveMember, resolveSubjectMember } from "./state.ts";
import { bucketPlans, gateStepPosition, gateSteps, planProgress, type GateStepId, type GateStepPosition, type PlanStatusLiteral, type Tone } from "./status.ts";
import {
  OVERVIEW_MILESTONE_LIMIT,
  milestoneRow,
  overviewIterationOf,
  residualModel,
  type MilestoneRow,
  type OverviewIteration,
  type ResidualModel,
} from "./overview.ts";
import type { IterationGateStep, OverviewDTO, OverviewMember, WorkflowDTO } from "@mstar-harness/engine";

/** The session's delivery position, or the explicit "no iteration" arm. */
export type DeliveryLine =
  | { kind: "iteration"; iterationId: string; gateStep: IterationGateStep | null; position: { step: number; of: 5 } | null; steps: Array<{ step: number; id: GateStepId; position: GateStepPosition }> }
  | { kind: "no-iteration" };

/** One plan on the board. */
export type FocusPlan = {
  planId: string;
  status: string | null;
  statusTone: Tone;
  progress: { done: number; total: number } | null;
  /**
   * The plan's recorded progress note (its next move), or `null` when the store
   * records none — the `absent` arm, never a fabricated step.
   */
  note: string | null;
  /** The recorded blocked reason, only for a `Blocked` plan. */
  blockedReason: string | null;
};

/** One status group of the board. */
export type FocusGroup = {
  status: PlanStatusLiteral;
  count: number;
  plans: readonly FocusPlan[];
};

/**
 * The binding line: bound, unbound, idle, or a selection error with its own repair.
 *
 * `idle` is the NORMAL state of a session between lifecycles. The gate reports it
 * as `workflow.selection.no-active` with a long internal sentence, and that
 * sentence is a host fact, not a product sentence — rendering it turned the whole
 * screen into a paragraph of gate text. The UI says its own calm line instead.
 */
export type FocusBinding =
  | { kind: "bound"; workflowId: string; dir: string }
  | { kind: "terminal"; workflowId: string; dir: string }
  | { kind: "unbound"; picker: readonly string[] }
  | { kind: "idle" }
  | { kind: "error"; code: string; message: string; candidates: readonly string[] };

/** The gate code that means "this session has no active lifecycle": the idle state. */
export const NO_ACTIVE_LIFECYCLE_CODE = "workflow.selection.no-active";

/** The bound workflow's identity line (IA §8.2). */
export type FocusWorkflow = {
  id: string;
  type: string;
  phase: string | null;
  status: string;
  branch: { base: string | null; source: string | null; integration: string | null; target: string | null };
};

/** The session view model. */
export type FocusModel = {
  binding: FocusBinding;
  /** The bound workflow's identity, or `null` when unbound/errored. */
  workflow: Resolved<FocusWorkflow | null>;
  groups: readonly FocusGroup[];
  delivery: DeliveryLine;
  /** The harness enforcement flag — the only digest fact Focus renders. */
  enforcement: string;
  /**
   * The three project-scoped panels (the dashboard alignment change, Task 1),
   * all sourced from ONE `overview` dashboard-view read. `undefined` when the
   * host supplies no overview read — the panels render nothing rather than an
   * arm no transport answered.
   */
  overview?: FocusOverview;
};

/** The overview read as the transport answers it (the workflow member's union). */
export type FocusOverviewInput =
  | { state: "read"; data: OverviewDTO }
  | { state: "not-applicable"; reason: string }
  | { state: "unavailable"; reason: string };

/** The three project-scoped panels, each resolved to its own arm. */
export type FocusOverview = {
  residuals: Resolved<ResidualModel>;
  milestones: Resolved<readonly MilestoneRow[]>;
  /** The project those milestones belong to — the milestones panel's head states it. */
  milestoneProject: string | null;
  latestIteration: Resolved<OverviewIteration | null>;
};

/**
 * Build the three project panels from ONE overview read (contract C3): the
 * engine's members already share one store snapshot, and `state.ts` maps each
 * to its own degrade arm — a failed read degrades these panels only, never the
 * session facts.
 */
/** Re-key a non-populated arm to another value type: the arms carry no data. */
function sameArm<T>(arm: Exclude<Resolved<unknown>, { kind: "populated" }>): Resolved<T> {
  if (arm.kind === "unavailable" || arm.kind === "not-applicable") return { kind: arm.kind, reason: arm.reason };
  return { kind: arm.kind };
}

export function focusOverviewModel(input: FocusOverviewInput, phase: "loading" | "loaded" = "loaded"): FocusOverview {
  // A failed whole-read answer stands in for every member: the arms travel as a
  // value, so the panels degrade without re-deriving anything.
  if (input.state !== "read") {
    // Delegate to the read path with every member carrying the failure: the
    // arms travel as a value, so the panels degrade without re-deriving.
    const member = { state: input.state, reason: input.reason };
    return focusOverviewModel(
      {
        state: "read",
        data: {
          residuals: member as OverviewDTO["residuals"],
          milestones: member as OverviewDTO["milestones"],
          latestIteration: member as OverviewDTO["latestIteration"],
          workflows: member as OverviewDTO["workflows"],
          issueFlow: member as OverviewDTO["issueFlow"],
        } as OverviewDTO,
      },
      phase,
    );
  }
  const read = input.data;
  const residuals = resolveMember(read.residuals, { phase, whenNull: "absent" });
  const milestones = resolveMember(read.milestones, {
    phase,
    whenNull: "absent",
    isEmpty: (milestoneRead) => milestoneRead.milestones.length === 0,
  });
  const latestIteration = resolveMember(read.latestIteration, { phase, whenNull: "empty" });
  return {
    residuals:
      residuals.kind === "populated" ? { kind: "populated", value: residualModel(residuals.value.bySeverity) } : sameArm(residuals),
    milestones:
      milestones.kind === "populated"
        ? { kind: "populated", value: milestones.value.milestones.slice(0, OVERVIEW_MILESTONE_LIMIT).map(milestoneRow) }
        : sameArm(milestones),
    milestoneProject: read.projectId ?? null,
    latestIteration:
      latestIteration.kind === "populated"
        ? { kind: "populated", value: latestIteration.value === null ? null : overviewIterationOf(latestIteration.value) }
        : sameArm(latestIteration),
  };
}

/** Map the host's selection union to the binding line. */
export function focusBinding(selection: SessionBinding | null): FocusBinding {
  if (selection === null) return { kind: "unbound", picker: [] };
  switch (selection.kind) {
    case "active":
      return { kind: "bound", workflowId: selection.workflowId, dir: selection.dir };
    case "terminal":
      return { kind: "terminal", workflowId: selection.workflowId, dir: selection.dir };
    case "error":
      // No active lifecycle is not a failure: it is the ordinary state of a session
      // between lifecycles, and the product owns its copy for it.
      if (selection.code === NO_ACTIVE_LIFECYCLE_CODE) return { kind: "idle" };
      // A multi-active selection error carries the pickable ids; any other error
      // carries none, and the message says why.
      return {
        kind: "error",
        code: selection.code,
        message: selection.message,
        candidates: selection.activeWorkflowIds ?? [],
      };
  }
}

/** Plan status → tone, for the board's dots. */
function planTone(status: string | null): Tone {
  switch (status) {
    case "Done":
      return "success";
    case "Blocked":
      return "warning";
    default:
      return "neutral";
  }
}

/**
 * One plan. `note` and `blockedReason` are the *same* recorded string read under
 * two labels: for `InProgress` it is the next move, for `Blocked` it is why the
 * plan stopped. Neither is ever synthesised from a plan document.
 */
export function focusPlan(plan: { planId: string; status: string | null; progress: string | null }): FocusPlan {
  const recorded = plan.progress === null || plan.progress.trim() === "" ? null : plan.progress;
  return {
    planId: plan.planId,
    status: plan.status,
    statusTone: planTone(plan.status),
    progress: planProgress(null, null),
    note: plan.status === "Blocked" ? null : recorded,
    blockedReason: plan.status === "Blocked" ? recorded : null,
  };
}

/**
 * Build the session model.
 *
 * `workflow` is the bound workflow as an aggregate member, so an unreadable
 * execution projection degrades the board only — the binding line and the
 * enforcement flag still render (IA §5 rule 3).
 */
export function focusModel(input: {
  enforcement: string;
  selection: SessionBinding | null;
  workflow:
    | { state: "read"; data: WorkflowDTO | null }
    | { state: "not-applicable"; reason: string }
    | { state: "unavailable"; reason: string };
  /** The iteration that contains the bound workflow's plans, or `null`. */
  iteration: { iterationId: string; gateStep: IterationGateStep | null } | null;
  /** The shared overview read behind the three project panels, when the host issues one. */
  overview?: FocusOverviewInput;
  overviewPhase?: "loading" | "loaded";
  phase?: "loading" | "loaded";
}): FocusModel {
  const binding = focusBinding(input.selection);
  // The subject question ("is this session bound at all") is answered by the
  // resolver, not here: `state.ts` owns every absence decision, and an unbound
  // session is `not-applicable` while a bound one whose record vanished is
  // `absent`. Eight screens follow this one, so the decision gets one home.
  const resolvedWorkflow: Resolved<WorkflowDTO | null> = resolveSubjectMember(
    input.workflow,
    {
      phase: input.phase,
      whenNull: "absent",
      subjectResolves: binding.kind !== "unbound" && binding.kind !== "idle",
      unresolvedReason: "no active workflow",
    },
  );

  const workflowModel: Resolved<FocusWorkflow | null> =
    resolvedWorkflow.kind === "populated"
      ? {
          kind: "populated",
          value:
            resolvedWorkflow.value === null
              ? null
              : {
                  id: resolvedWorkflow.value.id,
                  type: resolvedWorkflow.value.type,
                  phase: resolvedWorkflow.value.phase,
                  status: resolvedWorkflow.value.status,
                  branch: {
                    base: resolvedWorkflow.value.branch.base,
                    source: resolvedWorkflow.value.branch.source,
                    integration: resolvedWorkflow.value.branch.integration,
                    target: resolvedWorkflow.value.branch.target,
                  },
                },
        }
      : resolvedWorkflow;

  const plans = resolvedWorkflow.kind === "populated" && resolvedWorkflow.value !== null
    ? resolvedWorkflow.value.plans.map((plan) =>
        focusPlan({ planId: plan.planId, status: plan.status, progress: plan.progress }),
      )
    : [];

  const delivery: DeliveryLine =
    input.iteration === null
      ? { kind: "no-iteration" }
      : {
          kind: "iteration",
          iterationId: input.iteration.iterationId,
          gateStep: input.iteration.gateStep,
          position: gateStepPosition(input.iteration.gateStep),
          steps: gateSteps(input.iteration.gateStep),
        };

  return {
    binding,
    workflow: workflowModel,
    groups: bucketPlans(plans).map((group) => ({
      status: group.status,
      count: group.count,
      plans: group.plans,
    })),
    delivery,
    enforcement: input.enforcement,
    ...(input.overview === undefined
      ? {}
      : { overview: focusOverviewModel(input.overview, input.overviewPhase ?? "loaded") }),
  };
}
