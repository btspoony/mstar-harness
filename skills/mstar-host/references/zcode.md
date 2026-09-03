# ZCode host reference

Load when **`mstar-host`** detection resolves **zcode** (ZCode client session, `Agent` / `AskUserQuestion` / `EnterPlanMode` / `TodoWrite` tools, or `/morning-star-harness:*` plugin commands).

Plan mode: read **`zcode-plan-mode-bridge.md`** when `EnterPlanMode` / `ExitPlanMode` is active.

Parallel PM dispatch: read **`parallel-dispatch.md`** when dispatching **N ≥ 2** concurrent `Agent` invocations.

## ZCode-only context

- Plugin manifest: **`.zcode-plugin/plugin.json`** (plugin root is the **repo root**; paths stay `./skills/`, `./commands/`, `./agents/`).
- Runtime skills: repo `skills/` mounted by the plugin (`"skills": "./skills/"`).
- Plugin commands: repo `commands/` → `/morning-star-harness:<name>` (e.g. `/morning-star-harness:iteration-start`).
- Plugin agents: repo `agents/*.md` (role frontmatter `name` + **single-line quoted English `description`** — ZCode's flat frontmatter parser cannot read `|-` block scalars and silently drops nested `tools`/`permission` maps). ZCode registers them as callable `subagent_type`s in both bare (`fullstack-dev`) and plugin-qualified (`morning-star-harness:fullstack-dev`) forms (see C5).
- **No `sessionStart.skill`** (ZCode has no Kimi-style session auto-load) — enter PM manually via **`/morning-star-harness:pm`** or the **`pm`** skill, then **Read next** → `mstar-harness-core` → `project-manager.md`.
- Install (user-scoped, recommended): `npx @mstar-harness/cli init --target zcode --scope global`, then in ZCode **Settings → Plugin Management → Discover** install **morning-star-harness** from the **mstar-local** marketplace. Direct-add also works without the CLI: the repo ships `.claude-plugin/marketplace.json` (root `marketplace.json` fallback), which ZCode discovers when refreshing a `github`-source marketplace.
- Plugins are **user-scoped** (all projects); managed copy lives under `~/.zcode/cli/plugins/` after install.
- Project `.agents/skills/` symlinks are **not** required when using the plugin — commands and skills come from the plugin mount.

## Skill loading

1. On entry: invoke **`pm`** (via `/morning-star-harness:pm` or `/skill:pm`) → **Read next** loads `mstar-harness-core`, then `mstar-roles` → `project-manager.md` when PM is active.
2. Read `mstar-host` and this ZCode reference.
3. If Plan mode is active, read `zcode-plan-mode-bridge.md`.
4. Load `mstar-roles` and the active role reference.
5. Load topic skills on demand per the role reference.

Use skill names in prompts and references. Avoid absolute local paths unless maintaining this repository or skills are not installed. Skill-root resolve (plugin mount `./skills/<name>/`) → `mstar-host` § Resolve loaded skill root.

## Tools map (default agent)

| ZCode tool | Harness use |
|------------|-------------|
| **Agent** | Primary dispatch — delegate one subagent task (`subagent_type`: bare Morning Star role id, e.g. `fullstack-dev`; `general-purpose` fallback; `Explore` read-only) |
| **AskUserQuestion** | Structured clarify (1–4 questions, 2–4 options each); prefer over free-form when choices are known |
| **EnterPlanMode** / **ExitPlanMode** | Plan mode entry/approval → **`zcode-plan-mode-bridge.md`** |
| **TodoWrite** | Session UX only; mirror to SSOT plan / workflow snapshot (`{WORKFLOW_DIR}/<id>/snapshot.json`) when durable |
| **Bash** | Commands, git, tests — evidence per `mstar-coding-behavior` |
| **Read** | File reads (text + images) |
| **Edit** / **Write** | Edits |
| **Glob** / **Grep** | Search (prefer over shell find/grep) |
| **WebSearch** / **WebFetch** | External docs / facts |
| **Skill** | Invoke bundled skills (`/morning-star-harness:pm`, `mstar-harness-core`, …) |
| **TaskOutput** / **TaskStop** | Long-running task management when present |

OpenCode-style `question`/`task`, Cursor **Task**, and Kimi **AgentSwarm** are **not** ZCode tools — do not assume them.

## Role agents (C5)

ZCode registers the plugin's Morning Star agents (`agents/*.md`) as callable **`subagent_type`** values alongside the built-in profiles, in both **bare role id** (`fullstack-dev`) and **plugin-qualified** (`morning-star-harness:fullstack-dev`) forms. Prefer the **bare role id** (verified on ZCode 0.16.5: the bare form loads the role shell body; the qualified form can silently fall back to the default prompt):

| `subagent_type` | ZCode profile | Harness mapping |
|-----------------|---------------|-----------------|
| `<role-id>` (bare, e.g. `fullstack-dev`, `qc-specialist`) | Registered plugin agent | **Preferred** for the matching Morning Star role |
| `Explore` | Built-in read-only exploration | Orientation, codebase survey, Prepare explore passes |
| `general-purpose` | Built-in general profile | **Universal fallback** when a role id is not exposed |

Role shells are thin — each body only states the role identity and points at the `mstar-roles` skill — so C5b prompt binding stays **required** on every dispatch regardless of `subagent_type`.

### Role binding in prompt (C5b — required)

Role-binding contract + Assignment template → **`_shared/host-role-binding-core.md`** (C5/C5b). ZCode-specific invoke shapes, same turn:

```text
Agent(
  subagent_type: "fullstack-dev",
  description: "<short task label>",
  prompt: "<full Assignment body including Act as + skill load>"
)
```

Role id not exposed (older ZCode) → fall back to `subagent_type: "general-purpose"`. For **`Explore`** orientation:

```text
Agent(subagent_type: "Explore", description: "...", prompt: "... Act as explore-only orientation; Execute as: n/a ...")
```

## PM dispatch (`Agent`)

Harness **dispatch** on ZCode = **one or more `Agent` tool calls** with correct **`subagent_type`** and role-bound prompts (C5b → **`_shared/host-role-binding-core.md`**). N-parallel / 1-Assignment-1-invoke / paste-only mechanics → **`parallel-dispatch.md`**.

| Harness | ZCode |
|---------|-------|
| `Execute as: <role-id>` | Role id in Assignment + **Act as** + skill load in **Agent** prompt (C5b) |
| `subagent_type` for invoke | bare role id (e.g. `fullstack-dev`, `qc-specialist`); `general-purpose` fallback; `Explore` for read-only |
| Parallel batch **N** | **N `Agent`** calls in **one assistant message** |

### QC default

- **`Execution mode: sdd`**: **N=3** `Agent` calls (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`) — each prompt **Act as** the respective QC role, all via bare `subagent_type: "qc-specialist"` / `"qc-specialist-2"` / `"qc-specialist-3"` (`general-purpose` fallback; N rules → `parallel-dispatch.md`).
- **`inline`**: **N=1** per `parallel-dispatch.md`.

Cannot emit required **N** → **`Blocked`**.

### SDD implement (serial)

- **`Execution mode: sdd`**: one implementer **`Agent`** per task id (bare role id per C5, `general-purpose` fallback); task reviewer = new **`Agent`** with **Act as `code-reviewer`** (`subagent_type: "code-reviewer"`, `general-purpose` fallback; ZCode L2 review; not qc-specialist*), always with C5b prompt binding — no sticky resume unless host adds it later. Serial rule → **`parallel-dispatch.md`** § SDD implement.
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
- Morning Star roles **are** registered as ZCode subagent types from `agents/*.md` — but the shells are thin, so role binding is **still always** prompt + skill load (C5b); prefer bare role ids, the qualified form can fall back to the default prompt.
- ZCode has no `sessionStart.skill`; new sessions do **not** auto-load PM — invoke `/morning-star-harness:pm` or `/skill:pm` manually.
