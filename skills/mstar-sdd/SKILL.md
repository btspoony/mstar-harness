---
name: mstar-sdd
description: Morning Star subagent-driven development (SDD) — file handoff, per-task implementer + task reviewer (L2), progress ledger, branch review-package for plan QC tri (L3). **Must** Read when project-manager runs `Execution mode: sdd` (multi-task plan, single-plan, or iteration Phase 2), dispatches SDD implementer/reviewer subagents, or prepares review-package paths. Leaf implementer/reviewer subagents skip PM sections via SUBAGENT-STOP in dispatch prompts.
---

## Load order

**Before first Read:** `mstar-harness-core` → `mstar-dispatch-gates`. Path symbols → **`mstar-plan-conventions`** (`{SDD_DIR}`). Plan QC after SDD → **`mstar-review-qc`**. On conflict, **`mstar-harness-core` wins**.

<SUBAGENT-STOP>
If you were dispatched as an SDD implementer or task reviewer, skip PM orchestration sections. Follow your dispatch prompt only.
</SUBAGENT-STOP>

## When to use

- Plan locked; tasks mostly independent; PM orchestrates in-session
- Assignment has **`Execution mode: sdd`**
- **Not** for hotfix inline work (`Execution mode: inline`) or leaf self-dispatch

## Core principle

Fresh subagent per task + task review (spec + quality) + plan-level QC on whole branch = quality with isolated context.

**Narration:** at most one short line between tool calls — ledger and file paths carry the record.

**Continuous execution:** do not check in with the human between tasks. Stop only for BLOCKED, genuine ambiguity, or all tasks complete.

## Pre-flight plan scan

Before Task 1, scan plan once for:

- tasks contradicting Global Constraints
- plan-mandated items that review rubric would flag as defects

Batch all findings for the human in one message. If clean, proceed silently.

## Per-task loop (PM only)

1. Record `BASE_SHA` (never use `HEAD~1` later)
2. `sdd-workspace <plan-id>` → `SDD_DIR`
3. `task-brief <plan> N` → brief file
4. Dispatch implementer (brief + report paths, model tier) — templates: `references/implementer-prompt.md`
5. On `DONE`: `review-package BASE HEAD` → diff file
6. Dispatch task reviewer (brief, report, diff, Global Constraints) — `references/task-reviewer-prompt.md`
7. Fix loop for Critical/Important; re-review until approved
8. Append `progress.md`; update `status.json` `task_commits[]` if used
9. Next task

**Never** dispatch multiple implementers in parallel (write conflicts).

Detail: **`references/file-handoffs.md`**.

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

1. `review-package MERGE_BASE HEAD` → branch diff in `{SDD_DIR}`
2. PM dispatches **plan QC tri-review (L3)** — **`QC mode: full tri-review`**, **N=3** — with branch review-package path → **`mstar-review-qc`** · **`mstar-dispatch-gates`**. Layer SSOT → **`mstar-review-qc/references/review-responsibility-boundaries.md`**. PM writes `qc-consolidated.md`. **Mandatory whenever `Execution mode: sdd`** (single-plan or iteration).
3. Critical/Important QC findings → **one** fix dispatch (full list), then targeted re-review
4. QA gate → **`mstar-review-qc`** / `mstar-harness-core` Done rules

## Progress ledger

At start: `cat {SDD_DIR}/progress.md`. Tasks marked complete are DONE — do not re-dispatch after compaction.

Append on clean review: `Task N: complete (<base>..<head>, review clean)`.

Minor findings → `## Minor (for plan QC)` section in same file.

## Red flags (NEVER)

- Parallel implementer dispatches
- Paste plan, diffs, or task history into dispatch prompts
- Dispatch reviewer without diff file
- `HEAD~1` as review BASE
- Pre-judge reviewer ("do not flag", "at most Minor")
- Skip task review or accept missing verdict
- Re-dispatch tasks listed complete in ledger
- PM thread implements instead of subagent dispatch

## Scripts

From repo: `skills/mstar-sdd/scripts/` (bundled in OpenCode as `harness-skills/mstar-sdd/scripts/`).

| Script | Usage |
|--------|--------|
| `sdd-workspace` | `PLAN_ID` → creates `{SDD_DIR}`, prints path |
| `task-brief` | `PLAN_FILE TASK_N [OUTFILE]` |
| `review-package` | `BASE HEAD [OUTFILE]` |

## References

- `references/file-handoffs.md` — paths and fix-loop evidence
- `references/implementer-prompt.md`
- `references/task-reviewer-prompt.md`
