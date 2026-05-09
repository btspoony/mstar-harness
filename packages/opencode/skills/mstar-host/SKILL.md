---
name: mstar-host-opencode
description: OpenCode host adapter for Morning Star harness. Use this skill whenever running Morning Star in OpenCode, especially for host entry behavior, `opencode.json`-driven role loading, `question`-based structured clarify, `@explore`/`@general` usage boundaries, and PM-triggered named-role invocation (including paste-only dispatch failure: Assignment Markdown without matching subagent/Task tool calls). Always load this after `mstar-harness-core` to keep host behavior aligned with shared gates and routing.
---

# Morning Star × OpenCode Host Adapter

This skill defines host adaptation for **Morning Star running in OpenCode** (capabilities, entry behavior, and noise control).  
Neutral process rules and invariants remain authoritative in `mstar-harness-core`.

## First Action: Load `mstar-harness-core`

Regardless of whether OpenCode injected root `AGENTS.md` via Global Rules, the agent’s **first action** is to read `mstar-harness-core`.

## Default path (recommended)

Use this default sequence unless a project rule explicitly overrides it:

1. Read `mstar-harness-core`
2. Read current host adapter (`mstar-host-opencode`)
3. Load role via `mstar-roles`
4. Execute with evidence-first completion checks

## Role loading

- **Role shell**: `agents/<id>.md` is referenced by `opencode.json` `agent.<id>`; the file keeps only frontmatter and role binding.
- **Role body**: stored in `mstar-roles` `references/<id>.md` (or shared references + role parameters).
- **Plugin orchestration conflict handling**: see `mstar-superpowers-align`.

## OpenCode-specific capabilities (other hosts may differ)

- **Structured clarify**: prefer built-in `question` tool (title, prompt, options, optional custom text). Requires `permission.question` in config (user-maintained; agent must not edit global config without explicit consent).
- **Built-in subagents**: e.g., `@explore` (read-only navigation), `@general`; still subject to `mstar-harness-core` boundaries for explore usage.
- **Named roles (`@<agent-id>`)**: roles configured in `opencode.json` `agent.<id>` must be **actually invoked** by PM through host entry points. Printing Assignment Markdown alone does not create subagent sessions.
- **Per-role models**: different models can be configured per subagent in `opencode.json`.

### OpenCode PM: dispatch order and “no tool = no dispatch” (critical)

Some models **only paste** `## Assignment` in the main thread and **never call** the host subagent / Task entry. That is **not** delegation; downstream work **does not start**. Parallel dispatch makes this worse (two Assignments printed, **zero** invokes).

**Turn model: prerequisite vs dispatch (prevents “bash then one QC” failure)**

- **Prerequisite turn** (optional, any assistant message): use `bash` / `read` / `glob` / `grep` to collect facts (`merge-base`, `Review range`, `git rev-parse`, paths). **Do not** emit **any** subagent/Task **dispatch** for the batch in this same message **unless** `N = 1` and that single tool call *is* the dispatch.
- **Dispatch turn** (mandatory shape when `N ≥ 2` concurrent assignees): the **first** message where you emit **any** dispatch for that batch must contain **all `N`** host invocations (each with its Assignment body). If you are **not** ready to emit all `N`, emit **zero** dispatches in that message — finish prep, then send **one** message with **`N`** calls.

**Mandatory order in the same assistant turn that issues dispatch**

1. **Finalize** all `N` Assignment payloads (after any prerequisite turn).
2. **Count** independent Assignments for this turn (`N` = number of distinct `Execute as` sessions you must open).
3. **Issue `N` host invocations first** (subagent / Task / equivalent), each carrying **one** Assignment body as the task message. For **parallel** work, put **all `N` tool calls in this single assistant message** when the host allows it.
4. **Only after** those tool calls, optionally post a short user-facing **Status Update** (may repeat Assignment titles as audit trail — **does not** replace the **`N`** invocations in step 3).

**Hard rules**

- **Emit zero until batch-ready**: if `N ≥ 2` and you can only issue **one** invoke right now, **do not issue that one** yet; complete the other payloads, then issue **all `N` in one message**. Partial single-invoke sends are **serial rollout**, not parallel launch.
- **Do not end** the dispatch turn until **`N` invocations have been emitted** (or you explicitly mark `Blocked` / `dispatch incomplete` with host reason and a follow-up plan).
- **Dual-track implement** (two dev Assignments) uses the **same** rule as QC tri-review: **`N = 2` ⇒ two invocations in one message** when parallel is required — not one invoke “and we’ll do the second later.”
- In Status Update for dispatch turns, include **`Subagent invokes issued: N`** (must match Assignment count). If `N` is 0 while Assignments were written → state **`dispatch failed — paste-only`** and fix in the **next** message.

