# omp host reference

Load when **`mstar-host`** detection resolves **omp** (Oh My Pi / `omp` session, **`task`** tool with **`agent`** / **`tasks[]`** batch shape, **`ask`** tool, **`hub`** tool, or `/skill:pm` / `/iteration-*` from this plugin).

Plan mode: read **`omp-plan-mode-bridge.md`** when `/plan`, plan-yolo, or plan-model / read-only-with-resolve plan UX is active.

Parallel PM dispatch: read **`parallel-dispatch.md`** when dispatching **N ≥ 2** concurrent `task` invocations.

## omp-only context

- Plugin markers: **`.omp-plugin/plugin.json`** (Morning Star host marker) and **`.claude-plugin/plugin.json`** (Claude-compatible marketplace discovery). Plugin root is the **repo root**; paths stay `./skills/`, `./commands/`, `./agents/`.
- Runtime skills: repo `skills/` discovered after `omp plugin install` / `omp plugin link` (OMP extension-package sub-discovery) or Claude marketplace install.
- Plugin commands: repo `commands/<name>.md` → slash **`/<name>`** (e.g. `/iteration-start`). omp uses the **filename** as the command name (no `morning-star-harness:` prefix).
- Plugin agents: repo **`agents/*.md`** are discovered into the live **`task.agent`** list after install/link + reload. Morning Star **subagent** role ids (`product-manager`, `architect`, `fullstack-dev`, `qc-specialist`, …) are valid `agent` values **when listed** — see C5. `project-manager` is **`mode: primary`** (orchestration seat), not a typical `task` dispatch target.
- **No Kimi-style `sessionStart.skill`** — enter PM manually via **`/skill:pm`** (or the `pm` skill), then **Read next** → `mstar-harness-core` → `project-manager.md`.
- Install (user-scoped, recommended):
  - `omp plugin install github:btspoony/mstar-harness`
  - or CLI: `npx @mstar-harness/cli init --target omp --scope global` (links `~/.mstar/harness`)
- Project scope: `omp plugin install github:btspoony/mstar-harness --scope project` or `npx @mstar-harness/cli init --target omp --scope project`.
- Local maintainers: `omp plugin link /path/to/mstar-harness` (or the CLI-managed `~/.mstar/harness` checkout).
- After install/link: `omp plugin list` should show package **`morning-star`** (root `package.json` name). Reload / new session to pick up skills, commands, and agents.

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

- `project-manager` is the **primary** orchestration agent (`agents/project-manager.md` `mode: primary`). Do not dispatch PM-to-PM via `task` unless the live schema explicitly lists it **and** the Assignment requires it.
- Host generics (`scout`, `reviewer`, `designer`, …) remain useful for non-role orientation / assist — they do not replace a listed Morning Star role agent for role-owned deliverables.

### Role binding in prompt (C5b — required)

omp C5/C5b SSOT is **this file** — do **not** use `_shared/host-role-binding-core.md` (that file is Kimi/ZCode only). Even when `agent` already matches the role id, still bind Morning Star process in the Assignment / `task` body (agent shell ≠ full role prompt; skill load is not automatic).

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

### SDD implement (serial)

- **`Execution mode: sdd`**: one implementer `task` entry per task id with `agent` matching the implementer role when listed; task reviewer = new entry with `agent: "code-reviewer"` (omp L2 review; not qc-specialist*) or `agent: "reviewer"`/`"task"` as fallback + C5b — no sticky resume unless host resume/id is available and recorded. Serial rule → **`parallel-dispatch.md`** § SDD implement.
- **Never** multiple implementer entries in one message for the same plan.

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

