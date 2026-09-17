# omp host reference

Load when **`mstar-host`** detection resolves **omp** (Oh My Pi / `omp` session, **`task`** tool with **`agent`** / **`tasks[]`** batch shape, **`ask`** tool, **`hub`** tool, or `/skill:pm` / `/iteration-*` from this plugin).

Plan mode: read **`omp-plan-mode-bridge.md`** when `/plan`, plan-yolo, or plan-model / read-only-with-resolve plan UX is active.

Parallel PM dispatch: read **`parallel-dispatch.md`** when dispatching **N ≥ 2** concurrent `task` invocations.

## omp-only context

- Plugin markers: **`.omp-plugin/plugin.json`** (Morning Star host marker) and **`.claude-plugin/plugin.json`** (Claude-compatible marketplace discovery). The **npm package** (`@mstar-harness/omp`) ships its own package-root `plugin.json` + `skills/` + `commands/` + `agents/` + `hooks/` + `tools/` mirrors; the **maintainer link path** is now `<repo>/packages/omp` (built) — hooks/tools moved into the package (2026-09-03), so linking the repo root provides skills/commands/agents only, with NO runtime gates.
- Runtime skills: package `skills/` (or repo `skills/` on the link path) discovered after `omp plugin install` / `omp plugin link` (OMP extension-package sub-discovery) or Claude marketplace install.
- Plugin commands: `commands/<name>.md` → slash **`/<name>`** (e.g. `/iteration-start`). omp uses the **filename** as the command name (no `morning-star-harness:` prefix).
- Plugin agents: **`agents/*.md`** are discovered into the live **`task.agent`** list after install/link + reload. Morning Star **subagent** role ids (`product-manager`, `architect`, `fullstack-dev`, `qc-specialist`, …) are valid `agent` values **when listed** — see C5. `project-manager` ships **no agent shell here** — the `mode: primary` seat is OpenCode-only (`packages/opencode/agents/`); PM enters via the `pm` skill and is never a `task` dispatch target.
- **No Kimi-style `sessionStart.skill`** — enter PM manually via **`/skill:pm`** (or the `pm` skill), then **Read next** → `mstar-harness-core` → `project-manager.md`.
- Install (user-scoped, recommended):
  - `omp plugin install @mstar-harness/omp`
  - or CLI: `npx @mstar-harness/cli init --target omp --scope global` (links `~/.mstar/harness`)
- Project scope: `omp plugin install @mstar-harness/omp --scope project` or `npx @mstar-harness/cli init --target omp --scope project`.
- Local maintainers: `omp plugin link /path/to/mstar-harness/packages/omp` (or the CLI-managed `~/.mstar/harness/packages/omp` checkout) — the linked package tree resolves the engine via the workspace member, so run `bun install && bun run engine:build && bun run --cwd packages/omp build` in the checkout first. Linking the repo root no longer provides the runtime gates (hooks/tools moved into the package); the npm install stays the primary path.
- After install/link: `omp plugin list` should show package **`@mstar-harness/omp`** (npm) or **`morning-star`** (root `package.json` name, link path). Reload / new session to pick up skills, commands, and agents.

## Skill loading

1. On entry: invoke **`pm`** via `/skill:pm` → **Read next** loads `mstar-harness-core`, then `mstar-roles` → `project-manager.md` when PM is active.
2. Read `mstar-host` and this omp reference.
3. If Plan mode is active, read `omp-plan-mode-bridge.md`.
4. Load `mstar-roles` and the active role reference.
5. Load topic skills on demand per the role reference.

Use skill names in prompts and references. Prefer `skill://<name>/…` / `/skill:<name>` over absolute local paths unless maintaining this repository. Full skill-root table (all hosts) → `mstar-host` § Resolve loaded skill root.

## Internal URLs

