---
module: @mstar-harness/dsh
date: 2026-09-11
last_updated: 2026-11-09
problem_type: architecture_pattern
category: architecture-patterns
severity: low
plan_id: "20260910-dsh-panel-sidebar"
tags:
  - dsh
  - client-plugin
  - sidebar-right
  - ui-migration
  - narrow-column
status: active
---

# dsh right-sidebar seat migration

## Context

`@deepseek-ai/dsh-client-ui-sidebar-right` (first published `0.1.5-rc.1`) gives dsh client plugins a
docking surface with a **two-stage extension contract**: a plugin registers a static **page-tab type
definition** (`ctx.sidebarRightTabs.register(definition)`) plus **keyed body/title seats**
(`ctx.slots.inject('sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title', () =>
ctx.slots.register({ name, key: <definition id>, … }, Component))`) under the same `id`. This
migrated the MStar workflow panel out of the `conversation.view` view ring (plan
`20260910-dsh-panel-sidebar`).

## Guidance

- **Definition shape (page types)**: `id` (use the package name), `kind` (opened by kind —
  `sidebar://<kind>` is composed only inside the package), `title(address)` thunk; **omit**
  `patterns`/`canOpen`/`priority` for page types; `guide: [{ order, title, description?, icon? }]`
  for a user-facing entry capsule. Every registration sits in its own `ctx.effect` so unload disposes
  it.
- **Guide entry changes the host's default page** (`defaultSeed`): exactly one registered guide entry
  → that page seeds a first-expanded empty pane; zero or **multiple** entries → the guide page seeds.
  Adding a second capsule (files = order 10, ours = order 20) flips the seeded page from files to the
  guide — composition-dependent, accepted deliberately (U6), not hackable around.
- **Chip titles are captured at open time**; a `title` seat is decoration only (glyph + the captured
  title). A live locale-following chip would need its own store-backed registration — not worth it.
- **Bodies are `scope: 'session'`** → they receive the session standard kit (`sessionId`, `useChat`,
  `useSessions` — the kit comes from `ui-session`, `useChat` is merged by `ui-chat`). A docked body
  **unmounts** when another tab in the pane activates; only `tab.visible === false` (collapsed
  column) keeps it mounted-but-hidden → the body's first statement after hooks is
  `if (!tab.visible) return null`, and per-tab UI state must live in a **slot store keyed by
  `tab.id`** (`defineStore` from `dsh-client-store`, passed via the registration's `store` option) or
  it silently resets on every tab switch.
- **Narrow-column IA**: the host's `.paneBody` is a definite-height `overflow: auto` box; the panel
  is a three-zone flex column (nav / ONE scroll body / pinned meta), `container-type: inline-size` +
  `@container` rules (never media queries — the column width is a fraction of the viewport), exactly
  one `overflow-y: auto` element, zero horizontal scrollers, and **no JS layout measurement anywhere**
  (no `ResizeObserver`/`getBoundingClientRect`/…) — the width invariants are pure CSS so the hidden
  state costs nothing.
- **Manifest**: `dsh.client.inject` names the packages whose factories must arrive first; every row
  must be a declared `peerDependencies` entry at the shared caret range. bun resolves
  `^0.1.5-rc.1` to a higher `0.1.5-rc.*` — pin the single-version peer set or the single-version
  spec trips.
- **Testing**: model the seat with a fixture chain `rightbar` → `rightbar.session` → keyed
  `sidebar.right.pane.tab` (+ `.title`) on the real `SlotRegistry`; assert the definition shape, the
  hidden-tab null render, teardown of all four registrations, and a negative (nothing registers into
  the old seat). Browser-side, reuse the rebuilt-bundle harness (`testing-patterns/
  mstar-plugin-browser-harness-verification.md`).
- **Persisted-log identity renames**: when renaming an emitted catalog anchor identity (here
  `mstar-engine-status` → `mstar-engine`), old sessions' logs keep the old rows forever, so the
  compatibility surface must survive somewhere explicit — today the dsh session-format V3→V4
  migration lifts a persisted row to `{ kind: 'plugin:mstar-engine' | 'plugin:mstar-engine-status',
  form: 'catalog' }` and the panel's anchor reader accepts both migrated kinds
  (`packages/dsh/src/types.ts`); unknown identities must degrade to an explicit state, never guessed
  data.

## Why This Matters

The sidebar is now the canonical docking surface for dsh workspace tooling; every future panel
follows this contract. The expensive part (verified against DSH source AND the published tarball —
the dev tree can lag the manifest by whole rc trains) is the contract recon, not the code.

## When To Apply

Any dsh client plugin mounting UI beside the conversation; any migration off
`conversation.view`; any persisted-log anchor identity change.

## Examples

`packages/dsh/src/client/panel/definition.ts` + `src/client/index.ts` (registration), `panel-store.ts`
(keyed section state), `PanelView.tsx` (visible gate + `MstarPanelBodyProps`); tests
`tests/client-seat.spec.ts`, `tests/panel-anchor-contract.spec.ts`.
