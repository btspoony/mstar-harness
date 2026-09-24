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
  injected context), returning a success result. Alongside that mirror the
  plugin registers ONE command of its own, **`/mstar-execution`** — a closed-JSON
  operator entry that is **not** steered into the model (§ `/mstar-execution` —
  native human admission below).
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
  `order: 20`) labeled **"晨星工作流" / "Morning
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

- **Runtime**: Bun-hosted host — the plugin, its gates and its in-process engine all run under dsh's Bun, floor **Bun >=1.4.0** with in-process native `node:sqlite`. Release-surface `enforcement` / `.mstarc` settings (see § Configuration) are gates, not a runtime floor: below-floor or missing-capability refuses actionably instead of degrading to a transport or JSON.
- **Upgrade / reload**: `dsh plugin --profile web add <spec>` against the published version, or re-run `npx @mstar-harness/cli init --target dsh`; then reload the profile so the composed rows pick up the new build. The bundled `harness-skills/` mirror is a build-time sync — a checkout that has not run `bundle-assets` mounts no skills. The plugin-owned **`/mstar-execution`** command comes from the plugin's own build (it is not part of the `harness-commands/` mirror), so an installed copy only offers it after that build is refreshed and the profile reloaded — a source checkout that has not been built has it neither.
- **Readiness, not an action**: refreshing an *installed* copy is a bounded, authorized ops act — an authority flip first quiesces, then reloads/upgrades (or explicitly excludes) every installed reader/writer and attests the versions it saw. Editing harness docs or source performs none of it. If this host cannot reload safely, stop at the exact manual-restart step, have the user restart, then re-verify entrypoint/runtime/version/session identity read-only before the flip.

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
| **`workflow`** | Read-only N≥3 fan-out — one run, one conversation `workflow-run` node (§ Read-only fan-out via the `workflow` tool; scripts → `references/dsh-workflow-scripts.md`) |
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
| Status gate | `fs/write-intent` + `fs/edit-intent` on `{HARNESS_DIR}/status.json` | repair-escape advisory (never vetoes the repairing write) — **except** the store-authority refusal class below |
| Store authority in the status gate | inside the status gate's document classification (register kind, snapshot cleanup extension) | **typed veto under hard, and no repair escape**: when the findings-cleanup verdict cannot be read because the issue authority is missing (`store.not-initialized`), staged (`store.not-active`), corrupt, below-floor or busy, the write is vetoed (`status.veto` / `findings.cleanup-authority-unavailable`) — the repair is a store command (`mstar store init|upgrade|migrate`), never a document write |
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
repair escape) — **except** the status gate's store-authority refusal class,
whose veto rests on the authority being unreadable rather than on the
document's content, so no content can repair it. The register kind itself
stays synchronous shape validation: a project register is migration history,
and a retired path is not a lookup. Config / `.mstarc` `soft` are the local
rollbacks. Hard gates are never a global default.

Every composed agent step carries ONE **`<mstar_engine_status>`** catalog
message: the watermark (unified mstar version, harness dir, enforcement),
the iteration phase-gate section when a steering compass resolved, and the
workspace-state digest section (plan registry, open issues from the store rollup,
branch/policy anchors, active leases, knowledge digest, compass direction)
when the workspace has a `status.json`. The row is digest-gated (once per
turn, re-injected only when it changed) over one per-workspace TTL-cached
build (`catalogTtlMs`, default 60 s).

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
- A missing (`store.not-initialized`) or staged (`store.not-active`) store keeps
  the legacy file authority in force, so those writes still pass through the
  register's own document validator.
- This plugin **does** ship one host-native human execution entry: the
  plugin-owned command **`/mstar-execution`**, registered through the `ctx.commands`
  service (`registerExecutionSessionCommand` →
  `ctx.inject(['commands'])` → `commands.register({name:'mstar-execution', …, input:{hint:'{operation JSON}'}})`,
  `packages/dsh/src/gates/execution-session.ts:127-136`), wired at plugin apply
  (`packages/dsh/src/index.ts:725`). Its semantics are documented under
  **§ `/mstar-execution` — native human admission** below.