- **Surfaces** (repo root = plugin root): `hooks/pre/mstar-gates.ts` — one `tool_call` pre-hook that returns `{ block: true, reason }` (structured refusal the model sees as the tool error) or `undefined` (pass); `tools/mstar_{status_validate,dispatch_validate,lease_verify,path_resolve,iteration_gate,worktree_check}/index.ts` — six model-callable validator tools (engine validators only, Zod params via `pi.zod`).
- **Enforcement semantics**: block ONLY under `Enforcement: hard`. The status gate reads the harness compass frontmatter (`enforcement: hard`, active/locked iterations only); the dispatch gate reads each Assignment's own header flag (`assignmentHeaderRegion` — a body example never hardens). Soft / no flag → silent pass. Rollback = unset the flag. Never global.
- **Engine dependency**: the adapters import the published engine package (root `package.json` `dependencies` entry). omp git/npm plugin installs run `bun install <spec>` in the plugins tree → declared deps installed; a bare `-l` / `omp plugin link` symlink install without `node_modules` cannot resolve the modules.
- **Graceful degradation (explicit)**: module load failure → `mstar_*` tools skipped, hook absent (no blocking), `commands/*.md` shell-out fallback intact. Caveat: a partial failure is SILENT — no in-band signal that gates are off; verify with `omp -p '/extensions'`.
- **`MSTAR_HARNESS_DIR` override**: the hook and tools discover `{HARNESS_DIR}` via `resolveHarnessDir`, which probes only `.mstar/` → `.agents/` → `.plans/`/`plans/` roots. Repos using a non-standard harness root (e.g. this plugin repo's own `.harness/`) MUST export `MSTAR_HARNESS_DIR` (absolute path) in the omp session env — without it the status gate does not cover those roots and tools like `mstar_path_resolve` / `mstar_lease_verify` error out (parity with the opencode binding).
- **Edit-path limitation**: the status gate validates the on-disk file for `edit` events (pre-edit state) — a corrupting edit is caught by the next write or `mstar_status_validate` (known v1 limitation, parity with opencode).
- **Engine version compatibility**: the hook and tools degrade gracefully until the engine release exporting both `composeDispatchGate` and `parseCompassFrontmatter` (published 2.0.2 predates both). Missing exports never fail module load: the hook's dispatch gate needs `composeDispatchGate` — on older engines Gate 2 (task dispatch) is skipped with a one-time warning while Gate 1 (status) stays active — and `mstar_dispatch_validate` / `mstar_iteration_gate` report an explicit upgrade error instead of loading (no silent absence; CLI fallbacks: `mstar dispatch validate`, `mstar iteration gate`).
- **Reload**: edits are picked up by a new session (`?mtime` cache-buster); in-session `/reload-plugins` (omp ≥ 17.2.11) applies them without a new session.

## Files, shell, and approvals

- Prefer host search/edit tools over shell find/sed when available.
- Respect omp approval prompts (`approval-mode`, write/yolo) for destructive operations.
- Do not edit `~/.omp/` credentials, plugin lockfiles, or user secrets without explicit consent.

## Git and final evidence

- Git work follows `mstar-branch-worktree` and Assignment **Working branch** / **Branch policy**.
- omp may offer task isolation / worktrees (`task.isolation`, `~/.omp/wt`) — still record Morning Star **Worktree path** / leases when L1 gates apply.
- Completion reports cite concrete commands, artifacts, and commit lines when required.

## Gotchas

- Installed npm/git plugin package name is root **`morning-star`** (`package.json`); Morning Star display name remains **morning-star-harness**.
- Marketplace (Claude) installs and `omp plugin install` are different discovery providers — prefer one install path per machine to avoid duplicate skill listings.
- Session plan UI / todos are not durable SSOT unless mirrored to `{HARNESS_DIR}`.
- After install/link, **reload / new session** so `agents/*.md` appear in the live `task.agent` list — stale sessions may only show host generics and wrongly push you to `agent: "task"`.
- Role agent shell ≠ full role prompt: **C5b skill load remains required** even when `agent` already equals the role id.
- omp has no `sessionStart.skill`; new sessions do **not** auto-load PM — invoke `/skill:pm` manually.
- Do not confuse omp **`task.agent`** with OpenCode **`subagent`** or Cursor **`subagent_type`**.
- Do not treat Kimi/ZCode “built-ins only → always `coder`/`task`” habits as omp defaults when Morning Star role agents are listed.
- **Sequential N=1 Review-&-Edit turns are where `agent` gets dropped**: the “all N in one message” pressure is absent and the count gate passes trivially — re-verify **`agent: "<Execute as>"`** on every single dispatch; `tasks:[{task:"…"}]` with no `agent` is a silent generic fallback, not a valid role invoke.
