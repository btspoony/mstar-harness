import { Effect } from "effect";
import type { Scope } from "effect/Scope";
import type { Context } from "@opencode/plugin/effect/plugin";

import { addBootstrapToContext, loadBootstrapContent } from "./bootstrap";

/** Central hook registration seam; task-specific hook registrations extend here. */
export function registerHooks(context: Context): Effect.Effect<void, never, Scope.Scope> {
  const bootstrap = loadBootstrapContent();
  return Effect.asVoid(context.session.hook("context", (event) =>
    Effect.sync(() => addBootstrapToContext(event, bootstrap)),
  ));
}
