# dsh host reference

Load when **`mstar-host`** detection resolves **dsh** (DeepSeek Harness — session
has the **`subagent`** model-facing delegation tool, the `@deepseek-ai/dsh`
cordis plugin stack; `@mstar-harness/dsh` mounted via the `web` profile bundle
or a custom profile).

## dsh-only context

- Plugin markers: **`@mstar-harness/dsh`** (cordis function plugin) + the
  **profile bundle** (`dsh.bundle.patch` manifest) installed into the `web`
  profile via `dsh plugin --profile web add <spec>`. The composed app rows:
  `@deepseek-ai/dsh-skill` (skill registry), `@deepseek-ai/dsh-tools` (tool
  registry), `@deepseek-ai/dsh-commands` (command registry), then the `mstar`
  row.
- Runtime skills: the plugin mounts the packaged **`harness-skills/`** mirror
  (repo `skills/`, synced by `bundle-assets`) through the dsh skill-local
  provider as a **single canonical mount** (`providerName: mstar`). Skills are
  loadable by **name** via `ctx.skills`; the canonical skill-root form is
  `$DSH_BUNDLED_SKILL_DIR/<name>[/<rel>]`.
- Plugin commands: the plugin registers the **seven** bundled
  **`harness-commands/`** commands on `ctx.commands` — **`/iteration-start`**,
  **`/iteration-drive`**, **`/iteration-loop`**, **`/codebase-audit`**,
  **`/amazing-pr-review`**, **`/amazing-e2e-check`**,
  **`/amazing-test-audit`**. Each
  command steers its command body into the receiving agent as a USER-source
  message (the mstar workflow prompt — the model executes it as a task, not
  injected context), returning a success result. The plugin registers **no
  duplicated** mstar command tools: the writable mstar command surface on this
  host is the **MCP** route (§ The native command surface below), and the
  only native tools are the three the MCP route cannot replace.
- **No `sessionStart.skill`** — enter PM manually via the `pm` skill (the
  `mstar-roles` load path), then **Read next** → `mstar-harness-core` →
  `project-manager.md`.
- Model-facing tools: the plugin registers exactly **three** tools on
  `ctx.tools` — **`mstar_plan_bind`** (the durable-slot producer),
  **`mstar_audit_validate`** (no MCP twin) and **`mstar_execution_clear`** (no
  shared command); the membership rule and each tool's unique contribution are
  in § The native command surface. Every other mstar capability is an MCP tool of
  the one shared connection, published one tool per command family
  (`mcp__mstar__mstar_plan`, `mstar_workflow`, `mstar_issue`, `mstar_sdd`,
  `mstar_iteration`, `mstar_design_md`, `mstar_audit`, `mstar_compound`,
  `mstar_roles`, …) with an `action` argument selecting the member command.
