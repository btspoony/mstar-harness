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
 * Deliberately absent, per IA §8.1: the knowledge rollup, the harness digest
 * beyond the enforcement flag, and every project-scoped panel (residuals,
 * milestones, the trend). The digest the transport supplies still carries
 * `knowledge`; this module never reads it.
 *
 * The progress line is the plan's recorded note — never "the first uncompleted
 * step", because the store carries no checklist (contract §5).
 */
import type { SessionBinding } from "./session.ts";
import type { Resolved } from "./state.ts";
import { resolveSubjectMember } from "./state.ts";
import { bucketPlans, gateStepPosition, gateSteps, planProgress, type GateStepId, type GateStepPosition, type PlanStatusLiteral, type Tone } from "./status.ts";
import type { IterationGateStep } from "@mstar-harness/engine";

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

/** The binding line: bound, unbound, or a selection error with its own repair. */
export type FocusBinding =
  | { kind: "bound"; workflowId: string; dir: string }
  | { kind: "terminal"; workflowId: string; dir: string }
  | { kind: "unbound"; picker: readonly string[] }
  | { kind: "error"; code: string; message: string; candidates: readonly string[] };

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
};

/** Map the host's selection union to the binding line. */
export function focusBinding(selection: SessionBinding | null): FocusBinding {
  if (selection === null) return { kind: "unbound", picker: [] };
  switch (selection.kind) {
    case "active":
      return { kind: "bound", workflowId: selection.workflowId, dir: selection.dir };
    case "terminal":
      return { kind: "terminal", workflowId: selection.workflowId, dir: selection.dir };
    case "error":
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
    | { state: "read"; data: import("@mstar-harness/engine").WorkflowDTO | null }
    | { state: "not-applicable"; reason: string }
    | { state: "unavailable"; reason: string };
  /** The iteration that contains the bound workflow's plans, or `null`. */
  iteration: { iterationId: string; gateStep: IterationGateStep | null } | null;
  phase?: "loading" | "loaded";
}): FocusModel {
  const binding = focusBinding(input.selection);
  // The subject question ("is this session bound at all") is answered by the
  // resolver, not here: `state.ts` owns every absence decision, and an unbound
  // session is `not-applicable` while a bound one whose record vanished is
  // `absent`. Eight screens follow this one, so the decision gets one home.
  const resolvedWorkflow: Resolved<import("@mstar-harness/engine").WorkflowDTO | null> = resolveSubjectMember(
    input.workflow,
    {
      phase: input.phase,
      whenNull: "absent",
      subjectResolves: binding.kind !== "unbound",
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
  };
}
