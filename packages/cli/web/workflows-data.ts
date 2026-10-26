/**
 * The host's half of the Workflows pair.
 *
 * Same discipline as the Issues pair: fetch, validate the envelope, hand it to the
 * shared model, keep the outcomes apart. Two things are specific to this pair:
 *
 *  - **The list's truncation is disclosed from `total`, never from the item
 *    count.** The host passes the DTO through; `workflowListModel` compares the
 *    store's count against the rows it actually got.
 *  - **A workflow detail whose execution projection has no generation is NOT a
 *    missing record.** The server answers `200` with a `null` payload and a
 *    projection of `generation: null` precisely so the view can say "execution
 *    unavailable" instead of claiming the workflow does not exist. The host
 *    therefore hands that envelope on untouched: `data === null` with no generation
 *    is `unavailable`; `data === null` with a published generation is `absent`.
 *    Collapsing the two would turn a degradation into a 404.
 */
import type { ReadEnvelope, WorkflowDTO, WorkflowListDTO } from "@mstar-harness/engine";

import { UNREACHABLE, asEnvelope, refusalMessage } from "./read-envelope";

import { ABSENT_PROJECTION } from "./absent-projection";
import {
  workflowDetailModel,
  workflowListModel,
  type Copy,
  type WorkflowDetailCopy,
  type WorkflowFilters,
  type WorkflowListModel,
  type WorkflowDetailModel,
  type WorkflowsCopy,
  type Resolved,
} from "@mstar-harness/ui";

/** Where the pair answers. */
export const WORKFLOWS_PATH = "/api/workflows";

export function workflowDetailPath(id: string): string {
  return `/api/workflows/${encodeURIComponent(id)}`;
}

/**
 * The list screen's copy: the catalogue's own words plus the three absence arms,
 * whose headings are the page title. The detail's is complete in the dictionary.
 */
export function workflowsCopy(copy: Copy): WorkflowsCopy {
  return {
    ...copy.workflows,
    empty: { ...copy.state.empty, heading: copy.workflows.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.workflows.pageTitle },
    absent: { ...copy.state.absent, heading: copy.workflows.pageTitle },
  };
}

export function workflowDetailCopy(copy: Copy): WorkflowDetailCopy {
  return copy.workflowDetail;
}

/** What the list is handed. */
export type WorkflowsOutcome =
  | { kind: "loading" }
  | { kind: "ready"; model: WorkflowListModel }
  | { kind: "failed"; message: string };

/** What the detail is handed. */
export type WorkflowDetailOutcome =
  | { kind: "loading" }
  | { kind: "ready"; model: Resolved<WorkflowDetailModel> }
  | { kind: "failed"; message: string };

/** One list read. */
export async function readWorkflows(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ status: "ready"; envelope: ReadEnvelope<WorkflowListDTO> } | { status: "error"; message: string }> {
  try {
    const response = await fetchImpl(WORKFLOWS_PATH, {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<WorkflowListDTO>(body);
    if (envelope === null) return { status: "error", message: "The workflow list answered with something that is not a read envelope." };
    return { status: "ready", envelope };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}

/**
 * One record read.
 *
 * A `null` payload is passed on inside its envelope: only the projection decides
 * whether that is "unavailable" or "absent", and only the shared model decides it.
 */
export async function readWorkflowDetail(
  fetchImpl: typeof fetch,
  id: string,
  signal?: AbortSignal,
): Promise<
  | { status: "ready"; envelope: ReadEnvelope<WorkflowDTO> }
  | { status: "absent" }
  | { status: "error"; message: string }
> {
  try {
    const response = await fetchImpl(workflowDetailPath(id), {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    // The server answers 404 only when there is no such record — a workflow whose
    // projection is unreadable comes back as 200 with a null payload instead, so
    // it reaches the model as `unavailable` and is never confused with this.
    if (response.status === 404) return { status: "absent" };
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<WorkflowDTO>(body);
    if (envelope === null) return { status: "error", message: "The workflow read answered with something that is not a read envelope." };
    return { status: "ready", envelope };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}

/** The list outcome for a settled read. */
export function workflowsOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; envelope: ReadEnvelope<WorkflowListDTO> }
    | { status: "error"; message: string },
  /** The list's filter state; the model applies it, so a change re-derives the rows. */
  filters?: WorkflowFilters,
): WorkflowsOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "ready":
      return {
        kind: "ready",
        model: workflowListModel({
          data: result.envelope.data,
          projection: result.envelope.projection,
          filters,
        }),
      };
    case "error":
      return { kind: "failed", message: result.message };
  }
}

/** The detail outcome for a settled read. */
export function workflowDetailOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; envelope: ReadEnvelope<WorkflowDTO> }
    | { status: "absent" }
    | { status: "error"; message: string },
): WorkflowDetailOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "absent":
      // No envelope exists for a record that is not there; the model still needs a
      // `read`, so the shared constant supplies the published generation, and the
      // resolver turns the null payload into the `absent` arm.
      return { kind: "ready", model: workflowDetailModel({ data: null, projection: ABSENT_PROJECTION }) };
    case "ready":
      return {
        kind: "ready",
        model: workflowDetailModel({
          data: result.envelope.data,
          projection: result.envelope.projection,
        }),
      };
    case "error":
      return { kind: "failed", message: result.message };
  }
}