- Web client plugin (workflow panel): the same `mstar` bundle row carries a
  browser client half (`dsh.client` + `exports["./client"]`) discovered
  automatically by `ClientModuleHostService` — no separate profile layer or
  install step. It registers a **right-Sidebar page tab type** (`id:
  '@mstar-harness/dsh'`, `kind: 'mstar-workflow'`, one guide-page capsule at
  `order: 20`) labeled **"晨星工作流" / "Morning
  Star Workflow"** rendering the latest `mstar-engine` catalog **anchor** row
  — the persisted source is the producer-owned catalog source
  (`{ kind: 'mstar-engine', form: 'catalog' }`, no
  payload members; the anchor reader also accepts the V3→V4-migrated legacy
  kinds `plugin:mstar-engine` and `plugin:mstar-engine-status` from persisted logs), and the payload is fetched from the host's
  `/api/mstar/engineStatus` endpoint (the gateway owns the route; the browser
  half calls `connection.rpc.call('/api', 'mstar/engineStatus', { args: { sessionId, cwd } })`
  and renders the session's stored snapshot, or an explicit unavailable
  reason). **Morning Star Workflow layout**: a narrow-column shell bound to the
  sidebar pane's definite height — exactly three zones: the **section nav**
  (任务迭代 / 代理执行 / 事件记录; `data-mstar-tab-nav`), the panel-owned
  **single scroll body** (`[data-mstar-scroll]` — the ONLY `overflow-y`
  element in the panel; nothing scrolls horizontally; `data-mstar-graph`
  rides it), and the pinned **meta dock** (version + harness dir; never
  scrolls). The workspace-state digest (plans ≤5 time-desc + `+N more`,
  open residual findings ≤10 with severity chips + overflow hint, policy
  with **enforcement first** then push / worktree / integration worktree,
  leases, knowledge, direction) renders IN FLOW at the end of the scroll
  body, closed by the freshness footer (`snapshot {time} · turn {turn}` —
  the served snapshot's own timestamp + turn, never "live"). The three
  sections stack in the scroll body: the tasks page (iteration head +
  **vertical** 5-step stepper with the FOUR-STATE `current` / `next` /
  `done` / `idle` machine + the branch panel + five stacked status groups
  — the merged「受阻/未知」/「Blocked / Unknown」column kept, `PLAN_CAP`
  render caps + the clickable 「更多」/「收起」 expand button
  (`data-kanban-more`); the projection keeps ALL plan rows — then the
  project rollup), the events page (two partitions — Agent 流转事件 /
  违规记录 — as flow rows, every row an expandable native `<details>`
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
  the `N executing · M pending` summary, and the three-entry legend in
  flow below the list; rows carry the projected **emphasis tier**
  (`--mstar-canvas-emphasis-*` chrome alpha mix — never a whole-row
  `opacity`, so the status point + running glow stay opaque), settled
  entities get the standalone GREEN done frame + ✓
  (`data-agent-done="true"`) ONLY when `emphasis ≠ 'off'`; the agents page
  contains zero `<svg>`, zero `data-agent-port` / `data-canvas-*` anchors
  and no pan transform. The **iteration info section is shared by the
  tasks AND agents pages** (one `IterationInfoSection`, both render the
  same `view.iteration` block). Empty branches are explicit states —
  `waiting` / `loading` / `unavailable` (with its reason) / no-harness
  each carry their OWN anchor and copy and render no tabs, no digest and
  no meta dock; no harness renders a CENTERED inactive-state card that
  activates automatically once a harness is detected (inside the same
  single scroll zone). Projection is the pure `projectGraph(source)`
  function (schema constants vs catalog evidence strictly separated; never
  throws; explicit degraded states — muted empty states, never orange warn
  boxes). Refresh follows the session snapshot, no polling — while the
  main agent is ACTIVELY orchestrating, a ledger record (dispatch/settle)
  invalidates the workspace's TTL-cached catalog row so the next pre-step
  rebuilds and (digest text change) re-injects it, and the panel refreshes
  per step (seconds, not the 60 s TTL); while the main agent IDLES the
  panel keeps the LAST snapshot — no live push channel. Bundle served at
  `/plugins/@mstar-harness/dsh/client.js` (closure-factory CJS with NO
  graph library inlined — react-flow removed; the build asserts the bundle
  contains no `xyflow`/`reactflow` markers, no `@deepseek-ai/*` value
  imports, and no `import.meta` / ESM statements — the loader runs plugin
  bundles as classic scripts). Full realized layout detail:
  `packages/dsh/README.md` (§ Web client plugin). **Known limitations**:
  the stepper's Step 1 (iteration-start) IS the current step while the
  steering compass is `status: active` (Phase 1 in flight — catalog
  `compassStatus` field), carrying NO PASS/FAIL badge (Phase 1 has no gate
  verdict); Step 5 (merge-ready) can never be the CURRENT step — the
  engine phase gate only evaluates Phase 2→3→4; the current step follows
  the TTL-refreshed `compassStatus` — up to one catalog interval (60 s)
  behind a mid-session `active`→`locked` flip (bounded, documented
  staleness, never a wrong verdict); the agent-entity status derivation
  pairs a PAIRED settle exactly by its dispatch identity (`agent`, `role`,
  `planId`, `taskId`), and an unpaired dispatch stays `running` (never
  guessed, never faked); with NO steering compass the current-iteration
  filter infers the iteration from plan ids (8-digit date prefix) +
  doneAt — deterministic, documented heuristic, only provably
  cross-iteration events are dropped, no historical back-scan of resumed
  long logs; the sidebar chip title is captured at open time; a docked
  body renders nothing while `tab.visible === false`. Routine panel QA uses affected unit evidence only. Real-browser rebuilt-bundle
  verification or user-restart GUI acceptance belongs to an explicitly requested
  independent **`mstar-e2e`** workflow (`/amazing-e2e-check`), never an iteration QA gate.

## Runtime and upgrade

- **Runtime**: Bun-hosted host — the plugin, its gates and its in-process engine all run under dsh's Bun, which is **not version-gated**: the store's Node floor applies to Node entrypoints only, and `engines.bun` declares the development toolchain. Release-surface `enforcement` / `.mstarc` settings (see § Configuration) are gates, not a runtime floor: a runtime without the native `node:sqlite` capability refuses actionably instead of degrading to a transport or JSON.
- **Upgrade / reload**: `dsh plugin --profile web add <spec>` against the published version, or re-run `npx @mstar-harness/cli init --target dsh`; then reload the profile so the composed rows pick up the new build. The bundled `harness-skills/` mirror is a build-time sync — a checkout that has not run `bundle-assets` mounts no skills.
- **Readiness, not an action**: refreshing an *installed* copy is a bounded, authorized ops act — an authority flip first quiesces, then reloads/upgrades (or explicitly excludes) every installed reader/writer and attests the versions it saw. Editing harness docs or source performs none of it. If this host cannot reload safely, stop at the exact manual-restart step, have the user restart, then re-verify entrypoint/runtime/version/session identity read-only before the flip.

## MCP delivery

- **Native install and loading**: install `@mstar-harness/dsh` in the `web` profile (`dsh plugin --profile web add @mstar-harness/dsh`; `dsh-llm-fallbacks` remains a separate optional plugin). DSH config is a Cordis YAML row, not `mcp.json`: the shipped bundle patch (`packages/dsh/bundle/cordis.patch.yml`) inserts an `mstar-mcp` row that launches `npx @mstar-harness/cli mcp` over stdio through Cordis's `@deepseek-ai/dsh-mcp-client` bridge (`serverName: mstar`). The row loads only when the bridge plugin is in the profile's dependencies (`dsh plugin --profile web add @deepseek-ai/dsh-mcp-client`); app-boot tolerates the row failing without it — no mstar MCP tools appear until it is installed. The CLI process requires **Node >=24.18.0**; the dsh plugin itself remains Bun-hosted.
- **Context boundary**: optional `host` is validated context selection, not a role or authority grant. `sessionId` is the main conversation session. MCP does not require or perform per-call child-agent attribution; shared handler workflow ownership, path, state-transition and CAS checks remain authoritative.
- **One shared connection, declared control root**: that `mstar-mcp` row is the WHOLE MCP channel — the plugin registers no MCP client of its own and no per-agent mount exists, so a subagent shares the parent's connection. The control root is DECLARED, never inferred: the launch pin (`mstar mcp --harness <absolute path>`, else a non-blank `MSTAR_HARNESS_DIR`) wins, then the admitted call's `harness` field; a command whose contract reads no root (`schema`, `path.resolve`, `host.*`, `doctor`, the read-only validators) and `harness.scaffold` run with a null root, and any other call that declares no root is refused with `[mcp.control-root-unresolved]` plus its recoveries — the two launcher recoveries are universal, the per-call `harness` selector is tool-dependent. The launch cwd is the HOST's directory and is never a root candidate, and a root-free command may not take its answer from it either: with no declared workspace its cwd-derived inputs are REQUIRED as absolute paths (`harness.scaffold`'s `path`, `roles.validate`'s `rolesDir`, `path.resolve`'s `path`, `plugin.validate`'s `root`, `audit.secret-scan`/`supply-chain`'s `path`, `pr-review.seat-prompt`'s `worktree`/`skillRoot`, and `doctor`'s project scope), while `pr-review.size`/`post` (whose subject IS the checkout) refuse outright, each naming the cause and the two launcher recoveries; a declared `--workspace` or a pinned root lifts all of them; a pin beats a per-call `harness`, and on an unpinned connection `harness` is published as REQUIRED on every tool whose root is not otherwise fixed. The connection carries **no identity of its own** and, by default, accepts **no caller-declared identity either**: the per-call `sessionId` selector is not published, and a call that supplies one refuses with `mcp.caller-identity-unavailable`. Only a launcher that explicitly opts in (`mstar mcp --trust-caller-session-id`, OFF in the shipped row) publishes it. The host-proven route for a session-identity operation is a native tool, where identity is `exec.agent.id`; the native surface covers plan bind, audit report validation and execution clear only, so plan prepare/progress/complete and every other identity-consuming action run through the CLI from the session's shell.
- **Doctor and evidence**: `mstar-harness doctor --target dsh` parses the profile's Cordis sources (`cordis.yml` plus the installed bundle patch) structurally and reports the `mstar-mcp` row as `aligned` only when the `@deepseek-ai/dsh-mcp-client` bridge package is installed in the profile; a configured row without the bridge is a `mismatch`, no composed sources or no row is `unavailable`. It does not open `store.db`. An aligned config does not establish installed-host behavior; live verification is separately authorized.

## Skill loading

1. On entry: invoke **`pm`** (skill name via the mstar provider) → **Read
   next** loads `mstar-harness-core`, then `mstar-roles` →
   `project-manager.md` when PM is active.
2. Read `mstar-host` and this dsh reference.
3. Load `mstar-roles` and the active role reference.
4. Load topic skills on demand per the role reference (skill **names** —
   never app-cwd `skills/<name>/…`).

## Tools map

| dsh tool | Harness use |
|----------|-------------|
| **`subagent`** / **`subagent_fork`** | Direct-delegation channel — one Assignment per invoke, returned at activation start (default `toolName`; a renamed instance must be declared via Config `dispatchTools`). The default channel on a profile WITHOUT the Team layer; also a one-off seat the board does not track. `subagent_fork` is the variant that seeds the child with the completed conversation (§ Delegation channels) |
| **`spawn_teammate`** / **`team_task_create`** / `team_task_list` / `team_task_get` / `team_task_update` / **`wait_agent`** / **`send_message`** / `list_agents` / `interrupt_agent` | Agent Teams — the DEFAULT dispatch channel whenever the Team layer is mounted (one board task per Assignment, one teammate per track). Protocol → `references/dsh-agent-teams.md` |
| **`workflow`** | Read-only fan-out — one run, one conversation `workflow-run` node. N≥3 is its design width; a one-seat read-only run is supported when no direct delegation can carry it (§ Read-only fan-out via the `workflow` tool; scripts → `references/dsh-workflow-scripts.md`) |
| **`mcp__mstar__mstar_<family>`** | The writable mstar command surface — one MCP tool per command family with an `action` argument (`mstar_plan` → `bind`/`prepare`/`progress`/`complete`, `mstar_workflow` → `register`, `mstar_issue` → `add`/`close`, `mstar_sdd` → `workspace`/`task-brief`, `mstar_iteration` → `gate`, `mstar_design_md` / `mstar_compound` / `mstar_roles` → `validate`, `mstar_audit` → `scaffold`/`secret-scan`/`supply-chain`). The one shared connection carries no identity and publishes no caller session selector by default; a call may name the control root through `harness` when the connection is unpinned. An operation needing a session identity uses the native tool where one exists (plan bind, audit validate, execution clear) and otherwise the CLI (§ The native command surface) |
| **`mstar_plan_bind`** | Native bind — the only producer of the dsh-local durable record: it binds the engine coordinator row AND writes the session's `executionBinding` slot plus the adoption receipt that ledger attribution reads (§ The native command surface). A coordinating session that wants dsh-local ledger attribution uses this tool, not the MCP action |
| **`mstar_audit_validate`** | Native report validator — the review-report credential scan (`mstar-audit` Hard Rule 4); the `mstar_audit` family publishes no report validator, so this capability has no MCP action |
| **`mstar_execution_clear`** | Clear the calling session's own durable execution binding — no shared `execution.clear` command exists. No parameters, identity from `exec.agent.id`, leaf seats refused fail-closed |
| **bash / read / write / edit / grep / glob / web_search** | Standard agent tools — evidence per `mstar-coding-behavior` |

### `subagent` dispatch shape

The dsh `subagent` tool is the DIRECT delegation channel (schema rendered by
`@deepseek-ai/dsh-tool-subagent`; `provider`-bound, default toolName
`subagent`) — the one that carries an Assignment when the Team layer is not
mounted, and the shape below is what its callers emit. On a Team-mounted profile
the same Assignment text goes out through a board task + `spawn_teammate`
instead (§ Delegation channels). Either way the dispatch gate validates the
**Assignment header region** (`## Assignment`
+ `**Execute as**` / `**Delegation**` / `**Task category**` / `**Working
branch**` / `**Branch policy**` fields — engine `composeDispatchGate`, same
violation codes as opencode/omp/CLI).

Envelope-first discipline applies: put the header fields at the top of the
Assignment body — the dsh dispatch gate reads only the header region, so
body-quoted examples never leak into header fields.

## Delegation channels

dsh exposes three delegation surfaces. **Mounting decides which channel you
start from, not which work is allowed.** When the Agent Teams layer is
installed it is the default delegation channel — a multi-task plan belongs on
its board — and `subagent` is the fallback for a profile without it. `workflow`
rides alongside both as the read-only fan-out surface.

| Channel | Surface | Use when | Not for |
|---|---|---|---|
| **Agent Teams** — `spawn_teammate` + `team_task_create` / `team_task_list` / `team_task_get` / `team_task_update` + `wait_agent` + `send_message` (+ `list_agents`, `interrupt_agent`) | a durable named roster plus a shared task board; a teammate IS a subagent child carrying the ordinary agent toolset (it can enter an assigned checkout through its own tools), and any root session is the implicit Lead | **the default whenever the layer is mounted** — list the plan's tasks on the board first (one task per Assignment), then spawn one teammate per track: multi-task plans, parallel writable tracks, and any seat that must stay addressable across rounds or be steered by name | read-only fan-out while `workflow` is mounted |
| **`subagent`** / **`subagent_fork`** | one model-facing call per Assignment; `{ kind: 'activation', subagentId }` at start, settlement notice at finish; continuable on the providers this deployment configures | the documented fallback when the Team layer is NOT mounted; also single one-off lookups that need no roster | work that must stay addressable across turns, or read-only fan-out while `workflow` is mounted |
| **`workflow`** | one model-written JS script over `agent()` / `parallel()` / `pipeline()`; its children are fresh one-shot subagents, never Team members | read-only fan-out of N≥3 seats (plan QC tri, audit categories, PR-review seats), chunked to the activation-pool width; a single read-only seat routes here when no direct delegation can carry it (Team profile, where `subagent` is disabled and a review must not take a roster seat) | writable fan-out — it has no per-child pre-start veto seam |

**Parallel writable tracks are a Team workload, not a Team exclusion.** The
channel does not create checkouts for you — that stays the repository's worktree
procedure (one writable seat per worktree, L2 isolation) — but a teammate runs a
full agent toolset and enters its assigned checkout itself. Record each track's
prefix on its board task (`write_scopes` is advisory and never a lock), keep
disjoint seats in disjoint directories, and leave integration to the Lead.

**Every Assignment has EXACTLY one gated carrier.** `spawn_teammate.prompt`,
`team_task_create.description`, `team_task_update.description` and
`send_message.message` are all dispatch carriers. Two carriers for one piece of
work leave a permanently unresolved duplicate in the ledger; **zero carriers
leave the work ungated** — a teammate reused on a track is steered by
`send_message`, so a header-free steer means the field, lease and worktree checks
never run for that task. The board `description` is therefore always coordination
text, and each task's Assignment rides its own carrier: the track's first task in
`spawn_teammate.prompt`, every later task on that track in the `send_message`
that starts it (§ `references/dsh-agent-teams.md` § Exactly one gated carrier per
Assignment).

**Seats are budgeted per track, not per task.** The roster is finite and has no
removal operation, so one durable teammate per writable track (reused via
`send_message`) is the plan shape; task reviewers are fresh-context `workflow`
children that never join the roster. Budget, member migration between tracks (a wave frees no capacity), and the at-cap recovery →
`references/dsh-agent-teams.md` § Capacity.

**Mounting decides the starting channel.** The shipped Agent Teams profile layer
(`@deepseek-ai/dsh-experimental-agent-team-profile`) inserts the Team rows and
**disables** the direct `subagent` / `subagent_fork` rows, so that profile
exposes exactly one direct-delegation surface. A profile that mounts both (a
custom composition) starts from Agent Teams and keeps `subagent` for a seat the
board does not track. When `spawn_teammate` is absent from the toolset the Team
layer is not mounted — use `subagent` and never attempt the Team protocol.
`workflow` rides alongside both.

Team protocol — roster naming, plan-row ⇄ team-task mirroring, wake
discipline, capacity, and worktree hand-off — → **`references/dsh-agent-teams.md`**.

## Gates and enforcement

The plugin wires the engine gates on dsh seams (all in-process):

| Gate | Seam | Hard-mode channel |
|------|------|-------------------|
| Status gate | `fs/write-intent` + `fs/edit-intent` on `{HARNESS_DIR}/status.json` | repair-escape advisory (never vetoes the repairing write) — **except** the store-authority refusal class below |
| Store authority in the status gate | inside the status gate's document classification (register kind, snapshot cleanup extension) | **typed veto under hard, and no repair escape**: when the findings-cleanup verdict cannot be read because the issue authority is missing (`store.not-initialized`), staged (`store.not-active`), corrupt, below-floor or busy, the write is vetoed (`status.veto` / `findings.cleanup-authority-unavailable`) — the repair is a store command (`mstar store init|upgrade|migrate`), never a document write |
| Dispatch gate | `tools/pre-execute` on every delegation carrier — the configured `dispatchTools` (`subagent` / `subagent_fork` by default) **and** the Agent Teams carriers (`spawn_teammate`, `team_task_create`, `team_task_update`, `send_message`) | `PreToolDecision { kind: 'deny', reason }` |
| Lease gate | inside the dispatch gate (SDD / InProgress dispatches) | deny under hard |
| Worktree L1/L2 | inside the dispatch gate | deny under hard |
| Skill-authoring lint | `fs/write-intent` on `SKILL.md` under mounted roots | repair-escape advisory |
| Seam lints | `fs/write-intent` on DESIGN.md / audit / compound / roles | repair-escape advisory |

**Enforcement semantics**: warn-only by default. `Enforcement: hard` —
resolved from the plugin Config (`enforcement: hard`), the Assignment header
flag, the repo `.mstarc` `[config] enforcement`, or the iteration compass
frontmatter — escalates dispatch violations to
a real veto; status/skill-lint writes are never hard-vetoed because the intent
waterfall is content-blind (an already-invalid document is allowed as a
repair escape) — **except** the status gate's store-authority refusal class,
whose veto rests on the authority being unreadable rather than on the
document's content, so no content can repair it. The register kind itself
stays synchronous shape validation: a project register is migration history,
and a retired path is not a lookup. Config / `.mstarc` `soft` are the local
rollbacks. Hard gates are never a global default.

A composed agent step carries ONE **`<mstar_engine_status>`** catalog
message when the row is emitted. The row is a compact DELTA, not a snapshot:
ONE delta line carrying the selected `workflow`, its non-Done `plans`, the
`branch` anchors, and — when a steering compass resolved — the iteration phase
`gate` verdict with its transition and violation codes. A `workflow warning:
<code> <message>` line follows that delta line when the selection carries a
warning (the registration-less fallback adds the watermark trio above it), so
the block is one delta line plus those disclosures. `plans:` distinguishes an
empty registry (`plans: none registered`) from a workflow whose every plan row
is Done (`plans: all done`); the non-Done rows are listed otherwise. When no
lifecycle is selected it renders `workflow selection: ERROR (<code>) <message>`
in place of that line, and that message names the execution authority plus a
real recovery (`mstar workflow register` / `mstar iteration register`, or
picking a registered lifecycle for this session) rather than a retired
`status.json` path.

Everything else the payload carries — the open-issue rollup and its detail
rows, the branch policy, the spec-integration branch anchor, plan row scopes (a
recorded scope, never a lease), the knowledge digest, the compass direction and
the agent-flow ledger — is deliberately NOT in the row. Those facts stay in
`MstarEngineStatusPayload` (the panel renders them from the persisted emission)
and in the engine authorities behind it; there is no single `status` command
that serves them, so read the concrete one per fact: `mstar status tech-debt`
for the open-issue rollup, `mstar roadmap show` and the compass document
(`{ITERATION_DIR}/<id>/delivery-compass.md`) for direction, branch policy and
the spec-integration anchor, `mstar plan show` for plan rows and their recorded
scopes, `{KNOWLEDGE_DIR}` for the knowledge documents, and the persisted
`dsh_status_emissions` snapshot for the agent-flow ledger. The row is a
projection of the payload, never the authority for it: treat the row as a
change notice and re-read the authority when a decision needs the full state.

Emission is change-driven per session+workspace, and the two sides are gated
separately. The MODEL row is keyed on its own rendered text: first emission,
then only when that line changes — so a residual count, a ledger event, a
knowledge digest or a row scope moving does not append an identical-looking
row, and a long unchanged session does not accumulate stale copies. The PANEL
is keyed on the full payload projection: a change to any payload-only fact
still persists the new payload for the panel (the freshness footer keeps the
turn the model last saw a row). The start of a turn is neither trigger, and a
workspace with no resolved `{HARNESS_DIR}` composes no row at all.

The block is a projection of the payload: the version / harness dir /
enforcement watermark stays in the payload (the panel meta dock renders
version + harness dir from it) and stays model-visible once in the always-on
system prompt (`mstar:engine-status` digest + `mstar:harness-rules`), never
repeated in the row. The one exception is a composition without
`dsh-system-prompt`: the registration fails open and neither prompt section
exists, so the row falls back to re-rendering the trio itself (the listener's
`showWatermark` option, taken from that registration verdict) — the watermark
is never absent from the model's context. The newest per-session emission
persists in the control-root `store.db` (`dsh_status_emissions`); its
freshness footer `turn` / `at` name the last MODEL-row emission, so a
panel-only persist updates the payload without claiming the model saw a new
row. The row is not periodically re-anchored, so after host-side context
compaction it may be absent until the next rendered change — the system-prompt
digest still carries the version, the active workflow, its non-Done plans, the
`branch` anchors (when the payload resolved both) and the phase-`gate` verdict
(when a steering compass gated the iteration). The remaining facts are read on
demand: `mstar status tech-debt` for the open-issue rollup,
`mstar iteration gate --workflow <id> --compass <path>` for a fresh gate
evaluation, and the compass / plan documents for direction, policy and row
scopes. The build behind it is one per-workspace TTL cache (`catalogTtlMs`,
default 60 s).

### Execution authority in this host (source state)

The engine's own route (`resolveExecutionReadRoute`) decides which authority
answers, and no tool argument or config key selects one:

- While the control harness's execution authority is **ACTIVE**, the plugin's
  gates select the lifecycle they are about from the **DB authority** with
  explicit identities — never a newest/only guess, never a fallback to the
  retired `status.json` / snapshot bytes — and a write to a retired
  coordination document is refused **unconditionally** (`execution.direct-write-refused`),
  canonical path and symlink alias alike. A register write while an active store
  answers is refused as migration history; a register write while the authority
  cannot be read at all fails closed.
- A missing (`store.not-initialized`) or staged (`store.not-active`) store is not
  an execution route: coordination documents have no file fallback there
  (`execution.not-active` — the file route is retired), and the
  register kind stays under its own document validator.
- The host-native execution entry is the **shared MCP connection**, not a command and
  not a native duplicate: the writable mstar commands arrive as MCP tools
  (`mcp__mstar__mstar_<family>` with an `action`). Three dsh-native tools ride
  beside them, and only for what the MCP route cannot do — `mstar_plan_bind`
  (the durable-slot producer), `mstar_audit_validate` (no MCP twin) and
  `mstar_execution_clear` (no shared command); the rule is in § The native
  command surface below.

### Concurrent lifecycles and workflow selection

**Several ACTIVE lifecycles at once is the normal state**, not an error: each
plan, worktree, and PR advances on its own lifecycle, and nothing in the host
caps how many run concurrently. A session only has to answer "which lifecycle
does THIS operation belong to", and the resolver answers it from the operation
itself before it ever asks the operator. The order below is the resolver's own:

1. **A plan row's recorded worktree** contains the session cwd.
2. **A lifecycle's integration worktree** contains the session cwd.
3. **The session's explicit pick** (the panel selection or `mstar plan bind`).
4. **The plan row the operation names** — an Assignment's `Plan Path` / `SDD dir`,
   a `--plan` argument. A plan row belongs to exactly one lifecycle, so naming it
   identifies its owner even when the cwd matches several.
5. **The only active entry.**

Every automatic rung (1, 2, 4) needs **exactly one distinct** lifecycle: zero or
several matches fall through to the next rung, and nothing is ever decided by
registry order, recency, or a longest-prefix guess.

An explicit pick outranks rung 4 on purpose: a pick that names a lifecycle
WITHOUT the requested plan row is a contradiction the caller must see
(`lease.dispatch.plan-not-found`), never a silent switch of lifecycle. A pick
naming a lifecycle that is no longer active has expired, so the operation's own
plan row may resolve it (rung 4) — the pick named nothing the store can confirm.

Only when none of the five applies does a write report
`workflow.selection.unbound-multi-active`, and that refusal is scoped to the one
operation: it lists the active ids and the ways to name one. It is not a session
pause — every other operation keeps working, and the same session can drive
several lifecycles by naming the plan each call.

### The native command surface

The writable mstar command surface on this host is the **MCP route**: the
plugin's bundle patch inserts ONE `mstar-mcp` row (`npx @mstar-harness/cli mcp`
over stdio, § MCP delivery) and that row is the whole MCP channel — no
per-agent mount exists, so a subagent shares the connection its parent already
has. The connection carries **no identity and no control root of its own**: the
root is declared at launch (`--harness`, else a non-blank `MSTAR_HARNESS_DIR`)
or named per call through `harness` (REQUIRED while the connection is
unpinned), a command whose contract reads no root runs with a null one, and a
command that needs a session identity has **no caller-declared channel** on the
default connection — the host-proven route is a dsh-native tool, where identity
comes from `exec.agent.id`, or the CLI (§ MCP delivery). The native tools cover
plan bind, audit report validation and execution clear; plan
prepare/progress/complete have no native tool yet and are CLI-only. Each MCP tool is one
command FAMILY with an `action` argument —
`mstar_plan` (`bind` / `prepare` / `progress` / `complete`), `mstar_workflow`
(`register`), `mstar_issue` (`add` / `close`), `mstar_sdd` (`workspace` /
`task-brief`), `mstar_iteration` (`gate`), `mstar_design_md` / `mstar_compound` /
`mstar_roles` (`validate`), `mstar_audit` (`scaffold` / `secret-scan` /
`supply-chain`), plus every other family. An unknown or missing `action` refuses
with that family's real action list, and a missing required field refuses with
the shared aggregated message naming every missing field — validation, refusal
aggregation and payload composition are the shared command layer's, unchanged.

