# ZCode host reference

Load when **`mstar-host`** detection resolves **zcode** (ZCode client session, `Agent` / `AskUserQuestion` / `EnterPlanMode` / `TodoWrite` tools, or `/morning-star-harness:*` plugin commands).

Plan mode: read **`zcode-plan-mode-bridge.md`** when `EnterPlanMode` / `ExitPlanMode` is active.

Parallel PM dispatch: read **`parallel-dispatch.md`** when dispatching **N ≥ 2** concurrent `Agent` invocations.

## ZCode-only context

- Plugin manifest: **`.zcode-plugin/plugin.json`** (plugin root is the **repo root**; paths stay `./skills/`, `./commands/`, `./agents/`).
- Runtime skills: repo `skills/` mounted by the plugin (`"skills": "./skills/"`).
- Plugin commands: repo `commands/` → `/morning-star-harness:<name>` (e.g. `/morning-star-harness:iteration-start`).
- Plugin agents: repo `agents/*.md` (role frontmatter `name` + `description`); ZCode reads them as subagent definitions but **does not** expose custom named `subagent_type` values for Morning Star roles (see C5).
- **No `sessionStart.skill`** (ZCode has no Kimi-style session auto-load) — enter PM manually via **`/morning-star-harness:pm`** or the **`pm`** skill, then **Read next** → `mstar-harness-core` → `project-manager.md`.
- Install (user-scoped, recommended): `npx @mstar-harness/cli init --target zcode --scope global`, then in ZCode **Settings → Plugin Management → Discover** install **morning-star-harness** from the **mstar-local** marketplace (or add `github:btspoony/mstar-harness` as a marketplace directly).
- Plugins are **user-scoped** (all projects); managed copy lives under `~/.zcode/cli/plugins/` after install.
- Project `.agents/skills/` symlinks are **not** required when using the plugin — commands and skills come from the plugin mount.

## Skill loading

1. On entry: invoke **`pm`** (via `/morning-star-harness:pm` or `/skill:pm`) → **Read next** loads `mstar-harness-core`, then `mstar-roles` → `project-manager.md` when PM is active.
2. Read `mstar-host` and this ZCode reference.
3. If Plan mode is active, read `zcode-plan-mode-bridge.md`.
4. Load `mstar-roles` and the active role reference.
5. Load topic skills on demand per the role reference.

Use skill names in prompts and references. Avoid absolute local paths unless maintaining this repository or skills are not installed.

## Tools map (default agent)

| ZCode tool | Harness use |
|------------|-------------|
| **Agent** | Primary dispatch — delegate one subagent task (`subagent_type`: built-in profiles such as `general-purpose` / `Explore`) |
| **AskUserQuestion** | Structured clarify (1–4 questions, 2–4 options each); prefer over free-form when choices are known |
| **EnterPlanMode** / **ExitPlanMode** | Plan mode entry/approval → **`zcode-plan-mode-bridge.md`** |
| **TodoWrite** | Session UX only; mirror to SSOT plan / `status.json` when durable |
| **Bash** | Commands, git, tests — evidence per `mstar-coding-behavior` |
| **Read** | File reads (text + images) |
| **Edit** / **Write** | Edits |
| **Glob** / **Grep** | Search (prefer over shell find/grep) |
| **WebSearch** / **WebFetch** | External docs / facts |
| **TaskOutput** / **TaskStop** | Long-running task management when present |

OpenCode-style `question`/`task`, Cursor **Task**, and Kimi **AgentSwarm** are **not** ZCode tools — do not assume them.

## Role agents (C5 — hard constraint)

ZCode ships **built-in subagent types only** (e.g. `general-purpose`, `Explore`). Valid **`subagent_type`** values are the host's built-in profiles:

| `subagent_type` | ZCode profile | Harness mapping |
|-----------------|---------------|-----------------|
| `Explore` | Read-only exploration | Orientation, codebase survey, Prepare explore passes |
| `general-purpose` | General implementation / research | **All other Morning Star roles** (`product-manager`, `fullstack-dev`, `qc-specialist`, …) |

