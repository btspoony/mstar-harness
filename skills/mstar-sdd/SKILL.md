---
name: mstar-sdd
description: "Morning Star subagent-driven development (SDD) — file handoff, per-task implementer + task reviewer (L2), progress ledger, branch review-package for plan QC tri (L3). **Implementer session** `fresh` (default) or **`sticky`** (same dev subagent across tasks — `references/sticky-implementer-session.md`). **Must** Read when project-manager runs `Execution mode: sdd` (multi-task plan, single-plan, or iteration Phase 2), dispatches SDD implementer/reviewer subagents, or prepares review-package paths. Leaf implementer/reviewer subagents skip PM sections via SUBAGENT-STOP in dispatch prompts."
---

## Load order

**Before first Read:** `mstar-harness-core` → `mstar-dispatch-gates`. Path symbols → **`mstar-conventions`** (`{SDD_DIR}`). Plan QC after SDD → **`mstar-review-qc`**. On conflict, **`mstar-harness-core` wins**.

<SUBAGENT-STOP>
If you were dispatched as an SDD implementer or task reviewer, skip PM orchestration sections. Follow your dispatch prompt only.
</SUBAGENT-STOP>

## When to use

- Plan locked; tasks mostly independent; PM orchestrates in-session
- Assignment has **`Execution mode: sdd`**
- **Not** for hotfix inline work (`Execution mode: inline`) or leaf self-dispatch

## Core principle

**Default:** fresh implementer subagent per task + task review (spec + quality) + plan-level QC on whole branch = quality with isolated context.

**Optional:** **`SDD implementer session: sticky`** — same implementer subagent across sequential tasks on one plan/branch; **task reviewers stay fresh per task**. SSOT → **`references/sticky-implementer-session.md`**.