**The native-surface rule** (memorize this instead of a list): a command is a
dsh-native tool only when it

1. **produces a dsh-local durable record the MCP route cannot write**, or
2. **exposes a capability the MCP surface does not publish at all**.

Everything else is MCP. Three tools satisfy the rule today:

- **`mstar_plan_bind`** — rule 1. It binds the engine coordinator row *and*
  persists the dsh plugin's own durable state: the session's `executionBinding`
  slot in the control root's `store.db` plus the in-process adoption receipt the
  workflow-ledger attribution resolver and `mstar_execution_clear` read. Shape:
  the shared `plan.bind` parameters mirrored mechanically from the published
  schema (the session selector is not one of them — identity comes from
  `exec.agent.id`), engine refusals returned verbatim, a known leaf seat refused
  fail-closed before admission.
- **`mstar_audit_validate`** — rule 2. It validates one review report under
  `{REVIEW_DIR}`: the credential scan of `mstar-audit` Hard Rule 4, the validator
  behind `mstar audit scaffold`. The `mstar_audit` family publishes `scaffold` /
  `secret-scan` / `supply-chain`; none of them validates an existing report file,
  so folding this one into the family would have dropped the capability.
- **`mstar_execution_clear`** — rule 2. It clears that same dsh-local
  `executionBinding` slot, and there is no shared `execution.clear` command for
  the MCP route to carry. No parameters at all: identity comes from
  `exec.agent.id`, so a `sessionId` argument (or any other argument) is ignored
  and only the caller's own binding is reachable; the user's workflow selection
  and exclusion floor are preserved. A known leaf seat
  (`header.origin === 'subagent'` or `delegationDepth > 0`) is refused
  fail-closed before the store read. Refusals: `execution.clear.no-harness` names
  the two routes that exist (open the session in a workspace declaring
  `.mstar/`/`.mstarc`, or point the plugin's `harnessDir` config at the control
  root); `execution.clear.no-binding` names the `harnessDir` config route for a
  binding recorded in another control root and states the no-action case;
  `execution.clear.store-refused` names the store's own reason and, when this
  session is keyed to another workspace, carries that workspace under
  `data.recordedCwd`.

