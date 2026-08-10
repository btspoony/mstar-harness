# bundle/ — mstar profile-bundle layer for dsh

`@mstar-harness/dsh` doubles as a dsh **profile bundle**: its package.json
declares `"dsh": { "bundle": { "patch": "./bundle/cordis.patch.yml" } }`,
making it an installable patch layer for `dsh --profile` compositions
(dsh-bundle contract; see dsh-private `packages/bundle/README.md`). The
substance of this bundle is the patch list in
[`cordis.patch.yml`](cordis.patch.yml) — one `insert` of the `mstar` plugin
row over the dsh-base layer.

## Install

Two profile-bundle install forms into the shipped `web` profile
(`dsh plugin --profile web add <spec>`; `dsh web` boots it):

Local checkout install (local-only — no npm publish yet):

```sh
cd <repo>/packages/dsh
dsh plugin --profile web add .
```

Repo URL install (the git repo hosting the package, pnpm `path:` spec selecting the monorepo subdirectory):

```sh
dsh plugin --profile web add git+https://github.com/dsh-external/mstar-workflow.git#path:/packages/dsh
```

`dsh plugin --profile <name> add <spec>` initializes the profile on first use
(`web` starts from the shipped template: `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-web-app`), forwards `<spec>` to pnpm in the profile
directory, and reconciles the profile's `dsh.profile.bundles` layer list from
the installed state: any dependency whose package.json declares `dsh.bundle`
joins the layer stack. Relative specs (`.`, and `file:`/`link:` forms) anchor
to the invoking directory, so `add .` must run from the package checkout.
pnpm must be on PATH. Git-hosted specs build on install via the package
`prepare` script (`bun run build` → `dist/`), which pnpm ≥10 blocks until
allowed — the first `add` fails with pnpm's `allowBuilds` hint; add the
printed key under `allowBuilds` in the profile's `pnpm-workspace.yaml`, then
re-run.

Bundle resolution is two-anchored: a bundle name resolves from the dsh
installation first, then from the profile directory. During local
development `@mstar-harness/dsh` is not installed into the dsh installation,
so the profile-local copy installed by `add` is the one mounted.

## Layer position

`dsh.profile.bundles` applies in list order over the profile's empty root
config:

1. `@deepseek-ai/dsh-base` — the shared dsh core.
2. `@deepseek-ai/dsh-web-app` — the shipped web app layer (the `web` profile
   template the install targets; absent from a hand-made profile).
3. This bundle — inserts the `mstar` plugin row (`id: mstar`,
   `name: @mstar-harness/dsh`).
4. The profile's own `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`
   (the home-level layer outranks the per-profile layer).

Patches are id-targeted and the last write wins per row. **A patch replaces
the targeted row's whole `config` — no deep merge** — so a user-level
override must restate every field it keeps (the dsh-bundle whole-row-config
semantics, not a merge).

## Config surface

The `mstar` row accepts the plugin `Config` (see `src/index.ts`):

| Field | Shipped default | Meaning |
|---|---|---|
| `harnessDir` | unset (resolved per session workspace) | explicit `{HARNESS_DIR}` root — **required for repos whose harness root is not a probed name** (`.mstar/` → `.agents/` → `.plans/` → `plans/`): e.g. the mstar-workflow maintenance repo itself uses `.harness/` (deliberately not probed), so set `harnessDir: <repo>/.harness` in the profile layer. Without the config the probe starts from the SESSION workspace root (the session cwd — **never the process/launch cwd**) and may walk up to a global `~/.mstar` or an unrelated `.agents/` |
| `enforcement` | **unset — default OFF** | `hard` / `soft` override; absent → the iteration compass decides, warn-only when no compass hardens (never a global always-on hard gate) |
| `dispatchTools` | unset (plugin default `['subagent']`) | delegation tool names the dispatch gate matches |
| `dispatchBinding` | unset | the dispatching agent's role for the anti-recursion precheck |
| `skillRoots` | unset | additional skill roots (custom mirrors) |
| `bundledSkillDir` | unset → plugin resolves its OWN packaged `harness-skills/` mirror package-relative | bundled skill mount — the repo-root `skills/` mirror synced by `bundle-assets` at build/postinstall (gitignored), resolved package-relative (NOT cwd-anchored). An explicit value wins; a RELATIVE override stays cwd-anchored, so pass an absolute path in the profile layer |
| `catalogTtlMs` | unset → `60000` | pre-step catalog cache refresh interval (ms) — how often the per-workspace unified `mstar-engine-status` catalog row (watermark + iteration gate + workspace-state digest) re-reads `status.json` / the compass / the knowledge index; the hot path is a timestamp compare + cache hit between refreshes |

