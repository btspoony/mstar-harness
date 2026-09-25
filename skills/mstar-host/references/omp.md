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

## Runtime and upgrade

- **Runtime**: Bun-hosted plugin — the pre-hook, the tools and the extensions run under the host's Bun, floor **Bun >=1.4.0** with in-process native `node:sqlite`. The floor is read from the actual runtime (Bun's emulated `process.versions.node` never certifies a Bun entrypoint); a below-floor or missing-capability runtime refuses actionably instead of degrading to a transport or JSON.
- **Upgrade / reload**: reinstall or relink the package, then a new session — or `/reload-plugins` on omp ≥17.2.11 (see § Gotchas).
- **Readiness, not an action**: refreshing an *installed* copy is a bounded, authorized ops act — an authority flip first quiesces, then reloads/upgrades (or explicitly excludes) every installed reader/writer and attests the versions it saw. Editing harness docs or source performs none of it. If this host cannot reload safely, stop at the exact manual-restart step, have the user restart, then re-verify entrypoint/runtime/version/session identity read-only before the flip.

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

A second extension entry from this package: `extensions/model-handoff.js` (manifest `omp.extensions`; engine inlined, its single `@oh-my-pi/pi-coding-agent` import resolved by the running host). It is a **coordinator model policy owned by native settings**, not a user command — no session, flag, goal or prose can enable it. The same entry registers the coordinator **identity** tool `mstar_coordinator` (§ Coordinator identity and session association) — an identity entry, not a model policy, so no setting here governs it.

| Surface | Contract |
|---|---|
| Native path | `/settings` → **Plugins** → **`@mstar-harness/omp`** — the rows are the schema keys: `modelHandoff` (boolean, default `false`) and `handoffTarget` (`@default` \| `@smol`, default `@default`). No activation command, no harness settings file, no second settings UI. |
| Persistence | Host plugin settings (user-scope `omp-plugins.lock.json`, plus project `plugin-overrides.json`), reread through the exported helper at entry **and again at fire time** — a mid-flight enable never retro-arms an iteration already under way, and disabling at fire time suppresses the switch without terminalizing the binding. |
| Scope | That panel lists **user-scope** installs; a project-scope npm install has no native row (host limitation, documented rather than worked around). Use the user-scope path — never double-install or add a private settings parser/UI. |
| Supported entries | `/iteration-start`, `/iteration-loop`, and a natural-language / skill-driven start (`skill-start`) as labelled from the host's own `input` event. `/iteration-drive` in any form never arms — the scoped-plan route only restores the session's existing binding, and a start call after it is refused `scoped-plan-route`. |
| Inert contexts | Ordinary chat, unrelated commands, leaf/subagent sessions (host `session_init` marker), plan-scoped PM sessions, other hosts, and an iteration whose coordinator never armed. |
| PM binding | Tool `mstar_model_handoff`, executed at two host hook anchors — **`direction-lock`** (`{operation:"start"}`) and **`phase-1-lock`** (`{operation:"phase1-complete"}`). Exact parameters, prerequisites, refusal codes and required-vs-optional per anchor → **§ Host hooks** below. Session identity, cwd, entry route, task-session state and coordinator authority are host-derived from the ledger, the workflow's own session envelopes and the root register. |
| Ownership | One explicitly named workflow and control root own the coordinator. Missing, foreign or ambiguous ownership fails closed — no `workflows[0]`, latest-mtime, unique-new-row or "most recent" inference, and a concurrent sibling iteration stays untouched. Only the bound coordinator session changes model; role mappings, other sessions, subagents, goal objective and workflow snapshot status are never written. |
| Full readiness | Fire requires the sequential specialist returns for that iteration, PM-confirmed Prepare gates for every registered plan with `compass status: locked`, a distinct same-repository integration checkout on its recorded branch, and a remote tip equal to the validated integration HEAD. `evaluatePhaseGate` is a later-phase gate and is never readiness evidence; a draft compass, a lock alone, a missing checkout or an unpushed commit is not ready. |
| Cancellation | While pending, an unowned model change — history or live model — cancels the not-yet-executed switch, and the arm's own transition can never cancel it. Cancellation is deliberately conservative (it can also catch another extension's change; there is no exact user-selection event), and it never clears the saved preference. Navigation arriving during an invoked action is refused immediately; navigation arriving first fences the action instead of letting it start. |
| Replay | Full session ledger with exact session-id filtering. A persisted attempt with no recorded outcome restores as `uncertain` — never retried, never reported as a successful handoff because the current model happens to match. Tree/branch/reload replay the ledger; a fork or new session id inherits nothing. |
| Failure visibility | Refusals appear in the tool result, state transitions also as a durable session notice; the session keeps the model it actually has and there is no automatic retry loop. Missing auth, an unresolvable role and missing evidence are reported as failures, never as a handoff. |
| Modes | Arming is observed from the host's `input` event, so it is documented for the interactive entries above only — no print/JSON/RPC automatic-behaviour claim exists (E1 boundary). The completion checkpoint is an ordinary tool call whose result the host renders like any other tool result. |

