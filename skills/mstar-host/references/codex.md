# Codex host reference

Load when **`mstar-host`** detection resolves **codex** (Codex app/CLI session, Codex plugin installed from `.codex-plugin/plugin.json`, Codex custom agents linked from `codex/agents/*.toml`, or Codex tool namespaces such as `functions.*`, `codex_app.*`, `tool_search`, `image_gen`, or Browser plugin tools).

Plan / Goal Mode: read **`codex-plan-goal-mode-bridge.md`** when Codex Plan Mode (`/plan`) or Goal Mode (`/goal`, goal tools, or goal progress controls) is active. Codex session plans, UI todos, and goal text are not durable harness SSOT.

Parallel PM dispatch: read **`parallel-dispatch.md`** only when Codex exposes an actual multi-agent / Task-style invocation tool. If no callable invoke tool exists, Assignment Markdown is coordination text only; do **not** claim subagent dispatch.

## Codex-only context

- Plugin source: `.codex-plugin/plugin.json`.
- Runtime skills: repo `skills/` mounted by the Codex plugin (`"skills": "./skills/"`).
- Custom agent source: repo `codex/agents/*.toml`; CLI/manual install links these into `~/.codex/agents/` or project `.codex/agents/`.
- `/pm`: shared force entry via the `pm` skill; after that, role behavior comes from `mstar-roles`.
- Role files under root `agents/` are for hosts that load OpenCode/Cursor-style agent shells; Codex uses `codex/agents/*.toml` and still loads `mstar-roles` references directly.
- Tool and plugin availability can be lazy-loaded or session-dependent. Use the tools actually present in the current session; do not infer capability from documentation alone.

## Skill loading

1. Read `mstar-harness-core`.
2. Read `mstar-host` and this Codex reference.
3. If Plan Mode or Goal Mode is active, read `codex-plan-goal-mode-bridge.md`.
4. Load `mstar-roles` and the active role reference.
5. Load topic skills on demand per the role reference.

Use skill names in prompts and references. Avoid absolute local paths unless the user is maintaining this repository or the skill is not installed and must be read from the checkout.

## Clarify

- Codex does not imply an OpenCode-style `question` tool.
- If a structured user-input tool is available in the active mode, use it for concise 1-3 choice decisions.
- Otherwise ask one concise Markdown question only after codebase exploration cannot answer it.
- `update_plan` / local todo UI is session progress only; it does not replace `{PLAN_DIR}` plans or `{HARNESS_DIR}/status.json`.
- Codex Goal Mode objective is completion criteria for the host thread, not Morning Star Done authority; mirror it into the SSOT plan when the work is implementation-sized.

## Dispatch and role execution

- **No invoke tool / no linked custom agent = no dispatch**: printing `## Assignment` does not start another Codex worker.
- If Codex exposes custom-agent / multi-agent tools and matching Morning Star agents are linked, PM may dispatch through those tools and must follow `parallel-dispatch.md`.
- If no invoke tool is present when dispatch is required, return **`Blocked`** — report missing invoke capability to the user. Do not substitute single-session role execution in the PM thread unless the user explicitly overrides harness dispatch for this turn.
- QC tri-review requires three callable reviewer sessions in one dispatch turn. Cannot emit **N=3** → **`Blocked`** for PM rerouting; do not claim tri-review complete or substitute serial/manual review in the PM thread.
- Leaf executors still follow `mstar-dispatch-gates`: no recursive Task/subagent calls unless Assignment says `Delegation: allowed (...)`.

## Files, shell, and approvals

- Prefer `rg` / `rg --files` for search and `apply_patch` for manual edits.
- Respect Codex sandbox and approval prompts. If a required command fails because of sandbox or network restrictions, request escalation through the host approval mechanism.
- Do not edit global Codex plugin metadata, marketplace files, credentials, secrets, or user config without explicit user consent.
- Browser, image, document, spreadsheet, presentation, and automation capabilities are host tools. Use them only when the user request or verification need calls for them.

## Git and final evidence

- Git work still follows `mstar-branch-worktree` and the Assignment `Working branch` / `Branch policy`.
- Codex app git directives, when available, are audit annotations only. Emit them only after the underlying git action succeeds; never use a directive as a substitute for staging, committing, pushing, or PR creation evidence.
- Completion reports should cite concrete commands, artifacts, and commit lines when required by the Assignment.

## Gotchas

- Codex plugin install gives skills; Morning Star role subagents require custom agent TOML files linked from `codex/agents/`.
- Tool discovery (`tool_search`) can reveal capabilities, but availability is not authorization; Assignment `Delegation` still controls use.
- Session plans, Goal Mode text, chat summaries, and UI todos are not durable harness SSOT unless mirrored to `{HARNESS_DIR}`.