## OpenCode parallel dispatch contract (critical)

When PM dispatches parallel work (especially QC tri-review **or two concurrent implement tracks**), treat "parallel" as a **tool-level requirement**, not only a wording requirement. The **Turn model: prerequisite vs dispatch** rules above apply here too (bash/read prep ≠ partial dispatch).

- **Hard rule**: if 2+ subagents must run in parallel, emit all corresponding subagent/task invocations in the **same assistant message**. **Printing two Assignments without two matching tool calls is a failed dispatch**, not partial success.
- **QC tri-review**: launch `qc-specialist`, `qc-specialist-2`, and `qc-specialist-3` in one dispatch turn (three invocations in one message block).
- **Failure mode to avoid**: sending only one invocation and planning to send the others later is a serial rollout, not a successful parallel launch.
- **Completion claim gate**: do not claim "QC tri-review dispatched in parallel" unless all three invocations were issued in that same dispatch turn.

Quick self-check before sending:
1. How many independent assignments are required this turn? (`N`)
2. Am I in a **prerequisite-only** message? If yes, ensure **zero** batch dispatches here unless `N = 1`.
3. If this message is the **dispatch** message, does it contain **exactly `N`** invocation calls (not `1` when `N = 3`)?
4. For QC tri-review, is the count **exactly 3** in **one** message in the dispatch turn?
5. If the **previous** message was prerequisite-only, this message **must** include all **`N`** dispatches (not “start with QC1 only”).

Post-dispatch validation (mandatory for QC tri-review):
1. Verify the three runtime invocations were started as the intended agent IDs: `qc-specialist`, `qc-specialist-2`, `qc-specialist-3` (not three runs of the same role).
2. Verify runtime model mapping matches host config intent for each reviewer.
3. If any role/model mismatch is observed, mark dispatch as invalid, do not enter QC consolidation, and re-dispatch with corrected role/model targeting.

## Gotchas

- `question` availability is host-config dependent; if unavailable, fall back to structured Markdown clarify flow.
- Printing an Assignment in the main thread is not dispatch; PM must actually invoke the target role.
- Built-in `@explore` remains read-only orientation, not a substitute for role-owned implementation or review deliverables.
- More MCPs does not fix process gaps; follow phase-gate and evidence rules first.

## Shared protocol: library documentation retrieval (Context7)

Context7 retrieval is a shared process rule maintained by `mstar-harness-core`.  
Follow: `mstar-harness-core` skill `references/library-docs-protocol.md`.

---

## Session context and plugin injection (noise control)

- **Large platform injections** (for example, long Vercel ecosystem prompts, SessionStart hooks): if unrelated to current stack, they consume context and can conflict with project choices. For non-Vercel projects, disable or make them on-demand (`alwaysApply: false` + explicit trigger description).
- **Multiple search/docs MCPs**: keep one default channel per capability class.

---

## Optional MCPs / skills by capability

This section lists optional enhancements by capability domain, aligned with principles in `mstar-harness-core` `references/open-harness-principles.md` (documentation retrieval, observable verification, structured exploration). User decides whether to enable them; editing global `opencode.json` requires explicit user consent.

| Capability | Purpose | Notes |
|------|------|------|
| **Current docs** | Reduce hallucination for versioned APIs/libs | Context7-like MCP or equivalent host-configured docs tool |
| **Web search** | Time-sensitive issues and migration notes | Avoid overlapping multiple search MCPs for the same purpose |
| **Code pattern search** | Cross-repo implementation references | Example: `https://mcp.grep.app`; skip if equivalent already configured |
| **Repo graph / impact analysis** | Dependency/call graph and PR risk | Example: GitNexus |
| **Browser / E2E verification** | User-visible flow validation and evidence capture | agent-browser, Playwright, aligned with QA observable-evidence requirements |
| **Git workflow** | Atomic commits and branch closure | e.g., `git-commit`, `finishing-a-development-branch` |
| **Systematic debugging** | RCA before fix | Superpowers `systematic-debugging` (see `mstar-superpowers-align`) |

### Not recommended

- Keeping multiple overlapping search MCPs always enabled.
- Using more tools to mask phase-gate/process gaps when harness baseline is not yet followed.

## Maintenance boundary (separate from runtime skill)

This skill should contain only **runtime host adaptation** (capabilities and entry behavior).

- Runtime guardrail remains unchanged: agent must not modify `opencode.json`, `secrets.env`, or `.secrets/*` without explicit user consent.