omp resolves **internal URL schemes** natively (see <https://omp.sh/#urls>), so skills and shared content stay addressable wherever omp installs the plugin — prefer URLs over absolute local paths:

| Scheme | Use |
|--------|-----|
| `skill://<name>` | Load a skill's `SKILL.md` — e.g. `skill://mstar-harness-core`, `skill://mstar-host` |
| `skill://<name>/<path>` | Read a file inside a skill — e.g. `skill://mstar-host/references/omp.md` |
| `local://<name>.md` | Share context / assignments with subagents — prefer over pasting large payloads inline |
| `artifact://<id>` / `agent://<id>` | Read a subagent's output artifact / a nested child's output |
| `history://<id>` | Read-only transcript of a (sub)agent session |

`/skill:<name>` (slash command to **invoke**) and `skill://<name>` (URL the model can **`Read`**) resolve to the same skill. Put URLs in `task` assignment bodies and skill **Read next** lists so a role subagent loads the right skill regardless of install path — this is what makes cross-host skill references portable on omp.

## Tools map (default agent)

| omp tool | Harness use |
|----------|-------------|
| **`task`** | Primary dispatch — fan out one or more subagents (`agent` = live-schema id; prefer Morning Star role id; batch via `tasks[]` + shared `context`) |
| **`ask`** | Structured clarify (options + recommended); prefer over free-form when choices are known |
| **`hub`** | Optional peer messaging / long-running process control among subagents — not a substitute for Assignment + `task` |
| **bash** | Commands, git, tests — evidence per `mstar-coding-behavior` |
| **read** / **write** / **edit** | File I/O (and host AST/edit variants when present) |
| **grep** / **glob** | Search (prefer over shell find/grep) |
| **web_search** / URL fetch tools | External docs / facts when present |

OpenCode **`question`** / **`task`+`subagent`**, Cursor **Task**+`subagent_type`, and Kimi/ZCode **Agent** / **AskUserQuestion** are **not** omp tools — do not assume them.

### `task` shape (operational SSOT)

Prefer the live tool schema every session. Typical batch shape:

```text
task(
  context: "<shared batch context>",
  tasks: [
    {
      name: "CamelCaseId",
      agent: "<Execute as role-id>",   # prefer live-schema role agent — see C5
      task: "<full Assignment body including Act as + skill load>"
    }
  ]
)
```

Single-task shorthand may exist depending on host version — always match the live schema. Parallel **N** Morning Star assignees ⇒ **one** `task` call with **N** `tasks[]` entries **or** **N** `task` calls in one assistant message when the host requires that shape. Count emitted dispatches = **N**.

**Envelope-first**: write `agent` + `name` as the first fields of each `tasks[]` entry, before the long `task` body — the body crowds them out and `agent` gets silently dropped (omp defaults to generic `task`, no error). SSOT → `parallel-dispatch.md` § Mandatory order.

**Role-binding field (single home)**: OMP binds the dispatched role through the `tasks[]` entry field **`agent`** — `agent: "<Execute as role-id>"`, in the batch shape `task(context: "…", tasks: [{name, agent, task}])`. This field name is omp's; no other host's invoke tool uses it. A round that writes the role only in the prompt body has set no binding.

## Role agents (C5 — hard constraint)

**Live `task` tool schema is SSOT every session.** Exact `agent` names vary by omp version and which `agents/*.md` were discovered after plugin install/link. Read the tool's Available Agents list before dispatch — do not invent names; do not hard-code stale tables over the live list.

### Selection order (required)

1. **Role match first** — if Assignment `Execute as: <role-id>` appears in the live `task.agent` list, set **`agent: "<role-id>"`**. Examples commonly present after Morning Star plugin discovery: `product-manager`, `architect`, `frontend-dev`, `fullstack-dev`, `fullstack-dev-2`, `ops-engineer`, `prompt-engineer`, `qa-engineer`, `qc-specialist`, `qc-specialist-2`, `qc-specialist-3`, `writing-specialist`.
2. **Generic built-in only as fallback** — when the role id is **absent** from the live schema, pick the closest host built-in and keep full C5b prompt binding:

| Fallback `agent` | When |
|------------------|------|
| `scout` / `explore` | Read-only orientation / codebase survey / Prepare explore |
| `reviewer` / `security-reviewer` | Optional QC assist **only if** the matching `qc-specialist*` agent is missing |
| `designer` | UI-heavy work when `frontend-dev` is missing |
| `librarian` | External library/API research assist |
| `sonic` / `quick_task` | Mechanical / low-reasoning transcription only |
| `task` (or omit if schema says omit = general worker) | Last resort general worker when no specialist fits |

3. **Anti-pattern** — **`agent: "task"` (or omitting agent) while a matching role agent is listed** is incorrect dispatch. Prefer the specialist; generic `task` is not the Morning Star default when role agents are available.

### Notes

- PM is the **primary** orchestration seat via the `pm` skill (no PM agent shell is bundled here — the `mode: primary` shell is OpenCode-only, `packages/opencode/agents/`). Do not dispatch PM-to-PM via `task` unless the live schema explicitly lists it **and** the Assignment requires it. The **scoped primary route** (`/iteration-drive --assignment | --workflow --plan | --resume`) likewise runs in the **primary session** — it is never a `task` target, and a plan session may not reach sibling rows, the root register / shared projections, or Phase 3–6 (`mstar-iteration` `references/plan-scoped-pm.md`).
- Host generics (`scout`, `reviewer`, `designer`, …) remain useful for non-role orientation / assist — they do not replace a listed Morning Star role agent for role-owned deliverables.

### Role binding in prompt (C5b — required)

omp C5/C5b SSOT is **this file**. Even when `agent` already matches the role id, still bind Morning Star process in the Assignment / `task` body (agent shell ≠ full role prompt; skill load is not automatic).

Required in every role dispatch:

1. **`Execute as: <role-id>`** in Assignment (harness routing SSOT).
2. **`Act as <role-id>`** (or equivalent) at the top of the `task` body.
3. **Skill load list** — instruct the subagent to read `mstar-roles` → `references/<role-id>.md` (or shared reference + parameters) and topic skills per that reference.
4. **`agent`** — live-schema role id per C5 above (not “always `task`”).

Paste-only Assignment **without** a `task` invoke is **not** dispatch.

Assignment / prompt template:

```markdown
## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Working branch**: feat/example
**Plan Path**: .mstar/plans/20260717-example.md

**IDENTITY:** You ARE `fullstack-dev`. Act as `fullstack-dev` for this task.

Load: `mstar-harness-core` → `mstar-host` → `omp.md` → `mstar-roles` → `references/fullstack-dev-shared.md` → topic skills per that reference.

<task body>
```

omp invoke shapes, same turn:

```text
task(
  context: "Morning Star dispatch for plan 20260717-example",
  tasks: [{
    name: "ImplementAuth",
    agent: "fullstack-dev",   # live-schema role id matching Execute as
    task: "<full Assignment body including Act as + skill load>"
  }]
)
```

Review & Edit / Prepare specialist chain (sequential, **N=1** each turn — re-set **`agent`** on **every** dispatch; at N=1 the count gate is trivial, so the **field** gate is the only protection):

```text
# pass 1 — product-manager
task(
  context: "Review & Edit — product scope",
  tasks: [{ name: "ReviewEditProduct", agent: "product-manager",
            task: "<Assignment: Execute as product-manager; Act as + skill load>" }]
)
# repeat for architect, writing-specialist, … — each a separate N=1 dispatch with agent re-set
```

For explore-only orientation (no Morning Star role deliverable):

```text
task(
  tasks: [{
    name: "ExploreAuth",
    agent: "scout",   # or explore if that is what the live schema lists
    task: "... Act as explore-only orientation; Execute as: n/a ..."
  }]
)
```

## PM dispatch (`task`)

Harness **dispatch** on omp = **one or more `task` tool calls** with correct **`agent`** values and role-bound assignment text (C5 + C5b in this file). N-parallel / 1-Assignment-1-invoke / paste-only mechanics → **`parallel-dispatch.md`**.

| Harness | omp |
|---------|-----|
| `Execute as: <role-id>` | **`agent: "<role-id>"`** when listed in live schema; else generic built-in + C5b |
| Role identity / skills | Assignment **Act as** + skill load in **task** body (C5b) — always |
| Parallel batch **N** | **N** `tasks[]` entries in **one** `task` call, or **N** `task` calls in **one** assistant message |

### QC default

- **`Execution mode: sdd`**: **N=3** task entries — prefer `agent: "qc-specialist"`, `"qc-specialist-2"`, `"qc-specialist-3"` when listed; each body still **Act as** the respective QC role + QC skill load. If a seat is missing from the live schema, fall back per C5 (generic + C5b) for that seat only. N rules → `parallel-dispatch.md`.
- **`inline`**: **N=1** per `parallel-dispatch.md`.

Cannot emit required **N** → **`Blocked`**.

### SDD implement

- **`Execution mode: sdd`**: one implementer `task` entry per task id with `agent` matching the implementer role when listed; task reviewer = new entry with `agent: "code-reviewer"` (omp L2 review; not qc-specialist*) or `agent: "reviewer"`/`"task"` as fallback + C5b — no sticky resume unless host resume/id is available and recorded. Ready-task scheduling → **`parallel-dispatch.md`** § SDD implement.
- Independent ready implementers use isolated parallel tracks; never share a writable worktree or session.

## Clarify

- Prefer **`ask`** for 1–3 high-impact choices with known options (`recommended` when there is a default).
- Fallback: one concise Markdown question after codebase exploration cannot answer it.
- Plan approval in Plan mode follows **`omp-plan-mode-bridge.md`** — do not treat a casual `ask` as plan lock.
- “Question asked” ≠ clarify done; blocking ambiguity → **`Blocked`** or escalation.

## Commands and skills paths

| Surface | Path / invocation |
|---------|-------------------|
| Plugin skills | `/skill:<skill-name>` or auto-load from `skills/` via plugin discovery |
| Plugin commands | `/iteration-start`, `/iteration-drive`, `/iteration-loop` (filename-based) |
| Session entry | `/skill:pm` → `mstar-harness-core` via pm **Read next** |

## In-process engine binding (omp ≥ 17.2.11)

- **Surfaces** (npm package root = plugin root; sources live in `packages/omp/src/`): `hooks/pre/mstar-gates.js` — one `tool_call` pre-hook that returns `{ block: true, reason }` (structured refusal the model sees as the tool error) or `undefined` (pass); `extensions/model-handoff.js` — the coordinator model-handoff extension, published through the manifest `omp.extensions` entry (see **Model handoff** below); `tools/mstar_{status_validate,dispatch_validate,lease_verify,path_resolve,iteration_gate,worktree_check}.js` — six model-callable validator tools (engine validators only, Zod params via `pi.zod`). omp discovers `hooks/` and `tools/` by convention from the installed package root (`<pkg>/hooks/pre/` any file, `<pkg>/tools/` direct `*.js` files — the sub-directory scan only accepts `tools/<name>/index.ts`), not from `dist/`; `extensions/` is discovered from the manifest entry.

- **Surfaces** (npm package root = plugin root; sources live in `packages/omp/src/`): `hooks/pre/mstar-gates.js` — one `tool_call` pre-hook that returns `{ block: true, reason }` (structured refusal the model sees as the tool error) or `undefined` (pass); `extensions/phase2-orchestration.js` — the Phase-2 reminder + launch-bookkeeping extension (`mstar_phase2`), published through the manifest `omp.extensions` entry (see **Phase-2 plan instances** below); `tools/mstar_{status_validate,dispatch_validate,lease_verify,path_resolve,iteration_gate,worktree_check}.js` — six model-callable validator tools (engine validators only, Zod params via `pi.zod`). omp discovers these by convention from the installed package root (`<pkg>/hooks/pre/` any file, `<pkg>/tools/` direct `*.js` files — the sub-directory scan only accepts `tools/<name>/index.ts`), not from `dist/`.
|- **Enforcement semantics**: block ONLY under `Enforcement: hard`. Both gates read the repo `.mstarc` `[config] enforcement`, else the harness compass frontmatter (`enforcement: hard`, active/locked iterations only); the dispatch gate ALSO honors each Assignment's own header flag (`assignmentHeaderRegion` — a body example never hardens). A hard repo setting therefore hardens flag-less dispatches (Gate 1 / dsh `resolveDispatchHard` parity). Soft-mode dispatch violations are warn-logged through the extension logger (never blocked); soft status-write violations stay a silent pass. Rollback = unset the flag (or `.mstarc` `soft`). Never global.
- **Anti-recursion scope (issue #156)**: the engine's `antiRecursionPrecheck` is **caller-scoped** — it compares the DISPATCHING agent's own role against the new Assignment's `Execute as`. omp's `tool_call` event carries no caller identity and the task entry `agent` is the spawn TARGET, which equals `Execute as` on every compliant dispatch (C5 above) — so Gate 2 does NOT run the precheck on omp (the pre-#156 wiring hard-blocked every compliant hard-mode dispatch on `self-type`, or on `empty-binding` when `agent` was omitted). The NEVER red line stays prompt-level on this host (`mstar-dispatch-gates`); dsh enforces it in-engine via Config `dispatchBinding`.
- **Engine dependency**: the npm package **bundles the engine inline** into every hook/tool bundle at build time — zero runtime package resolution, so module link can never fail on a missing package (the 2026-09-03 hotfix for the bare-import load failure). The maintainer `omp plugin link` path (now `<repo>/packages/omp`) still resolves the engine via the workspace member — run `bun install && bun run engine:build && bun run --cwd packages/omp build` in the checkout first (the member's `dist/` and the package's generated mirrors are gitignored).
- **Graceful degradation (explicit)**: module load failure → `mstar_*` tools skipped, hook absent (no blocking), `commands/*.md` shell-out fallback intact. Caveat: a partial failure is SILENT — no in-band signal that gates are off; verify with `omp -p '/extensions'`.
|- **`MSTAR_HARNESS_DIR` override / `.mstarc`**: the hook and tools discover `{HARNESS_DIR}` via `resolveHarnessDir` — a repo `.mstarc` `[config] harness_dir` (gitignored local config) first, then the probe `.mstar/` → `.agents/` → `.plans/`/`plans/`. Repos using a non-standard harness root can declare it in `.mstarc` or MUST export `MSTAR_HARNESS_DIR` (absolute path) in the omp session env — without either the status gate does not cover those roots and tools like `mstar_path_resolve` / `mstar_lease_verify` error out (parity with the opencode binding).
- **Edit-path limitation**: the status gate validates the on-disk file for `edit` events (pre-edit state) — a corrupting edit is caught by the next write or `mstar_status_validate` (known v1 limitation, parity with opencode).
- **Engine version compatibility**: the hook and tools degrade gracefully until the engine release exporting both `composeDispatchGate` and `parseCompassFrontmatter` (published 2.0.2 predates both). Missing exports never fail module load: the hook's dispatch gate needs `composeDispatchGate` — on older engines Gate 2 (task dispatch) is skipped with a one-time warning while Gate 1 (status) stays active — and `mstar_dispatch_validate` / `mstar_iteration_gate` report an explicit upgrade error instead of loading (no silent absence; CLI fallbacks: `mstar dispatch validate`, `mstar iteration gate`).
- **Reload**: edits are picked up by a new session (`?mtime` cache-buster); in-session `/reload-plugins` (omp ≥ 17.2.11) applies them without a new session.

## Model handoff (native settings)

A second extension entry from this package: `extensions/model-handoff.js` (manifest `omp.extensions`; engine inlined, its single `@oh-my-pi/pi-coding-agent` import resolved by the running host). It is a **coordinator model policy owned by native settings**, not a user command — no session, flag, goal or prose can enable it.

| Surface | Contract |
|---|---|
| Native path | `/settings` → **Plugins** → **`@mstar-harness/omp`** — the rows are the schema keys: `modelHandoff` (boolean, default `false`) and `handoffTarget` (`@default` \| `@smol`, default `@default`). No activation command, no harness settings file, no second settings UI. |
| Persistence | Host plugin settings (user-scope `omp-plugins.lock.json`, plus project `plugin-overrides.json`), reread through the exported helper at entry **and again at fire time** — a mid-flight enable never retro-arms an iteration already under way, and disabling at fire time suppresses the switch without terminalizing the binding. |
| Scope | That panel lists **user-scope** installs; a project-scope npm install has no native row (host limitation, documented rather than worked around). Use the user-scope path — never double-install or add a private settings parser/UI. |
| Supported entries | `/iteration-start`, `/iteration-loop`, and a natural-language / skill-driven start (`skill-start`) as labelled from the host's own `input` event. `/iteration-drive` in any form never arms — the scoped-plan route only restores the session's existing binding, and a start call after it is refused `scoped-plan-route`. |
| Inert contexts | Ordinary chat, unrelated commands, leaf/subagent sessions (host `session_init` marker), plan-scoped PM sessions, other hosts, and an iteration whose coordinator never armed. |
| PM binding | Tool `mstar_model_handoff`, executed at two host hook anchors — **`iteration-entry`** (`{operation:"start"}`) and **`phase-1-lock`** (`{operation:"phase1-complete"}`). Exact parameters, prerequisites, refusal codes and required-vs-optional per anchor → **§ Host hooks** below. Session identity, cwd, entry route, task-session state and coordinator authority are host-derived from the ledger, the workflow's own session envelopes and the root register. |
| Ownership | One explicitly named workflow and control root own the coordinator. Missing, foreign or ambiguous ownership fails closed — no `workflows[0]`, latest-mtime, unique-new-row or "most recent" inference, and a concurrent sibling iteration stays untouched. Only the bound coordinator session changes model; role mappings, other sessions, subagents, goal objective and workflow snapshot status are never written. |
| Full readiness | Fire requires the sequential specialist returns for that iteration, PM-confirmed Prepare gates for every registered plan with `compass status: locked`, a distinct same-repository integration checkout on its recorded branch, and a remote tip equal to the validated integration HEAD. `evaluatePhaseGate` is a later-phase gate and is never readiness evidence; a draft compass, a lock alone, a missing checkout or an unpushed commit is not ready. |
| Cancellation | While pending, an unowned model change — history or live model — cancels the not-yet-executed switch, and the arm's own transition can never cancel it. Cancellation is deliberately conservative (it can also catch another extension's change; there is no exact user-selection event), and it never clears the saved preference. Navigation arriving during an invoked action is refused immediately; navigation arriving first fences the action instead of letting it start. |
| Replay | Full session ledger with exact session-id filtering. A persisted attempt with no recorded outcome restores as `uncertain` — never retried, never reported as a successful handoff because the current model happens to match. Tree/branch/reload replay the ledger; a fork or new session id inherits nothing. |
| Failure visibility | Refusals appear in the tool result, state transitions also as a durable session notice; the session keeps the model it actually has and there is no automatic retry loop. Missing auth, an unresolvable role and missing evidence are reported as failures, never as a handoff. |
| Modes | Arming is observed from the host's `input` event, so it is documented for the interactive entries above only — no print/JSON/RPC automatic-behaviour claim exists (E1 boundary). The completion checkpoint is an ordinary tool call whose result the host renders like any other tool result. |

Do not describe this feature as a `pause` flag, as a goal, or as a switch performed by any other session, and do not require a provider-side or upstream change to use it.

## Phase-2 plan instances (native settings + optional transport)

An extension entry from this package: `extensions/phase2-orchestration.js` (manifest `omp.extensions`; engine inlined, and its one runtime host import — `getPluginSettings` from `@oh-my-pi/pi-coding-agent/extensibility/plugins`, the public uncached settings reader — resolved by the running host, declared as an optional peer). It supplies one bounded Phase-2 advisory plus the `mstar_phase2` bookkeeping tool. It never spawns, merges, rewrites workflow state or releases leases — the optional skill below performs every CLI call, and engine scope/lease/revision/worktree/merge verbs stay authoritative.

Phase 2 only. Ordinary sessions, leaf/subagent sessions, scoped-plan PM sessions and Phase 1/3–6 never activate the reminder or a launch.

| Surface | Contract |
|---|---|
| Native path | `/settings` → **Plugins** → **`@mstar-harness/omp`** — the rows are the schema keys: `phase2PlanInstances` (boolean, default `false`) and `maxPlanInstances` (number, default `2`, minimum `1`, step `1`) with **no ceiling of 2**. |
| Launch-only opt-in | `phase2PlanInstances` gates **extra primary launches only**. Native background task concurrency and the bounded reminder are independent of it: a disabled opt-in neither silences the reminder nor limits ordinary `task` dispatch. |
| Configurable capacity | `maxPlanInstances` counts concurrently active **plan-scoped primaries** plus owned pending launch intents — the union by plan id, each counted once. The iteration coordinator and task subagents are excluded. Lowering it stops further launches and never kills running work. |
| Invalid values | A present-but-malformed key (non-boolean, non-integer, below 1, unparsable) **fails visibly** and authorizes no launch — never coerced to the default, never an unbounded mode, never a silent hard limit. Absent keys take the schema defaults. |
| Reminder | At most one advisory per **changed** opportunity observation, emitted at `agent_end` only; the observation key is recorded before the message, so identical unchanged state never re-fires and A→B→A does not re-nudge A. No timer, no polling, no invented job-settled event; a `null` snapshot means "unavailable", never "no jobs". Native completion delivery stays authoritative and is never duplicated. The advisory text asserts nothing about a plan being ready. |
| Checkpoint pointer | The advisory only points at the shared Phase-2 rescheduling checkpoint (`mstar-iteration/references/phase-2-worktree-lease.md` §2.4). It never copies the decision matrix — this section does not either. |
| Scope limitation (host behaviour) | The native `/settings` → Plugins panel lists **user-scope** plugin installs; a `--scope project` install has no row there (documented, not worked around). The runtime still reads the saved preference through the host's own settings helper. |

### PM call sequence (tool `mstar_phase2`)

Not a user activation command: nothing is spawned, merged, leased or written to engine state by the tool, and no session/flag/goal/prose can substitute for the calls below.

1. **`bind`** — the **`phase-2-entry`** anchor (→ **§ Host hooks**): the coordinator's **Phase 2 execute/resume entry** (immediately before the per-plan loop, after the §2.0 gates; §2.3's Phase-1-reused integration-worktree step is not this anchor), independent of any setting or model handoff, and also required on a no-argument `/iteration-drive` resume. Call shape, authority derivation, the rejection set and its refusal codes live in that section.
2. **`checkpoint`** — the **`rescheduling-checkpoint`** anchor (→ **§ Host hooks**): acknowledge that PM ran the shared scheduling procedure against the sample taken at that moment, with `reason` from the five frozen names and `decision` ∈ `dispatched | wait | blocked`. The runtime attaches the sampled key; the caller cannot choose or reset it. `blocked` suppresses advisory continuation until a new explicit user turn or a later checkpoint clears it — never a timer or incidental snapshot churn. A checkpoint carries a decision and note, never a ready list.
3. **`reserve-launch`** — `{operation:"reserve-launch", planId, transport:"herdr"|"tmux", skill:{name,source}, capability:{executable,version,target}}`. Admission additionally requires the enabled opt-in, a valid latest capacity, a coordinator-prepared row — prepared by **`mstar plan prepare`**, the coordinator step that writes `coordination.prepared` and its pinned Assignment path (verb preconditions and sequence → `mstar-use-cli/references/plan-and-workflow.md`) — with no plan binding/lease/handoff, the identical prepared Assignment hash, an existing canonical **distinct** feature worktree on its assigned branch, and the transport prerequisites. Only `applied:true` authorizes a side effect; an identical duplicate returns the recorded intent with `applied:false` and authorizes nothing, while a different live intent/binding for that plan refuses. Intents are journaled at `<workflow dir>/omp-launches.json` — a plugin-owned transport journal, never a lifecycle register.
4. **`record-launch`** — one transition per observed step, each recorded **before** its matching side effect: `{operation:"record-launch", intentId, observation, target?, evidencePath}` with `observation` ∈ `starting | created | submitting | submitted | refused | uncertain`. Strict forward order `reserved → starting → created → submitting → submitted`; `starting` permits pane creation, `created` (which **requires the returned opaque target**) permits starting OMP in it, `submitting` permits the single scoped prompt. Only a newly persisted transition reports `applied:true`; PM acts only on that. `refused` is legal only for an observed failure that provably precedes any process/prompt side effect; from `submitting` onward a lost outcome is `uncertain`, which is terminal. A recorded target is never re-pointed, and settings/capacity/ownership are re-read before each side-effecting transition.

