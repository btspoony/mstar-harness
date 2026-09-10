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

Registry install (published form — the npm package carries the built `dist/`):

```sh
dsh plugin --profile web add @mstar-harness/dsh
```

Local checkout install (dev — requires a prior `bun run build` in the package):

```sh
cd <repo>/packages/dsh
dsh plugin --profile web add .
```

`dsh plugin --profile <name> add <spec>` initializes the profile on first use
(`web` starts from the shipped template: `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-web-app`), forwards `<spec>` to pnpm in the profile
directory, and reconciles the profile's `dsh.profile.bundles` layer list from
the installed state: any dependency whose package.json declares `dsh.bundle`
joins the layer stack. Relative specs (`.`, and `file:`/`link:` forms) anchor
to the invoking directory, so `add .` must run from the package checkout.
pnpm must be on PATH. The package has no `prepare` script (the monorepo
builds packages explicitly, matching cli/opencode), so a local checkout must
be built before `add .`.

The optional `dsh-llm-fallbacks` capability plugin is a SECOND install
(`dsh plugin --profile web add dsh-llm-fallbacks`) — the two-command install
is the contract. This bundle's patch will NEVER fold a fallbacks row in: the
loader has no insert-if-absent semantics, so a same-`id` insert is a
`duplicate loader entry id` boot failure and a different-`id` insert mounts
the plugin twice (two `apply()` runs, split fallback state) for anyone who
also installs the package directly (roadmap §8.3 F4). Reconcile append order
places `dsh-llm-fallbacks` after `dsh-base`/`llm-retry` (its hard ordering
requirement) and after this bundle's `mstar` row.

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
| `harnessDir` | unset (resolved per session workspace) | explicit `{HARNESS_DIR}` root — **required for repos whose harness root is not a probed name** (`.mstar/` → `.agents/` → `.plans/` → `plans/`); set it to the absolute root in the profile layer (or declare `[config] harness_dir` in a repo `.mstarc` — gitignored local config, honored above probing). Without either, the probe starts from the SESSION workspace root (the session cwd — **never the process/launch cwd**) and **stops there** — it never walks above the session workspace, so a global `~/.mstar` is never adopted |
| `enforcement` | **unset — default OFF** | `hard` / `soft` override; absent → the repo `.mstarc` `[config] enforcement`, else the iteration compass decides, warn-only when no compass hardens (never a global always-on hard gate) |
| `dispatchTools` | unset (plugin default `['subagent', 'subagent_fork']`) | delegation tool names the dispatch gate matches — the dsh preset's TWO delegation tools (`subagent` + its fork sibling `subagent_fork`, both Assignment-shaped); a custom list overrides the default wholesale, so it must include `subagent_fork` to keep fork dispatches gated |
| `dispatchBinding` | unset → fail-closed `empty-binding` under hard | the dispatching agent's own role (the anti-recursion CALLER) for the precheck |
| `skillRoots` | unset | additional skill roots (custom mirrors) |
| `bundledSkillDir` | unset → plugin resolves its OWN packaged `harness-skills/` mirror package-relative | bundled skill mount — the repo-root `skills/` mirror synced by `bundle-assets` at build time (gitignored), resolved package-relative (NOT cwd-anchored). An explicit value wins; a RELATIVE override stays cwd-anchored, so pass an absolute path in the profile layer |
| `catalogTtlMs` | unset → `60000` | pre-step catalog cache refresh interval (ms) — how often the per-workspace unified `mstar-engine` catalog row (watermark + iteration gate + workspace-state digest) re-reads `status.json` / the compass / the knowledge index; the hot path is a timestamp compare + cache hit between refreshes |

## Client half (workflow panel)