**The two bind routes are NOT equivalent.** MCP `mstar_plan` with
`action: "bind"` binds the engine row and stops there. The native
**`mstar_plan_bind`** binds the engine row *and* writes the dsh adoption receipt
plus the durable slot. A coordinating session on this host therefore uses the
**native** tool whenever it wants dsh-local ledger attribution (workflow-ledger
rows and the clear both resolve through that record); the MCP action remains the
route for any other bind caller, including every non-dsh host.

**Holding an old tool name?** Any `mstar_<family>_<action>` spelling of a
command — the former plan / workflow / issue / sdd / iteration / design-md /
compound / roles mirrors, twelve tools in all — is gone with no alias and no
compatibility tool. Those twelve duplicated an MCP tool 1:1, so two identical
surfaces competed for the same call and the whole set cost ~10k characters of
fixed context per request. **One exception to that 1:1 phrasing:** the dsh
compound-validate mirror also published a dsh-only `repo_root` parameter for
reference-existence checks (the compound-refresh Phase 2 check), and
`compound.validate` in `packages/commands/src/families/validation.ts` carries
neither that parameter nor that check — so the capability went with the tool and
has no MCP twin. Recovery: call the folded family instead —
`mcp__mstar__mstar_plan` with `action: "prepare"` where an older document spells
the prepare mirror natively, and so on — and read the family's real actions and
parameters with `mcp__mstar__mstar_schema` (`family: <name>`, or
`command: <command-id>` for one leaf contract) instead of guessing from the old
name. For the knowledge-doc checks use MCP `mstar_compound` with
`action: "validate"` (or the CLI `mstar compound validate`) without `repo_root`;
the reference-existence half is the `mstar-compound-refresh` knowledge-write
seam's job, not an on-demand tool. The former plugin-owned command
**`/mstar-execution`** stays removed; the
ADR `docs/adr/dsh-native-identity-channels.md` (§ Superseded rationale) explains
why identity lives on the mount and the clear rather than on a command.