Morning Star role ids (`project-manager`, `fullstack-dev`, `qc-specialist`, …) are **not** valid `subagent_type` values. Although `agents/*.md` are read by ZCode, the host does not register them as callable named agent types the way Codex TOML or Cursor `subagent_type` role ids do.

### Role binding in prompt (C5b — required)

Role-binding contract + Assignment template → **`_shared/host-role-binding-core.md`** (C5/C5b). ZCode-specific invoke shapes, same turn:

```text
Agent(
  subagent_type: "general-purpose",
  description: "<short task label>",
  prompt: "<full Assignment body including Act as + skill load>"
)
```

For **`Explore`** orientation:

```text
Agent(subagent_type: "Explore", description: "...", prompt: "... Act as explore-only orientation; Execute as: n/a ...")
```

## PM dispatch (`Agent`)

Harness **dispatch** on ZCode = **one or more `Agent` tool calls** with correct **`subagent_type`** and role-bound prompts (C5b → **`_shared/host-role-binding-core.md`**). N-parallel / 1-Assignment-1-invoke / paste-only mechanics → **`parallel-dispatch.md`**.

| Harness | ZCode |
|---------|-------|
| `Execute as: <role-id>` | Role id in Assignment + **Act as** + skill load in **Agent** prompt (C5b) |
| `subagent_type` for invoke | built-in profiles only (typically `general-purpose`; `Explore` for read-only) |
| Parallel batch **N** | **N `Agent`** calls in **one assistant message** |

### QC default

- **`Execution mode: sdd`**: **N=3** `Agent` calls (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`) — each prompt **Act as** the respective QC role, all `subagent_type: "general-purpose"` (N rules → `parallel-dispatch.md`).
- **`inline`**: **N=1** per `parallel-dispatch.md`.

Cannot emit required **N** → **`Blocked`**.

### SDD implement (serial)

- **`Execution mode: sdd`**: one implementer **`Agent`** per task id; task reviewer = new **`Agent`** (no sticky resume unless host adds it later). Serial rule → **`parallel-dispatch.md`** § SDD implement.
- **Never** multiple implementer Agents in one message for the same plan.

## Clarify

- Prefer **`AskUserQuestion`** for 1–3 high-impact choices with known options.
- Fallback: one concise Markdown question after codebase exploration cannot answer it.
- `AskUserQuestion` for plan approval is wrong in Plan mode — use **`ExitPlanMode`** for plan sign-off.
- "Question asked" ≠ clarify done; blocking ambiguity → **`Blocked`** or escalation.

## Commands and skills paths

| Surface | Path / invocation |
|---------|-------------------|
| Plugin skills | `/skill:<skill-name>` or auto-load from `skills/` via plugin |
| Plugin commands | `/morning-star-harness:iteration-start` etc. |
| Session entry | `/morning-star-harness:pm` or `/skill:pm` → `mstar-harness-core` via pm **Read next** |

## Files, shell, and approvals

- Prefer **Glob** / **Grep** for search; **Write** / **Edit** for edits.
- Respect ZCode permission prompts for destructive operations.
- Do not edit `~/.zcode/` credentials, managed plugin copies, or user secrets without explicit consent.

## Git and final evidence

- Git work follows `mstar-branch-worktree` and Assignment **Working branch** / **Branch policy**.
- Completion reports cite concrete commands, artifacts, and commit lines when required.

## Gotchas

- Plugin install materializes source under `~/.zcode/cli/plugins/` — edit the harness checkout + reinstall to pick up harness changes.
- Session todos (`TodoWrite`) are not durable SSOT unless mirrored to `{HARNESS_DIR}`.
- No custom ZCode agent profiles for Morning Star roles — role binding is **always** prompt + skill load (C5b).
- ZCode has no `sessionStart.skill`; new sessions do **not** auto-load PM — invoke `/morning-star-harness:pm` or `/skill:pm` manually.
