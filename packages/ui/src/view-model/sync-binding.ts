/**
 * The sync-binding panel's transform: identity, correspondence, readiness.
 *
 * Three answers and no fourth column (`DESIGN.md` § The sync-binding panel):
 *
 *  - which workspace and team this repo's `.mstarc` names, or the reader's
 *    refusal when it names none;
 *  - which local project is which remote project, verbatim from the store;
 *  - whether a sync would work now, and why not.
 *
 * Readiness is the one pair that cannot be split: a state arrives with the
 * cause the read supplied, and a state with no cause is refused rather than
 * rendered — the panel never composes a cause. `not-probed` is a state like the
 * other four and keeps the cause the view already sets, so it stays distinct
 * from a null binding, which is a different answer to a different question.
 *
 * Nothing here reads a credential and the DTO has no field for one.
 */
import type { SyncBindingDTO } from "@mstar-harness/engine";

import type { Resolved } from "./state.ts";
import { resolveRead } from "./state.ts";
import type { Tone } from "./status.ts";

/** The identity block: the declared connection, or the reader's own refusal. */
export type SyncBindingIdentity =
  | { readonly kind: "bound"; readonly enabled: boolean; readonly mode: string; readonly workspace: string; readonly team: string }
  | { readonly kind: "unbound"; readonly message: string };

/**
 * The readiness block: the state with its cause, or the refusal of a state
 * that arrived without one. A refused pair renders no dot and no label.
 */
export type SyncBindingReadiness =
  | { readonly kind: "probed"; readonly state: SyncBindingDTO["readiness"]["state"]; readonly cause: string; readonly tone: Tone }
  | { readonly kind: "refused"; readonly reason: string };

export type SyncBindingModel = {
  readonly identity: SyncBindingIdentity;
  readonly correspondence: Resolved<readonly SyncBindingDTO["projectBindings"][number][]>;
  readonly readiness: SyncBindingReadiness;
};

/**
 * State → tone, in the prototype's own names: `tone-done` for ready,
 * `tone-warning` for both not-yet-answered states, `tone-danger` for a refusal
 * of access, `tone-neutral` for the unasked question.
 */
export function readinessTone(state: string): Tone {
  switch (state) {
    case "ready":
      return "success";
    case "service-absent":
    case "unreachable":
      return "warning";
    case "access-denied":
      return "danger";
    default:
      return "neutral";
  }
}

/** The three display records the screen consumes. */
export function syncBindingModel(data: SyncBindingDTO): SyncBindingModel {
  const identity: SyncBindingIdentity =
    data.binding === null
      ? {
          kind: "unbound",
          // The reader's message, verbatim. The DTO pairs a null binding with it;
          // the transport boundary is where that stops being guaranteed.
          message: data.bindingError ?? "linear.binding-absent: .mstarc declares no [linear] section",
        }
      : { kind: "bound", ...data.binding };

  const { state, cause } = data.readiness;
  const readiness: SyncBindingReadiness =
    cause.trim() === ""
      ? { kind: "refused", reason: `readiness.${state} carries no cause` }
      : { kind: "probed", state, cause, tone: readinessTone(state) };

  // A read that failed is not a store with no rows. `projectBindingsError`
  // travels with the rows so the failure reaches `unavailable` with its own
  // reason instead of being dressed as the `empty` answer.
  const rows: SyncBindingModel["correspondence"] =
    data.projectBindingsError === null
      ? resolveRead(
          { data: data.projectBindings, projection: { generation: null } },
          { whenNull: "empty", isEmpty: (items) => items.length === 0 },
        )
      : { kind: "unavailable", reason: data.projectBindingsError };

  return { identity, correspondence: rows, readiness };
}