> **Engine check (when available):** import `implementerSessionStickyRules` from `@mstar-harness/engine` in a host hook to validate the sticky resume decision above (no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

**Narration:** at most one short line between tool calls — ledger and file paths carry the record.

**Continuous execution:** do not check in with the human between tasks. Stop only for BLOCKED, genuine ambiguity, or all tasks complete.

## Pre-flight plan scan

Before Task 1, scan plan once for:

- tasks contradicting Global Constraints
- plan-mandated items that review rubric would flag as defects

Batch all findings for the human in one message. If clean, proceed silently.

## Per-task loop (PM only · Workflow)

1. Record `BASE_SHA` (never use `HEAD~1` later)
2. `mstar sdd workspace <plan-id>` → `SDD_DIR`（iteration L1 从 feature cwd 调用时：`MSTAR_CONTROL_ROOT=<control_worktree_path>` 或 `mstar sdd workspace <plan-id> <control_worktree_path>`；probe 以 v2 根 `status.json`（`workflows[]`）或 workflow snapshot 存在为准，linked worktree 缺文件会 fail closed）
3. `mstar sdd task-brief <plan> N` → brief file
4. Dispatch implementer:
    - **`SDD implementer session: fresh`** (default) — new subagent; templates: `references/implementer-prompt.md`
    - **`SDD implementer session: sticky`** — first task: same as fresh + write `{SDD_DIR}/implementer-session.json` with `host_agent_id`; later tasks: host **resume** + `references/implementer-continuation-prompt.md` (see **`references/sticky-implementer-session.md`**)
5. On `DONE`: `mstar sdd review-package BASE HEAD` → diff file
6. Dispatch **fresh** task reviewer — role **`code-reviewer`** (L2; **not** `qc-specialist*`; host fallback generic + C5b → `mstar-host` C5) — brief, report, diff, Global Constraints — `references/task-reviewer-prompt.md` — **never** sticky resume for reviewers
7. Fix loop for Critical/Important; re-review until approved
8. Append `progress.md`; update the workflow snapshot plan row (`workflows/<id>/snapshot.json` → `plans[]`) `task_commits[]` and `implementer-session.json` `last_task` if sticky
9. Next task

**Never** dispatch multiple implementers in parallel (write conflicts).

Detail: **`references/file-handoffs.md`**.

> **Engine check (when available):** run `mstar sdd workspace <plan-id>` / `mstar sdd task-brief <plan-file> <task-number>` / `mstar sdd review-package <base> <head>` (or `import { assertBaseSha, sddWorkspace, taskBrief, reviewPackage } from "@mstar-harness/engine"` in a host hook) to drive the loop steps above. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Implementer statuses

| Status | PM action |
|--------|-----------|
| DONE | review-package → task reviewer |
| DONE_WITH_CONCERNS | read concerns; fix scope issues before review |
| NEEDS_CONTEXT | provide context; re-dispatch |
| BLOCKED | more context, higher tier, split task, or escalate human — **never** same-model blind retry |

## Reviewer ⚠️ items

`⚠️ Cannot verify from diff` does not block other findings. PM must resolve each before task complete.

## Model tier

| Tier | Use |
|------|-----|
| fast | Transcription (complete code in plan); 1–2 file mechanical |
| standard | Prose implementer; task reviewer (floor) |
| capable | Integration judgment; plan QC on large branch diff |

**Turn count beats token price:** use `standard` floor for reviewers and prose implementers. **Always name model on dispatch** — omitted model inherits session default (often most expensive).

Host mapping → **`mstar-host`** references (`model` / Task field).

## After all tasks

1. `mstar sdd review-package MERGE_BASE HEAD` → branch diff in `{SDD_DIR}/review/`
2. PM dispatches **plan QC tri-review (L3)** — **`QC mode: full tri-review`**, **N=3** — with branch review-package path and report paths under `{SDD_DIR}/review/` → **`mstar-review-qc`** · **`mstar-dispatch-gates`**. Layer SSOT → **`mstar-review-qc/references/review-responsibility-boundaries.md`**. PM writes `{SDD_DIR}/review/qc-consolidated.md` and durable main-plan gate summary. **Mandatory whenever `Execution mode: sdd`** (single-plan or iteration).
3. Critical/Important QC findings → **one** fix dispatch (full list), then targeted re-review. Fix rounds run on four mechanics — the per-task fix loop applies the same (`references/file-handoffs.md`):
    - **Unverified rounds count**: a fix round without verification evidence (reviewer not confirmed / report not on disk) is **not clean** — re-check and count the round; never enter the convergence branch.
    - **Full re-entry**: the next fix dispatch carries **all** open findings (including last round's unverified items) — never slice a subset.
    - **Capped cross-round excerpt**: from round ≥2, the fix dispatch attaches an excerpt of prior rounds' findings and dispositions (advisory caps: ~500 words per round, ~1500 total — suggested values, not hard limits).
    - **Honest non-convergence**: open findings at wave close → list them in detail and state the disposition — re-feed to the next fix round **or** transfer to residual tracking — never silently close.
4. QA gate → **`mstar-harness-core`** Done rules; PM **`mstar-roles/references/project-manager/qa-trigger-matrix.md`**

## Progress ledger（Evidence）

At start: `cat {SDD_DIR}/progress.md`. Tasks marked complete are DONE — do not re-dispatch after compaction.

Append on clean review: `Task N: complete (<base>..<head>, review clean)`.

Minor findings → `## Minor (for plan QC)` section in same file.

> **Engine check (when available):** import `readProgressLedger` from `@mstar-harness/engine` in a host hook to read the ledger above (no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Red flags (NEVER)

- Parallel implementer dispatches
- Paste plan, diffs, or task history into dispatch prompts
- Dispatch reviewer without diff file
- `HEAD~1` as review BASE
- Pre-judge reviewer ("do not flag", "at most Minor")
- Skip task review or accept missing verdict
- Re-dispatch tasks listed complete in ledger
- PM thread implements instead of subagent dispatch
- Sticky **resume** for task reviewers
- Resume implementer without `host_agent_id` in `implementer-session.json`

## CLI

The SDD helpers are engine-backed commands under **`mstar sdd`**（引擎 CLI；原 bash 脚本已移除，行为语义不变）。Run the `mstar` binary from any checkout; env vars `MSTAR_CONTROL_ROOT` / `MSTAR_HARNESS_DIR` / `SDD_DIR` are honored exactly as before.

| Command | Usage |
|--------|--------|
| `mstar sdd workspace` | `PLAN_ID [CONTROL_ROOT]` → creates `{SDD_DIR}` under control harness when set (`MSTAR_CONTROL_ROOT` or 2nd arg); fail closed on linked worktree without `status.json` |
| `mstar sdd task-brief` | `PLAN_FILE TASK_N [OUTFILE]` |
| `mstar sdd review-package` | `BASE HEAD [OUTFILE]` |

## References

- `references/file-handoffs.md` — paths and fix-loop evidence
- `references/sticky-implementer-session.md` — `fresh` vs `sticky`, ledger, host resume, micro-batch fallback
- `references/implementer-prompt.md`
- `references/implementer-continuation-prompt.md`
- `references/task-reviewer-prompt.md`
- `mstar-artifacts/references/plan-quality-bar.md` — plan self-containment standard (plans must meet this before SDD dispatch)
