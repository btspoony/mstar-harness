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
| `harnessDir` | unset (resolved per session workspace) | explicit `{HARNESS_DIR}` root — **required for repos whose harness root is not a probed name** (`.mstar/` → `.agents/` → `.plans/` → `plans/`): e.g. the mstar-workflow maintenance repo itself uses `.harness/` (deliberately not probed), so set `harnessDir: <repo>/.harness` in the profile layer. Without the config the probe starts from the SESSION workspace root (the session cwd — **never the process/launch cwd**) and **stops there** — it never walks above the session workspace, so a global `~/.mstar` is never adopted |
| `enforcement` | **unset — default OFF** | `hard` / `soft` override; absent → the iteration compass decides, warn-only when no compass hardens (never a global always-on hard gate) |
| `dispatchTools` | unset (plugin default `['subagent']`) | delegation tool names the dispatch gate matches |
| `dispatchBinding` | unset | the dispatching agent's role for the anti-recursion precheck |
| `skillRoots` | unset | additional skill roots (custom mirrors) |
| `bundledSkillDir` | unset → plugin resolves its OWN packaged `harness-skills/` mirror package-relative | bundled skill mount — the repo-root `skills/` mirror synced by `bundle-assets` at build/postinstall (gitignored), resolved package-relative (NOT cwd-anchored). An explicit value wins; a RELATIVE override stays cwd-anchored, so pass an absolute path in the profile layer |
| `catalogTtlMs` | unset → `60000` | pre-step catalog cache refresh interval (ms) — how often the per-workspace unified `mstar-engine-status` catalog row (watermark + iteration gate + workspace-state digest) re-reads `status.json` / the compass / the knowledge index; the hot path is a timestamp compare + cache hit between refreshes |

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