### `/mstar-execution` — native human admission

A cooperative association/transport boundary the human invokes directly, never a
model tool and never a fence:

- **Closed JSON input, executed without sending the payload to the model.** The
  raw input is parsed as JSON by `parseExecutionRequest`
  (`execution-session.ts:52-71`) into exactly one of three shapes; anything else
  refuses:
  `{operation:"adopt", sessionRef}` (only those two keys; `sessionRef` the
  canonical `exec-session-v1:` wire), `{operation:"clear"}` (no extra fields), or
  `{operation:"run", workflowId, role:"coordinator"|"plan-pm", planId, argv}`
  (exactly five keys, non-empty `argv` of non-empty strings, `planId` `null` or a
  non-empty string). A malformed, mixed or extra-field payload throws
  (`execution command input must be JSON` / `… must be a closed JSON object` /
  `adopt requires only a canonical sessionRef` / `clear does not accept extra
  fields` / `run requires workflowId, role, planId, and a non-empty argv` /
  `unknown execution operation`). The command's returned text goes to the
  operator, not into the model's context: the payload is an operator intent, and
  no model tool path can reach this entry.
- **Identity comes from the carrying native session only.** `nativeFacts`
  (`:38-46`) reads `CommandInvocation.agent.session.header` — `header.id` (the
  session id) and `header.cwd` — and throws `native session identity and cwd are
  required` when either is missing; nothing is taken from command fields, tool
  arguments or a spawn target.
- **Known leaf/subagent seats refuse on every operation, before any parse and
  before the harness probe** (`:98-104`): `header.origin === 'subagent'` or a
  positive `header.delegationDepth` throws `known leaf sessions cannot adopt,
  clear, or launch execution` — a leaf can never obtain a writer seat and can
  never hand a coordinator identity to a child. Eligibility is taken from these
  authoritative facts; if it cannot be established the call refuses rather than
  inferring it.
- **`adopt` is read-only first.** It decodes the reference, requires
  `ref.sessionId` to equal the native session id, builds the canonical
  `ExecutionBinding {version: 1, harnessRoot, session}` and runs the **C1
  resume** (`resumeExecutionSession`) under a host identity before anything is
  written; a resumed session/workflow that does not match the native session
  throws `current execution session admission did not match the native session`,
  and only then does the F3 slot adoption run
  (`adoptExecutionBinding`, `workflow-selection.ts`). Success text:
  `execution binding adopted for <workflowId>`. Adoption mints **no** authority:
  the engine's own admission did.
- **`clear` is one explicit slot-clearing write** (`clearExecutionBinding`,
  `workflow-selection.ts`) that preserves the session's user selection and
  exclusion floor; a session with nothing to clear throws `no clearable
  execution binding`. Success text: `execution binding cleared`.
- **`run` is the host-native launcher.** It validates the requested scope with
  `executionContextFor` (an invalid scope throws before a child exists), then
  spawns with `shell: false` (`runExecutionCommand`, `:79-95`) after building the
  child environment in `identityEnv` (`:72-77`), which **deletes every spoof key**
  (`MSTAR_EXECUTION_IDENTITY`, `MSTAR_EXECUTION_SESSION_ID`,
  `MSTAR_HOST_SESSION_ID`, `MSTAR_HARNESS_DIR`, `MSTAR_SESSION_ID`,
  `MSTAR_CALLER_ID`) and then sets `MSTAR_EXECUTION_IDENTITY` to
  `serializeExecutionValue({source:"host", sessionId, workflowId, role, planId})` —
  the engine's canonical identity serialization. The child inherits the session's
  native id (no local identity is minted), cancellation aborts it (`SIGTERM`),
  and the result is `success` on exit 0 (text = stdout) or `error` otherwise
  (text = stderr or `execution exited with code <n>`).