## Client half (workflow panel)

The same bundle row carries a browser client half for the dsh **web** profile:
`dshClient` (`platform: 'web'`, declared inject faces) + `exports["./client"]`
(`dist/client.js`) in package.json. The `ClientModuleHostService` discovers it
automatically on the **already-installed `mstar` bundle row** — no separate
profile layer, no second install step (spec §6.1; mechanism-guide §1.1). At
boot the web app serves the closure-factory CJS bundle at
`/plugins/@mstar-harness/dsh/client.js` (rev = content sha1) and loads it via
`window.__ModuleLoader__.load({ id, factory })`.

The client entry registers a `conversation.view` view-ring tab
(`id: 'mstar-workflow'`, `order: 20`), labeled **"MStar 工作流" / "MStar
Workflow"**, rendering the latest `mstar-engine-status` catalog row as the
**MStar Workflow layout**: header (version / harness dir / enforcement evenly
spread), right sidebar (plans / residuals / knowledge / leases /
branches+policy / direction), and a **react-flow cyclic workflow graph** as
the main body — phase ring (iteration-start → autonomous-execute →
iteration-close → pr-delivery → merge-ready, loop edge) + plan state machine
(Todo → InProgress → InReview → Done / InProgress ⇄ Blocked / unknown bucket)
projected from the catalog by the pure `projectGraph` function (schema
constants vs catalog evidence strictly separated; never throws; explicit
degraded states), with current-phase highlight + legend + zoom/pan +
freshness footer. Build step: `bun run
build-client` (`scripts/build-client-bundle.ts` — closure-factory CJS,
CLIENT_EXTERNALS external, CSS modules hashed + `<style data-plugin>`
injection, purity gate, `@xyflow/react` inlined, and inline assertions that
the bundle carries the xyflow markers, zero `@deepseek-ai/*` value imports
and no `import.meta` / ESM statements — the web loader executes plugin
bundles as classic `<script>`s); the full `bun run build` runs it after the
node half. Verified locally: boot graph entry, the `/plugins/<id>/client.js`
route serving the exact built bundle, and the browser-handoff
materialization (`inject`/`apply`/CSS injection under classic-script
semantics) — see
`.mstar/iterations/iter-20260809-mstar-panel-beautify/guides/install-verification.md`.

Known limitations (this iteration): the graph's Phase 1 / Phase 5 nodes are
**schema-only** — the engine phase gate never emits their transitions (it
evaluates Phase 2→3→4), and the loop edge is planning semantics; no
historical back-scan of resumed long logs; no custom top-level slot (the
`conversation.view` tab is the only session-level panel seat without
dsh-private layout changes). Browser UI observation is the user-restart
acceptance (R1 folded into this iteration's AC-1/2).

## Known constraints

- The plugin's DEFAULT bundled root is its own `harness-skills/` mirror,
  resolved package-relative via `import.meta.url` — it works from any launch
  cwd (the default is not cwd-anchored). An
  explicit RELATIVE `bundledSkillDir` override resolves against the dsh
  **process cwd** at boot (skill-local `join` semantics — covered by
  `tests/e2e-session.spec.ts` § bundledSkillDir), so deployments
  overriding the default should pass an **absolute path** in the profile's
  `cordis.patch.yml`.
- The bundled `harness-skills/` + `harness-commands/` mirrors are build-time
  syncs (`bundle-assets`; repo-root `skills/` + `commands/`; gitignored) —
  a checkout without the sync mounts no bundled skills and registers no
  commands (inert, not an error).
- The patch ships only neutral defaults; deployment-owned values
  (`harnessDir`, `enforcement`, `dispatchTools`, `dispatchBinding`,
  `skillRoots`, `bundledSkillDir`) belong in the user's profile layer,
  restating kept fields.
- Local install **verified**: from the repo
  checkout, `DSH_HOME=<temp> dsh plugin --profile web add <packages/dsh>`
  exits 0 — pnpm links the local checkout, the reconcile step joins
  `@mstar-harness/dsh` to `dsh.profile.bundles`, and
  `dsh --profile web --dump-config` composes the `mstar` row over the web
  template layers. The repo-URL path (`add git+https://github.com/dsh-external/mstar-workflow.git#path:/packages/dsh`)
  runs through the same pnpm + reconcile mechanism (verified against the real
  remote); it builds via the `prepare` script, which pnpm ≥10 blocks until an
  `allowBuilds` entry is added (see Install). No public-registry install is
  offered yet.