## Agent-flow ledger

The plugin records ACTUAL subagent dispatch and real-completion settle events —
the evidence of what really happened, distinct from the client-side expected
role flow. The workflow panel's 代理执行 (agents) page and the 事件记录
tab's `EventLogPage` log page are pure consumers of this evidence.

- **Recording point (one core)**: `DshHostAdapter.dispatchGate` is the SINGLE
  record path behind both dispatch surfaces — the `tools/pre-execute` listener
  (exec-bound; the lease gate joins here) and the host `beforeDispatch` hook
  (exec-less). Every Assignment-shaped dispatch that reaches the gate records,
  including hard denies (verdict derived: ok / advisory / denied); the shape
  guard lives at the shared core, so non-Assignment text stays silent on BOTH
  surfaces (the listener's own guard plus the core's guard for the exec-less
  hook path — no phantom records). Recording is advisory (try/catch-contained,
  logs only `mstar/agent-flow`) — a failing ledger never blocks dispatch.
  Known tradeoff: the same logical dispatch crossing BOTH surfaces (a host
  `beforeDispatch` followed by the identical text as an in-loop subagent tool
  call) records two dispatch events — the surfaces are mutually exclusive by
  design; the double record is documented, not deduplicated.
- **Native storage / bounds**: host machine state lives in the existing
  control-root `store.db` domain: `dsh_ledger_events`,
  `dsh_accepted_identities`, `dsh_scan_bounds`, `dsh_session_bindings` and
  `dsh_status_emissions`. Catalog/panel windows are read projections, not
  storage retention. No shared JSONL tail/index/cursor/cache authority,
  compaction journal, file freeze or directory lock remains. An unavailable
  authority is absent evidence, never a fabricated empty view. Before ACTIVE,
  native host session logging continues; authority persistence reports
  unavailable/degraded with supported `store init` / `store upgrade` recovery,
  not a legacy-file fallback.
