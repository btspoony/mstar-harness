/**
 * `@mstar-harness/ui` — the host-agnostic presentation layer.
 *
 * Consumed as TypeScript source, shipped as type declarations only (plan
 * Technical decisions §1): a JS build would be a second artifact to keep in
 * step with the source both hosts already bundle, and a copied CSS file could
 * drift from the tokens beside it.
 *
 * Task 1 landed the design system (tokens, base layer, scheme contract);
 * Task 2 lands the view-model transforms. Components, screens and the
 * dictionary follow in Tasks 3–5 and are exported from here as they land.
 *
 * The stylesheets are side-effect imports; a host that wants only the tokens
 * may import `@mstar-harness/ui/styles/tokens.css` directly.
 */

import "./styles/tokens.css";
import "./styles/base.css";

export * from "./view-model/contracts.ts";
export * from "./view-model/format.ts";
export * from "./view-model/state.ts";
export * from "./view-model/status.ts";
export * from "./view-model/issues.ts";
export * from "./view-model/workflows.ts";
export * from "./view-model/iterations.ts";
export * from "./view-model/projects.ts";
export * from "./view-model/overview.ts";
export * from "./view-model/focus.ts";

import { TONES, type Tone } from "./view-model/status.ts";

/**
 * The attribute a host sets on the product wrapper to select the value set.
 *
 * There is deliberately no `"system"` arm: `prefers-color-scheme` is a host
 * concern. A host that offers "follow the OS" resolves it itself and sets
 * `"light"` or `"dark"` here (plan Technical decisions §4).
 */
export type MsScheme = "light" | "dark";

/** The attribute name both hosts set, exported so neither re-types the string. */
export const MS_THEME_ATTRIBUTE = "data-ms-theme" as const;

/**
 * The status tone vocabulary, in the order `DESIGN.md` § Status treatments
 * lists it. The values are owned by `view-model/status.ts` so the transform
 * layer and the components cannot disagree about them; re-exported here because
 * `StatusDot` (Task 3) takes one.
 */
export const MS_TONES = TONES;

/** One status tone. */
export type MsTone = Tone;

/**
 * The container name every reflow rule queries, and the layout hook that
 * declares it. Exported so a host adapter cannot invent a second container.
 */
export const MS_CONTAINER_NAME = "pane" as const;

/** The class that declares the named size container (see `base.css`). */
export const MS_CONTAINER_CLASS = "ms-container" as const;