Ordered summary of the extra-primary route: the plan row is **registered during Prepare** and still `Todo` → its assigned feature worktree exists → the coordinator is bound → **`mstar plan prepare`** prepares the row and produces the prepared Assignment → `reserve-launch` (item 3) → the record-before-side-effect transitions of item 4, then the pane/start/submission sequence in **§ Optional transport** below. Launch through this journaled sequence only; never invent a shorter unjournaled path. Row admission closes with Phase 1 — earlier once any row starts preparation or execution — so a row that was not admitted by then does not exist and cannot be launched. `mstar plan prepare` itself has no phase gate: it requires only a claimable unprepared row, so an already-registered eligible row may be prepared during Phase 2. Row admission and row preparation are different operations, and nothing here widens an engine rule. The host-agnostic statement of this precondition lives in `mstar-iteration/references/plan-scoped-pm.md` § Transport.

Refusal codes for `reserve-launch` / `record-launch` — **not** anchor-triggered (the optional extra-primary path carries no shared anchor moment, so these belong to no anchor row): `launch.invalid-request`, `launch.session-denied`, `launch.phase-inactive`, `launch.snapshot-unreadable`, `launch.journal-corrupt`, `launch.plan-not-found`, `launch.plan-unavailable`, `launch.plan-not-prepared`, `launch.plan-occupied`, `launch.prepared-hash-drift`, `launch.worktree-unavailable`, `launch.capability-unavailable`, `launch.settings-disabled`, `launch.settings-invalid`, `launch.settings-read-failed`, `launch.capacity-exceeded`, `launch.intent-not-found`, `launch.transition-invalid`, plus the shared `tool-error`. Every one is a visible refusal that authorizes nothing; success codes are `reserved` / `recorded`, and `replayed` (`applied:false`) for an identical duplicate that likewise authorizes no side effect.

