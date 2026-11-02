/**
 * Dev-time ambient declarations for untyped seam packages used by the dsh
 * test suite (no bundled types, no @types/* installed — the packages ship
 * plain JS):
 *
 * - `js-yaml` — used by `bundle-patch.ts` (the `!!js` entry-list dialect of
 *   the shipped cordis patch) and `bundle-layer.spec.ts`.
 * - `react-dom/server` — used by client-panel.spec.tsx
 *   (`renderToStaticMarkup` over the panel view; the `web` profile resolves
 *   the runtime react-dom from the composed app, not this package).
 *
 * Each mirrors only the consumed surface. These are test-only; the package's
 * own src typecheck (dsh tsconfig, `include: ["src"]`) never pulls them in.
 */
declare module 'js-yaml' {
  /** Sentinel a scalar resolver returns when the source does not match its tag. */
  export const NOT_RESOLVED: unique symbol

  export interface ScalarTagOptions<Result> {
    /** Construct the value from the scalar text; `NOT_RESOLVED` when invalid. */
    resolve: (source: string, isExplicit: boolean, tagName: string) => Result | typeof NOT_RESOLVED
    /** Select this tag when dumping a JavaScript value (`() => false` = load-only). */
    identify: (data: unknown) => boolean
  }

  export interface TagDefinition {
    readonly tagName: string
  }

  export class Schema {
    withTags(...tags: Array<TagDefinition | readonly TagDefinition[]>): Schema
  }

  export const JSON_SCHEMA: Schema

  export function defineScalarTag<Result>(
    tagName: string,
    options: ScalarTagOptions<Result>,
  ): TagDefinition

  export interface LoadOptions {
    schema?: Schema
  }

  export function load(input: string, options?: LoadOptions): unknown
}

declare module 'react-dom/server' {
  import type { ReactElement } from 'react'
  export function renderToStaticMarkup(element: ReactElement): string
}
