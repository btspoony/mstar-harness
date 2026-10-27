/**
 * The host's half of the Iterations pair.
 *
 * Three facts belong to this pair specifically, and the host must not flatten any
 * of them:
 *
 *  - **Two empty states, one boolean-shaped input.** The list's `attribution` arm
 *    decides which absence a project-scoped read lands in: `present` with no rows
 *    means *this project has none* (`empty`), `absent` with no rows means *no
 *    project is attributed* (`not-applicable`-style `absent`). The host passes the
 *    DTO through; `iterationListModel` owns the arm.
 *  - **The gate is a position, never a count.** The shared screen marks one of four
 *    reachable steps and names the fifth without ever marking it. The host renders
 *    no violation count and no "step 5 current".
 *  - **A `null` payload with a published generation is `absent`**, while a `null`
 *    payload with no generation is `unavailable` — the same distinction the
 *    Workflows pair pinned, expressed through the same `ABSENT_PROJECTION`.
 */
import type { IterationDTO, IterationListDTO, ReadEnvelope } from "@mstar-harness/engine";

import { UNREACHABLE, asEnvelope, readAllListPages, refusalMessage } from "./read-envelope";
import {
  iterationDetailModel,
  iterationListModel,
  type Copy,
  type IterationDetailCopy,
  type IterationDetailModel,
  type IterationFilters,
  type IterationListModel,
  type IterationsCopy,
  type Resolved,
} from "@mstar-harness/ui";

import { ABSENT_PROJECTION } from "./absent-projection";

/** Where the pair answers. `project` scopes the list; the host supplies it. */
export function iterationsPath(projectId: string | null, offset = 0): string {
  const params = new URLSearchParams({ limit: "200", offset: String(offset) });
  if (projectId !== null) params.set("project", projectId);
  return `/api/iterations?${params.toString()}`;
}

export function iterationDetailPath(id: string): string {
  return `/api/iterations/${encodeURIComponent(id)}`;
}

/**
 * The list screen's copy: the dictionary's own words plus the two absence arms and
 * the one label it does not carry, whose headings are the page title.
 */
export function iterationsCopy(copy: Copy): IterationsCopy {
  return {
    ...copy.iterations,
    notStarted: copy.iterationDetail.fields.notStarted,
    empty: { ...copy.state.empty, heading: copy.iterations.pageTitle },
    absent: { ...copy.state.absent, heading: copy.iterations.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.iterations.pageTitle },
  };
}

/** The detail screen's copy: complete in the dictionary except its two absence arms. */
export function iterationDetailCopy(copy: Copy): IterationDetailCopy {
  return {
    ...copy.iterationDetail,
    unavailable: { ...copy.state.unavailable, heading: copy.iterationDetail.compassHeading },
    absent: { ...copy.state.absent, heading: copy.iterationDetail.compassHeading },
  };
}

/** What the list is handed. */
export type IterationsOutcome =
  | { kind: "loading" }
  | { kind: "ready"; model: IterationListModel }
  | { kind: "failed"; message: string };

/** What the detail is handed. */
export type IterationDetailOutcome =
  | { kind: "loading" }
  | { kind: "ready"; model: Resolved<IterationDetailModel> }
  | { kind: "failed"; message: string };

/** One list read. `projectId` comes from the route, never from the address bar twice. */
export async function readIterations(
  fetchImpl: typeof fetch,
  projectId: string | null,
  signal?: AbortSignal,
): Promise<
  { status: "ready"; envelope: ReadEnvelope<IterationListDTO> } | { status: "error"; message: string }
> {
  return readAllListPages<IterationListDTO>(
    fetchImpl,
    (offset) => iterationsPath(projectId, offset),
    signal,
  );
}

/** One record read. A `null` payload stays inside its envelope for the model to judge. */
export async function readIterationDetail(
  fetchImpl: typeof fetch,
  id: string,
  signal?: AbortSignal,
): Promise<
  | { status: "ready"; envelope: ReadEnvelope<IterationDTO> }
  | { status: "absent" }
  | { status: "error"; message: string }
> {
  try {
    const response = await fetchImpl(iterationDetailPath(id), {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 404) return { status: "absent" };
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<IterationDTO>(body);
    if (envelope === null) {
      return { status: "error", message: "The iteration read answered with something that is not a read envelope." };
    }
    return { status: "ready", envelope };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}

/** The list outcome for a settled read. */
export function iterationsOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; envelope: ReadEnvelope<IterationListDTO> }
    | { status: "error"; message: string },
  /** The list's filter state; the model applies it, so a change re-derives the rows. */
  filters?: IterationFilters,
): IterationsOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "ready":
      return {
        kind: "ready",
        model: iterationListModel({ data: result.envelope.data, projection: result.envelope.projection, filters }),
      };
    case "error":
      return { kind: "failed", message: result.message };
  }
}

/** The detail outcome for a settled read. */
export function iterationDetailOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; envelope: ReadEnvelope<IterationDTO> }
    | { status: "absent" }
    | { status: "error"; message: string },
): IterationDetailOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "absent":
      // The same constant every detail pair uses: a published generation with a
      // null payload is the `absent` arm, not an unreadable one.
      return { kind: "ready", model: iterationDetailModel({ data: null, projection: ABSENT_PROJECTION }) };
    case "ready":
      return {
        kind: "ready",
        model: iterationDetailModel({ data: result.envelope.data, projection: result.envelope.projection }),
      };
    case "error":
      return { kind: "failed", message: result.message };
  }
}
