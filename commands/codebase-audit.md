---
name: codebase-audit
description: Survey a codebase as a senior advisor and produce a prioritized, evidence-backed review report. Read-only on source code. Use standalone before iteration-start to discover what's worth doing, or independently to build a prioritized backlog.
agent: project-manager
input: "[simplify]"
---

# Audit Codebase

Run a read-only codebase audit that discovers what is worth doing and writes one prioritized review report under `{REVIEW_DIR}`.

**Read-only.** No source edits, no state machine, no commits. Output: the review report `README.md` at `{REVIEW_DIR}/<date>-codebase-<level>-<round>/`.

## Boot

1. `mstar-harness-core`
2. `mstar-audit` → SKILL.md（common core：hard rules、recon、vet、variant dispatch、review report 输出）+ `references/codebase-audit.md`（full-audit 变体：Phase 2 类别 + effort、scope variants、Phase 4 变体细则、review report 模板）
3. `mstar-roles` → `references/code-reviewer.md`（执行角色：audit 执行体）
4. `mstar-conventions` (path symbols — `{HARNESS_DIR}`, `{REVIEW_DIR}`)
5. `mstar-host` → active host reference (invoke capability for parallel subagents)

## Routing（谁执行 audit）

| Context | Who runs the audit |
|---------|-------------------|
| **Small repo** (single scan pass feasible) | PM dispatches `@code-reviewer` — single scan pass, then vet and write the review report |
| **Large repo** (parallel categories needed) | `@code-reviewer` fans out read-only `scout` / `explore` subagents per category via Assignment `Delegation: allowed (scout/explore only, read-only)`, then vets and writes the review report |
| **Specialist depth needed** | PM orchestrates an `@architect` consult for architecture/tech-debt depth (separate dispatch, or folded into the audit delegation brief) |

**dsh host only.** On dsh the large-repo fan-out goes through the native **`workflow`** tool, not `subagent`: after the operator types `/codebase-audit`, take the `script` + `meta` (`meta.name: mstar-audit-fanout`) from skill **`mstar-host`** → `references/dsh-workflow-scripts.md` (§ `mstar-audit-fanout`) — N≥3 read-only category seats, each `agent()` prompt opening with the Assignment header (`Execute as:` / `Delegation: forbidden`), one conversation `workflow-run` node. Other hosts unchanged (they keep their own invoke tool: `task` / Task).

This command is the PM entry point; the audit execution body is `code-reviewer`（PM dispatch）.

The audit is **advisory** — it does not enter the per-plan state machine (`Todo → InProgress → InReview → Done`). Its output is one review report under `{REVIEW_DIR}`.

## Execute

Execute **`mstar-audit`** end to end（SKILL.md common core：Recon → Vet & prioritize；full-audit detail：**`references/codebase-audit.md`** —— Phase 2 九类别 fan-out、effort `quick` / `standard` / `deep`、scope variants `bare` / `quick` / `deep` / category focus（`security` / `perf` / `tests`, ...）/ `branch` / `next` / `roadmap` / `simplify`、Phase 4 变体细则）。Review report → `{REVIEW_DIR}/<date>-codebase-<level>-<round>/README.md`，由 `mstar audit scaffold` 写入（`--level` / `--round` / `--reviews-dir` / `--dir` 见 help；默认 run dir 由 date + level + round 组成，同 date+level 的第二轮是 `-2`）。

Executor: PM dispatches `@code-reviewer`；大型仓库 scout 扇出经 Assignment `Delegation: allowed (scout/explore only, read-only)`（Routing 表）。