### Optional transport (skill-driven — no compiled bridge)

Every prerequisite is required and checked per launch: the **corresponding optional skill actually present in the catalog and read** (the `herdr` skill today; a tmux skill only if one truly exists — binary existence is not skill availability), the CLI executable available, and this session actually inside the matching managed environment (`HERDR_ENV=1`; `TMUX` set for tmux). Two managed environments visible at once is a visible refusal, not a focus-based choice. A missing prerequisite is a **visible no-op**: no process start, no silently substituted plan, native background scheduling intact, never a fabricated success. This never becomes a mandatory load-order dependency of the standalone `mstar-*` skill set.

**Herdr** (the currently available contract — read the skill and its current group help/status at use): create the pane with `herdr pane split --current --direction <chosen> --cwd <prepared-worktree> --no-focus` and use the returned `result.pane.pane_id` verbatim as the opaque target; then `herdr agent start <unique-name> --kind omp --pane <returned-id>`; then submit exactly once with `herdr agent prompt <unique-name> "/iteration-drive --assignment <absolute-prepared-assignment>"`, without waiting for plan completion. Preserve CLI argument boundaries. `<absolute-prepared-assignment>` is the absolute `coordination.prepared.assignment_path` pinned when the coordinator ran **`mstar plan prepare`** for this row (see the ordered summary under **§ PM call sequence**); submission is defined only for a row whose preparation already produced that artifact, never for a merely registered one. *Exactly once* bounds the **initial** command only: any further context is steering sent after the session has bound (its `InProgress` row and execution lease identify the new session) — sent earlier it either duplicates the command or becomes the session's first instruction.

