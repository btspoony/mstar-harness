---
name: codebase-audit
description: Survey a codebase as a senior advisor and produce prioritized, self-contained improvement plans. Read-only on source code. Use standalone before iteration-start to discover what's worth doing, or independently to build a prioritized backlog.
agent: project-manager
---

# Audit Codebase

Run a read-only codebase audit that discovers what is worth doing and writes self-contained plans for the normal Prepare → Execute flow.

**Read-only.** No source edits, no state machine, no commits. Output: prioritized plans in `{PLAN_DIR}/audit-<date>/`.

## Boot

1. `mstar-harness-core`
2. `mstar-audit` → SKILL.md（workflow、hard rules、scope variants、handoff 全量在此）
3. `mstar-plan-conventions` (path symbols — `{PLAN_DIR}`, `{HARNESS_DIR}`)
4. `mstar-host` → active host reference (invoke capability for parallel subagents)

## Routing（谁执行 audit）

| Context | Who runs the audit |
|---------|-------------------|
| **Small repo** (single scan pass feasible) | PM thread runs the audit directly — read, search, vet, write plans |
| **Large repo** (parallel categories needed) | PM dispatches read-only `scout` / `explore` subagents per category, then vets and writes plans |
| **Specialist depth needed** | PM dispatches `@architect` for architecture/tech-debt depth, or category-specific specialists |

The audit is **advisory** — it does not enter the per-plan state machine (`Todo → InProgress → InReview → Done`). Its output is plan *candidates*.

## Execute

Execute **`mstar-audit`** end to end（SKILL.md：Recon → Audit → Vet & prioritize → Write plans；effort `quick` / `standard` / `deep`；scope variants `security` / `perf` / `tests` / `branch` / `next` / `roadmap`）。Plans → `{PLAN_DIR}/audit-<YYYY-MM-DD>/NNN-<slug>.md` + `README.md` index，per **`mstar-plan-artifacts/references/plan-quality-bar.md`**。

Pursued plans feed the normal Prepare → Execute flow（fast-track Prepare — intent gate + clarify still apply）or `/iteration-start` as direction candidates。