The same bundle row carries a browser client half for the dsh **web** profile:
`dsh.client` (`platform: 'web'`, declared inject faces) + `exports["./client"]`
(`dist/client.js`) in package.json. The `ClientModuleHostService` discovers it
automatically on the **already-installed `mstar` bundle row** — no separate
profile layer, no second install step (spec §6.1; mechanism-guide §1.1 — the
upstream discovery reads the nested `dsh.client` declaration and resolves each
client's `exports["./client"]` into the boot graph). At
boot the web app serves the closure-factory CJS bundle at
`/plugins/@mstar-harness/dsh/client.js` (rev = content sha1) and loads it via
`window.__ModuleLoader__.load({ id, factory })`.

The client entry registers a right-Sidebar page tab type (`id:
'@mstar-harness/dsh'`, `kind: 'mstar-workflow'`, one guide-page capsule at
`order: 20`), labeled **"MStar 工作流" / "MStar
Workflow"**; clicking the capsule opens the panel in that pane's slot
(replacing the guide tab, expanding the sidebar) and a second click focuses
the existing tab (the host's page-dedup rule). The former
`conversation.view` view-ring tab is REMOVED (migration, not a second
surface). The body + its chip title register as keyed seats under the same
id (`sidebar.right.pane.tab` + `sidebar.right.pane.tab.title`; the chip is
the glyph + the title captured at open — it does not follow a mid-session
locale switch), and a docked body renders NOTHING while `tab.visible ===
false` (collapsed column or another pane tab active). The tab renders the
latest `mstar-engine` catalog **anchor** row — the persisted source is the
bare first-party `plugin` arm
(`{ kind: 'plugin', plugin: 'mstar-engine', form: 'catalog' }`; the anchor
reader also accepts the legacy `mstar-engine-status` identity from
persisted logs) — and the payload is fetched from the host's
`/api/mstar/engineStatus` endpoint (the gateway owns the route; the
panel's browser half calls
`connection.rpc.call('/api', 'mstar/engineStatus', { args: { sessionId, cwd } })`
and renders the session's stored snapshot, or an explicit unavailable
reason).

**MStar Workflow layout**: a narrow-column shell bound to the sidebar
pane's definite height — exactly three zones: the **section nav** (任务迭代
/ 代理执行 / 事件记录; `data-mstar-tab-nav`), the panel-owned **single
scroll body** (`[data-mstar-scroll]` — the ONLY `overflow-y` element in
the panel; nothing scrolls horizontally; `data-mstar-graph` rides it), and
the pinned **meta dock** (version + harness dir; never scrolls). The
workspace-state digest (plans ≤5 time-desc + `+N more`, open residual
findings ≤10 with severity chips + overflow hint, policy with enforcement
first then push / worktree / control worktree, leases, knowledge,
direction) renders IN FLOW at the end of the scroll body, closed by the
freshness footer (`snapshot {time} · turn {turn}` — the served snapshot's
own timestamp + turn, never "live"). The shell carries `container-type:
inline-size`: below 480px container width padding and group gap tighten;
at ≥720px the shared group grid spreads to two columns
(`repeat(auto-fit, minmax(280px, 1fr))`) — the only structural change any
width makes (one DOM, one tree; no JS layout measurement). The three
sections stack in the scroll body: the tasks page (iteration head +
**vertical** 5-step stepper with the FOUR-STATE `current` / `next` /
`done` / `idle` machine + the branch panel + five stacked status groups —
the merged「受阻/未知」/「Blocked / Unknown」column kept, `PLAN_CAP` render
caps + the clickable 「更多」/「收起」 expand button (`data-kanban-more`) —
then the project rollup), the events page (two partitions — Agent 流转事件
/ 违规记录 — as flow rows, every row an expandable native `<details>`
carrying the full catalog fields, missing fields render 「—」 never a
guessed value), and the agents page — a **vertical grouped list** (the
react-flow canvas, its SVG edge layer, card ports and pointer pan are
REMOVED): two Phase groups in constant order (Phase 1 review-edit-chain
above; Phase 2 sdd-implement → qc-tri → qa-gate below, its label
annotating the CURRENT plan — `data-agent-group-plan` + `+N more`),
`sdd-implement` split into implementor / reviewer sub-partitions, the
`general` bucket sunk into an `unknown` sub-bucket, the full 14-role
roster as full-width flow rows (idle rows dashed muted — the roster is
never hidden) with role chip / status point / `×N` count / record line,
the `N executing · M pending` summary, and the three-entry legend in flow
below the list; rows carry the projected **emphasis tier**
(`--mstar-canvas-emphasis-*` chrome alpha mix — never a whole-row
`opacity`, so the status point + running glow stay opaque), settled
entities get the standalone GREEN done frame + ✓ (`data-agent-done="true"`)
ONLY when `emphasis ≠ 'off'`; the agents page contains zero `<svg>`, zero
`data-agent-port` / `data-canvas-*` anchors and no pan transform. The
**iteration info section is shared by the tasks AND agents pages** (one
`IterationInfoSection`, both render the same `view.iteration` block).
Empty branches are explicit states — `waiting` / `loading` /
`unavailable` (with its reason) / no-harness each carry their OWN anchor
and copy and render no tabs, no digest and no meta dock; no harness
renders a CENTERED inactive-state card that activates automatically once a
harness is detected. Projection is the pure `projectGraph(source)`
function (schema constants vs catalog evidence strictly separated; never
throws; explicit degraded states — muted empty states, never orange warn
boxes). Refresh follows the session snapshot, no polling — a ledger
record (dispatch/settle) invalidates the workspace's TTL-cached catalog
row so the panel refreshes per step; while the main agent idles the panel
keeps the last snapshot (no live push channel). Full realized layout
detail: `packages/dsh/README.md` (§ Web client plugin).

Build step: `bun run
build-client` (`scripts/build-client-bundle.ts` — closure-factory CJS,
CLIENT_EXTERNALS external, CSS modules hashed + `<style data-plugin>`
injection, purity gate, and inline assertions that the bundle carries **no
`xyflow`/`reactflow` markers** (negative assertion — the react-flow library
and its plain-`.css` text loader were removed with the graph layer), zero
`@deepseek-ai/*` value imports and no `import.meta` / ESM statements — the
web loader executes plugin bundles as classic `<script>`s); the full `bun run
build` runs it after the node half. Verified locally: boot graph entry, the
`/plugins/<id>/client.js` route serving the exact built bundle, and the
browser-handoff materialization (`inject`/`apply`/CSS injection under
classic-script semantics) — see the
`install-verification.md` guide of the panel-beautify iteration (local harness root).

Known limitations (this iteration): the iteration stepper's Step 1
(iteration-start) IS the current step while the steering compass is
`status: active` (Phase 1 in flight — catalog `compassStatus` field), carrying
NO PASS/FAIL badge (Phase 1 has no gate verdict); Step 5 (merge-ready) can
never be the current step —
the engine phase gate only evaluates Phase 2→3→4 (merge-ready is never a gate
transition); it renders `next` only while Step 4 (pr-delivery) is current, idle
otherwise;
the current step follows the TTL-refreshed `compassStatus` — up to one catalog
interval (60 s) behind a mid-session `active`→`locked` flip (bounded,
documented staleness, never a wrong verdict);
the agent-entity status derivation pairs a PAIRED settle exactly by its
dispatch identity (agent, role, planId, taskId — QC-tri N=3 settles land on
their own cards), and an unpaired dispatch stays running (no paired settle,
never faked); the current-iteration filter with NO steering compass infers
the iteration from plan ids (8-digit date prefix) + doneAt — a
deterministic, documented heuristic, and only provably cross-iteration
events are dropped; no historical
back-scan of resumed long logs; the sidebar chip title is captured at open
time (a mid-session locale switch does not flip it), and a docked body
renders nothing while the column is collapsed or another pane tab is active
(`tab.visible === false`). Browser UI observation is the user-restart
acceptance (R1 folded into this iteration's AC-1/2).

## Known constraints

- The plugin's DEFAULT bundled root is its own `harness-skills/` mirror,
  resolved package-relative via `import.meta.url` — it works from any launch
  cwd (the default is not cwd-anchored). An
  explicit RELATIVE `bundledSkillDir` override resolves against the dsh
  **process cwd** at boot (skill-filesystem `join` semantics — covered by
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
  template layers. The registry form (`add @mstar-harness/dsh`) runs through
  the same pnpm + reconcile mechanism; a local checkout must be built first
  (no `prepare` script — see Install).
