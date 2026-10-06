---
name: pm
description: "PM entry shim — force project-manager orchestration when the user invokes /pm or this skill. General per-plan PM work: this skill + project-manager.md. Formal iteration lifecycle: mstar-iteration (host commands/ may orchestrate Phase 1–5). Boot, routing, dispatch SSOT → mstar-roles/references/project-manager.md and topic mstar-* skills — not here. Host entry spelling → the active mstar-host reference."
---

# PM (entry shim)

**Thin launcher only.** Boot lists, iteration phases, Assignment templates, and SDD loops are **not** maintained in this file.

## Workflow

Entry spelling differs per host; the **active `mstar-host` reference** owns it (command form, skill invocation form, session auto-load behaviour, iteration command names). This table keeps the routing only.

| Entry surface | Use |
|------|-----|
| Host ships a **`/pm`** command or exposes this **`pm`** skill | → **`project-manager`** for the session (general PM orchestration: single-plan, hotfix, QC waves, dispatch) |
| Host with no command entry | Same route: **`project-manager`** via `mstar-roles` → `references/project-manager.md` |
| Formal iteration (host **`commands/`** where shipped) | Phase 1–5 sequencing by the host commands — **without** an iteration the shim still serves ordinary per-plan PM |

**Iteration lifecycle** (optional): host `commands/` may sequence Phase 1–5; semantics SSOT → **`mstar-iteration`**. Not required for ordinary PM work.

**Codebase audit** (optional): `/codebase-audit` command → **`mstar-audit`** — read-only codebase survey producing prioritized, self-contained improvement plans. Output feeds iteration-start §1 Research or normal Prepare → Execute. Dispatched by PM under `Task category: audit`.

Detect host → **`mstar-host`** → the reference that detection resolves to (per-host entry, tool shapes and plan-mode bridges live only there).

## Load Order

1. `mstar-harness-core`
2. `mstar-roles` → **`references/project-manager.md`** — required reading list, routing, dispatch-first, iteration branch policy
3. Topic skills **on demand** per that file and the active workflow (`mstar-dispatch-gates`, `mstar-iteration`, `mstar-sdd`, `mstar-review-qc`, …)

## Decision Rules

1. **Delegate** — PM does not implement, QC, or QA in-thread (`project-manager.md` Execution Boundary; hotfix → `mstar-phase-gates`).
2. **Dispatch** — when host has invoke/Task tools: **1 Assignment ⇒ 1 invoke** (`mstar-dispatch-gates`). Markdown alone is not dispatch.
3. **SSOT** — iteration lifecycle → **`mstar-iteration`**; host Plan mode → the active host reference's plan-mode bridge (nested under `mstar-host`).
4. **Autonomous Execute push** — multi-plan iteration Phase 2–5: continuously dispatch implement → QC → QA → Done through merge-ready exit without routine yes/no prompts; **Blocked** only on true conflicts or metadata gaps → **`mstar-iteration` §2.6**.

Conflict: user instructions → project `AGENTS.md` / `CLAUDE.md` → `mstar-harness-core` → this file.

## Evidence

Successful entry selects `project-manager` and follows the owning workflow's verification and delivery gates. Loading this shim is not plan completion.

## References

Open `mstar-roles` → `references/project-manager.md` for PM procedures; open the active `mstar-host` reference for host entry and routing details.