- **Record identity and accepted source replay**: verified native workflow
  events retain `{sessionId, streamId, seq}` and
  `wfe1:<kind>:<sessionId>:<streamId>:<seq>`. The stream incarnation comes
  from the durable native session header, never the store epoch or file mtime.
  Their append, accepted-identity/digest check and monotone scan-bound advance
  commit in one native transaction. Reusing an accepted identity with different
  bytes refuses without overwriting it. Live dispatch/settle/link/verdict rows
  are append evidence and may repeat; a correlation ID does not deduplicate
  them. Original legacy tail/history/index/cursor bytes remain read-only
  one-time import/history through `mstar store upgrade`, never live authority.
- **Settle = real completion pairing, never faked**: `tools/post-execute`
  IS part of the
  verified dsh-tools registry surface (`runPostExecute` dispatches the
  waterfall for every tool call — verified against the upstream source and
  pinned by a real-call probe). The pairing listener matches dispatch TOOLS
  (Config `dispatchTools`, default `['subagent', 'subagent_fork']`), looks up
  the exec's agent-namespaced call key in the apply-scoped pairing store, and
  branches on the verified result shapes:
  - `{ kind: 'background', jobId }` (the registry job id, `<kind>-N`) → store
    `jobId → dispatchRef` and the bounded job id as the ref's `taskRef`; the
    REAL settle arrives via `ctx.inject(['jobs'])` → `jobs.onJobDone`
    (terminal mapping completed → ok / killed → denied / failed → error,
    `durationMs` when available). A background value without a valid `jobId` →
    nothing mappable (no settle).
  - `{ kind: 'continuable', subagentId }` → no terminal signal this round →
    no settle (documented limit — the child owns its turns); the value
    authorizes the child-identity join below and nothing is copied onto a
    settle.
  - any other successful value (foreground included) → settle `ok`; a failed
    result (`isError` or an `error` payload) → settle `error`. A returned
    foreground `runId` is the settle's `childId`, extracted independently of
    the outcome (an error settle keeps its identity without becoming `ok`).
  Pairing is apply-scoped (in-memory `callId → dispatchRef` /
  `jobId → dispatchRef` maps created in the entry `apply`; an HMR restart
  resets them, and completions outside the window stay unpaired). Every
  PAIRED settle carries the paired dispatch's identity (`role`/`planId`/
  `taskId` — same field names + semantics as the dispatch event; the registry
  job id is never written as `taskId` — `taskId` stays the Assignment `Task N`
  tag, `taskRef` is reserved for the registry id). Unpaired payloads
  (non-dispatch tools, calls outside the pairing window) record NOTHING — the
  ledger stays dispatch-only, never a fabricated settle.
- **Child identity (`subagent-link`, nonterminal)**: the child session id is
  published upstream as a PARENT-OWNED `subagent/catalog` session event
  (`{ version: 0, childId, childCreatedAt, mode, label }`; `label` = the
  delegation `description`), appended by the tool body — for the continuable
  path BEFORE the tool returns. The join spans a per-dispatch CALL WINDOW: the
  pre-execute reserves the first raw-label slot under the live parent Session
  object and captures its `seq` as the window start; a valid `background` /
  `continuable` result at `tools/post-execute` makes that exact candidate
  eligible (every other outcome retires it to a tombstone; a duplicate label
  was already refused a candidate at reservation). Eligibility walks
  `eventAt(seq)` over `[fromSeq, end)`, where `end` is the session's `seq`
  CAPTURED when the candidate became eligible — recovering a catalog appended
  before the tool returned — while ONE root-context `session/event` observer
  feeds the same matcher for later arrivals against the session's CURRENT
  `seq`: only that live observer follows the session forward, so a catalog
  appended after eligibility still joins through it (the catch-up scan stays
  frozen at its captured endpoint). A matched
  candidate is consumed once and appends `{ v: 1, ts, kind: 'subagent-link',
  agent?, childId, label, role, planId?, taskId?, taskRef? }` to the
  DISPATCH's own workflow dir (`ts` = observation time), correlating the
  catalog child back to the dispatch identity mstar recorded. It is an
  IDENTITY record, NOT a completion: no `outcome`, no `verdict`, no `paired`
  marker. A background one-shot link also carries its registry `taskRef`; a
  continuable link omits it. Settle rows carry an optional `childId` — a
  foreground `runId`, or for background only when the join has already
  supplied one.
- **Join bounds (honest degrade)**: NO row when the label is missing/empty,
  the dispatch unpaired, a background result carries no valid `jobId` (the
  reserved candidate is retired — nothing mappable: no settle, no link),
  the catalog version unknown, the mode not matching the result kind,
  a continuable catalog naming a different child than the tool returned,
  the slot map at capacity (500 labels per parent Session), or the slot
  already consumed. The join is apply-scoped: no whole-history cold
  scan and no `session/created` backfill — a catalog written before apply
  (constructor seeds) can never label a new dispatch. Duplicate labels are
  deterministic best-effort (first reservation + first matching catalog wins),
  NOT proof of unique ownership. Not every provider emits a catalog — a remote
  run without a `localAgent` produces none, so a dispatch may legitimately
  have no link row.
- **Catalog**: `state.agentFlow` carries the ledger view (`events` ≤ 50,
  latest-first, + `summary`) for the panel — the compact
  `<mstar_engine_status>` row does NOT render a ledger line (a ledger event is
  not a lifecycle delta the model acts on, and it kept spending a full row).
  A ledger record (dispatch/settle/link) invalidates the affected workspace's
  TTL cache entry IMMEDIATELY (apply-scoped `harnessDir → cache key` reverse
  map + invalidation closure) → the next pre-step rebuilds, persists the new
  payload for the panel and re-injects a row only if a RENDERED fact moved.
  The 60 s TTL no longer bounds ledger-change latency for the panel; it still
  bounds non-ledger staleness.
- **Explicit ledger target (ACTIVE authority)**: each event boundary resolves
  the session's selected native target and validates its current store identity,
  epoch and workflow scope. Missing, stale, revoked, corrupt or mismatched
  authority records no accepted fact and never selects a newest/only workflow,
  root file or legacy target. Native session logging remains independent of
  whether authority persistence is available.
- **Maintainer view**: change the ledger shape (event schema, bounds, settle
  seam) and update the projections together — `gates/agent-flow.ts` (record /
  read / settle / catalog-join listeners), `gates/catalog.ts` (the `agentFlow`
  payload view + the panel-projection emission key) and
  `client/panel/graph/project-graph.ts` (the ZoneView flow/agents projection) —
  the panel renders ONLY what the evidence shows.

## PM dispatch

Harness **dispatch** on dsh carries the full Assignment text as the delegation
prompt (role binding in the prompt — `Execute as` / `Act as` + skill load;
there is no separate `agent` field, the Assignment body IS the prompt). **Which
tool carries it is the mounted channel's decision** (§ Delegation channels):
with Agent Teams mounted, one board task plus one `spawn_teammate` per assignee;
on a direct-`subagent` profile, one `subagent` call per Assignment. **N
assignees = N independent delegations** on either channel (dispatch-gate
口径: one assistant message carries all N invokes — the gate counts each
dispatched Assignment, board task or `subagent` call alike). Paste-only
Assignment without an invoke is **not** dispatch.

