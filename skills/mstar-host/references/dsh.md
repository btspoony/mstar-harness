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
- Plugin commands: the plugin registers the bundled **`harness-commands/`**
  mirror as slash commands on `ctx.commands` — **`/iteration-start`**,
  **`/iteration-drive`**, **`/iteration-loop`**, **`/codebase-audit`**. Each
  command steers its command body into the receiving agent as a USER-source
  message (the mstar workflow prompt — the model executes it as a task, not
  injected context), returning a success result.
- **No `sessionStart.skill`** — enter PM manually via the `pm` skill (the
  `mstar-roles` load path), then **Read next** → `mstar-harness-core` →
  `project-manager.md`.
- Model-facing tools: the plugin registers **`mstar_sdd_workspace`**,
  **`mstar_sdd_task_brief`**, **`mstar_iteration_gate`**, and the seam
  validators **`mstar_design_md_validate`** / **`mstar_audit_validate`** /
  **`mstar_compound_validate`** / **`mstar_roles_validate`** on `ctx.tools`.
- Web client plugin (workflow panel): the same `mstar` bundle row carries a
  browser client half (`dsh.client` + `exports["./client"]`) discovered
  automatically by `ClientModuleHostService` — no separate profile layer or
  install step. It registers a **right-Sidebar page tab type** (`id:
  '@mstar-harness/dsh'`, `kind: 'mstar-workflow'`, one guide-page capsule at
  `order: 20`) labeled **"启明星工作流" / "Morning
  Star Workflow"** rendering the latest `mstar-engine` catalog **anchor** row
  — the persisted source is the bare first-party `plugin` arm
  (`{ kind: 'plugin', plugin: 'mstar-engine', form: 'catalog' }`, no
  payload members; the anchor reader also accepts the legacy
  `mstar-engine-status` identity from persisted logs), and the payload is fetched from the host's
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
  with **enforcement first** then push / worktree / control worktree,
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
  body renders nothing while `tab.visible === false`. Panel acceptance is
  dual-track: in-loop browser harness verification against the rebuilt
  bundle plus user-restart final GUI acceptance.

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
| **`subagent`** | Primary dispatch — the model-facing delegation tool the dispatch gate matches (default `toolName`; a renamed instance must be declared via Config `dispatchTools`) |
| **`mstar_iteration_gate`** | Evaluate the iteration phase gate in-app (`evaluatePhaseGate` — `mstar iteration gate` parity) |
| **`mstar_sdd_workspace`** / **`mstar_sdd_task_brief`** | SDD workspace resolve + task brief extraction (`mstar sdd …` parity) |
| **`mstar_*_validate`** | On-demand seam validators (design-md / audit / compound / roles) |
| **bash / read / write / edit / grep / glob / web_search** | Standard agent tools — evidence per `mstar-coding-behavior` |

### `subagent` dispatch shape

The dsh `subagent` tool is the delegation channel (schema rendered by
`@deepseek-ai/dsh-tool-subagent`; `provider`-bound, default toolName
`subagent`). Dispatch an Assignment the same way as other agent-tool hosts:
the dispatch gate validates the **Assignment header region** (`## Assignment`
+ `**Execute as**` / `**Delegation**` / `**Task category**` / `**Working
branch**` / `**Branch policy**` fields — engine `composeDispatchGate`, same
violation codes as opencode/omp/CLI).

Envelope-first discipline applies: put the header fields at the top of the
Assignment body — the dsh dispatch gate reads only the header region, so
body-quoted examples never leak into header fields.

## Gates and enforcement

The plugin wires the engine gates on dsh seams (all in-process):

| Gate | Seam | Hard-mode channel |
|------|------|-------------------|
| Status gate | `fs/write-intent` + `fs/edit-intent` on `{HARNESS_DIR}/status.json` | repair-escape advisory (never vetoes the repairing write) |
| Dispatch gate | `tools/pre-execute` on the `subagent` tool | `PreToolDecision { kind: 'deny', reason }` |
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
repair escape). Config / `.mstarc` `soft` are the local rollbacks. Hard gates
are never a global default.

