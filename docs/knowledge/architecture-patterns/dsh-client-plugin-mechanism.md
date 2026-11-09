---
module: dsh-web-client
date: 2026-08-09
last_updated: 2026-11-09
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: "<plan-id>, <plan-id>"
tags:
  - "dsh"
  - "client-plugin"
  - "web-ui"
  - "slots"
  - "bundle"
---

# dsh web client plugin mechanism (external consumer view)

## Context

`@mstar-harness/dsh` ships a **client-side half** — a Morning Star workflow visualization panel in the dsh web UI — alongside its server cordis plugin. Verified against the dsh source snapshot tree (baseline `347a99b` / staging-20260808T163559Z, re-verified on `staging-20260810T165245Z` 2026-08-11) while building the panel. This doc records HOW a dsh web client plugin loads and registers UI, so future client-side work (the zone dashboard, new panel surfaces) starts from verified facts instead of re-deriving them.

## Guidance

**Client rows are discovered, not composed.** The web profile composes server rows; client halves are auto-discovered: `ClientModuleHostService` scans live loader entries (including profile-bundle rows) for a **`dsh.client` declaration** + `exports["./client"]` — the `mstar` bundle row already installed by `@mstar-harness/dsh` carries the client half with **no separate profile row**. The client bundle is served at `/plugins/<id>/client.js?rev=<sha1-12>`.

**Discovery contract is nested and has NO legacy fallback** (verified at `staging-20260810T165245Z`, `packages/client/modules/src/index.ts`): `resolveMeta` reads `pkg.dsh` → `parseDshClient(pkgName, pkg.dsh.client)`. The declaration is the nested object `dsh.client` — a top-level `dshClient` key is silently ignored (`parseDshClient` returns `undefined` for a missing value → the package is not a client row → the panel simply never loads, no error). Field shape: `platform` required string (must be `'web'`), `inject` optional string array, `immediately` optional boolean; malformed (non-object / non-string platform) is a LOUD throw. `exports["./client"]` must also resolve to an existing file — upstream throws when `dsh.client` is declared without the export, and `MissingClientBundleError` when the target file is absent. This contract is pinned by our contract test (see `tooling-decisions/dsh-client-manifest-field-rename.md`).

**Entry shape.** A client plugin mirrors the server function-plugin shape on the client: named `inject` (service names) + `apply(ctx: ClientContext)`. `ClientContext` is the cordis Context merged with client services (`slots`, `sessions`, `locale`, `layout`, …). The bundle must be a **closure-factory CJS** (`window.__ModuleLoader__.load({ id, factory: (require) => … })`), externals kept to platform modules + `react/jsx-runtime`; CSS modules are inlined with `data-plugin` hashing (mirror the snapshot `tsdown.client.ts` recipe).

**UI contribution = slot registry.** `ctx.slots.register({ name, key, locale, store?, inject? }, Component)` — registering into an **undeclared slot throws**, so use a declared slot, and the modern form is `ctx.slots.inject('<slot>', () => ctx.slots.register(...))` so the registration unwinds with your fiber. Since the sidebar migration (plan `<plan-id>`) the session panel is NOT in `conversation.view`: it is a two-stage right-sidebar seat — a page-type definition (`ctx.sidebarRightTabs.register`) plus keyed `sidebar.right.pane.tab` body and `sidebar.right.pane.tab.title` chip registrations under `MSTAR_PANEL_ID`. Registering NOTHING into `conversation.view` is now an asserted contract (`packages/dsh/tests/client-seat.spec.ts`). See `architecture-patterns/dsh-right-sidebar-seat-migration.md`.

**Browser data channel = the host's typert gateway, plus the session log.** The browser cannot read the host filesystem. Two channels exist and the panel now uses the first: the plugin's own `mstarPanelSnapshot` typert invocation over the shared `/api` gateway (`panel-snapshot-client.ts`: one-shot `readDigest`/`readView`, no poll, no subscription), and the session log (`ContextMessageNode` with `form === 'catalog'` + a plugin `source`) that the digest/`engine-status` rows ride. The retired 5-second poll is gone — a mounted seat asks once per session identity and on an explicit `reload()`.

## Why This Matters

Server plugins alone cannot paint UI — the client half is the only way into the web app's panels, and its contract (discovery marker, closure-factory bundle, declared-slot registration, log-message data channel) is strict: wrong bundle format or an undeclared slot fails loudly. The manifest field itself is **upstream-renameable**: `dshClient` → `dsh.client` moved without a compatibility fallback, and the failure was silent (panel missing, no in-loop signal) — any baseline move is a mandatory re-audit of the pinned facts, and the manifest shape must be guarded by a contract test so a rename trips CI before the user's GUI.

## When to Apply

Adding or extending a dsh web client plugin: panel/tab registration, session-log-driven UI, packaging a client half into a profile bundle row. Re-verify each fact against the current dsh source snapshot before relying on it — the snapshot is the contract SSOT, and any upstream baseline move is a re-audit trigger (see the manifest-rename lesson in `tooling-decisions/dsh-client-manifest-field-rename.md`).

## Examples

- `@mstar-harness/dsh`: `dsh.client` + `exports["./client"]` in package.json (migrated from top-level `dshClient` on `staging-20260810T165245Z`); `scripts/build-client-bundle.ts` closure-factory CJS build; `src/client/index.ts` `inject = ['slots','sessions','locale','connection','sidebarRightTabs','theme']` + `ctx.slots.inject('sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title', …)`; `src/client/panel/panel-snapshot-client.ts` reads the digest/view over typert (the `use-mstar-engine-status.ts` catalog tail-scan is deleted).
- Contract pin: `packages/dsh/tests/manifest-contract.spec.ts` (5 assertions — `dsh.client.platform === 'web'`, exact `inject` string array, legacy `dshClient` key absent, `dsh.bundle.patch` untouched, `exports["./client"]` resolves to an existing artifact).
- Install-verification evidence: `dsh plugin --profile web add` → dump-config shows the `mstar` row → web boot graph contains the client entry → `/plugins/@mstar-harness/dsh/client.js` served byte-identical to `dist/client.js` → loader handoff materializes `{inject, apply}` + CSS injection (see iteration package `guides/install-verification.md`).
