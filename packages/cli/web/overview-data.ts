/**
 * The host's half of the Overview page: fetch `/api/overview`, hand the envelope
 * to the shared model, and say what happened when it did not answer.
 *
 * Three outcomes, three presentations, and the distinction between them is the
 * whole job — the screen, its fact set and its absence arms are the shared
 * layer's and are not re-derived here:
 *
 *  - **ok** — the envelope is a `ReadEnvelope<OverviewDTO>`; its five members are
 *    `OverviewMember<T>` wrappers the model unwraps. The host unwraps nothing.
 *  - **a degraded member** — one member answers `unavailable` while the other four
 *    are readable. The page still renders; that member shows its own arm with the
 *    store's reason. It must never be drawn as "nothing here".
 *  - **a whole-read failure** — no envelope at all (transport error, timeout,
 *    refused store). There is nothing to render, so the host says so once instead
 *    of mounting a page whose every panel would lie.
 *
 * `issueFlow` arrives on the envelope and is deliberately not passed anywhere: the
 * trend was removed from the product (D30), the shared model ignores it, and this
 * module does not even name it in the model it builds.
 */
import type { OverviewDTO, ReadEnvelope, ReadProjection } from "@mstar-harness/engine";

import { UNREACHABLE, asEnvelope, refusalMessage } from "./read-envelope";
import {
  overviewModel,
  type Copy,
  type OverviewCopy,
  type OverviewModel,
} from "@mstar-harness/ui";

/** What the host knows about the page's read. */
export type OverviewOutcome =
  | { kind: "loading" }
  | { kind: "ready"; model: OverviewModel; revision: number | null }
  | { kind: "failed"; message: string };

/** The path the aggregated read answers on. One read, not five. */
export const OVERVIEW_PATH = "/api/overview";

/**
 * Compose the shared screen's copy contract from one dictionary.
 *
 * The shared package ships the sections; the panel heading and the four absence
 * arms are composition, not translation. This lives here because the shared
 * package's own composition is still in a test (its `copyForScreen` export is
 * pending); when that lands, this collapses to a call.
 */
export function overviewCopy(copy: Copy): OverviewCopy {
  return {
    ...copy.overview,
    workflowsEmpty: copy.overview.workflowsHeading,
    absence: {
      "not-applicable": copy.state["not-applicable"],
      absent: copy.state.absent,
      empty: copy.state.empty,
      unavailable: copy.state.unavailable,
    },
  };
}

/**
 * The model for one envelope.
 *
 * The projection block is the page's only validity disclosure (D28 narrowed by
 * D30): the shared `projectionState` reads it, so the host passes it through and
 * states no version, no `{HARNESS_DIR}` and no counters of its own.
 */
export function overviewFromEnvelope(envelope: ReadEnvelope<OverviewDTO>): OverviewModel {
  return overviewModel(envelope.data, { projection: envelope.projection satisfies ReadProjection });
}

/** Turn a settled read into the page's outcome. An absent envelope is a failure. */
export function overviewOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; envelope: ReadEnvelope<OverviewDTO> }
    | { status: "error"; message: string },
): OverviewOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "ready":
      return {
        kind: "ready",
        model: overviewFromEnvelope(result.envelope),
        revision: result.envelope.projection.generation,
      };
    case "error":
      return { kind: "failed", message: result.message };
  }
}

/**
 * Read the aggregated page.
 *
 * `fetchImpl` is a parameter so the three outcomes are testable without a server
 * and without a DOM; the entry passes the global `fetch`.
 */
export async function readOverview(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<
  | { status: "ready"; envelope: ReadEnvelope<OverviewDTO> }
  | { status: "error"; message: string }
> {
  try {
    const response = await fetchImpl(OVERVIEW_PATH, {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<OverviewDTO>(body);
    if (envelope === null) {
      return { status: "error", message: "The overview read answered with something that is not a read envelope." };
    }
    return { status: "ready", envelope };
  } catch {
    return {
      status: "error",
      message: "The dashboard could not reach its local server. Check that the dashboard is running, then reload.",
    };
  }
}