Do not describe this feature as a `pause` flag, as a goal, or as a switch performed by any other session, and do not require a provider-side or upstream change to use it.

## Phase-2 plan instances (native settings + optional transport)

An extension entry from this package: `extensions/phase2-orchestration.js` (manifest `omp.extensions`; engine inlined, and its one runtime host import — `getPluginSettings` from `@oh-my-pi/pi-coding-agent/extensibility/plugins`, the public uncached settings reader — resolved by the running host, declared as an optional peer). It supplies one bounded Phase-2 advisory plus the `mstar_phase2` bookkeeping tool. It never spawns, merges, rewrites workflow state or releases leases — the optional skill below performs every CLI call, and engine scope/token/lease/worktree/merge verbs stay authoritative.

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

1. **`bind`** — the **`phase-2-entry`** anchor (→ **§ Host hooks**): the coordinator's **Phase 2 execute/resume entry** (immediately before the per-plan loop, after the §2.0 gates; §2.3's Phase-1-reused integration-worktree step is not this anchor), independent of any setting or model handoff, and also required on a no-argument `/iteration-drive` resume. The input is exactly `{operation:"bind", workflowId}` — **no session path is accepted or needed**: the adapter adopts this session's own identity pointer from whatever authority the addressed control root has (the ACTIVE DB coordinator binding, or the workflow's own recorded envelope pre-activation, resolved by the host and never supplied by the call). Call shape, authority derivation, the rejection set and its refusal codes live in that section.
2. **`checkpoint`** — the **`rescheduling-checkpoint`** anchor (→ **§ Host hooks**): acknowledge that PM ran the shared scheduling procedure against the sample taken at that moment, with `reason` from the five frozen names and `decision` ∈ `dispatched | wait | blocked`. The runtime attaches the sampled key; the caller cannot choose or reset it. `blocked` suppresses advisory continuation until a new explicit user turn or a later checkpoint clears it — never a timer or incidental snapshot churn. A checkpoint carries a decision and note, never a ready list.
3. **`reserve-launch`** — `{operation:"reserve-launch", planId, transport:"herdr"|"tmux", skill:{name,source}, capability:{executable,version,target}}`. It requires the **ACTIVE execution authority**: the caller's `ExecutionBinding` is resumed before anything else, the workflow's plan rows are read through the execution authority (never from the retired snapshot), and a session bound only through the pre-activation envelope record refuses. Admission additionally requires the enabled opt-in, a valid latest capacity, a coordinator-prepared row — prepared by **`mstar plan prepare`**, the coordinator step that writes the row's prepared state and its pinned Assignment path (verb preconditions and sequence → `mstar-use-cli/references/plan-and-workflow.md`) — with no plan binding/lease/handoff, the identical prepared Assignment hash, an existing canonical **distinct** feature worktree on its assigned branch, and the transport prerequisites. Only `applied:true` authorizes a side effect; an identical duplicate returns the recorded intent with `applied:false` and authorizes nothing, while a different live intent/binding for that plan refuses. Intents live in the version-2 journal at `<workflow dir>/omp-launches.json` (`omp-launch-v2`, owned by the execution binding and written under the maintenance exclusion plus the canonical workflow lock, with the synchronous session re-check immediately before the atomic write); a version-1 journal is read as the legacy record it is — retained with its byte digest and coordinator provenance and adopted only when a legitimate write supersedes it. It is a plugin-owned transport journal, never a lifecycle register.
4. **`record-launch`** — one transition per observed step, each recorded **before** its matching side effect, on the same ACTIVE authority: `{operation:"record-launch", intentId, observation, target?, evidencePath}` with `observation` ∈ `starting | created | submitting | submitted | refused | uncertain`. Strict forward order `reserved → starting → created → submitting → submitted`; `starting` permits pane creation, `created` (which **requires the returned opaque target**) permits starting OMP in it, `submitting` permits the single scoped prompt. Only a newly persisted transition reports `applied:true`; PM acts only on that. `refused` is legal only for an observed failure that provably precedes any process/prompt side effect; from `submitting` onward a lost outcome is `uncertain`, which is terminal for this attempt and never retried, and an owner or epoch change keeps an unresolved intent occupied until recorded native evidence or explicit stopped-owner reconciliation releases it — a reservation is never dropped and relaunched.
5. **`export-history`** — read-only source evidence, never an action: `{operation:"export-history", workflowId}` returns this carrying session's own hidden history as one canonical document (workflow id, host session id, and the embedded export with its digest) through the tool result. It opens no file, spawns nothing, binds nothing, stops nothing, grants no authority and claims no quiescence — it is **source/package inventory evidence**, not installed-deployment adoption and not an operational stop attestation.

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

