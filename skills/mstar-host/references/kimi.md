# Kimi host reference

Load when **`mstar-host`** detection resolves **kimi** (Kimi Code CLI session, `Agent` / `AgentSwarm` / `AskUserQuestion` / `EnterPlanMode` tools, or `/morning-star-harness:*` plugin commands).

Plan mode: read **`kimi-plan-mode-bridge.md`** when `EnterPlanMode` / `ExitPlanMode`, `/plan`, or `kimi --plan` is active.

Parallel PM dispatch: read **`parallel-dispatch.md`** when dispatching **N ≥ 2** concurrent `Agent` invocations.

## Kimi-only context

- Plugin manifest: **`.kimi-plugin/plugin.json`** (plugin root is the **repo root**; paths stay `./skills/` and `./commands/`).
- Runtime skills: repo `skills/` mounted by the plugin (`"skills": "./skills/"`).
- Plugin commands: repo `commands/` → `/morning-star-harness:<name>` (e.g. `/morning-star-harness:iteration-start`).
- **`sessionStart.skill: pm`** auto-loads the PM entry shim on new sessions; `pm` → **Read next** → `mstar-harness-core` → `project-manager.md`.
- **`/skill:pm`** or **`pm` skill**: same PM entry when invoked manually.
- Install (user-scoped): in Kimi TUI `/plugins install https://github.com/btspoony/mstar-harness` then `/plugins reload` (or `/new`).
- Plugins are **user-scoped** (all projects); managed copy lives under `$KIMI_CODE_HOME/plugins/managed/` after `/plugins install`.
- Project `.agents/skills/` symlinks are **not** required when using the plugin — commands and skills come from the plugin mount.

## Skill loading

1. On session start: `pm` (via `sessionStart.skill`) → **Read next** loads `mstar-harness-core`, then `mstar-roles` → `project-manager.md` when PM is active.
2. Read `mstar-host` and this Kimi reference.
3. If Plan mode is active, read `kimi-plan-mode-bridge.md`.
4. Load `mstar-roles` and the active role reference.
5. Load topic skills on demand per the role reference.

Use skill names in prompts and references. Avoid absolute local paths unless maintaining this repository or skills are not installed.

## Tools map (default agent)

| Kimi tool | Harness use |
|-----------|-------------|
| **Agent** | Primary dispatch — delegate one subagent task (`subagent_type`: `coder` \| `explore` \| `plan`) |
| **AgentSwarm** | Parallel batch when **same** role/profile and prompts differ only by task slice; prefer **N× Agent** when roles differ |
| **AskUserQuestion** | Structured clarify (1–4 questions, 2–4 options each); prefer over free-form when choices are known |
| **EnterPlanMode** / **ExitPlanMode** | Plan mode entry/approval → **`kimi-plan-mode-bridge.md`** |
| **TodoList** | Session UX only; mirror to SSOT plan / `status.json` when durable |
| **Bash** | Commands, git, tests — evidence per `mstar-coding-behavior` |
| **Read** / **ReadMediaFile** | File reads |
| **Glob** / **Grep** | Search (prefer over shell find/grep) |
| **Write** / **Edit** | Edits |
| **WebSearch** / **FetchURL** | External docs / facts |
| **TaskList** / **TaskOutput** / **TaskStop** | Long-running task management when present |

OpenCode-style `question` and Cursor **Task** are **not** Kimi tools — do not assume them.

## Role agents (C5 — hard constraint)

Kimi ships **built-in subagent types only**. Valid **`subagent_type`** values:

| `subagent_type` | Kimi profile | Harness mapping |
|-----------------|--------------|-----------------|
| `explore` | Read-only exploration | Orientation, codebase survey, Prepare explore passes |
| `plan` | Plan-mode subagent | Prepare plan-only work when host is already in plan context |
| `coder` | General implementation | **All other Morning Star roles** (`product-manager`, `fullstack-dev`, `qc-specialist`, …) |

