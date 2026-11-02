/**
 * The host's half of the sync-binding screen.
 *
 * One read, one envelope, no host-supplied probe: the dashboard is the host, and
 * it has no Linear probe result to attach, so readiness arrives honestly as
 * `not-probed` with the cause the engine sets. Sending a state we did not observe
 * would be the one thing this panel refuses to do.
 */
import type { ReadEnvelope, SyncBindingDTO } from "@mstar-harness/engine";
import { syncBindingModel, type Copy, type SyncBindingCopy, type SyncBindingModel } from "@mstar-harness/ui";

import { UNREACHABLE, asEnvelope, refusalMessage } from "./read-envelope";

/** Where the read answers. */
export const SYNC_BINDING_PATH = "/api/sync-binding";

/** The screen's copy: the dictionary's own words plus the shared absence families. */
export function syncBindingCopy(copy: Copy): SyncBindingCopy {
  return { ...copy.syncBinding, state: copy.state };
}

/** What the screen is handed. */
export type SyncBindingOutcome =
  | { kind: "loading" }
  | { kind: "ready"; model: SyncBindingModel }
  | { kind: "failed"; message: string };

/** One read of the binding view. */
export async function readSyncBinding(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ status: "ready"; envelope: ReadEnvelope<SyncBindingDTO> } | { status: "error"; message: string }> {
  try {
    const response = await fetchImpl(SYNC_BINDING_PATH, {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<SyncBindingDTO>(body);
    if (envelope === null) {
      return { status: "error", message: "The binding read answered with something that is not a read envelope." };
    }
    return { status: "ready", envelope };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}

/** The outcome for a settled read. */
export function syncBindingOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; envelope: ReadEnvelope<SyncBindingDTO> }
    | { status: "error"; message: string },
): SyncBindingOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "ready":
      return { kind: "ready", model: syncBindingModel(result.envelope.data) };
    case "error":
      return { kind: "failed", message: result.message };
  }
}
