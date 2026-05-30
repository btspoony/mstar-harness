# OpenCode host reference

Load when **`mstar-host`** detection resolves **opencode** (`question` tool, `@<agent-id>` invoke, or OpenCode session).

Parallel PM dispatch: **`parallel-dispatch.md`** (read in dispatch rounds).

## Role loading

- **Role shell**: `agents/<id>.md` referenced by `opencode.json` `agent.<id>` (frontmatter + role binding only).
- **Role body**: `mstar-roles` `references/<id>.md` (or shared references + parameters).
- Superpowers conflicts: `mstar-superpowers-align`.

## OpenCode-specific capabilities

- **Structured clarify**: prefer `question` tool (title, prompt, options, optional custom text). Requires `permission.question` in config (user-maintained; do not edit global config without consent).
- **Built-in subagents**: `@explore` (read-only), `@general`; subject to `mstar-harness-core` explore boundaries.
- **Named roles (`@<agent-id>`)**: configured in `opencode.json` `agent.<id>` must be **actually invoked** by PM. Assignment Markdown alone does not open sessions.
- **Per-role models**: configurable per subagent in `opencode.json`.

## Invoke entry

Use host subagent / Task / equivalent per **`parallel-dispatch.md`**. OpenCode PM typically uses **`@<agent-id>`** or the host’s subagent entry — same **no tool = no dispatch** rule.

## Prepare phase — serial roles still require invoke

`mstar-roles` **project-manager** may route `@explore → @product-manager → @architect` **sequentially**. Each handoff still needs a real **host invoke** with Assignment (often **`N = 1`** per dispatch turn). Writing PRD / architecture only in the PM chat when routing assigns **`product-manager`** or **`architect`** is **not** a substitute. Cross-check: `mstar-roles` → `references/project-manager.md` → **§1.1.1a Phase routing pre-flight**.

## Gotchas

- `question` availability is config-dependent; if unavailable, structured Markdown clarify.
- `@explore` is orientation only, not role-owned implementation or review deliverables.
- More MCPs do not replace phase gates or evidence rules.

## Session noise control

- Large unrelated platform injections (e.g. long ecosystem prompts): prefer on-demand / `alwaysApply: false` when not stack-relevant.
- One default channel per capability class (search, docs).

## Optional MCPs / skills (user-enabled)

Aligned with `mstar-harness-core` `references/open-harness-principles.md`. Editing global `opencode.json` requires explicit user consent.

| Capability | Purpose | Notes |
|------|------|------|
| **Current docs** | Versioned API/libs | Context7-like MCP or equivalent |
| **Web search** | Time-sensitive / migrations | Avoid duplicate search MCPs |
| **Code pattern search** | Cross-repo references | e.g. grep.app MCP |
| **Repo graph** | Impact / PR risk | e.g. GitNexus |
| **Browser / E2E** | Observable QA evidence | agent-browser, Playwright |
| **Git workflow** | Atomic commits, branch closure | git-commit, finishing-a-development-branch |
| **Systematic debugging** | RCA before fix | `mstar-superpowers-align` |
| **OpenViking memory** | Long-term memory tools | Only if `memsearch` present; `openviking-memory-plugin.md` |

**Not recommended**: overlapping search MCPs; extra tools to mask missing harness baseline.

## Maintenance boundary

Runtime only — do not modify `opencode.json`, `secrets.env`, or `.secrets/*` without explicit user consent.
