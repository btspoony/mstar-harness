# OpenViking Memory Plugin (OpenCode, optional)

This reference applies **only** when the current agent session exposes OpenViking tools (detection: **`memsearch`** is available in the tool list). It documents harness-aligned usage; implementation details follow the OpenCode plugin (for example `openviking-memory.ts` beside `openviking-config.json` under the user’s OpenCode plugins directory).

## What the plugin provides

Typical tools (names match the reference plugin):

| Tool | Purpose |
| --- | --- |
| `memsearch` | Unified semantic search over memories, resources, and skills (`mode`: `auto` / `fast` / `deep`). |
| `memread` | Read a single item by `viking://` URI with progressive depth (`abstract` / `overview` / `read` / `auto`). |
| `membrowse` | List / tree / stat views under a `viking://` prefix. |
| `memcommit` | Trigger session commit / memory extraction for the mapped OpenViking session (optional mid-session). |

**URI rule**: `memread` and `membrowse` require URIs starting with `viking://` (validated by the plugin).

**Service dependency**: The plugin calls an OpenViking HTTP API (default `http://localhost:1933` unless overridden). If tools error with connection or health failures, treat memory as **unavailable** for this turn; do not block core harness gates on memory.

**Auto features** (when enabled in plugin config): conversation capture, periodic auto-commit, and optional **auto-recall** injection (`<relevant-memories>` appended to the latest user message). Recall is best-effort and must not replace explicit search when you need traceable evidence.

## Harness alignment (mandatory)

1. **Subordinate to SSOT**: `mstar-harness-core` state machine, phase gates, branch/worktree rules, and QC/QA alignment **always** override any suggestion retrieved from memory. If memory conflicts with plan, `status.json`, or Assignment, **follow the written artifacts** and record the conflict in notes or Completion Report.

2. **No secrets in memory tools**: Do not paste API keys, tokens, or private credentials into `memsearch` queries or stored memories. Redact before commit-style operations.

3. **Evidence for claims**: Memory hits are **hints**, not proof. For library/API facts, still follow `references/library-docs-protocol.md` (Context7 MCP / ctx7) when the question depends on current docs.

4. **When to call `memsearch`**: Prefer early in a **new** task or thread when user preferences, prior decisions, or plan IDs may exist in OpenViking; after major clarify/plan changes, a fresh search can reduce stale context.

5. **`memread` after `memsearch`**: Use URIs from search results; escalate depth (`overview` → `read`) only when needed to avoid token burn.

6. **`memcommit`**: Use for explicit “persist now” or mid-session extraction when the user asks or when wrapping a milestone. Do **not** spam commits after every trivial edit; the plugin may already run **auto-commit** on an interval—respect that and user policy.

7. **Parallel / multi-agent**: Memory tools do **not** replace PM dispatch, worktree isolation, or QC tri-review invokes. They do not authorize subagent recursion.

## When **not** to rely on this reference

- `memsearch` (and sibling tools) are **absent** → skip this file; no OpenViking rules apply.
- Non-OpenCode hosts (unless they expose the same tool names with the same semantics) → ignore.

## Configuration (user-owned)

Plugin reads `openviking-config.json` next to the plugin file and env vars such as `OPENVIKING_API_KEY`, `OPENVIKING_ACCOUNT`, `OPENVIKING_USER`. Agents must **not** edit user global config without explicit user consent (see `mstar-harness-core` guardrails).