- **Capability stays decision-only.** This command is not a veto and not an OS
  process fence: it cannot stop an arbitrary native write, and the plugin's
  other verdicts (status/store authority, dispatch, lints) remain decision
  records plus logs — on this host an authority decision is surfaced, not
  enforced, wherever the host exposes no refusal channel. Model tool paths
  consume persisted bindings; they never gain authority from a human command
  payload.

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
- **File / bounds**: events append to the ACTIVE workflow dir —
  `{HARNESS_DIR}/workflows/<id>/agent-flow.jsonl` (JSON Lines, one event per
  line; harness dirs are gitignored by convention) — never the harness root:
  with no active lifecycle the record is SKIPPED with a one-time warn. The
  append, the durable identity commit and the scan-bound advance form ONE
  critical section behind a per-workflow lockdir (`recordWorkflowEvent`), so a
  second dsh session sharing the active lifecycle cannot silently drop the other
  writer's lines (steady state stays one writer per workflow dir); any loss here
  only under-reports actual flow in the panel, never a gate impact. The catalog
  read returns the latest-first view with a default window of **50** and a role ×
  outcome summary. A MISSING ledger file reads as the empty view ("no actual
  dispatches yet" — recording starts at plan merge); an unreadable file is
  absent evidence; malformed lines are skipped, never fatal.
- **Record identity, dedup authority and the durable cursor**: every new row
  carries a stable `eventId`. Durable workflow events carry the verified source
  position `{sessionId, streamId, seq}` and the id
  `wfe1:<kind>:<sessionId>:<streamId>:<seq>`, where `streamId` is the log's
  verified native **incarnation** — derived from the durable session header's
  creation stamp, never the store epoch and never a file mtime — so a session
  cross or a rebuilt log cannot collide. Live tool-call rows
  (`dispatch` / `settle` / `subagent-link` / `workflow-verdict`) carry
  `wfc1:<sessionId>:<callId>:<kind>` only when the seam supplies BOTH the
  carrying session id and a call id; a row without them is recorded **without**
  an id, never as `wfc1::`. Rows predating this keep their exact bytes and
  line-offset identity — they simply carry no `eventId`. The **dedup authority
  is the durable accepted-identity index** (`agent-flow-ids.jsonl`, one fsynced
  line per accepted row), which survives tail compaction and cursor eviction;
  the cursor sidecar (`workflow-ledger-cursors.json`, version 2 `{next, stream}`
  with version-1 read compatibility) is reduced to a per-incarnation **scan
  bound**. A MISSING index is a legitimate first run only while no retained
  history chunk holds an index-scoped (`wfe1:`) accepted row — a history of only
  live tool-call rows or legacy rows still proceeds — while an unreadable or
  damaged history/index refuses instead of reading as "no history", a session
  whose log head cannot be read records **nothing** rather than inventing an
  incarnation, and an event id already present with different bytes is an
  advisory refusal (no append, no cursor advance).
- **Bounded display tail + archived history**: the 500-event display bound is
  unchanged, but evicted lines are archived byte-exact into `fsync`ed sealed
  chunks under `<workflowDir>/agent-flow-history/chunk-NNNNNN.jsonl` **before**
  the tail is rewritten. The pair is one transaction recorded in the transient
  `agent-flow-compaction.json` journal (`tailBefore`/`tailAfter` full-file
  sha256, the exact archive range and the removed line count): the record is
  durable before the archive is touched, the archive before the tail is
  replaced, and the record is durably removed only once the range is provably
  complete. Every write path resolves an unfinished transaction first, so no
  later compaction can pass an unfinished one; a tail matching neither state —
  or a matching after-state with an incomplete archive range — is refused rather
  than guessed. Display retention and dedup retention are separate: a row may
  leave the live tail as soon as its record id is in the durable identity index,
  whatever incarnation it belongs to, because that index — not the tail and not
  the scan bound — proves the record can never be appended again. Rows without a
  source keep their bytes and are archived by line position. This is the host's
  own display/ledger behaviour; it is evidence about what happened, never
  authority, and never a lifecycle register.
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
  latest-first, + `summary`); the model-facing `<mstar_engine_status>` text
  renders ONE compact `agent flow: …` line only when events > 0 (role totals
  top-5 + latest dispatch with HH:MM — the event detail lives in the
  structured source, never the model text). A ledger record
  (dispatch/settle/link) invalidates the affected workspace's TTL cache entry
  IMMEDIATELY (apply-scoped `harnessDir → cache key` reverse map +
  invalidation closure) → the next pre-step rebuilds and (digest text change)
  re-injects the row — the 60 s TTL no longer bounds ledger-change latency; it
  still bounds non-ledger staleness.
