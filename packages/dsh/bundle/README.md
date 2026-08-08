# bundle/ — mstar profile-bundle layer for dsh

`@mstar-harness/dsh` doubles as a dsh **profile bundle**: its package.json
declares `"dsh": { "bundle": { "patch": "./bundle/cordis.patch.yml" } }`,
making it an installable patch layer for `dsh --profile` compositions
(dsh-bundle contract; see dsh-private `packages/bundle/README.md`). The
substance of this bundle is the patch list in
[`cordis.patch.yml`](cordis.patch.yml) — one `insert` of the `mstar` plugin
row over the dsh-base layer.

## Install

Local checkout (this iteration — local-only, no npm publish yet):

```sh
cd <repo>/packages/dsh
dsh plugin --profile mstar add .
```

Published package (later, once `@mstar-harness/dsh` is on the registry):

```sh
dsh plugin --profile mstar add @mstar-harness/dsh
```

`dsh plugin --profile <name> add <spec>` initializes the profile on first use
(`@deepseek-ai/dsh-base` as the first bundle), forwards `<spec>` to pnpm in
the profile directory, and reconciles the profile's `dsh.profile.bundles`
layer list from the installed state: any dependency whose package.json
declares `dsh.bundle` joins the layer stack. Relative specs (`.`, and
`file:`/`link:` forms) anchor to the invoking directory, so `add .` must run
from the package checkout. pnpm must be on PATH.

Bundle resolution is two-anchored: a bundle name resolves from the dsh
installation first, then from the profile directory. During local
development `@mstar-harness/dsh` is not installed into the dsh installation,
so the profile-local copy installed by `add` is the one mounted.

## Layer position

`dsh.profile.bundles` applies in list order over the profile's empty root
config:

1. `@deepseek-ai/dsh-base` — the shared dsh core.
2. This bundle — inserts the `mstar` plugin row (`id: mstar`,
   `name: @mstar-harness/dsh`).
3. The profile's own `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`
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
| `skillRoots` | unset | additional skill roots (dev-time mirror) |
| `bundledSkillDir` | `./skills` | packaged skill mount (the repo-root `skills/` mirror, copied here by the P3 packaging step) |

## Known constraints

- `bundledSkillDir: ./skills` resolves against the dsh **process cwd** at
  boot (skill-local `path.resolve` semantics). A deployment that launches dsh
  from another cwd must override it with an absolute path in the profile's
  `cordis.patch.yml`.
- The patch ships only neutral defaults; deployment-owned values
  (`harnessDir`, `enforcement`, `dispatchTools`, `dispatchBinding`,
  `skillRoots`) belong in the user's profile layer, restating kept fields.
- Local install resolves through the profile pnpm forwarder; the `dsh
  plugin --profile mstar add <spec>` public-registry path is exercised once
  the package is published (open decision — see the plan's Task 5 e2e).