Every composed agent step carries ONE **`<mstar_engine_status>`** catalog
message: the watermark (unified mstar version, harness dir, enforcement),
the iteration phase-gate section when a steering compass resolved, and the
workspace-state digest section (plan registry, open residuals,
branch/policy anchors, active leases, knowledge digest, compass direction)
when the workspace has a `status.json`. The row is digest-gated (once per
turn, re-injected only when it changed) over one per-workspace TTL-cached
build (`catalogTtlMs`, default 60 s).

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
- **File / bounds**: events append to `{HARNESS_DIR}/agent-flow.jsonl` (JSON
  Lines, one event per line; harness dirs are gitignored by convention). The
  ledger assumes ONE dsh process writes each harness dir (single-writer):
  concurrent dsh sessions on the same repo can lose events (the append itself
  is near-atomic O_APPEND, but truncation is a read-modify-write) — the loss
  only under-reports actual flow in the panel, never a gate impact. After each
  append the file truncates to the most recent **500** events; truncation is
  size-gated (≈500 lines' typical size — small files stay append-only) and
  performed as an atomic temp-file rename. The catalog read returns the
  latest-first view with a default window of **50** and a role × outcome
  summary. A MISSING file reads as the empty view ("no actual dispatches yet"
  — recording starts at plan merge); an unreadable file is absent evidence;
  malformed lines are skipped, never fatal.
- **Settle = real completion pairing, never faked**: `tools/post-execute`
  IS part of the
  verified dsh-tools registry surface (`runPostExecute` dispatches the
  waterfall for every tool call — verified against the upstream source and
  pinned by a real-call probe). The pairing listener matches dispatch TOOLS
  (Config `dispatchTools`, default `['subagent']`), looks up the exec's
  `callId` in the apply-scoped pairing store, and branches on the verified
  result shapes:
  - `{ kind: 'background', taskId }` → store `taskId → dispatchRef`; the REAL
    settle arrives via `ctx.tasks.onTaskDone` (terminal mapping
    completed → ok / killed → denied / failed → error, `durationMs` when
    available), wired through `ctx.inject(['tasks'])`.
  - `{ kind: 'continuable', subagentId }` → no terminal signal this round →
    no settle (documented limit — the child owns its turns).
  - any other successful value (foreground included) → settle `ok`; a failed
    result (`isError`) → settle `error`.
  Pairing is apply-scoped (in-memory `callId → dispatchRef` /
  `taskId → dispatchRef` maps created in the entry `apply`; an HMR restart
  resets them, and completions outside the window stay unpaired). Every
  PAIRED settle carries the paired dispatch's identity (`role`/`planId`/
  `taskId` — same field names + semantics as the dispatch event; the registry
  background-task id is never written as `taskId`, `taskRef` is reserved for
  it). Unpaired payloads (non-dispatch tools, calls outside the pairing
  window) record NOTHING — the ledger stays dispatch-only, never a
  fabricated settle.
- **Catalog**: `state.agentFlow` carries the ledger view (`events` ≤ 50,
  latest-first, + `summary`); the model-facing `<mstar_engine_status>` text
  renders ONE compact `agent flow: …` line only when events > 0 (role totals
  top-5 + latest dispatch with HH:MM — the event detail lives in the
  structured source, never the model text). A ledger record (dispatch/settle)
  invalidates the affected workspace's TTL cache entry IMMEDIATELY
  (apply-scoped `harnessDir → cache key` reverse map + invalidation closure)
  → the next pre-step rebuilds and (digest
  text change) re-injects the row — the 60 s TTL no longer bounds
  ledger-change latency; it still bounds non-ledger staleness.
- **Maintainer view**: change the ledger shape (event schema, bounds, settle
  seam) and update the projections together — `gates/agent-flow.ts` (record /
  read / settle listener), `gates/catalog.ts` (agent-flow line + `source`
  view) and `client/panel/graph/project-graph.ts` (the ZoneView flow/agents
  projection) — the panel renders ONLY what the evidence shows.

## PM dispatch

Harness **dispatch** on dsh = a `subagent` tool call with the full Assignment
text (role binding in the prompt — `Execute as` / `Act as` + skill load;
there is no separate `agent` field, the Assignment body IS the prompt). **N
assignees = N `subagent` calls = N independent delegations** (dispatch-gate
口径: one assistant message carries all N invokes — the gate counts each
dispatched Assignment). Paste-only Assignment without an invoke is **not**
dispatch.

