---
module: packages/dsh
date: 2026-10-19
last_updated: 2026-10-19
severity: medium
track: knowledge
problem_type: architecture_pattern
category: architecture-patterns
tags:
  - dsh
  - delegation
  - agent-teams
  - subagent
  - workflow
  - channel-contract
related_components:
  - skills/mstar-host/references/dsh.md
  - skills/mstar-host/references/dsh-agent-teams.md
  - packages/dsh/src/gates/dispatch.ts
  - packages/dsh/src/gates/agent-flow.ts
  - "@deepseek-ai/dsh-experimental-agent-team"
  - "@deepseek-ai/dsh-tool-subagent"
  - "@deepseek-ai/dsh-tool-workflow"
applies_when:
  - routing MStar delegation on a dsh session
  - designing a gate, ledger, or panel surface that must cover every delegation channel
  - reviewing a profile composition that mounts the Agent Teams bundle
plan_id: "20261019-dsh-channel-skill-contract, 20261019-team-ledger-panel-closeout, 20261019-dsh-delegation-channels"
---

# dsh delegation channels: one contract, three transports

## Context

dsh ships three model-facing delegation surfaces, and a profile can expose several at once:
`subagent`/`subagent_fork` (one-shot activation + settlement notice), the nine Agent Teams tools
(`spawn_teammate`, task board, `wait_agent`, `send_message`; teammates are continuable subagent
children), and `workflow` (a JS script over fresh one-shot `agent()` calls). MStar originally keyed
host detection, the Assignment dispatch gate, and the agent-flow ledger on the `subagent` tool
alone — so a team-only profile was invisible, ungated, and unrecorded. The contract that now holds
(PR #538 + the iter-20261019-dsh-channel-adoption plans):

- **Selection is by work shape, not by tool preference.** One self-contained Assignment →
  `subagent`. Multi-seat / role-persistent / multi-round → Agent Teams. Read-only N≥3 fan-out →
  `workflow` (chunked to the 8-slot child pool). Skills must capability-detect and never assume a
  tool exists.
- **One gate stack covers every carrier.** `DEFAULT_DISPATCH_TOOLS` stays
  `['subagent','subagent_fork']`; team carriers (`spawn_teammate.prompt`,
  `team_task_create/update.description`, `send_message.message`) route through the same core via a
  separate terminal branch. The gate fires only on Assignment-shaped text.
- **The ledger never settles at tool return.** `subagent` returns `{kind:'activation'}` and
  `spawn_teammate` returns at member creation — both mean "started". Only the child's own
  completion (the verified `subagent/end` settlement) records the outcome; unpaired shapes record
  an explicit `continuation/unresolved` row instead of a fabricated `ok`.

## Guidance

- Carrier fields differ per tool: resolve the Assignment text per carrier (`prompt` /
  `description` / `message`); a missing or non-string carrier means no gate decision, never a
  throw.
- Team semantics that surprise: `inactive` ≠ done; task **readiness never starts the owner** (the
  Lead must `send_message`/`reassign`); `failed` means creation failed and permanently occupies the
  name and a member slot; the board's `writeScopes` is advisory — isolation comes from worktrees.
- Capacity: `maxMembers` 8 in the shipped bundle (Lead counts), `maxActiveSubagents` 8 with hard
  reject (no queue), workflow `maxConcurrentAgents = min(16, cores−2)` — the last two are
  independent, so fan-out templates must chunk to ≤ 8 themselves.
- Panel honesty: project the durable `continuation` row and derive a distinct non-running entity
  state; deriving `running` from "dispatch without a paired settle" turns protocol-standard task
  writes into phantom work.

## Why This Matters

Every surface that keys on a single tool name silently stops working the day a profile mounts the
official team bundle — detection, gates, and observability all at once, with no error. The
capability-based contract keeps the safety stack load-bearing on every composition.

## When to Apply

Any dsh-side detection, gating, ledger, projection, or skill text that names a delegation tool; any
profile composition review that adds or removes a delegation bundle.

## Durable per-session metadata seams

Two supported host seams exist; they own different data, and picking the wrong one is a design
error rather than a style choice.

- **`@deepseek-ai/dsh-storage-domain` — host-side sidecar metadata (use this for a pointer).**
  `ctx.storageDomain.open(spec)` over a `defineDomain({ name, version, tables: { t: domainTable(schema) } })`
  spec gives schema-validated, durable KV records: reads are synchronous from validated in-memory
  state, every write resolves only after the backend acknowledges durability, and the handle is
  closed by its owner's disposer. `dsh-base` mounts the stack by default (`storage` +
  `storage-json` rooted at `dshHomePath('storages')` + `storage-domain` with `backend: json`), so a
  plugin can depend on it; the session projection cache already persists through it. This is the
  right seam for a small mutable sidecar such as the control root a native bind adopted into.
- **`@deepseek-ai/dsh-session` plugin records — data that belongs in the session log.**
  `appendPluginRecord(session, type, data)` commits an ignorable event (type grammar:
  `plugin:` followed by lowercase slash-separated segments) that persists and is restored with the
  log; `pluginRecordOf(event)` reads it back from a live or restored event. It needs a real
  `Session` instance (the append path is a private-field method) and the record type must be
  declared by module augmentation of `PluginRecordMap`. Append-only, session-scoped: suited to
  history, not to a single current value.

An in-process `Map` receipt cannot survive a restart; whichever seam is chosen, the design is
"write the fact durably at the moment it becomes true, and re-read it where the fact is consumed".

For the cross-harness binding-root pointer the record key is the carrying session id AND its workspace — the same
pair the durable binding slot is keyed by — with session id, workspace and root in the value. A workspace-only key
is the tempting simplification and is wrong: two sessions in one workspace can hold different selected roots
(one picked an explicit per-call harness), so the unbound session would inherit the other's root and mis-attribute
or mis-clear. The consumer never lacks the session id — the ledger row and the native clear both carry it — so the
pair is exactly as discoverable as the slot it points at.

## Examples

- `packages/dsh/src/gates/dispatch.ts` — `TEAM_DISPATCH_TOOLS` carrier map + the terminal team
  branch before the `dispatchTools` match.
- `packages/dsh/src/gates/agent-flow.ts` — team post-execute branch (no settle at return), the
  `subagent/end` pairing, the activation normalization (started-not-settled), and the projected
  continuation row.
- `skills/mstar-iteration/SKILL.md` §2.6 — the wake-discipline hard rule.
