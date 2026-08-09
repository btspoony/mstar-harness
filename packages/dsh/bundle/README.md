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
| `harnessDir` | unset (probed from cwd) | explicit `{HARNESS_DIR}` root |
| `enforcement` | **unset — default OFF** | `hard` / `soft` override; absent → the iteration compass decides, warn-only when no compass hardens (never a global always-on hard gate) |
| `dispatchTools` | unset (plugin default `['subagent']`) | delegation tool names the dispatch gate matches |
| `dispatchBinding` | unset | the dispatching agent's role for the anti-recursion precheck |
| `skillRoots` | unset | additional skill roots (custom mirrors) |
| `bundledSkillDir` | unset → plugin resolves its OWN packaged `harness-skills/` mirror package-relative | bundled skill mount — the repo-root `skills/` mirror synced by `bundle-assets` at build/postinstall (gitignored), resolved package-relative (NOT cwd-anchored). An explicit value wins; a RELATIVE override stays cwd-anchored, so pass an absolute path in the profile layer |

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
