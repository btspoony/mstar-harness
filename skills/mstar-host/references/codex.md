# Codex host reference

Load when **`mstar-host`** detection resolves **codex** (Codex app/CLI session, `/plan` / `/goal` slash commands, Goal tools, or Codex tool namespaces such as `functions.*`, `codex_app.*`, `tool_search`, `image_gen`, or Browser plugin tools).

Plan Mode loads references/_shared/plan-mode-bridge-core.md; Goal Mode follows mstar-host's capability rule for the selected workflow's full lifecycle. Session plans, UI todos and goal text remain projections, not harness state authority. No per-row primary route exists.

Parallel PM dispatch: read **`parallel-dispatch.md`** only when Codex exposes an actual multi-agent / Task-style invocation tool. If no callable invoke tool exists, Assignment Markdown is coordination text only; do **not** claim subagent dispatch.

## Codex-only context

- Plugin source: `.codex-plugin/plugin.json`.
- Runtime skills: repo `skills/` mounted by the Codex plugin (`"skills": "./skills/"`).
- Custom agent source: repo `codex/agents/*.toml`; CLI install copies these as regular files into `~/.codex/agents/` or project `.codex/agents/`.
- **`/pm`** or **`pm` skill**: force PM entry → `mstar-roles` → `project-manager.md` (Codex primary; Cursor/OpenCode for general per-plan work). **`commands/`** when running iteration Phase 1–5; project CLI install (`mstar-harness init --target codex --scope project`) materializes `iteration-start`, `iteration-drive`, and `iteration-loop` as `.agents/skills/<name>/SKILL.md` symlinks.
- Role files under root `agents/` are for hosts that load OpenCode/Cursor-style agent shells; Codex uses `codex/agents/*.toml` and still loads `mstar-roles` references directly.
- Tool and plugin availability can be lazy-loaded or session-dependent. Use the tools actually present in the current session; do not infer capability from documentation alone.

## Runtime and upgrade

- **Runtime**: this host ships no bundled store-backed entrypoint — skills mount as text and Morning Star role subagents are TOML agent files, so the floor belongs to whatever executes → `_shared/host-runtime-contract.md` § Node floor.
- **Upgrade / reload**: re-run the project or global CLI install (`mstar-harness init --target codex --scope <global|project>`) so the installed skills and `~/.codex/agents/` (or project `.codex/agents/`) TOML files are rewritten, then start a new session. Verify install health with `mstar-harness doctor --target codex --scope <global|project>`. The readiness flip that precedes an authority change → same file § Readiness, not an action.

## MCP delivery

- **Native install and loading**: add the repo marketplace (`codex plugin marketplace add btspoony/mstar-harness --ref main`) and install `morning-star-harness@mstar-repo`; `init --target codex` is optional maintainer setup. `.codex-plugin/mcp.json` carries the `npx` launch → same file § MCP delivery (including the context boundary this host shares).
- **Doctor and evidence**: `mstar-harness doctor --target codex --scope <global|project>` → same file § Doctor and evidence.

## Coordination transport (no host-native seat)

Mount shape on this host: skills mount as text and role subagents are TOML agent files — no native execution transport → `_shared/host-runtime-contract.md` § Coordination transport.

## Skill loading

1. Read `mstar-harness-core`.
2. Read `mstar-host` and this Codex reference.
3. If Plan Mode is active, read `references/_shared/plan-mode-bridge-core.md`; Goal Mode follows the `/goal` rule in `mstar-host` SKILL.md.
4. Load `mstar-roles` and the active role reference.
5. Load topic skills on demand per the role reference.

Use skill names in prompts and references. Avoid absolute local paths unless the user is maintaining this repository or the skill is not installed and must be read from the checkout. Skill-root resolve (plugin `skills/<name>/`, project `.agents/skills/<name>/`) → `mstar-host` § Resolve loaded skill root.

## Clarify

- Codex does not imply an OpenCode-style `question` tool.
- If a structured user-input tool is available in the active mode, use it for concise 1-3 choice decisions.
- Otherwise ask one concise Markdown question only after codebase exploration cannot answer it.
- `update_plan` / local todo UI is session progress only; it does not replace `{PLAN_DIR}` plans or store.db registry/workflow/plan rows.
- Codex Goal Mode objective is completion criteria for the host thread, not Morning Star Done authority; mirror it into the SSOT plan when the work is implementation-sized.

## Dispatch and role execution

- **No invoke tool / no available custom agent = no dispatch**: printing `## Assignment` does not start another Codex worker.
- If Codex exposes custom-agent / multi-agent tools and matching Morning Star agents are available, PM may dispatch through those tools and must follow `parallel-dispatch.md`.
- If no invoke tool is present when dispatch is required, return **`Blocked`** — report missing invoke capability to the user. Do not substitute single-session role execution in the PM thread unless the user explicitly overrides harness dispatch for this turn.
- Bind the role using the actual invoke schema. For example, when `collaboration.spawn_agent` exposes `agent_type`, set `agent_type: "fullstack-dev"` for `Execute as: fullstack-dev`; do not guess another host's parameter name.
- Discovery does not prove loading: an advertised role may still fail to start. Record the actual invocation error; a role-load failure is not a missing-tool failure. For installed TOML issues, use `mstar-harness doctor --target codex --scope <global|project>` and repair via `init` for that scope, then retry the named role. Claim dispatch only after a successful invocation.
- QC: N rules → **`parallel-dispatch.md`** (**`Execution mode: sdd`** → N=3; **`inline`** → N=1) when a callable invoke tool exists. Cannot emit required **N** → **`Blocked`**.
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

- Codex plugin install gives skills; Morning Star role subagents require regular custom agent TOML files installed from `codex/agents/`.
- Tool discovery (`tool_search`) can reveal capabilities, but availability is not authorization; Assignment `Delegation` still controls use.
- Session plans, Goal Mode text, chat summaries, and UI todos are not durable harness SSOT unless mirrored to `{HARNESS_DIR}`.