**tmux** (conditional): only where a matching tmux skill is actually present **and read**, the CLI supports that skill's command forms, `TMUX` identifies this caller, and its explicit target is resolved. Use the skill's detached/non-focus creation with explicit cwd and returned pane id, launch OMP in it, and submit the same absolute scoped route; inspect help instead of guessing flags, and never shell-type into the user's focused pane. **No tmux skill exists in the current catalog**, so tmux is unavailable here — an unsupported seam to be named honestly, not a failed implementation and not a silent Herdr substitution.

**Scoped-route dispatch checklist** — every item is checked at this handover point; each states its reason:

1. Target a **fresh** session, never one already acting as a leaf: the harness itself refuses promotion (`commands/iteration-drive.md:32` refuses a leaf that receives the scoped command), and the field observation is that a session's role is fixed by its first instruction — that is the operational reason for the rule, not a universal transport API guarantee.
2. Confirm the row is **prepared, not merely registered**: `coordination.prepared` carries the pinned Assignment path, a current `coordination.revision` is observed, the row is still `Todo`, and there is no plan session/lease/handoff. A revision alone is insufficient. The coordinator runs **`mstar plan prepare`** at this handover point.
3. Use the absolute prepared Assignment path, and finish handover content **before** preparation so the prepared bytes survive the fresh bind. Both SHA-256 fields are stored at **prepare**, not first created at bind (`coordination.ts:1882-1884`); bind rechecks the Assignment hash and refuses `coordination.assignment-stale` when it changed (`:1094-1108`, `:1582`). Current source does not recheck `plan_sha256`, so the user-reported plan-edit refusal stays **mechanism-unconfirmed** — not a new engine guarantee and not an eternal ban on authorized plan evidence updates.
4. Submit the initial scoped command **exactly once**; no preliminary leaf/role prompt and no coordinator credentials.
5. Read the returned explicit target to confirm execution — submission is not execution. The reported trailing Enter being consumed before readiness is an **observation about a CLI this repository does not own**. Only if the readback unambiguously shows the same command waiting unexecuted, recover with one Enter/key press using the optional skill's verified command form; never resubmit. Otherwise stop with uncertainty: a timeout, a lost response and `agent_not_ready` remain terminal, not retry opportunities.
6. Send subsequent handover notes/corrections only as **steering**, after `InProgress` and the execution lease identify the new session; never prepend them as another first instruction.