**Role-binding field:** none — binding is **prompt-only** on dsh (the tool has
no role field; the header region of the Assignment body is what the gate and
the role-preset channel read, so `Execute as` / `Act as` + skill load must be
in the prompt). A dispatch that drops those lines has no field to fall back on
— it is a bare delegation.

**Execution: same-message invokes start concurrently.** The installed `subagent`
tool declares **`isConcurrencySafe: () => true`**, so a batch of invokes emitted
in ONE assistant message is admitted concurrently instead of serialized. Each
call is a **one-shot activation**, not a synchronous run: it returns
`{ kind: 'activation', subagentId }` (rendered `started subagent <id>`) as soon
as the runtime accepts the child, and the parent receives a **settlement
notice** when that child finishes — the call itself waits for nothing. The
tool's input schema is `cwd` / `description` / `prompt` plus the optional
preset and child-route fields: it has **no background-mode parameter** and **no
structured-output schema parameter**, so a child's structured result arrives
through its settlement notice and follow-up turns travel through
`send_message` (continuable providers), never through a tool argument.

Dispatch consequences:

- **N assignees = N invokes in one message.** Admission is concurrent, so an
  N-seat batch costs roughly one seat of wall time; nothing needs to be
  "backgrounded" to overlap.
- **Capacity is bounded.** The activation pool defaults to **8 concurrent
  children** (`maxActiveSubagents`, a deployment setting); an invoke beyond the
  free pool is rejected with `subagent limit reached (active child limit: 8)`,
  which means that seat never started. Keep one message at or below the free
  pool width, or dispatch the remaining seats after earlier children settle.
- **A missing or rejected invoke is dispatch-incomplete for its seat** — record
  it plainly and recover as the owning skill allows. It is never a reason to
  declare the whole batch `Blocked`: there is no background mode to switch to.