**Uncertainty, scope and ownership**: PM uses only returned opaque targets, records the observed command output before proceeding, and treats `agent_not_ready`, blocked UI, a timeout, a vanished response or a stalled submission as terminal — reported, never re-sent, never retried, with no fabricated id and **no write authority passed** (no session file path, no session reference, no `--expect` value — revision or full execution token — and no operation id; none of them is a credential that authorizes its holder, and the child acquires its own identity). A created empty pane may be removed only with proven ownership and no possibly-active primary; panes are never killed to free capacity. Pane ready/idle/done means prompt transport is ready — never plan completion, lease release or ownership. The child obtains its own engine session through a fresh `plan bind`, runs only the prepared scope and stops at its durable handoff; the coordinator alone keeps serial integration and Phase 3–6 closure.

**Evidence boundary**: this transport guidance is supported by **simulated** scripted skill/CLI observation traces (PM action sequences scored for command order, prepared cwd, non-focus creation, credential absence, opaque-target reuse, stopping on uncertainty and no blind resend) — not by a native end-to-end Herdr/tmux run, not by any probe of user terminals, and not by a real OMP child process.

## Host hooks

The four **host hook anchors** — `direction-lock`, `phase-1-lock`, `phase-2-entry`, `rescheduling-checkpoint` — are defined host-agnostically in `mstar-host` § `## Host hooks (anchor contract)`. Shared skills carry only the marker `<!-- host-hook: <anchor> -->` plus a one-line pointer and declare no host action; **this section is the OMP declaration for all four**. When the shared step carrying an anchor is reached, the PM executes the call declared here. Tool names, parameters, refusal codes and settings keys for these two mechanisms live in this file and nowhere else.

Carrier moments — where the PM meets the marker:

| Anchor | Shared carrier |
|---|---|
| `direction-lock` | `mstar-iteration/references/phase-1-prepare.md` §1.2 (tail, once the direction is locked and before the compass/plans draft; the workflow is intentionally **not** registered yet) |
| `phase-1-lock` | `mstar-iteration/references/phase-2-worktree-lease.md` §2.3 (`## Integration worktree (Phase 2 entry) + control root` checklist tail — after the integration checkout is recorded, the reviewed changes are committed there and that branch is pushed; the Phase 1 route reaches it through `iteration-start` §6, which carries a pointer only) |
| `phase-2-entry` | `mstar-iteration/references/phase-2-worktree-lease.md` immediately before the `## 2.4 Per-plan loop` heading (the Phase 2 execute/resume entry after the §2.0 gates) |
| `rescheduling-checkpoint` | `mstar-iteration/references/phase-2-worktree-lease.md` §2.4 (`### Rescheduling checkpoint`) |