**Uncertainty, scope and ownership**: PM uses only returned opaque targets, records the observed command output before proceeding, and treats `agent_not_ready`, blocked UI, a timeout, a vanished response or a stalled submission as terminal — reported, never re-sent, never retried, with no fabricated id and no credential passed (no session JSON path, no `--expect` revision, no `--resume`). A created empty pane may be removed only with proven ownership and no possibly-active primary; panes are never killed to free capacity. Pane ready/idle/done means prompt transport is ready — never plan completion, lease release or ownership. The child obtains its own engine session through a fresh `plan bind`, runs only the prepared scope and stops at its durable handoff; the coordinator alone keeps serial integration and Phase 3–6 closure.

**Evidence boundary**: this transport guidance is supported by **simulated** scripted skill/CLI observation traces (PM action sequences scored for command order, prepared cwd, non-focus creation, credential absence, opaque-target reuse, stopping on uncertainty and no blind resend) — not by a native end-to-end Herdr/tmux run, not by any probe of user terminals, and not by a real OMP child process.

## Host hooks

The four **host hook anchors** — `iteration-entry`, `phase-1-lock`, `phase-2-entry`, `rescheduling-checkpoint` — are defined host-agnostically in `mstar-host` § `## Host hooks (anchor contract)`. Shared skills carry only the marker `<!-- host-hook: <anchor> -->` plus a one-line pointer and declare no host action; **this section is the OMP declaration for all four**. When the shared step carrying an anchor is reached, the PM executes the call declared here. Tool names, parameters, refusal codes and settings keys for these two mechanisms live in this file and nowhere else.

Carrier moments — where the PM meets the marker:

| Anchor | Shared carrier |
|---|---|
| `iteration-entry` | `mstar-iteration/references/phase-1-prepare.md` §1.5 (tail, after the workflow is registered to the v2 status surface and its id is known) |
| `phase-1-lock` | `mstar-iteration/references/phase-2-worktree-lease.md` §2.3 (`## Integration worktree (Phase 2 entry) + control root` checklist tail — after the integration checkout is recorded, the reviewed changes are committed there and that branch is pushed; the Phase 1 route reaches it through `iteration-start` §6, which carries a pointer only) |
| `phase-2-entry` | `mstar-iteration/references/phase-2-worktree-lease.md` immediately before the `## 2.4 Per-plan loop` heading (the Phase 2 execute/resume entry after the §2.0 gates) |
| `rescheduling-checkpoint` | `mstar-iteration/references/phase-2-worktree-lease.md` §2.4 (`### Rescheduling checkpoint`) |

### Auto-trigger boundary — the diagnosed failure mode

Neither extension ever arms, binds or checkpoints by itself:

- `extensions/model-handoff.js` observes the host `input` event only to **label** the entry route (`/iteration-start`, `/iteration-loop`, `skill-start`) — "It never authorizes anything". Arming happens **only** inside the `mstar_model_handoff {operation:"start"}` handler, and the authority for it is derived host/engine-side (task-session ledger, the workflow's own session envelopes, the root register), never from the call.
- `extensions/phase2-orchestration.js` emits its bounded advisory **only after** a recorded `bind`; `{operation:"checkpoint"}` likewise requires a live binding.

Enabling `modelHandoff` or `phase2PlanInstances` in `/settings` **never retro-arms or retro-binds** an iteration already under way (the preference is re-read at entry *and* again at fire time), and disabling it suppresses the action without terminalizing the binding. A coordinator that never calls therefore produces **no state and no signal at all** — not a refusal, not a warning, not a log line. That silence is the failure mode this anchor contract fixes: both mechanisms shipped with zero PM call sites in the load chain, so every anchor below is an explicit **required** call, never something the host does for the PM.

### Anchor declarations

| Anchor | Call (exact) | When | Prerequisite | Required |
|---|---|---|---|---|
| `iteration-entry` | `mstar_model_handoff {operation:"start", workflowId}` | once the workflow is registered and its id is known — the PM's first preparation action that can name it (`phase-1-prepare.md` §1.5 tail); never before the register step | native `modelHandoff` enabled; an explicitly named workflow id; this session is that workflow's coordinator | **required** — the call itself is unconditional; the arm inside it is conditional |
| `phase-1-lock` | `mstar_model_handoff {operation:"phase1-complete", workflowId, coordinatorSessionPath, mainWorktreeBranch, reviews[], plans[]}` | Phase 1 completion — after the integration checkout exists, the reviewed changes are committed there and that branch is pushed (§2.3 integration-worktree checklist tail); the compass/PM lock alone is **not** ready and not the moment | a `pending` binding from `iteration-entry` **and** the four Phase-1 readiness facts | **required** — never a silent skip |
| `phase-2-entry` | `mstar_phase2 {operation:"bind", workflowId, coordinatorSessionPath}` | the **Phase 2 execute/resume entry** — immediately before the per-plan loop (§2.4), after the §2.0 gates; also required on a no-argument `/iteration-drive` resume. **Not** the Phase-1-reused integration-worktree step (§2.3), which triggers nothing | accepted phase `phase-2-execute`; a `coordinator`-role session envelope; the caller's checkout = main worktree or the recorded integration worktree | **required** |
| `rescheduling-checkpoint` | `mstar_phase2 {operation:"checkpoint", reason, decision, note}` | **one call per** `Rescheduling checkpoint` re-evaluation (§2.4), including every settle notification | a live `phase-2-entry` binding in this session | **required** per re-evaluation — never batched, never skipped |

#### `iteration-entry` — `mstar_model_handoff {operation:"start", workflowId}`

- **Exact parameters**: `workflowId` (string, required) — the only field a caller supplies that matters here; `coordinatorSessionPath` / `mainWorktreeBranch` are accepted by the schema but unused on this path. Authority, entry route, intent and task-session state are host-derived, never call-declared.
- **When**: once the workflow is registered to the v2 status surface and its **id is known** (`mstar-iteration/references/phase-1-prepare.md` §1.5 tail) — the PM's first preparation action that can name it. Never at the head of §1.1: the id does not exist yet, and the id must name a registered workflow so its coordinator envelope exists.
- **Required or optional**: **required** and unconditional — make the call even when the preference is off, because `preference-off` is then the expected non-fatal answer and its absence from the ledger is what makes the silence undiagnosable. One call per iteration; a second arm of the same workflow is refused.
- **No-op refusals** (visible in the tool result, **nothing changed**, model unchanged — not failures to fix beyond the stated cause): `preference-off` (not an error) · `already-bound` · `suspended` (state `none`; a navigation is in flight, retry in a moment) · `in-flight` / `arm-in-flight` (a previous handoff action is still running).
- **Authority refusals** (this session is not the iteration coordinator — fix the session, not the call; no model action, no binding written): `task-session` (leaf/subagent session, or a session with no id) · `scoped-plan-route` (the last observed entry was the scoped-plan PM route, which restores a binding and never arms a new one) · `plan-pm-session` · `coordinator-elsewhere` (this session coordinates another workflow, or the workflow belongs to another session) · `envelope-invalid` · `register-invalid` (unreadable or invalid v2 root register / workflow snapshot).
- **Visible arm failures** (reported as failures; **no automatic retry**): `settings-read-failed` · `record-failed` · `slow-unresolved` · `slow-selection-failed` · `slow-selection-refused` · `arm-evidence-conflict`.
- **Host-level**: `tool-error` (the tool threw without touching model, ledger or engine state).
- **Success code**: `armed` (state `pending`) — the coordinator holds it until `phase-1-lock` fires or the handoff is cancelled.

#### `phase-1-lock` — `mstar_model_handoff {operation:"phase1-complete", workflowId, coordinatorSessionPath, mainWorktreeBranch, reviews[], plans[]}`

- **Exact parameters**: `workflowId` (must equal the bound workflow) · `coordinatorSessionPath` (non-empty string) · `mainWorktreeBranch` (string — the recorded integration branch) · `reviews[]` — **exactly three ordered specialist returns** · `plans[]` — **at least one** bound-plan evidence entry. A missing or wrong-length input is refused, never inferred.
- **When**: Phase 1 completion — **after** the integration worktree exists (recorded `integration_worktree_path`), the reviewed changes are committed on that checkout and `spec_integration_branch` is pushed: the tail of the §2.3 integration-worktree checklist, whose **step 7** performs that transfer + commit + push (Phase 1 reaches it through `iteration-start` §6). The compass/PM lock alone is **not** the moment — it leaves readiness items 3–4 unmet, so `not-ready` returns, the binding stays `pending`, and no later marker retries it. The call is made once, on the Phase 1 route; a Phase 2 resume that walks the same section must not repeat it — the binding is already terminal, so a repeat call returns `not-pending` (flagged as an error, since no `pending` binding exists any more) and is not required.
- **Required or optional**: **required**, and never a silent skip — every refusal lands in the tool result, and every state transition additionally as a durable session notice.
- **Readiness prerequisite (all four, re-checked at fire time)**: the sequential specialist returns for that iteration; the PM-confirmed Prepare gate for every registered plan with `compass status: locked`; a distinct same-repository integration checkout on its recorded branch; a remote tip equal to the validated integration HEAD. `evaluatePhaseGate` is a later-phase gate and is never readiness evidence; a draft compass, a lock alone, a missing checkout or an unpushed commit is not ready.
- **Refusals that leave the binding `pending`** (fix the stated cause and call again — **nothing was switched**): `not-ready` (carries `codes[]` naming the unmet readiness facts; not an error) · `preference-off` (`modelHandoff` off at fire time; not an error) · `settings-read-failed` (read once before and once after the readiness work) · `suspended` · `in-flight` · `record-failed` · `not-pending` (no binding — run `iteration-entry` first) · `binding-mismatch` (the call names a different workflow) · `invalid-completion-input` (the evidence shape above).
- **Terminal refusals** (**no retry**; the session keeps the model it actually has): `cancelled` (an unowned model change arrived while pending; not an error) · `target-unresolved` (`handoffTarget` unresolvable) · `switch-refused` / `switch-threw` (the host refused the selection).
- **Host-level**: `tool-error`. **Success code**: `handed_off` (state `handed_off`, with the actual model reported).

#### `phase-2-entry` — `mstar_phase2 {operation:"bind", workflowId, coordinatorSessionPath}`

- **Exact parameters**: `workflowId` (must match both the session envelope and the workflow snapshot id) and `coordinatorSessionPath` (the coordinator's own session envelope). The request object is strict — nothing else is accepted, and authority is derived host-side, never from the call: host session id, control harness root, accepted phase and checkout root are all re-read.
- **When**: the **Phase 2 execute/resume entry** — immediately before the per-plan loop (`## 2.4 Per-plan loop`), after the §2.0 gates and after §2.3's branch/worktree resolution; also required on a no-argument `/iteration-drive` resume. It is explicitly **not** the Phase-1-reused integration-worktree step: Phase 1's `iteration-start` §6 walks §2.3 to create the integration checkout, and that step triggers no anchor (`phase-2-entry` fires only on the Phase 2 route, and `phase-1-lock` fires once at that checklist's tail).
- **Required or optional**: **required**. It records a session **identity pointer** only — plugin observation binding, not engine `plan bind` — and writes no engine credential and no engine state.
- **Prerequisite**: the snapshot's accepted phase is `phase-2-execute` (an unknown or missing phase disables the observation) · the envelope role is `coordinator` · the caller's checkout is the main worktree or the recorded integration worktree.
- **Refusals** (visible; **nothing bound**):
  - `phase2.task-session` — a leaf/subagent (`session_init`) session, or a session with no id.
  - `phase2.plan-pm-session` — a scoped-plan PM envelope: a scoped-plan PM never binds the Phase-2 observation.
  - `phase2.envelope-unreadable` · `phase2.workflow-mismatch` (envelope or snapshot names another workflow) · `phase2.harness-unresolvable` · `phase2.snapshot-unreadable` · `phase2.workflow-terminal` · `phase2.coordinator-mismatch` (the snapshot is bound to a different coordinator envelope) · `phase2.scope-mismatch` (the caller's checkout is neither the main worktree nor the integration worktree) · `phase2.record-failed` · `tool-error`.
- **Non-failure**: `already-bound` (`applied:false`) — an identical re-bind is idempotent, the pointer is unchanged, and the call is safe to repeat. **Success code**: `bound` (`applied:true`).
- The tool's other two operations — `reserve-launch` / `record-launch` — are **not** anchor-triggered; their codes are in § Phase-2 plan instances above.

#### `rescheduling-checkpoint` — `mstar_phase2 {operation:"checkpoint", reason, decision, note}`

- **Exact parameters**: `reason` — **one of the five frozen names, verbatim**: `before-wait`, `result-settled`, `dependency-changed`, `ownership-changed`, `capacity-changed` · `decision` ∈ `dispatched | wait | blocked` · `note` (string, required). The argument schema is a strict union: any other value is rejected before anything is written. The runtime attaches the sampled observation key — the caller cannot choose or reset it.
- **When**: **one call per** re-evaluation of the shared `Rescheduling checkpoint` (`mstar-iteration/references/phase-2-worktree-lease.md` §2.4) — a call acknowledges that PM ran the shared scheduling procedure against the sample taken at that moment.
- **Required or optional**: **required** per re-evaluation — never batched into the next one, never skipped because "nothing changed". A checkpoint carries a decision and a note, never a ready list.
- **Prerequisite**: a live `phase-2-entry` binding in this session; the ownership probe is re-run on every call.
- **Refusals** (visible; **no checkpoint recorded**, advisory state unchanged): `phase2.not-bound` (run `phase-2-entry` first) · `phase2.record-failed` · `tool-error`, plus the ownership-probe codes shared with `bind`: `phase2.envelope-unreadable` · `phase2.ownership-drift` (the envelope or snapshot no longer belongs to the bound session — re-run `bind`) · `phase2.harness-unresolvable` · `phase2.snapshot-unreadable` · `phase2.workflow-mismatch` · `phase2.workflow-terminal` · `phase2.phase-inactive` (the workflow left `phase-2-execute`). Both stale codes mark the local binding not-current and tell the PM to re-run `{operation:"bind"}` before relying on this session.
- **Success code**: `recorded` (with the returned `observationKey` and `blocked` flag; `blocked` suppresses advisory continuation until a new explicit user turn or a later checkpoint — never a timer or incidental snapshot churn).
- **Not checkpoint refusals** — the advisory path's own sample refusals are `phase2.snapshot-unavailable` (a `null` snapshot means "unavailable", never "no jobs") and `phase2.settings-read-failed` / `phase2.invalid-settings` (the native settings read failed, or a present-but-malformed key fails visibly).

## Files, shell, and approvals

- Prefer host search/edit tools over shell find/sed when available.
- Respect omp approval prompts (`approval-mode`, write/yolo) for destructive operations.
- Do not edit `~/.omp/` credentials, plugin lockfiles, or user secrets without explicit consent.

## Git and final evidence

- Git work follows `mstar-branch-worktree` and Assignment **Working branch** / **Branch policy**.
- omp may offer task isolation / worktrees (`task.isolation`, `~/.omp/wt`) — that is **host-level** task isolation **outside** the Morning Star convention; Morning Star **`Worktree path`** stays `<repoRoot>/.worktrees/` (record it + leases when L1 gates apply).
- Completion reports cite concrete commands, artifacts, and commit lines when required.

## Gotchas

- Installed npm plugin package name is **`@mstar-harness/omp`** (git/link path: root **`morning-star`**); Morning Star display name remains **morning-star-harness**.
- Marketplace (Claude) installs and `omp plugin install` are different discovery providers — prefer one install path per machine to avoid duplicate skill listings.
- Session plan UI / todos are not durable SSOT unless mirrored to `{HARNESS_DIR}`.
- After install/link, **reload / new session** so `agents/*.md` appear in the live `task.agent` list — stale sessions may only show host generics and wrongly push you to `agent: "task"`.
- Role agent shell ≠ full role prompt: **C5b skill load remains required** even when `agent` already equals the role id.
- omp has no `sessionStart.skill`; new sessions do **not** auto-load PM — invoke `/skill:pm` manually.
- Do not confuse omp **`task.agent`** with OpenCode **`subagent`** or Cursor **`subagent_type`**.
- Do not treat Kimi/ZCode “built-ins only → always `coder`/`task`” habits as omp defaults when Morning Star role agents are listed.
- **Sequential N=1 Review-&-Edit turns are where `agent` gets dropped**: the “all N in one message” pressure is absent and the count gate passes trivially — re-verify **`agent: "<Execute as>"`** on every single dispatch; `tasks:[{task:"…"}]` with no `agent` is a silent generic fallback, not a valid role invoke.