- **Activation is not completion.** A returned `subagentId` proves only that
  the child started; completion evidence is the settlement notice (and, where
  the role hands back a report, the child's closing message).

**Leaf completion discipline — closing message, not the report tool (PM
2026-08-12).** Leaf subagents hand back their Completion Report in the
**final (closing) message** — do NOT call the `report` tool to deliver it.
The dsh tool-subagent-report default `reportDelivery: quiet` routes a report
through `parent.inject` into the parent's **next-step queue**; when the
parent's turn has ended (no step boundary follows), the report strands in
the "queued messages" dock instead of reaching the parent (observed on dsh).
The closing message is the guaranteed delivery channel; reserve `report` for
MID-turn findings that change what the parent should do next.

### Progress discipline — native workflow, never `/goal`

dsh progress is driven by the **native workflow**: the workflow snapshot phases
+ the dispatch gates + **subagent settle notifications**. mstar **stops arming**
a goal on dsh — the surviving bridge is advisory-only (no `create` / `edit` /
`complete` / `pause` / `resume`, no goal read) — so no goal round loop drives
mstar work here. Never drive a dsh session with a `/goal` objective or a goal
round loop: `goal-round-driver` opens a round whenever the goal is active +
armed and the agent is idle, and it knows nothing about running subagents, so
an operator who arms `/goal` manually can still get rounds firing while a
dispatched child owns the critical path.

**Phase 2 continuous execution is a PM-local loop**, not a one-wave-at-a-time
queue: each child's settle notification is a **`result-settled`
`Rescheduling checkpoint`** — run that checkpoint and dispatch what is already
ready and authorized (independent plans and plan-local tasks, each in its own
isolated track) before waiting, and wait only when it finds none. Waiting stays
the correct action for work a running child already owns — never open another
unit of work **against the same worktree**. Procedure (and its frozen reason
vocabulary) → `mstar-iteration/references/phase-2-worktree-lease.md` §2.4.

No-argument iteration-drive resumes the primary coordinator's workflow; nonempty arguments refuse. It still never arms a goal here. The coordinator advances rows directly through ordinary prepare/progress/complete, with native leaf scheduling and real serial integration.

### QC default

- **`Execution mode: sdd`**: **N=3** seats — one per QC seat (`qc-specialist`,
  `qc-specialist-2`, `qc-specialist-3`), each body **Act as** the respective QC
  role + QC skill load. Read-only fan-out of N≥3 on dsh uses the native
  **`workflow`** tool (the `mstar-qc-tri` script — § Read-only fan-out via the
  `workflow` tool): one run, three concurrent children, one conversation
  `workflow-run` node. When the tool is not mounted (the `ptc` preset hides it),
  fall back to the `subagent` path below. **The `subagent` path emits all three
  invokes in ONE message**: the host admits every dispatch before any
  settlement, so all N are admitted before the first seat settles and the seats
  run CONCURRENTLY (wall ≈ single seat). There is no serialization promise
  either way — a PM that waits for each settlement before emitting the next
  invoke is what spaces the batch out and costs the wall time. The call return
  (`started subagent <id>`) is an activation, never a completion. A seat that
  cannot be started at all → **`Blocked`**.
- **`inline`**: **N=1**.

### SDD implement

- **`Execution mode: sdd`**: one implementer delegation per ready task id, on the
  mounted channel: with Agent Teams, one board task per task id and one
  `spawn_teammate` per track, each handed its own worktree; on a
  direct-`subagent` profile, one `subagent` call per task id. Independent tracks
  are started together so their activations overlap, then the PM waits for
  settlement, per **`mstar-sdd`** § Ready-task scheduling. The task reviewer is a
  fresh separate seat on either channel. Sticky resume is a durable teammate
  resumed by name on the Team channel, and a recorded continuable-subagent id on
  the direct one.

## Read-only fan-out via the `workflow` tool

dsh also exposes the upstream **`workflow`** tool
(`@deepseek-ai/dsh-tool-workflow`, mounted by the shipped agent presets; the
`ptc` preset disables it in favour of its own orchestration surface). It runs a
model-written plain-JavaScript script that fans children out inside ONE run; the
run is recorded as durable `tool-workflow/*` session events and the stock dsh UI
(`dsh-client-ui-workflow-run`) folds them into one conversation **`workflow-run`**
node the operator expands by phase and member. Use it for **read-only fan-out of
N ≥ 3 seats** — plan QC tri, large-repo audit categories, `/amazing-pr-review
deep` seats — and copy the `script` + `meta` + `args` from this skill →
`references/dsh-workflow-scripts.md`. For **1–2** seats a direct delegation is the
cheaper default — **`subagent`**, or a teammate when the Team layer is mounted —
following the tool's own guidance: the two-seat default tier of
`/amazing-pr-review` shows two subagent cards and no `workflow-run` node, and
that is expected.

**One read-only seat is supported when nothing else can carry it.** On a Team
profile the direct `subagent` rows are disabled, and a task review needs a fresh
context without taking a roster seat — so a **one-seat `workflow` run** is the
supported route there, with its executable form in
`references/dsh-workflow-scripts.md` § 4 `mstar-review-single`. It costs one
`workflow-run` node instead of a subagent card; that is the price of keeping the
reviewer off the finite roster, not an unsupported workaround.

**Read-only only.** A workflow child is a delegated child (the shipped `spawn`
provider pins `approval: never` for the whole delegation), and the run has **no
per-child pre-start veto seam** — so a script is never the channel for writable
work; writable fan-out goes through the mounted delegation channel
(`spawn_teammate`, or `subagent` on a direct profile) behind the dispatch and
lease gates.
Seats return findings in their result payload and must never depend on writing
files — the caller persists the seat reports.

**Every `agent()` prompt starts with the Assignment header** — `## Assignment`
plus `Execute as` / `Delegation` / `Task category` as the first lines:

```markdown
## Assignment

Execute as: qc-specialist
Delegation: forbidden
Task category: audit
```

Role binding on dsh is prompt-only (there is no `agent` field), and the same
engine grammar is what the role-preset channel parses
(`packages/dsh/src/gates/role-persona.ts` reads only the header region) — so
`Execute as: qc-specialist` selects the agent preset the deployment declared for
that role (dsh 0.2.1 delivers a child's identity through preset selection; a
role with no configured preset leaves the child on the delegating agent's
composition). Keep body-quoted field examples out of the header region, and
never pass the deferred `agentType` option: the engine rejects it loudly.

| Operator types | N | Tool | `meta.name` | Operator sees |
|---|---|---|---|---|
| `/codebase-audit` (large repo) | ≥3 | native `workflow` | `mstar-audit-fanout` | conversation `workflow-run` node |
| `/amazing-pr-review deep` | ≥3 | native `workflow` | `mstar-pr-seats` | same |
| `/amazing-pr-review` default tier | 2 | `subagent` | — | two subagent cards, no node (expected) |
| Plan QC tri (PM already in session, no extra slash) | 3 | native `workflow` | `mstar-qc-tri` | conversation `workflow-run` node |
| Any 1–2 read-only delegation | 1–2 | `subagent` | — | expected |

`meta.name` is the gate identity — keep it kebab-case and on the recommended
list. With the default Config (`workflowNames` unset) every name is *unknown*,
which under the default `workflowGate: warn` is one `workflow.name.unknown`
**advisory that the run survives** — acceptable on a first run, not a failure. A
production overlay may set `workflowNames: ['mstar-qc-tri', 'mstar-audit-fanout',
'mstar-pr-seats']` (and, separately, `workflowGate: hard`); both are operator
choices, never mstar defaults. The same run also reaches the panel's 事件记录 tab
through the agent-flow ledger (§ Agent-flow ledger).

## Commands and skills paths

| Surface | Path / invocation |
|---------|-------------------|
| Plugin skills | Skill **name** via the mstar skill-local provider (`ctx.skills`); canonical `$DSH_BUNDLED_SKILL_DIR/<name>` |
| Plugin commands | The seven bundled `harness-commands/` commands — `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`, `/amazing-pr-review`, `/amazing-e2e-check`, `/amazing-test-audit` |
| Session entry | `pm` skill → `mstar-harness-core` via pm **Read next** |

## Command delivery (dsh host, updated 2026-08-11)

The dsh web client resolves slash commands against a client-side lexicon driven by the registry's `input.hint`. Every mstar command declares a frontmatter `input` hint (see `commands/*.md`), so the client **claims** it on menu pick: `/name ` is inserted into the composer with the command highlight and the hint as ghost text (e.g. `/iteration-start [direction] [pause]`), the user types follow-up args (or just presses Enter for arg-less commands), and the line submits only on Enter. The handler steers the command body into the receiving agent as a USER-source message, appending the typed args as a `## User input` section when present.

**Degradation fallback:** when a command is NOT claimed client-side (lexicon fetch timing, args parsing, manual typing), the model receives the **bare text** (`/iteration-loop <方向> …`) with NO command body — unlike opencode/cursor/omp where the body always arrives.

**Rule:** when a user message begins with a registered mstar command name (`/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`, `/amazing-pr-review`, `/amazing-e2e-check`, `/amazing-test-audit`) but carries no command body, treat it as that command invoked with the user text as its argument — execute the command's OWN semantics from the repo `commands/<name>.md` (or the mirrored `harness-commands/`): in particular **`/iteration-loop` = autonomous (code-first direction lock, NO grill-me questions)**, `/iteration-drive` = Phase 2–5 on the active iteration, `/iteration-start` = interactive (grill-me). Do not silently substitute the interactive start flow for `/iteration-loop`. Also do not re-ask what the command already specifies (e.g. scale auto → M default, branch policy continuity).

## Harness dir and environment

- `{HARNESS_DIR}` resolves via the engine `resolveHarnessDir` (`.mstarc`
  `[config] harness_dir` → `.mstar/` → `.agents/` → `.plans/`/`plans/`),
  with the plugin Config `harnessDir`
  override winning. The probe starts from the SESSION workspace root (the
  session cwd — **never the dsh launch/process cwd**) and **STOPS there** — it
  never walks above the session workspace, so the watermark and gates follow
  the workspace the session actually works in. Repos using a
  non-standard harness root MUST set Config `harnessDir`
  (absolute path) or declare it in a repo `.mstarc` — the gates are inert
  without a resolvable harness dir.
- The dispatch gate needs the dispatching agent's own role for the
  anti-recursion precheck: declare it via Config **`dispatchBinding`** (dsh
  exposes no per-agent role on the tool-execution context). Under hard
  enforcement with no binding, the plugin logs the absence AND every
  Assignment-shaped dispatch fails closed (`dispatch.anti-recursion.
  empty-binding` → deny) until the binding is set.
- **Caller-scoped engine enforcement (the dsh-only half of issue #156).** That
  binding is what makes the precheck real here: with a declared dispatcher
  identity the engine compares the **dispatching seat's own role** against the
  Assignment `Execute as` and hard-enforces it (`callerRequired` — an unset
  binding fails closed, never skipped). Hosts whose reference declares **no**
  dispatcher binding expose only the **spawn target** in their role-binding
  field — and target == `Execute as` is the compliant C5 pattern — so there the
  leg is skipped and the red line stays **prompt-level**
  (`mstar-dispatch-gates` § 承接方反递归红线).

## Files, shell, and approvals

- Prefer host search/edit tools over shell find/sed when available.
- Respect dsh approval prompts for destructive operations.
- Do not edit `$DSH_HOME` credentials or user secrets without explicit consent.

## Git and final evidence

- Git work follows `mstar-branch-worktree` and Assignment **Working branch** /
  **Branch policy**; the worktree L1/L2 gates run in-process.
- Completion reports cite concrete commands, artifacts, and commit lines when
  required.

## Gotchas

- Do not confuse dsh **`subagent`** with opencode **`task_subagent`** or Cursor
  **`subagent_type`** — the detect rows differ by tool shape.
- A renamed `subagent` tool (Config `toolName`) silently disables the dispatch
  gate AND host detection unless `dispatchTools` declares the new name (the
  plugin warns under hard enforcement).
- A renamed Agent Teams tool (`spawn_teammate` / `send_message` /
  `team_task_create` / `team_task_update`) is out of reach until its fixed name
  is added to the plugin's `TEAM_DISPATCH_TOOLS` map; team names have no Config
  key, so the map is source-only — the same caveat as renamed `subagent`
  instances, one level stricter.
- Role binding is prompt-only on dsh: always include **`Execute as`** +
  **`Act as`** + skill load in the Assignment body — there is no separate
  `agent` field.
- Session plan UI / todos are not durable SSOT unless mirrored to
  `{HARNESS_DIR}`.
- The plugin's bundled skills/commands mirror is synced by `bundle-assets`
  (gitignored, package-local) — an explicit `bundledSkillDir` /
  `skillRoots` Config override wins when a deployment wants a different
  mirror.