The client entry registers a `conversation.view` view-ring tab
(`id: 'mstar-workflow'`, `order: 20`), labeled **"MStar 工作流" / "MStar
Workflow"**, rendering the latest `mstar-engine-status` catalog row as the
**MStar Workflow layout**: a right sidebar (plans ≤5 time-desc + `+N more`,
open residual findings ≤10 with severity chips + overflow hint, policy with
enforcement first, leases, knowledge, direction) over a bottom **fixed meta
dock** (version + harness dir; the former header row was removed), and an
**HTML/CSS zone dashboard** as the main body — the react-flow cyclic graph
was removed in plan `20260810-panel-canvas-zones`. The canvas fills the Tab
(the page never scrolls; the zone container is the only scroll body) and
lays out three zones projected from the catalog by the pure `projectGraph`
function (schema constants vs catalog evidence strictly separated; never
throws; explicit degraded states — muted empty states, never orange warn
boxes): an **iteration zone** (Step 1–5 stepper + `Step N/5` badge,
active-highlight / inactive dimmed states; the steps carry a FOUR-STATE machine —
`current` / `next` / `done` / `idle` (plan `20260812-panel-f5-iteration-zone-fix`
Task 1): every step BEFORE the current one projects `done`「已完成」(completed —
a finished Step 1 must not read as idle while Step 2 is current), `next` is the
single forward target, `idle` is schema-only — and the branch panel — iteration
base / target / spec integration, rendered only while active; the expanded
head is a LEFT-RIGHT SPLIT — branches (small left half, WIDTH-CAPPED —
`flex: 0 1 260px` + `max-width: 280px`, never stretches with the container; the
<860px column stack resets to content height) + steps (large right half,
`flex: 1 1 0` absorbing the remaining width) via `data-iteration-head-split`,
stacking on narrow widths, and NO
branch panel when there is no active iteration; the current step follows the
steering compass: `compassStatus: 'active'` (Phase 1 in flight) → Step 1
(iteration-start) is CURRENT with verdict `unknown` — no PASS/FAIL badge —
plan `20260811-panel-f4-iteration-zone`; the branches
block left the sidebar for this in plan `20260810-panel-sidebar-info`), a
**tasks zone** (6-column kanban: Todo / InProgress / InReview / Done /
Blocked / unknown with count badges, Done ≤5 + `+N more`), an
**agent-execution zone** (the four EXPECTED_ROLE_FLOW stage/phase columns
— review-edit-chain → sdd-implement → qc-tri → qa-gate (the terminal
stage; the former `sdd-task-review` stage is removed, its SDD L2 reviewer
is now the pipeline role `code-reviewer`, v2.1.1) — a strict FOUR-column
layout with NO standalone unknown column (plan
`20260812-panel-f5-design-system` Task 5, user 2026-08-12 round-2 decision —
the former rightmost unknown column of plan `20260812-panel-f5-agent-layout`
is superseded): the `general` bucket sinks into an **unknown sub-partition
at the bottom of the `qa-gate` column** (a `data-sub-bucket="unknown"`
caption row 「unknown / 未匹配角色」 after the last qa-gate card, then the
general cards; the standalone on-demand column was already removed in the
agent-layout plan); `explore` is removed — no card, no column. The `sdd-implement`
column splits into **sub-buckets** by the projected `entity.bucket` (never
a render guess): the **implementor** partition above — flow roles in the
stage's original order (fullstack-dev / fullstack-dev-2 / frontend-dev),
then the on-demand roles (ops-engineer / prompt-engineer, carrying the
**on-demand badge** — no standalone on-demand column) — and the
**sdd-reviewer** partition below (code-reviewer, the SDD L2 task reviewer),
with implementor / sdd-reviewer caption labels; `zone: 'on-demand'` entities
live in the implementor partition, `zone: 'general'` entities render in the
qa-gate column's bottom unknown sub-partition. The subagent ENTITY cards aggregate **by role** from actual
dispatch evidence — the same role across sessions folds into one card ×N,
and every off-roster dispatch (the former `generalPurpose` SDD reviewer,
`scout`, anonymous `role === ''`) folds into the single `general` bucket
entity (the card is role-titled — the role id; the agent session id / task
tag ride the record line, never the title) — role chip / status point / ×N
count; running entities carry the business glow-pulse
highlight (on the ROUNDED `.card-body` — the card is a single rounded
element, no square outline overlay, plan `20260812-panel-f5-design-system`
Task 5), un-evidenced stages render the dashed "待执行" pending
placeholder with their expected role chips, un-evidenced KNOWN_AGENTS
members render dashed idle cards (the full 14-role roster is never
hidden), and the header shows the
`N executing · M pending` summary; cards carry the projected **emphasis
tier** (plan `20260812-panel-f5-design-system` Task 4, design doc §3):
`emphasis: 'current' | 'next' | 'off' | null` — the iteration's
current-phase roles render at **100%** chrome intensity, later-phase
expected roles at **75%**, already-passed / stage-less (on-demand, general)
roles at **45%**, and `null` (no iteration / unresolved transition) applies
NO override — always a chrome **alpha mix** (`--mstar-canvas-emphasis-*`
tokens; never a whole-card `opacity`, so the status point + running glow
stay opaque). Edges — plan `20260812-panel-f5-design-system` Task 5 (design
doc §2): the `expected` stage skeleton arrows AND the ANIMATED **next** edge
(the former `@keyframes agent-dash-flow` dash-flow arrow of plan
`20260810-panel-agent-flow-zone`) are **REMOVED** — flow order is implied
by the fixed column order + column labels, the current position by the
running card glow + status point — leaving TWO semantic kinds: the
evidence-driven **`actual` handoff** edges (same-plan ts-adjacent dispatch
entity-key pairs, `general` endpoints filtered, ≤1 per entity pair) drawn as
**bezier `C` curves** anchored to card **ports** — 4 fixed edge-midpoint
ports (north / south / east / west; static-invisible, hover-revealed as
small dots) with the arrow tip pulled back to a **10px standoff** off the
port — the arrow follows the line's local tangent at the anchor (**H1**),
and no line's stroke or arrow crosses any text (**H2**: standoff + side-gap
routing, design doc §2.0/§2.5/§2.6) — plus the **bidirectional supervise
line** (plan `20260812-panel-f5-agent-layout` Task 1/2) — one static
design-knowledge sub-bucket edge inside the `sdd-implement` column
(implementor ↔ sdd-reviewer — the mstar-sdd mutual-supervision contract),
now anchored at the **side-gap vertical anchor** (`x = card right edge +
18px`, vertical bezier flow, arrows along the vertical tangent — design doc
§2.5/§2.7); dim dashed by default, lit business SOLID when the projected
`evidenced` flag is true — evidence-driven lighting, never a fabricated
activation), with the
agent-flow event strip migrated into the **事件记录 (Event Log) tab** — a
non-canvas log page (spec F1.5, plan `20260811-panel-event-log`): two
partitions (Agent 流转事件 / 违规记录), every row an expandable native
`<details>` carrying the full catalog fields (missing → 「—」), muted empty
states — the two partitions render SIDE BY SIDE in a locked-height
two-column grid (`repeat(2, minmax(0, 1fr))` — the page never scrolls as a
whole; each partition pins its title and owns an internal `overflow-y`
scroll on its row list), falling back to two stacked 50/50 locked rows
below 1200px (`data-event-log-*` anchors unchanged, plan
`20260811-panel-f3-agent-general`) — the canvas-corner **AgentEventDock** is REMOVED with the page
(无双份日志, spec §5; the fixed footer bar — zone legend + gate summary +
violations — died with the WorkflowCanvas in the tabs-shell plan; the
footer that remains is the freshness marker). Empty branches (spec §2, plan
`20260812-panel-f5-agent-layout` Task 3): waiting keeps the muted hint, and
NO harness renders a **centered inactive-state card** — folder icon + 「No
Morning Star harness detected」 title + hint copy (the detail panel stays
inactive — no tabs, no sidebar — and activates automatically once a harness
is detected; `data-mstar-empty="no-harness"` stays on the title,
`data-mstar-graph` on the main container). Below 1200px the zones stack vertically.
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
classic-script semantics) — see
`.mstar/iterations/iter-20260809-mstar-panel-beautify/guides/install-verification.md`.

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
never faked); no historical
back-scan of resumed long logs; no custom top-level slot (the
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
