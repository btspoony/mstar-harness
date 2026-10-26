/**
 * Iterations list + detail transforms.
 *
 * IA §8.2: the list carries id, compass status, gate step, plan `done/total` and
 * the dates; the detail carries the compass summary, the five gate steps with the
 * current one marked, the dates, the linked workflow, the plan table **and the
 * document inventory**.
 *
 * The inventory is returned because the prototype's detail screen has a Documents
 * card, and the prototype is this interface's acceptance criterion. IA §8.1 had
 * excluded it ("documents say nothing about progress"); that reasoning stands, but it
 * describes a different goal — a progress view — not this one. The compass
 * milestone-id list and the counters stay out: the Screen has no place for them.
 *
 * `attribution` (contract §4) is what tells a project feature whether its silence
 * is a fact (`absent`) or a gap (`present` + no rows) — the list model carries
 * both so a scoped screen can pick the right arm without re-deriving it.
 */
import type {
  IterationDTO,
  IterationGateStep,
  IterationListDTO,
  IterationPlanDTO,
} from "@mstar-harness/engine";

import type { Resolved } from "./state.ts";
import { resolveRead, resolveRecord } from "./state.ts";
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
 * It is the engine's own member — plain property access, no shape check. The
 * presentation layer never derives a step: a second derivation would be a second
 * truth, and the spec says the store is the only source.
 */
export function iterationGateStep(iteration: IterationDTO): IterationGateStep | null {
  return iteration.gateStep;
}

/** One iteration list row. */
export type IterationRow = {
  iterationId: string;
  title: string | null;
  lifecycle: string | null;
  compassStatus: string | null;
  compassTone: Tone;
  /** The execution the projection records for this iteration: `status · phase`, the
   *  prototype's `Projected execution` column. `null` when no workflow is registered. */
  execution: string | null;
  /** The proven step, or `null` when the iteration records no compass. */
  gateStep: IterationGateStep | null;
  /** `step N of 5`, or `null` — never `0 of 5`. */
  gatePosition: { step: number; of: 5 } | null;
  plansDone: number;
  plansTotal: number;
  /** How many documents the catalog links to this iteration. The prototype's list has
   *  this column beside `Plans`; the count comes from the same `documents` array the
   *  detail screen's inventory renders. */
  documents: number;
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
    execution:
      iteration.workflow === null
        ? null
        : iteration.workflow.phase === null
          ? iteration.workflow.status
          : `${iteration.workflow.status} · ${iteration.workflow.phase}`,
    gateStep: step,
    gatePosition: gateStepPosition(step),
    plansDone: tally.done,
    plansTotal: tally.total,
    documents: iteration.documents.length,
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
/** The filters the iteration list offers, mirroring the prototype's row. */
export type IterationFilters = { lifecycle: string; q: string };

export const DEFAULT_ITERATION_FILTERS: IterationFilters = { lifecycle: "", q: "" };

export type IterationListModel = {
  rows: Resolved<readonly IterationRow[]>;
  total: number;
  /** Whether this store attributes any iteration to a project (contract §4). */
  attribution: IterationListDTO["attribution"];
  /** The lifecycle values the current rows carry, for the select. */
  lifecycles: readonly string[];
  /** How many rows the filters leave. */
  filtered: number;
};

export function iterationListModel(read: {
  data: IterationListDTO;
  projection: { generation: number | null };
  filters?: IterationFilters;
}): IterationListModel {
  const attribution: IterationListDTO["attribution"] = read.data.attribution;
  // Zero rows mean different things depending on attribution (contract §4): a
  // store that attributes no iteration to any project answers `absent` — the
  // project's silence is a fact about the store — while an attributing store with
  // no scoped rows answers `empty`. The resolver owns the arm; `attribution` is
  // the domain judgement that picks it.
  const resolved = resolveRead(read, {
    whenNull: "empty",
    isEmpty: (list) => list.items.length === 0,
    whenEmpty: attribution === "absent" ? "absent" : "empty",
    // Iteration rows and their compass come from the execution projection.
    requiresProjection: true,
  });
  const mapped = resolved.kind === "populated" ? resolved.value.items.map(iterationRow) : [];
  const filters = read.filters ?? DEFAULT_ITERATION_FILTERS;
  const q = filters.q.trim().toLowerCase();
  const kept = mapped.filter(
    (row) =>
      (filters.lifecycle === "" || row.lifecycle === filters.lifecycle) &&
      (q === "" || row.iterationId.toLowerCase().includes(q) || (row.title ?? "").toLowerCase().includes(q)),
  );
  const rows: Resolved<readonly IterationRow[]> =
    resolved.kind === "populated" ? { kind: "populated", value: kept } : resolved;
  return {
    rows,
    total: read.data.total,
    attribution,
    lifecycles: [...new Set(mapped.map((row) => row.lifecycle).filter((v): v is string => v !== null))].sort(),
    filtered: kept.length,
  };
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
/** One row of the prototype's Documents card. */
export type IterationDocumentRow = {
  title: string;
  lifecycle: string;
  documentKind: string;
  location: string;
  revision: string;
};

export type IterationDetailModel = {
  iterationId: string;
  /** The catalog's document inventory, for the prototype's Documents card. */
  documents: readonly IterationDocumentRow[];
  title: string | null;
  lifecycle: string | null;
  compassStatus: string | null;
  compassTone: Tone;
  /** The compass's one-line summary, or `null` when it records none. */
  summary: string | null;
  /** The compass's own milestones — the prototype's `mini-table` in the Compass panel. */
  compassMilestones: ReadonlyArray<{ milestone: string; target: string; status: string }>;
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
  const arm = resolveRecord(read, {
    unavailableReason: "the execution projection for this iteration could not be read",
    requiresProjection: true,
  });
  if (arm.kind !== "populated") return arm;
  const iteration = arm.value;
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
      compassMilestones: (iteration.compass?.milestones ?? []).map((milestone) => ({
        milestone: milestone.milestone,
        target: milestone.target ?? "—",
        status: milestone.status ?? "—",
      })),
      steps: gateSteps(step),
      gateStep: step,
      gatePosition: gateStepPosition(step),
      startedAt: formatDate(iteration.compass?.startedAt ?? null),
      endedAt: iteration.compass?.endedAt ?? null,
      workflowId: iteration.workflow?.id ?? null,
      plans: iteration.plans.map(iterationPlanRow),
      documents: iteration.documents.map((doc) => ({
        title: doc.title ?? doc.relativePath,
        lifecycle: doc.lifecycle ?? "—",
        documentKind: doc.documentKind ?? "—",
        location: `${doc.rootKind}:${doc.relativePath}`,
        revision: String(doc.revision),
      })),
    },
  };
}