**Execution: concurrent dispatch REQUIRES background mode.** The `subagent`
tool does **not** declare `isConcurrencySafe` → fail-closed `exclusive`
classification, so same-message invokes are issued one-at-a-time (the next
invoke starts only after the previous one settles). Foreground invokes (no
`run_in_background`) settle only when the child completes → end-to-end serial
(wall ≈ N× single seat). **Therefore any N≥2 dispatch that needs parallel
execution MUST set `run_in_background: true` on EVERY invoke of the batch**:
background invokes settle at task start (task id returned) and their child
agents run CONCURRENTLY in background tasks (wall ≈ single seat, not N×).
Foreground N≥2 invokes run SERIALLY and do NOT satisfy an N-parallel
requirement — emitting them as "the dispatch" is dispatch-incomplete; if the N
background invokes cannot be emitted in one message → **`Blocked`** (same as
paste-only). **Future path (upstream suggestion, not editable from this
repo):** dsh-private declares `isConcurrencySafe: () => true` on the
tool-subagent so same-message foreground invokes can also run concurrently —
needs dsh maintainer evaluation (roadmap §7e).

**Leaf completion discipline — closing message, not the report tool (PM
2026-08-12).** Leaf subagents hand back their Completion Report in the
**final (closing) message** — do NOT call the `report` tool to deliver it.
The dsh tool-subagent-report default `reportDelivery: quiet` routes a report
through `parent.inject` into the parent's **next-step queue**; when the
parent's turn has ended (no step boundary follows), the report strands in
the "queued messages" dock instead of reaching the parent (observed on dsh).
The closing message is the guaranteed delivery channel; reserve `report` for
MID-turn findings that change what the parent should do next.

### QC default

- **`Execution mode: sdd`**: **N=3** `subagent` dispatches — one per QC seat
  (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`), each body **Act as**
  the respective QC role + QC skill load. **MUST dispatch all three with
  `run_in_background: true` in one message** → the seats run CONCURRENTLY
  (background children; wall ≈ single seat); foreground (no
  `run_in_background`) runs serially (wall ≈ 3× single seat) and does NOT
  count as parallel tri. Cannot emit required **N** → **`Blocked`**.
- **`inline`**: **N=1**.

### SDD implement (serial)

- **`Execution mode: sdd`**: one implementer `subagent` dispatch per task id;
  task reviewer = a separate dispatch (SDD review role) — no sticky resume
  unless the host's continuable-subagent id is available and recorded.

## Commands and skills paths

| Surface | Path / invocation |
|---------|-------------------|
| Plugin skills | Skill **name** via the mstar skill-local provider (`ctx.skills`); canonical `$DSH_BUNDLED_SKILL_DIR/<name>` |
| Plugin commands | `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit` (registered from `harness-commands/`) |
| Session entry | `pm` skill → `mstar-harness-core` via pm **Read next** |

## Command delivery (dsh host, updated 2026-08-11)

The dsh web client resolves slash commands against a client-side lexicon driven by the registry's `input.hint`. Every mstar command declares a frontmatter `input` hint (see `commands/*.md`), so the client **claims** it on menu pick: `/name ` is inserted into the composer with the command highlight and the hint as ghost text (e.g. `/iteration-start [direction] [pause]`), the user types follow-up args (or just presses Enter for arg-less commands), and the line submits only on Enter. The handler steers the command body into the receiving agent as a USER-source message, appending the typed args as a `## User input` section when present.

**Degradation fallback:** when a command is NOT claimed client-side (lexicon fetch timing, args parsing, manual typing), the model receives the **bare text** (`/iteration-loop <方向> …`) with NO command body — unlike opencode/cursor/omp where the body always arrives.

**Rule:** when a user message begins with a registered mstar command name (`/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`) but carries no command body, treat it as that command invoked with the user text as its argument — execute the command's OWN semantics from the repo `commands/<name>.md` (or the mirrored `harness-commands/`): in particular **`/iteration-loop` = autonomous (code-first direction lock, NO grill-me questions)**, `/iteration-drive` = Phase 2–5 on the active iteration, `/iteration-start` = interactive (grill-me). Do not silently substitute the interactive start flow for `/iteration-loop`. Also do not re-ask what the command already specifies (e.g. scale auto → M default, branch policy continuity).

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
- Role binding is prompt-only on dsh: always include **`Execute as`** +
  **`Act as`** + skill load in the Assignment body — there is no separate
  `agent` field.
- Session plan UI / todos are not durable SSOT unless mirrored to
  `{HARNESS_DIR}`.
- The plugin's bundled skills/commands mirror is synced by `bundle-assets`
  (gitignored, package-local) — an explicit `bundledSkillDir` /
  `skillRoots` Config override wins when a deployment wants a different
  mirror.
