/**
 * Dev-time ambient declarations for untyped seam packages used by the dsh
 * test suite (no bundled types, no @types/* installed — the packages ship
 * plain JS):
 *
 * - `js-yaml` — used by bundle-layer.spec.ts (`load` of the cordis patch).
 * - `react-dom/server` — used by client-panel.spec.tsx
 *   (`renderToStaticMarkup` over the panel view; the `web` profile resolves
 *   the runtime react-dom from the composed app, not this package).
 *
 * Each mirrors only the consumed surface. These are test-only; the package's
 * own src typecheck (dsh tsconfig, `include: ["src"]`) never pulls them in.
 */
declare module 'js-yaml' {
  export function load(input: string): unknown
}

declare module 'react-dom/server' {
  import type { ReactElement } from 'react'
  export function renderToStaticMarkup(element: ReactElement): string
}
