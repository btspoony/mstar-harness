---
name: codebase-audit
description: Survey a codebase as a senior advisor and produce prioritized, self-contained improvement plans. Read-only on source code. Use standalone before iteration-start to discover what's worth doing, or independently to build a prioritized backlog.
agent: project-manager
input: "[simplify]"
---

# Audit Codebase

Run a read-only codebase audit that discovers what is worth doing and writes self-contained plans for the normal Prepare → Execute flow.

**Read-only.** No source edits, no state machine, no commits. Output: prioritized plans in `{PLAN_DIR}/audit-<date>/`.

## Boot

1. `mstar-harness-core`
2. `mstar-audit` → SKILL.md（common core：hard rules、recon、vet、variant dispatch）+ `references/codebase-audit.md`（full-audit 变体：Phase 2 类别 + effort、scope variants、Phase 4、output、handoff）
3. `mstar-roles` → `references/code-reviewer.md`（执行角色：audit 执行体）
4. `mstar-conventions` (path symbols — `{PLAN_DIR}`, `{HARNESS_DIR}`)
5. `mstar-host` → active host reference (invoke capability for parallel subagents)

## Routing（谁执行 audit）

| Context | Who runs the audit |
|---------|-------------------|
| **Small repo** (single scan pass feasible) | PM dispatches `@code-reviewer` — single scan pass, then vet and write plans |
| **Large repo** (parallel categories needed) | `@code-reviewer` fans out read-only `scout` / `explore` subagents per category via Assignment `Delegation: allowed (scout/explore only, read-only)`, then vets and writes plans |
| **Specialist depth needed** | PM orchestrates an `@architect` consult for architecture/tech-debt depth (separate dispatch, or folded into the audit delegation brief) |

This command is the PM entry point; the audit execution body is `code-reviewer`（PM dispatch）.

The audit is **advisory** — it does not enter the per-plan state machine (`Todo → InProgress → InReview → Done`). Its output is plan *candidates*.

## Execute

Execute **`mstar-audit`** end to end（SKILL.md common core：Recon → Vet & prioritize；full-audit detail：**`references/codebase-audit.md`** —— Phase 2 九类别 fan-out、effort `quick` / `standard` / `deep`、scope variants `security` / `perf` / `tests` / `branch` / `next` / `roadmap` / `simplify`、Phase 4 plan writing、audit index + plan-file output）。Plans → `{PLAN_DIR}/audit-<YYYY-MM-DD>/NNN-<slug>.md` + `README.md` index，per **`mstar-artifacts/references/plan-quality-bar.md`**。

Executor: PM dispatches `@code-reviewer`；大型仓库 scout 扇出经 Assignment `Delegation: allowed (scout/explore only, read-only)`（Routing 表）。

Pursued plans feed the normal Prepare → Execute flow（fast-track Prepare — intent gate + clarify still apply）or `/iteration-start` as direction candidates。