- **Explicit ledger target (active authority)**: the plugin registers the
  consumer with F3's explicit resolver — `registerWorkflowLedger(ctx, resolver,
  adapter.workflowAskCache, resolveExecutionLedgerTarget)`
  (`packages/dsh/src/index.ts:644`; resolver at
  `gates/workflow-selection.ts`). Every event boundary awaits it and uses ONLY
  the returned target: an ACTIVE target requires the session's canonical stored
  `ExecutionBinding` plus a current SQL session row (`resumeExecutionSession`,
  with store/epoch agreement) before it may name a workflow dir, so a stale,
  revoked, missing, corrupt or scope-mismatched witness returns nothing and
  never falls back to the root or to a newest/only workflow; the legacy
  file-based target is produced only while no active execution authority exists,
  and only for a session with no stored execution binding. A `null` or
  inconsistent target records nothing at all — the consumer never infers an
  active writer.
- **Maintainer view**: change the ledger shape (event schema, bounds, settle
  seam) and update the projections together — `gates/agent-flow.ts` (record /
  read / settle / catalog-join listeners), `gates/catalog.ts` (agent-flow line
  + `source` view) and `client/panel/graph/project-graph.ts` (the ZoneView
  flow/agents projection) — the panel renders ONLY what the evidence shows.

## PM dispatch

Harness **dispatch** on dsh = a `subagent` tool call with the full Assignment
text (role binding in the prompt — `Execute as` / `Act as` + skill load;
there is no separate `agent` field, the Assignment body IS the prompt). **N
assignees = N `subagent` calls = N independent delegations** (dispatch-gate
口径: one assistant message carries all N invokes — the gate counts each
dispatched Assignment). Paste-only Assignment without an invoke is **not**
dispatch.

**Role-binding field:** none — binding is **prompt-only** on dsh (the tool has
no role field; the header region of the Assignment body is what the gate and
the role-persona channel read, so `Execute as` / `Act as` + skill load must be
in the prompt). A dispatch that drops those lines has no field to fall back on
— it is a bare delegation.

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

The **scoped plan route** changes none of this: `/iteration-drive --assignment |
--workflow --plan | --resume` still never arms a goal on dsh, and its
progression stays the plan-scoped native workflow (`mstar plan bind → progress →
handoff`, coordinator `accept` / `integration-*` / `complete`) —
`mstar-iteration/references/plan-scoped-pm.md`.

### QC default

- **`Execution mode: sdd`**: **N=3** seats — one per QC seat (`qc-specialist`,
  `qc-specialist-2`, `qc-specialist-3`), each body **Act as** the respective QC
  role + QC skill load. Read-only fan-out of N≥3 on dsh uses the native
  **`workflow`** tool (the `mstar-qc-tri` script — § Read-only fan-out via the
  `workflow` tool): one run, three concurrent children, one conversation
  `workflow-run` node. When the tool is not mounted (the `ptc` preset hides it),
  fall back to the `subagent` path below. **The `subagent` path MUST dispatch all
  three with `run_in_background: true` in one message** → the seats run
  CONCURRENTLY (background children; wall ≈ single seat); foreground (no
  `run_in_background`) runs serially (wall ≈ 3× single seat) and does NOT count
  as parallel tri. Cannot emit required **N** → **`Blocked`**.
- **`inline`**: **N=1**.

### SDD implement

- **`Execution mode: sdd`**: one implementer `subagent` dispatch per ready task id;
  independent tasks use isolated tracks and `run_in_background: true` before
  waiting, per **`mstar-sdd`** § Ready-task scheduling. Task reviewer is a fresh
  separate dispatch; sticky resume is limited to one sequential owner track
  with a recorded continuable-subagent id.

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
`references/dsh-workflow-scripts.md`. For **1–2** delegations keep **`subagent`**
(the tool's own guidance): the two-seat default tier of `/amazing-pr-review`
shows two subagent cards and no `workflow-run` node, and that is expected.

**Read-only only.** A workflow child is a delegated child (the shipped `spawn`
provider pins `approval: never` for the whole delegation), and the run has **no
per-child pre-start veto seam** — so a script is never the channel for writable
work; writable fan-out stays on `subagent` behind the dispatch and lease gates.
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
engine grammar is what the role-persona channel parses
(`packages/dsh/src/gates/role-persona.ts` reads only the header region) — so
`Execute as: qc-specialist` resolves the QC role persona for that child. Keep
body-quoted field examples out of the header region, and never pass the deferred
`agentType` option: the engine rejects it loudly.

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
| Plugin commands | `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit` (registered from `harness-commands/`) plus the plugin-owned `/mstar-execution` (closed-JSON operator entry; its payload is never steered to the model) |
| Session entry | `pm` skill → `mstar-harness-core` via pm **Read next** |

## Command delivery (dsh host, updated 2026-08-11)

The dsh web client resolves slash commands against a client-side lexicon driven by the registry's `input.hint`. Every mstar command declares a frontmatter `input` hint (see `commands/*.md`), so the client **claims** it on menu pick: `/name ` is inserted into the composer with the command highlight and the hint as ghost text (e.g. `/iteration-start [direction] [pause]`), the user types follow-up args (or just presses Enter for arg-less commands), and the line submits only on Enter. The handler steers the command body into the receiving agent as a USER-source message, appending the typed args as a `## User input` section when present. The plugin-owned **`/mstar-execution`** declares its own registry hint (`{operation JSON}`) and is the exception to that steering: it is executed by the plugin handler, its payload never reaches the model, and the hint text is a placeholder, not a body to parse.

**Degradation fallback:** when a command is NOT claimed client-side (lexicon fetch timing, args parsing, manual typing), the model receives the **bare text** (`/iteration-loop <方向> …`) with NO command body — unlike opencode/cursor/omp where the body always arrives.

**Rule:** when a user message begins with a registered mstar command name (`/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`) but carries no command body, treat it as that command invoked with the user text as its argument — execute the command's OWN semantics from the repo `commands/<name>.md` (or the mirrored `harness-commands/`): in particular **`/iteration-loop` = autonomous (code-first direction lock, NO grill-me questions)**, `/iteration-drive` = Phase 2–5 on the active iteration, `/iteration-start` = interactive (grill-me). Do not silently substitute the interactive start flow for `/iteration-loop`. Also do not re-ask what the command already specifies (e.g. scale auto → M default, branch policy continuity). **`/mstar-execution` is not covered by this fallback**: it has no repo `commands/<name>.md` and no model-facing semantics — a body-less mention of it is not an instruction to the model, and the model must never try to parse, replay or substitute its JSON payload; the operator invokes it through the host command registry.

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
- Role binding is prompt-only on dsh: always include **`Execute as`** +
  **`Act as`** + skill load in the Assignment body — there is no separate
  `agent` field.
- Session plan UI / todos are not durable SSOT unless mirrored to
  `{HARNESS_DIR}`.
- The plugin's bundled skills/commands mirror is synced by `bundle-assets`
  (gitignored, package-local) — an explicit `bundledSkillDir` /
  `skillRoots` Config override wins when a deployment wants a different
  mirror.
