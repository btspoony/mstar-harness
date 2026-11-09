---
module: dsh-workflow
date: 2026-08-14
problem_type: architecture_pattern
category: architecture-patterns
last_updated: 2026-11-09
severity: high
tags:
  - dsh
  - workflow
  - agent-presets
  - gate-coverage
  - session-events
  - approval
related_components:
  - packages/dsh
  - deepseek-harness packages/workflow
  - deepseek-harness packages/bundle
  - deepseek-harness packages/core/tools
applies_when:
  - reasoning about which tools a dsh web session actually has
  - gating fan-out tools (workflow/ralph) or any tool with non-prompt args
  - building ledgers from workflow runs
  - needing human mid-call approval from a plugin
---

## Context

dsh ships an official dynamic-workflow family (`ctx.workflowEngine` + `workflow`/`ralph` tools). Two composition facts were initially misread (host-plane `disabled: true` ≠ unavailable) and one enforcement gap was confirmed structural (fan-out children bypass tool gates entirely). This captures the verified composition model, the exact coverage boundary, and the data/decision channels that DO work — the basis for any gate-plugin design over fan-out tools.

## Guidance

**1. Composition model: the agent preset decides, not the bundle layer.** The base bundle mounts host-plane default instances; the web-app layer disables them **because** web moves every per-agent row behind agent presets (host-plane singletons collide per-session). The default `standard` preset's `delegation` group (`isolate: { workflowEngine: true }` — entry-local realm) mounts `workflow-worker-thread` (spawn) + `tool-workflow` + `tool-ralph` + `subagent` + `subagent_fork`. ⇒ **Every default web session has workflow/ralph/fork active.** Reading a bundle patch's `disabled: true` as "feature off" is wrong; read the preset (`apps/cli/config/agent-presets/*/agent.cordis.yml`) for session tooling.

**2. Gate coverage boundary.** Workflow children start via the subagent runtime's start surface (`SubagentRuntime.start` when written; on dsh 0.2.1+ the ONE start surface is `startActivation(spec)`, `start`/`startContinuable` removed) — a service call — **no `tools/pre-execute`**, only observe-only `subagent/start|end` (`@mode emit`) and `workflow/agent-start|end` (observe-only, payloads carry data snapshots so listeners cannot acquire cancel/dispose). What still holds:

- Child-side listeners registered at root (fs-intents, skill/seam lints) still fire — children are in-process descendant scopes.
- A child's OWN tool calls pass pre-execute normally; the `workflow`/`ralph` tool call itself passes as a non-dispatch tool (pass-through).
- ⇒ The gap is exactly the **fan-out dispatch layer**: no Assignment validation, no anti-recursion precheck, no lease check, no settle pairing.

**3. Gating fan-out tools needs an args-shape branch, not tool-name lists.** A gate matching `dispatchTools` names AND requiring `args.prompt` (the `subagent` contract) is a double no-op for workflow (`{meta, script, args}`) and ralph (`{objective, maxRounds}`). Decision inputs that DO exist at the veto point: tool name, `meta.name/description` (plain JSON, engine-validated BEFORE the script runs — safe to branch on), calling agent (`exec.parent`), mstar workspace state. Veto at pre-execute returns before `start()` → zero children, model gets a correctable error. Per-child refusal has no seam today (upstream gap).

**4. `{kind:'ask'}` is a real blocking human channel.** `tools/pre-execute` may return `{kind:'ask'}`: ToolRuntime blocks the call on an awaited promise while `ctx.approval.request()` runs an answerer waterfall (Web UI panel / ACP bridge / plugin answerer). One-shot grants only; **fail-closed everywhere** — no answerer, unmounted ApprovalService, or abort → deny. Per-session `ApprovalPolicy {ask|never}`; `never` degrades ask→deny (unattended). A gate can therefore be four-tier: allow / warn / ask / deny. NOTE: dsh has **no declarative tool-pattern allowlist/denylist** anywhere — a programmatic listener is the only pattern layer.

**5. Ledger source: durable session events, not in-memory emits.** `tool-workflow` projects invariant-validated session events into the parent session (top-level calls only): `run-start {runId, name}` → `agent-start {runId, seq, label, phase, childId}` → `agent-end` → `run-end {runId, stopReason}` — replayable on cold load, and **childId links run members to child sessions**. Strictly better for ledgers than `workflow/*` emits (process-local, no child linkage). Ralph runs record identically (same engine).

## Why This Matters

Any in-process enforcement plugin (mstar-style gates) that audits its coverage by tool-name matching will silently miss the fan-out channel — the one that can start up to `maxTotalAgents` (default 1000) children per call. Conversely, the durable event stream + ask channel mean visibility and human escalation are cheap to add once the composition model is understood.

## When to Apply

- Designing or reviewing gate coverage over delegation: enumerate preset-mounted tools (incl. renamed instances like `subagent_fork`), then verify each tool's args shape reaches the gate's validation branch.
- Building workflow observability: consume `tool-workflow/*` session events (replay-safe, child-linked); treat `workflow/*` emits as live-stream only.
- Adding human-in-the-loop escalation from any pre-execute listener: return `{kind:'ask'}`; never implement a parallel ask mechanism.
- Reading dsh bundle patches: preset rows override host-plane disable decisions — check `agent-presets/*/agent.cordis.yml` for what a session actually mounts.