### Coordinator identity and session association (host → `plan bind`)

Two comparisons this surface makes — the `phase-1-lock` readiness checkpoint and the `direction-lock` start-authority scan — compare the **engine** session id with the **host** session id, so they are one identifier only when the engine adopted the host's own. This host closes that gap by **acquisition**, never by injection: a coordinator identity is explicitly acquired, and the extension hands the host's native id straight to the engine. Coordinator bootstrap stays limited to one per workflow.

**Managed bootstrap — `mstar_coordinator`.** The only advertised managed route, registered by `extensions/model-handoff.js` and independent of the `modelHandoff` setting. The same three operations have **two authority-selected forms**, and **which one applies is read from the addressed control root — never selected by a tool argument**:

| Operation | ACTIVE form (the root's execution authority is active) | Pre-activation form (file route) |
|---|---|---|
| `bind` | `{operation:"bind", workflowId, expected, operationId}` — `expected` is the workflow's **full execution token**, `operationId` the replay key; the engine's `bindExecutionSession` runs directly under this session's independently derived identity | `{operation:"bind", workflowId}` — the Prepare bootstrap, unchanged |
| `show-recovery` | reads the DB workflow/session state | reads the recorded owner session id, both byte versions and the Prepare verdict (`recovery-allowed` / `recovery-blocked`), writing nothing |
| `recover` | `{operation:"recover", workflowId, priorSessionId, reason, attestation, expected, operationId}` under an independently acquired coordinator identity | `{operation:"recover", workflowId, expectedSnapshotVersion, expectedCompassVersion, operationId, reason, authorizationRef, stoppedSessionIds}` |

- **The active form is a lookup, never a credential.** The `bind` input carries no session path, no session id and no root: the adapter takes the **native** session id from the host session manager and the canonical control harness root from the host cwd, and the reference it returns is a stored row — a copied or stale one refuses in the engine's own caller comparison. A session id, root, caller role, authority flag or credential path has no home in the schema, and the adapter refuses any extra key by name (`forbidden-field`).
- Refusals: `identity-missing` (this host session has no native id — the engine never generates one), `leaf-session`, `scoped-plan-route` (that route restores an existing binding and never bootstraps one), `harness-not-found`, `invalid-input`, plus the engine's own codes passed through unchanged. Success is `bound`, with the engine-issued session on the result. A **mixed or partial** key set, an ACTIVE form on a pre-activation root and a Prepare form on an ACTIVE root all refuse instead of falling back to the other authority.
- The **shell route is retired**: a `plan bind --coordinator` inside `bash` / `functions.bash` is refused *before* execution with a redirect to this tool, and the former per-call `MSTAR_HOST_SESSION_ID` env revision is gone — nothing is injected for any call, so an absent or unsupported `env` field can no longer produce an input revision. Unrelated shell calls are untouched. Other hosts never produced that variable.
- A plain local operator works through the CLI instead: pre-activation `mstar plan bind --coordinator --workflow <id> --session-id <id>`, the id stated explicitly and never generated (omitted → `coordination.identity-missing`); on an ACTIVE root the same seat takes the active form, `mstar plan bind --execution --workflow <id> --coordinator --expect <full-execution-token> --operation <id>`, under an identity acquired for that invocation (→ `mstar-use-cli/references/plan-and-workflow.md`). The inherited `MSTAR_HOST_SESSION_ID` stays a declared local input form for a **plan/assignment** bind only.

No comparison is relaxed. An **absent** association (a host session with no id) and a **foreign** one (the id belongs to another session) still refuse: readiness keeps failing its `binding-invalid` code, the start-authority refusals (`task-session`, `plan-pm-session`, `coordinator-elsewhere`) keep their codes, and an id the engine cannot use as a session file name is refused with `coordination.invalid-session-id` before any write. One host session may hold both seats a workflow needs — a coordinator session and a plan-pm session — and on the active route both are **stored rows** carrying the same host-derived `session_id`, while the pre-activation route keeps them apart by the role-scoped envelope file name (`<role>-<session-id>.json`). A resume never re-identifies the caller and refuses `--session-id` as a usage error on the active route; replacing a stopped owner is **never** a resume.

**Diagnostics.** The broad codes above keep their names; the adapter attaches a typed subreason so the causes stay distinguishable — identity detail `identity-missing`, `identity-mismatch`, `foreign-owner`, `recovery-not-prepare`, `recovery-stale`, `recovery-unauthorized`, and path detail `plan-pointer-invalid`, `plan-identity-mismatch`, and a genuinely `prepare-unlocked` compass, never a malformed row pointer reported as an unlocked Prepare. Safe detail renders the workflow/plan, identity-source labels, already-public expected/current ids, the canonical base and target, and the next supported operation — never credentials, session JSON or environment payloads.

### Auto-trigger boundary — the diagnosed failure mode

Neither extension ever arms, binds or checkpoints by itself:

- `extensions/model-handoff.js` observes the host `input` event only to **label** the entry route (`/iteration-start`, `/iteration-loop`, `skill-start`) — "It never authorizes anything". Arming happens **only** inside the `mstar_model_handoff {operation:"start"}` handler, and the authority for it is derived host/engine-side (task-session ledger, the workflow's own session envelopes, the root register), never from the call.
- `extensions/phase2-orchestration.js` emits its bounded advisory **only after** a recorded `bind`; `{operation:"checkpoint"}` likewise requires a live binding.
- `mstar_coordinator {operation:"bind"}` is likewise an explicit call the PM makes when a workflow needs its coordinator session — no host event, entry route or setting performs it for the PM, and it stays a no-op on this feature's ledger.

Enabling `modelHandoff` or `phase2PlanInstances` in `/settings` **never retro-arms or retro-binds** an iteration already under way (the preference is re-read at entry *and* again at fire time), and disabling it suppresses the action without terminalizing the binding. A coordinator that never calls therefore produces **no state and no signal at all** — not a refusal, not a warning, not a log line. That silence is the failure mode this anchor contract fixes: both mechanisms shipped with zero PM call sites in the load chain, so every anchor below is an explicit **required** call, never something the host does for the PM.

### Coordinator-visible notices

Both mechanisms emit durable, coordinator-visible notices, and both families share one visible bar title: **`mstar:notice`** — the Phase-2 observation's diagnostics (`extensions/phase2-orchestration.js`) and coordinator model-handoff transitions (`extensions/model-handoff.js`). The bounded Phase-2 advisory carries **`mstar:advisory`**. The bar title is the `customType` literal (OMP has no separate title field). The hidden durable ledgers keep their own types — **`mstar:phase2`** for this feature's decision records and **`mstar:model-handoff`** for handoff records — which are never a visible notice name (`mstar:model-handoff` is never reused as one).

Every notice is rendered through the shared Morning Star title shape as `<title>: <detail>`, with the observed condition or refusal code preserved in the detail. A detail that opens with the title's own sentence is rendered as the title plus that detail's remainder, so a status sentence is never stated twice:

- **Status-bearing title** — when the workflow's own snapshot was successfully read at notice time, the title states a Morning Star status: the workflow id plus its actual lifecycle status, verbatim (`Workflow <id> is <status>`). It reports workflow lifecycle status only — never `snapshot.phase`, a refusal code, or the model-handoff ledger state (`pending`, `cancelled`, `handed_off`).
- **Fallback title** — when no readable snapshot supplied the id/status, the title states only the observed operation or condition (`… needs attention`) and asserts no workflow status. Missing or unreadable status evidence never suppresses a notice and never substitutes a guessed `running`/`completed` value.

A terminal lifecycle no longer produces a notice asserting the Phase-2 phase: a terminal workflow refuses `phase2.workflow-terminal` with its observed status, and no notice or refusal text on either path carries a fixed inactivity prefix or a detail sentence asserting a current Phase-2 position.

The Phase-2 diagnostic path stays deduplicated by code per generation — at most one notice per distinct refusal code until the generation resets. The model-handoff notices do not share that dedup mechanism.

### Anchor declarations

| Anchor | Call (exact) | When | Prerequisite | Required |
|---|---|---|---|---|
| `direction-lock` | `mstar_model_handoff {operation:"start", workflowId}` | once the direction is locked and before `## 1.3` writes the draft (`phase-1-prepare.md` §1.2 tail) — the arm happens **before** `mstar iteration register`, so the binding takes the unregistered reservation route; never before the direction is locked | native `modelHandoff` enabled; an explicitly named workflow id; this session is that workflow's coordinator | **required** — the call itself is unconditional; the arm inside it is conditional |
| `phase-1-lock` | `mstar_model_handoff {operation:"phase1-complete", workflowId, coordinatorSessionPath?, mainWorktreeBranch, reviews[], plans[]}` | Phase 1 completion — after the integration checkout exists, the reviewed changes are committed there and that branch is pushed (§2.3 integration-worktree checklist tail); the compass/PM lock alone is **not** ready and not the moment | a `pending` binding from `direction-lock` **and** the four Phase-1 readiness facts | **required** — never a silent skip |
| `phase-2-entry` | `mstar_phase2 {operation:"bind", workflowId}` | the **Phase 2 execute/resume entry** — immediately before the per-plan loop (§2.4), after the §2.0 gates; also required on a no-argument `/iteration-drive` resume. **Not** the Phase-1-reused integration-worktree step (§2.3), which triggers nothing | accepted phase `phase-2-execute`; the addressed root's own authority holding this session's coordinator seat (the ACTIVE DB binding, or the recorded coordinator envelope pre-activation); the caller's checkout = main worktree or the recorded integration worktree | **required** |
| `rescheduling-checkpoint` | `mstar_phase2 {operation:"checkpoint", reason, decision, note}` | **one call per** `Rescheduling checkpoint` re-evaluation (§2.4), including every settle notification | a live `phase-2-entry` binding in this session | **required** per re-evaluation — never batched, never skipped |

#### `direction-lock` — `mstar_model_handoff {operation:"start", workflowId}`

- **Exact parameters**: `workflowId` (string, required) — the only field a caller supplies that matters here; `coordinatorSessionPath` / `mainWorktreeBranch` are accepted by the schema but unused on this path. Authority, entry route, intent and task-session state are host-derived, never call-declared.
- **Two structural routes (host-derived)**: the public tool keeps `{operation:"start", workflowId}` — no mode, session credential or authority claim is accepted from the caller. The adapter classifies the branch from the validated root register for that explicit id, never from a newest/unique-workflow inference. **Unregistered workflow** → the reservation path, which is the **expected route** at this anchor: a new iteration has no register row, no snapshot and no compass yet, so root validation is unchanged, the three existing-artifact refusals keep their code and byte-identical messages, and a correctly timed call never trips them — `already-bound`: `workflow <id> is already registered in the root register — a new start never adopts it` · `a workflow snapshot already exists at <snapshotPath>` · `an iteration compass already exists at <compassPath>` (tripping one of them means the call came too late — after `mstar iteration register` — or named the wrong id). **Already-registered workflow** → attach, the **re-entry / abnormal-order case** (for example a coordinator that arms only once the register has landed): the named active register row (exactly one) and the workflow's actual own snapshot, identity and canonical paths are revalidated rather than trusted from the branch classification — on this branch an existing own snapshot/compass is expected, not an adoption refusal — and the start proceeds through the unchanged one-shot arm protocol to `pending` only after the existing authority derivation allows this session. Attach structural failures refuse through the existing vocabulary — `invalid-root` (absent register, vanished or malformed row, missing or mismatched snapshot, wrong canonical path), plus the pre-existing `not-coordinator` / `invalid-workflow` input checks unchanged — with no fallback into reservation and no state write. No new refusal code and no public tool mode is introduced by either branch.
- **When**: once the direction is locked and before `## 1.3` writes the draft — the tail of `mstar-iteration/references/phase-1-prepare.md` §1.2, immediately before the compass/plans draft. The call precedes `mstar iteration register` (§1.5), so the binding takes the unregistered reservation route; the workflow id is chosen during scope definition (§1.2) and names a workflow that does not exist yet — that is the expected state, never a reason to skip the call. A PM that has not completed its route's lock step must not make the call.
- **Required or optional**: **required** and unconditional — make the call even when the preference is off, because `preference-off` is then the expected non-fatal answer and its absence from the ledger is what makes the silence undiagnosable. One call per iteration; a second arm of the same workflow is refused.
- **No-op refusals** (visible in the tool result, **nothing changed**, model unchanged — not failures to fix beyond the stated cause): `preference-off` (not an error) · `already-bound` (the three reservation refusals under **Two structural routes** above; a pending/uncertain/terminal same-workflow binding in this session's ledger — a terminal binding is never re-armed; or, on the attach branch, the foreign-coordinator outcome described under **Authority refusals** below) · `suspended` (state `none`; a navigation is in flight, retry in a moment) · `in-flight` / `arm-in-flight` (a previous handoff action is still running).
- **Authority refusals** (this session is not the iteration coordinator — fix the session, not the call; no model action, no binding written): `task-session` (leaf/subagent session, or a session with no id) · `scoped-plan-route` (the last observed entry was the scoped-plan PM route, which restores a binding and never arms a new one) · `plan-pm-session` · `coordinator-elsewhere` (this session coordinates another workflow, or the workflow belongs to another session) · `envelope-invalid` · `register-invalid` (unreadable or invalid v2 root register / workflow snapshot). The derivation and its six-code vocabulary are the same on both routes; authority is decided by the adapter's `deriveStartAuthority` from host and engine facts, never by the call. At this anchor the named workflow has no coordinator session envelope yet — envelopes are written by `plan bind` / registration-time coordination, which follow the draft — so the derivation rests on that function's host-fact checks alone, the E1 trusted-assertion boundary already documented for a brand-new iteration at `packages/omp/src/extensions/model-handoff.ts:35-39`. The anchor move neither strengthens nor replaces that boundary and relaxes no envelope check. One approved observable mapping exists on the attach branch only: when the named registered workflow's own coordinator envelope names a different session, that decision — carrying an internal typed discriminator, itself not a refusal code or exported symbol — surfaces as `already-bound` with the original detail, `workflow <id> is bound to coordinator session <sessionId>, not to this session`. Every other authority failure keeps its original code on both routes, including `coordinator-elsewhere` when this session coordinates a different workflow.
- **Visible arm failures** (reported as failures; **no automatic retry**): `settings-read-failed` · `record-failed` · `slow-unresolved` · `slow-selection-failed` · `slow-selection-refused` · `arm-evidence-conflict`.
- **Host-level**: `tool-error` (the tool threw without touching model, ledger or engine state).
- **Success code**: `armed` (state `pending`) — the coordinator holds it until `phase-1-lock` fires or the handoff is cancelled.

#### `phase-1-lock` — `mstar_model_handoff {operation:"phase1-complete", workflowId, coordinatorSessionPath?, mainWorktreeBranch, reviews[], plans[]}`

- **Exact parameters**: `workflowId` (must equal the bound workflow) · `mainWorktreeBranch` (string — the recorded integration branch) · `reviews[]` — **exactly three ordered specialist returns** · `plans[]` — **at least one** bound-plan evidence entry · `coordinatorSessionPath` — **optional and pre-activation only**: on the file route it names the coordinator's own envelope, while on an ACTIVE execution authority the DB binding is the authority and the field is not supplied at all. A missing or wrong-length input is refused, never inferred.
- **When**: Phase 1 completion — **after** the integration worktree exists (recorded `integration_worktree_path`), the reviewed changes are committed on that checkout and `spec_integration_branch` is pushed: the tail of the §2.3 integration-worktree checklist, whose **step 7** performs that transfer + commit + push (Phase 1 reaches it through `iteration-start` §6). The compass/PM lock alone is **not** the moment — it leaves readiness items 3–4 unmet, so `not-ready` returns, the binding stays `pending`, and no later marker retries it. The call is made once, on the Phase 1 route; a Phase 2 resume that walks the same section must not repeat it — the binding is already terminal, so a repeat call returns `not-pending` (flagged as an error, since no `pending` binding exists any more) and is not required.
- **Required or optional**: **required**, and never a silent skip — every refusal lands in the tool result, and every state transition additionally as a durable session notice under `mstar:notice` (title semantics → **Coordinator-visible notices** above).
- **Readiness prerequisite (all four, re-checked at fire time)**: the sequential specialist returns for that iteration; the PM-confirmed Prepare gate for every registered plan with `compass status: locked`; a distinct same-repository integration checkout on its recorded branch; a remote tip equal to the validated integration HEAD. `evaluatePhaseGate` is a later-phase gate and is never readiness evidence; a draft compass, a lock alone, a missing checkout or an unpushed commit is not ready.
- **Refusals that leave the binding `pending`** (fix the stated cause and call again — **nothing was switched**): `not-ready` (carries `codes[]` naming the unmet readiness facts; not an error) · `preference-off` (`modelHandoff` off at fire time; not an error) · `settings-read-failed` (read once before and once after the readiness work) · `suspended` · `in-flight` · `record-failed` · `not-pending` (no binding — run `direction-lock` first) · `binding-mismatch` (the call names a different workflow) · `invalid-completion-input` (the evidence shape above).
- **Terminal refusals** (**no retry**; the session keeps the model it actually has): `cancelled` (an unowned model change arrived while pending; not an error) · `target-unresolved` (`handoffTarget` unresolvable) · `switch-refused` / `switch-threw` (the host refused the selection).
- **Host-level**: `tool-error`. **Success code**: `handed_off` (state `handed_off`, with the actual model reported).

#### `phase-2-entry` — `mstar_phase2 {operation:"bind", workflowId}`

- **Exact parameters**: `workflowId` alone, plus `operation`. The request object is strict — **no session path, session reference, token, caller role or authority claim is accepted** — and authority is derived host-side, never from the call: the host session id, the canonical control harness root, the accepted phase and the checkout root are all re-read, and the identity pointer is adopted from the addressed root's own authority (the ACTIVE DB coordinator binding — resumed against the current store/epoch before it is recorded — or, pre-activation, the workflow's **own** recorded coordinator envelope). An extra or missing key refuses instead of selecting a fallback authority.
- **When**: the **Phase 2 execute/resume entry** — immediately before the per-plan loop (`## 2.4 Per-plan loop`), after the §2.0 gates and after §2.3's branch/worktree resolution; also required on a no-argument `/iteration-drive` resume. It is explicitly **not** the Phase-1-reused integration-worktree step: Phase 1's `iteration-start` §6 walks §2.3 to create the integration checkout, and that step triggers no anchor (`phase-2-entry` fires only on the Phase 2 route, and `phase-1-lock` fires once at that checklist's tail).
- **Required or optional**: **required**. It records a session **identity pointer** only — plugin observation binding, not engine `plan bind` — and writes no engine credential and no engine state. On the ACTIVE route the durable record is the version-2 `bind` (`{version: 2, kind: "bind", hostSessionId, workflowId, executionBinding}`); an earlier record carrying an envelope path stays readable as **legacy history** and is never upgraded into a DB binding — an active binding always supersedes it, and the launch journal refuses on a binding that is still the pre-activation envelope record.
- **Prerequisite**: the snapshot's accepted phase is `phase-2-execute` (an unknown or missing phase disables the observation) · the caller sits on this workflow's coordinator seat · the caller's checkout is the main worktree or the recorded integration worktree.
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
