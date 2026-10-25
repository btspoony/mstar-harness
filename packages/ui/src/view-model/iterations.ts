/**
 * Iterations list + detail transforms.
 *
 * IA §8.2: the list carries id, compass status, gate step, plan `done/total` and
 * the dates; the detail carries the compass summary, the five gate steps with the
 * current one marked, the dates, the linked workflow and the plan table. The
 * document inventory, the compass milestone-id list and every counter are **not**
 * returned (IA §8.1): documents say nothing about progress, and the roadmap
 * feature already owns milestones.
 *
 * `attribution` (contract §4) is what tells a project feature whether its silence
 * is a fact (`absent`) or a gap (`present` + no rows) — the list model carries
 * both so a scoped screen can pick the right arm without re-deriving it.
 */
import type { IterationDTO, IterationListDTO, IterationPlanDTO } from "@mstar-harness/engine";

import type { IterationAttribution, IterationGateStep } from "./contracts.ts";
import type { Resolved } from "./state.ts";
import { resolveRead } from "./state.ts";
import { compassStatusTone, gateStepPosition, gateSteps, planStatusTone, type GateStepId, type GateStepPosition, type Tone } from "./status.ts";
import { formatDate } from "./format.ts";

/** Plan progress across an iteration's plans. */
function planTally(iteration: IterationDTO): { done: number; total: number } {
  const statuses = iteration.plans.map((plan) => plan.execution?.status ?? null);
  return { done: statuses.filter((status) => status === "Done").length, total: statuses.length };
}

/**
 * The iteration's delivery step, as the store proves it (contract §3).
 *
 * The engine will carry `gateStep` on the DTO; until that member is published
 * this reads it structurally and falls back to `null` (the `absent` arm) rather
 * than deriving a step in the presentation layer — a second derivation is a
 * second truth, and the spec says the store is the only source.
 */
export function iterationGateStep(iteration: IterationDTO): IterationGateStep | null {
  const carried = (iteration as IterationDTO & { gateStep?: IterationGateStep | null }).gateStep;
  if (carried === 1 || carried === 2 || carried === 3 || carried === 4) return carried;
  return null;
}

/** One iteration list row. */
export type IterationRow = {
  iterationId: string;
  title: string | null;
  lifecycle: string | null;
  compassStatus: string | null;
  compassTone: Tone;
  /** The proven step, or `null` when the iteration records no compass. */
  gateStep: IterationGateStep | null;
  /** `step N of 5`, or `null` — never `0 of 5`. */
  gatePosition: { step: number; of: 5 } | null;
  plansDone: number;
  plansTotal: number;
  startedAt: string;
  endedAt: string | null;
};

/** One list row from the DTO. */
export function iterationRow(iteration: IterationDTO): IterationRow {
  const tally = planTally(iteration);
  const step = iterationGateStep(iteration);
  return {
    iterationId: iteration.iterationId,
    title: iteration.catalog?.title ?? null,
    lifecycle: iteration.catalog?.lifecycle ?? null,
    compassStatus: iteration.compass?.status ?? null,
    compassTone: compassStatusTone(iteration.compass?.status ?? null),
    gateStep: step,
    gatePosition: gateStepPosition(step),
    plansDone: tally.done,
    plansTotal: tally.total,
    startedAt: formatDate(iteration.compass?.startedAt ?? null),
    endedAt: iteration.compass?.endedAt ?? null,
  };
}

/**
 * The list state.
 *
 * A catalog-driven list does not empty when the projection is unavailable — it
 * only loses its execution overlay — so this resolves the rows and reports the
 * attribution separately instead of promoting the whole list to `unavailable`.
 */
export type IterationListModel = {
  rows: Resolved<readonly IterationRow[]>;
  total: number;
  /** Whether this store attributes any iteration to a project (contract §4). */
  attribution: IterationAttribution;
};

export function iterationListModel(read: {
  data: IterationListDTO;
  projection: { generation: number | null };
}): IterationListModel {
  const readAttribution = (read.data as IterationListDTO & { attribution?: IterationAttribution }).attribution;
  const attribution: IterationAttribution = readAttribution === "absent" ? "absent" : "present";
  // Zero rows mean different things depending on attribution (contract §4): a
  // store that attributes no iteration to any project answers `absent` — the
  // project's silence is a fact about the store — while an attributing store
  // with no scoped rows answers `empty`.
  const projectionUnavailable = read.projection.generation === null;
  const rows: Resolved<readonly IterationRow[]> = projectionUnavailable
    ? { kind: "unavailable", reason: "the execution projection has no valid generation" }
    : read.data.items.length === 0
      ? { kind: attribution === "absent" ? "absent" : "empty" }
      : { kind: "populated", value: read.data.items.map(iterationRow) };
  return { rows, total: read.data.total, attribution };
}

/** One plan row of an iteration detail's plan table. */
export type IterationPlanRow = {
  planId: string;
  title: string | null;
  status: string | null;
  statusTone: Tone;
  progress: string | null;
  phase: string | null;
  doneAt: string | null;
};

/** One plan row; a plan with no execution row is `not started`, not an error. */
export function iterationPlanRow(plan: IterationPlanDTO): IterationPlanRow {
  return {
    planId: plan.planId,
    title: plan.catalog?.title ?? null,
    status: plan.execution?.status ?? null,
    statusTone: planStatusTone(plan.execution?.status ?? ""),
    progress: plan.execution?.progress ?? null,
    phase: plan.execution?.phase ?? null,
    doneAt: plan.execution?.doneAt ?? null,
  };
}

/** The detail model. */
export type IterationDetailModel = {
  iterationId: string;
  title: string | null;
  lifecycle: string | null;
  compassStatus: string | null;
  compassTone: Tone;
  /** The compass's one-line summary, or `null` when it records none. */
  summary: string | null;
  steps: Array<{ step: number; id: GateStepId; position: GateStepPosition }>;
  gateStep: IterationGateStep | null;
  /** `step N of 5`, or `null` — never `0 of 5` (contract §3). */
  gatePosition: { step: number; of: 5 } | null;
  startedAt: string;
  endedAt: string | null;
  /** The linked workflow's id, or `null` when the iteration has no execution row. */
  workflowId: string | null;
  plans: readonly IterationPlanRow[];
};

/**
 * The detail's arms. An iteration with no compass row is `absent` — it declares
 * no delivery position — and that is a different page from an iteration whose
 * record could not be read at all.
 */
export function iterationDetailModel(read: {
  data: IterationDTO | null;
  projection: { generation: number | null };
}): Resolved<IterationDetailModel> {
  if (read.projection.generation === null) {
    return { kind: "unavailable", reason: "the execution projection for this iteration could not be read" };
  }
  if (read.data === null) return { kind: "absent" };
  const iteration = read.data;
  const step = iterationGateStep(iteration);
  return {
    kind: "populated",
    value: {
      iterationId: iteration.iterationId,
      title: iteration.catalog?.title ?? null,
      lifecycle: iteration.catalog?.lifecycle ?? null,
      compassStatus: iteration.compass?.status ?? null,
      compassTone: compassStatusTone(iteration.compass?.status ?? null),
      summary: iteration.compass?.summary ?? null,
      steps: gateSteps(step),
      gateStep: step,
      gatePosition: gateStepPosition(step),
      startedAt: formatDate(iteration.compass?.startedAt ?? null),
      endedAt: iteration.compass?.endedAt ?? null,
      workflowId: iteration.workflow?.id ?? null,
      plans: iteration.plans.map(iterationPlanRow),
    },
  };
}
