---
name: mstar-host
description: Morning Star host adapter (OpenCode, Cursor, Codex). Use after mstar-harness-core whenever host entry, clarify, dispatch, or plan UX differs by platform — OpenCode question/@agent-id invoke, Cursor /pm and CreatePlan/SwitchMode dual-write and Task parallel QC, Codex skills from ./skills/. Auto-detect host from session tools; then Read references/<host>.md. Always load after mstar-harness-core.
---

# Morning Star Host Adapter

Host-specific **capabilities and entry behavior** for Morning Star. Process gates and invariants stay in `mstar-harness-core` and topic `mstar-*` skills.

## First action

Read **`mstar-harness-core`** before this skill (even when the host injects project `AGENTS.md`).

## Default path

1. Read `mstar-harness-core`
2. Read **`mstar-host`** (this skill) and detect host below
3. Read **`references/<host>.md`** for the active host
4. Load role via `mstar-roles`
5. Execute with evidence-first completion checks

Load topic skills **on demand** per `mstar-roles` (do not read every `mstar-*` skill by default). Cursor maint routing-eval: `.cursor/skills/mstar-routing-eval/` only.

## Detect active host

Use **capability signals** (not filesystem paths):

| Signal | Host | Next read |
|--------|------|-----------|
| **CreatePlan** / **SwitchMode** available | `cursor` | `references/cursor.md`; Plan mode also `references/cursor-plan-mode-bridge.md` |
| **`question`** tool or PM **`@<agent-id>`** subagent invoke | `opencode` | `references/opencode.md` |
| **Task** + `subagent_type`, no CreatePlan | `cursor` | `references/cursor.md` |
| Still ambiguous | — | Read sections in **both** `cursor.md` and `opencode.md` that match tools you have; **`mstar-harness-core` wins** on conflict |

## Parallel dispatch (all hosts)

When PM dispatches **N ≥ 2** concurrent assignees (QC tri-review, dual-track implement, etc.), read **`references/parallel-dispatch.md`** in the dispatch round (shared with `mstar-dispatch-gates`).

## Library docs (Context7)

Follow `mstar-harness-core` → `references/library-docs-protocol.md`.

## Conflict order

1. User explicit instructions (this turn)
2. Project `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` and related `mstar-*` skills
4. This `mstar-host` skill and `references/*`