Morning Star role ids (`project-manager`, `fullstack-dev`, `qc-specialist`, …) are **not** valid `subagent_type` values. The host cannot register custom named agents like Codex TOML or Cursor `subagent_type` role ids.

### Role binding in prompt (C5b — required)

Role-binding contract + Assignment template → **`_shared/host-role-binding-core.md`** (C5/C5b). Kimi-specific invoke shapes, same turn:

```text
Agent(
  subagent_type: "coder",
  prompt: "<full Assignment body including Act as + skill load>"
)
```

For **`explore`** orientation:

```text
Agent(subagent_type: "explore", prompt: "... Act as explore-only orientation; Execute as: n/a ...")
```

For Prepare plan-only when plan subagent is appropriate:

```text
Agent(subagent_type: "plan", prompt: "... Act as architect for plan design; load mstar-roles → architect.md ...")
```

## PM dispatch (`Agent` / `AgentSwarm`)

Harness **dispatch** on Kimi = **one or more `Agent` tool calls** with correct **`subagent_type`** and role-bound prompts (C5b → **`_shared/host-role-binding-core.md`**). N-parallel / 1-Assignment-1-invoke / paste-only mechanics → **`parallel-dispatch.md`**.

| Harness | Kimi |
|---------|------|
| `Execute as: <role-id>` | Role id in Assignment + **Act as** + skill load in **Agent** prompt (C5b) |
| `subagent_type` for invoke | `coder` \| `explore` \| `plan` only (see mapping) |
| Parallel batch **N** | **N `Agent`** calls in **one assistant message** when roles may differ; **`AgentSwarm`** only when same role/profile |

### QC default

- **`Execution mode: sdd`**: **N=3** `Agent` calls (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`) — each prompt **Act as** the respective QC role, all `subagent_type: "coder"` (N rules → `parallel-dispatch.md`).
- **`inline`**: **N=1** per `parallel-dispatch.md`.

Cannot emit required **N** → **`Blocked`**.

### SDD implement (serial)

- **`Execution mode: sdd`**: one implementer **`Agent`** per task id; task reviewer = new **`Agent`** (no sticky resume unless host adds it later). Serial rule → **`parallel-dispatch.md`** § SDD implement.
- **Never** multiple implementer Agents in one message for the same plan.

## Clarify

- Prefer **`AskUserQuestion`** for 1–3 high-impact choices with known options.
- Fallback: one concise Markdown question after codebase exploration cannot answer it.
- `AskUserQuestion` for plan approval is wrong in Plan mode — use **`ExitPlanMode`** for plan sign-off.
- “Question asked” ≠ clarify done; blocking ambiguity → **`Blocked`** or escalation.

## Commands and skills paths

| Surface | Path / invocation |
|---------|-------------------|
| Plugin skills | `/skill:<skill-name>` or auto-load from `skills/` via plugin |
| Plugin commands | `/morning-star-harness:iteration-start` etc. |
| Session entry | `sessionStart.skill: pm` → `mstar-harness-core` via pm **Read next** |

## Files, shell, and approvals

- Prefer **Glob** / **Grep** for search; **Write** / **Edit** for edits.
- Respect Kimi approval prompts for destructive operations.
- Do not edit `$KIMI_CODE_HOME` credentials, managed plugin copies, or user secrets without explicit consent.

## Git and final evidence

- Git work follows `mstar-branch-worktree` and Assignment **Working branch** / **Branch policy**.
- Completion reports cite concrete commands, artifacts, and commit lines when required.

## Gotchas

- Plugin install copies source to managed dir — edit checkout + reinstall to pick up harness changes.
- **`AgentSwarm`** shares one template — not for mixed-role QC tri-review; use **3× Agent** instead.
- Session plan file and `TodoList` are not durable SSOT unless mirrored to `{HARNESS_DIR}`.
- No custom Kimi agent profiles for Morning Star roles — role binding is **always** prompt + skill load (C5b).
