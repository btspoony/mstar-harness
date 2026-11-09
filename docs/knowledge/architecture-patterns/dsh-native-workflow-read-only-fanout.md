---
module: dsh-workflow
date: 2026-09-12
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
tags:
  - dsh
  - native-workflow
  - fan-out
  - authoring
  - role-persona
  - cold-scan
related_components:
  - packages/dsh
  - skills/mstar-host
source_plans:
  - <plan-id>
  - <plan-id>
status: active
last_updated: 2026-11-09
---

# Native `workflow` tool for read-only fan-out: authoring rules

## Context

mstar orchestration on dsh wanted its parallel read-only seats (QC tri, audit categories, PR-review seats) to run as dsh native workflows so the conversation shows a `workflow-run` node. The engine gives no per-child role/agentType — `agentType` is deferred and **rejects loudly** — and durable `tool-workflow/*` events (which `ui-workflow-run` replays) exist only for top-level calls through the `workflow` tool; a plugin calling `ctx.workflowEngine.start` directly gets no conversation node.

## Guidance

- **Authoring layer only**: skills/commands tell the operator to pass a `script` + `meta` to the native `workflow` tool; `meta.name` from a small allowlist (`workflowNames`; default `workflowGate: 'warn'`, production overlay `'hard'`). Never mount a second engine, never fold rows into the mstar patch.
- **Role delivery is prompt-shaped**: every `agent(prompt, { label, phase, schema })` prompt starts with an Assignment header — plain `Execute as: <id>` / `Delegation: forbidden` (the engine's field grammar reads the plain fallback; `**Execute as**: x` with the colon OUTSIDE the bold parses too, but `**Execute as:**` — colon inside — parses as nothing). The mstar `role-persona` seam parses that header out of the prompt and, on dsh ≥0.2.1, merges the role's agent-preset selection (`Config.rolePresets` → `SubagentStartRequest.agentPreset`; the persona slot the channel once decorated was removed upstream) into `startActivation`. Writable-seam authority is impossible by construction: children inherit parent sandbox and `approval: 'never'` — read-only seats only.
- **Durable evidence**: the ledger cold-scan must walk the real Session via `seq` + `eventAt(i)` (a real Session has no `.events` own property); capture `endSeq` once, start at `max(success cursor, exclusion floor, session.inheritedEventCount)` — the fork cut stops a forked child from re-recording its parent's `tool-workflow/*` prefix.
- **Script templates are code**: they live in `skills/mstar-host/references/dsh-workflow-scripts.md` as copy-pasteable `script` + `meta` (plain JS, `return`, no `export const meta`); commands name the slash → tool → script → `meta.name` chain, dsh-conditional only.

## Why This Matters

A malformed script dies fatally at `workflow` call time (`SCRIPT_PARSE`) and a missing header silently drops the role persona — both invisible until a real run. The authoring contract plus the fork-cut scan are what make the native node and the panel Event Log tell the truth.

## When to Apply

Read-only parallel seats on dsh (N≥3). 1–2 delegations stay on `subagent`. Writable fan-out stays forbidden (per-child pre-start refusal has no seam upstream).

## Examples

- `skills/mstar-host/references/dsh-workflow-scripts.md` (`mstar-qc-tri`, `mstar-audit-fanout`, `mstar-pr-seats`)
- `skills/mstar-host/references/dsh.md` § Read-only fan-out via the `workflow` tool
- `packages/dsh/src/gates/workflow-ledger.ts` (`sessionForkCutOf`, scan via `eventAt`)
- `packages/dsh/tests/agent-flow-workflow.spec.ts` (realistic no-`.events` Session; fork-cut red/green)
