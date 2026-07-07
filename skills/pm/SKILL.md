---
name: pm
description: "PM entry shim — force project-manager orchestration when user invokes /pm or this skill (Codex and Cursor). General per-plan PM work: this skill + project-manager.md. Formal iteration lifecycle on Cursor/OpenCode: commands (iteration-start, iteration-drive, mstar-bootstrap). Boot, routing, dispatch SSOT → mstar-roles/references/project-manager.md and topic mstar-* skills — not here."
---

# PM (entry shim)

**Thin launcher only.** Boot lists, iteration phases, Assignment templates, and SDD loops are **not** maintained in this file.

## Host entry

| Host | Use |
|------|-----|
| **Codex** | **`/pm`** or this skill → **`project-manager`** for the session |
| **Cursor** | **`/pm`** or this skill → general PM orchestration (single-plan, hotfix, QC waves, dispatch) **without** starting an iteration. Formal iteration → **`commands/`** below |
| **OpenCode** | Same as Cursor when no command: **`project-manager`** via `mstar-roles` → `references/project-manager.md` |

**Iteration commands** (optional; carry their own Boot): `iteration-start`, `iteration-drive`, `mstar-bootstrap` — use when running Phase 1–5 iteration lifecycle, not required for ordinary PM work.

Detect host → **`mstar-host`** → `references/codex.md` | `cursor.md` | `opencode.md`.

## Read next (in order)

1. `mstar-harness-core`
2. `mstar-roles` → **`references/project-manager.md`** — required reading list, routing, dispatch-first, iteration branch policy
3. Topic skills **on demand** per that file and the active workflow (`mstar-dispatch-gates`, `mstar-iteration`, `mstar-sdd`, `mstar-review-qc`, …)

## Three rules (everything else is a pointer)

1. **Delegate** — PM does not implement, QC, or QA in-thread (`project-manager.md` Execution Boundary; hotfix → `mstar-phase-gates`).
2. **Dispatch** — when host has invoke/Task tools: **1 Assignment ⇒ 1 invoke** (`mstar-dispatch-gates`). Markdown alone is not dispatch.
3. **SSOT** — iteration lifecycle → **`mstar-iteration`** (or **`commands/`** on Cursor/OpenCode); Cursor Plan mode → **`mstar-host/references/cursor-plan-mode-bridge.md`**.

Conflict: user instructions → project `AGENTS.md` / `CLAUDE.md` → `mstar-harness-core` → this file.
