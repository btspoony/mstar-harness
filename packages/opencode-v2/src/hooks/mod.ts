import { Effect } from "effect";
import type { Scope } from "effect/Scope";
import type { Context } from "@opencode/plugin/effect/plugin";

import { addBootstrapToContext, loadBootstrapContent } from "./bootstrap";
import { defaultStatusLogger } from "../log";
import { dispatchBefore } from "../gates/dispatch";
import type { DispatchGateServices } from "../gates/dispatch";
import { writeBefore } from "../gates/write";


/** Central hook registration seam; task-specific hook registrations extend here.
 * Preloaded bootstrap content is a parameter so the missing-asset warning is
 * reachable from setup without a packaged install. */
export function registerHooks(
  context: Context,
  bootstrap: string | null = loadBootstrapContent(),
): Effect.Effect<void, never, Scope.Scope> {
  if (!bootstrap) {
    // A packaged install always ships AGENTS.md; silence here would disable the
    // harness bootstrap without a trace in the host log.
    defaultStatusLogger(
      "warn",
      "AGENTS.md bootstrap content is missing or empty; the harness rules are not injected into session context. Reinstall @mstar-harness/opencode-v2 (it packs AGENTS.md) or restore the file in the package root.",
    );
  }
  return Effect.asVoid(context.session.hook("context", (event) =>
    Effect.sync(() => addBootstrapToContext(event, bootstrap)),
  ));
}

/** Register the native execute-before refusal hook for named subagent calls. */
export function registerDispatchGate(
  context: Context,
  services: DispatchGateServices = {},
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.asVoid(context.tool.hook("execute.before", (event) => dispatchBefore(event, services)));
}

/** Register structured write/edit validation and the typed authority refusal. */
export function registerWriteGate(context: Context): Effect.Effect<void, never, Scope.Scope> {
  return Effect.asVoid(context.tool.hook("execute.before", (event) => writeBefore(event)));
}
