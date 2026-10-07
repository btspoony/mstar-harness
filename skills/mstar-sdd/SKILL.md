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

**Default:** fresh implementer per ready task + task-scoped review + plan QC on the changed diff and directly affected interfaces. Execution scope → **`mstar-harness-core`** § 定向执行与验证边界.

**Optional:** **`SDD implementer session: sticky`** — same implementer subagent across sequential tasks on one plan/branch; **task reviewers stay fresh per task**. SSOT → **`references/sticky-implementer-session.md`**.

> **Engine check (when available):** import `implementerSessionStickyRules` from `@mstar-harness/engine` in a host hook to validate the sticky resume decision above (no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

**Narration:** at most one short line between tool calls — ledger and file paths carry the record.

**Continuous execution:** do not check in with the human between tasks. Stop only for BLOCKED, genuine ambiguity, or all tasks complete.

## Pre-flight plan scan

Before Task 1, scan plan once for:

- tasks contradicting Global Constraints
- plan-mandated items that review rubric would flag as defects

Batch all findings for the human in one message. If clean, proceed silently.

## Ready-task scheduling (PM only · Decision Rules)

Dispatch independent ready tasks concurrently after L2 worktree isolation. Keep one canonical per-plan SDD root; the primary coordinator alone updates its context.json and progress.md and records row state through public plan verbs against current authority (ACTIVE store.db-backed; snapshot files only pre-activation), never raw state edits. Prepare context-dependent helper outputs serially. Each writable track has its own worktree/branch and immutable task-specific absolute brief/report/diff paths. Subdirectories are artifact namespaces, not another SDD root. Parallel leaves consume supplied paths directly, never shared-context helpers or mutable checkout selectors; do not share a writable session or implementer-session.json. Use fresh parallel implementers. Serialize only actual dependencies, overlapping ownership, a sticky session or integration merge, naming the dependency. A reviewer may run alongside unrelated ready implementation. Only the coordinator reconciles returned evidence into the shared ledger and the addressed row.

**Rescheduling checkpoint:** a running background task is never a reason to stop scheduling. Re-run this ready-task check at the Phase-2 checkpoints named in **`mstar-iteration/references/phase-2-worktree-lease.md` §2.4** — that file is the single authoritative home for the five checkpoint names and their reason vocabulary, and they are deliberately not re-listed here — and start every authorized independent ready task before waiting for an unrelated running task or plan. Waiting is valid only when nothing useful is ready: state the wait reason once and do not re-check or remind on unchanged facts.

**Scope and credential boundary:** each brief carries the inherited plan id and absolute SDD/brief/report/diff paths. Leaf implementers/reviewers receive no coordinator session file/reference, token/revision, operation id or lifecycle authority. The single primary coordinator explicitly addresses the row for ordinary progress and, after QC/QA and declared-route proof, direct complete; own current context may be derived and explicit constraints remain checked. Neither the leaf nor the coordinator invents a per-row identity, claim, transfer or preparation ceremony to advance valid recorded source/defaults.

**Dependent-task readiness:** review approval alone does not make a prerequisite available. PM serially integrates the reviewed prerequisite commits, then creates or updates the idle dependent worktree from that integrated state before recording its `BASE_SHA` and dispatching. For each required reviewed commit, record `git -C "$FEATURE_CWD" merge-base --is-ancestor <prerequisite-sha> <BASE_SHA>` with exit 0; a missing commit blocks only that dependent task. Do not move an active task's base; independent ready tasks continue concurrently.

## Per-task loop (PM only · Workflow)

1. Record `BASE_SHA` (never use `HEAD~1` later)
2. `mstar sdd workspace <plan-id>` → `SDD_DIR`（iteration L1 从 feature cwd 调用时：`MSTAR_CONTROL_ROOT=<main-repo-root>`（= **Git 派生的主 worktree 根**；Git 主 worktree 发现失败（`readMainWorktree` 返回 null）时 fail closed）或 `mstar sdd workspace <plan-id> <main-repo-root>`；显式 Git root 必须与派生主根 canonicalize 一致，integration/外来检出被拒而非静默重定向；probe 仅查 `status.json` 或任一 workflow snapshot 文件存在性，不校验 `workflows[]`（这是当前发现探针，不是 ACTIVE 状态读写路由）；无文件命中则回退到主根下已有 `.mstar` / `.agents` 目录，否则 `.mstar`，不因 linked worktree 缺文件而拒绝）
3. `mstar sdd task-brief <plan> N` → brief file
4. Dispatch implementer:
    - Copy the plan task's budget into the Assignment header field **`Task budget (implement / ops rounds)`** (canonical template → `mstar-roles/references/project-manager/dispatch-and-assignment.md`; one-round capacity criterion → `mstar-artifacts/references/plan-quality-bar.md` item 7) — header region only, before the body markers
    - **`SDD implementer session: fresh`** (default) — new subagent; templates: `references/implementer-prompt.md`
    - **`SDD implementer session: sticky`** — first task: same as fresh + write `{SDD_DIR}/implementer-session.json` with `host_agent_id`; later tasks: host **resume** + `references/implementer-continuation-prompt.md` (see **`references/sticky-implementer-session.md`**)
5. On `DONE`: `mstar sdd review-package BASE HEAD` → diff file
6. Dispatch **fresh** task reviewer — role **`code-reviewer`** (L2; **not** `qc-specialist*`; host fallback generic + C5b → `mstar-host` C5) — brief, implementer report, diff, Global Constraints, and the reviewer's own output **`REPORT_FILE`** = `{SDD_DIR}/task-N-review.md` — `references/task-reviewer-prompt.md` — **never** sticky resume for reviewers
7. Fix loop for Critical/Important; re-review until approved. Then PM reads `{SDD_DIR}/task-N-review.md` — the always-on L2 report, never the implementer's `task-N-report.md` — before appending step 8: the earned `Task quality` and partial findings stand for the reviewed scope, but assigned review scope left uncovered blocks task-complete and dependent release, so PM routes the remaining scope through a fresh/tightened reviewer dispatch; it never overwrites an `Approved` earned for checked scope or invents `Needs fixes` because the budget ended
8. Append progress.md and record the reviewed task with ordinary mstar plan progress under the workflow's primary coordinator and explicit plan address. Inspect the applied/replay receipt and resolve only a genuine conflict; retain applied components where the verb documents partial semantics. Keep sticky implementer-session.json last_task in sync. Never add raw snapshot writes, token copying, per-row bind or ownership transfer. Row scope/configuration/ledger semantics → mstar-artifacts/references/status-and-residuals.md; task/row integration → mstar-iteration/references/phase-2-worktree-lease.md; public parameters/recovery → mstar-use-cli/references/plan-and-workflow.md.
9. Release dependent tasks only after reviewed prerequisite commits are present in their assigned base, per Dependent-task readiness above; independent ready tasks need not wait

**Never** dispatch parallel writers without isolated worktrees and disjoint ownership. Merge their outputs serially before producing the plan review-package.

Detail: **`references/file-handoffs.md`**.

> **Engine check (when available):** run `mstar sdd workspace <plan-id>` / `mstar sdd task-brief <plan-file> <task-number>` / `mstar sdd review-package <base> <head>` (or `import { assertBaseSha, sddWorkspace, taskBrief, reviewPackage } from "@mstar-harness/engine"` in a host hook) to drive the loop steps above. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Implementer statuses

| Status | PM action |
|--------|-----------|
| DONE | review-package → task reviewer |
| DONE_WITH_CONCERNS | read concerns; fix scope issues before review |
| NEEDS_CONTEXT | provide context; re-dispatch. Budget overrun (the declared round cannot close its Files and gates) → split the task per `mstar-artifacts/references/plan-quality-bar.md` item 7 and re-dispatch with a fresh budget |
| BLOCKED | more context, split task, or escalate human — **never** same-model blind retry. Budget overrun → split the task per `mstar-artifacts/references/plan-quality-bar.md` item 7 and re-dispatch with a fresh budget |

## Reviewer ⚠️ items

`⚠️ Cannot verify from diff` does not block other findings. PM must resolve each before task complete.

## After all tasks

1. `mstar sdd review-package MERGE_BASE HEAD` → branch diff in `{SDD_DIR}/review/`
2. PM dispatches **plan QC tri-review (L3)** — **`QC mode: full tri-review`**, **N=3** — with branch review-package path and report paths under `{SDD_DIR}/review/` → **`mstar-review-qc`** · **`mstar-dispatch-gates`**. Layer SSOT → **`mstar-review-qc/references/review-responsibility-boundaries.md`**. PM writes `{SDD_DIR}/review/qc-consolidated.md` and durable main-plan gate summary. **Mandatory whenever `Execution mode: sdd`** (single-plan or iteration).
3. Critical/Important QC findings → fix assignments partitioned by ownership/dependency, then targeted re-review. Independent fixes run concurrently; PM retains the complete findings ledger. Fix rounds run on four mechanics — the per-task fix loop applies the same (`references/file-handoffs.md`):
    - **Unverified rounds count**: a fix round without verification evidence (reviewer not confirmed / report not on disk) is **not clean** — re-check and count the round; never enter the convergence branch.
    - **Complete ledger, scoped dispatch**: PM retains every open finding, including unverified items; each fix assignment carries only its owned findings and relevant fix delta. Unrelated findings do not expand a leaf task.
    - **Capped cross-round excerpt**: from round ≥2, the fix dispatch attaches only relevant prior findings and dispositions (advisory caps: ~500 words per round, ~1500 total — suggested values, not hard limits).
    - **Honest non-convergence**: open findings at wave close → list them in detail and state the disposition — re-feed to the next fix round **or** transfer to residual tracking — never silently close.
4. QA gate → mstar-harness-core Done rules and mstar-roles/references/project-manager/qa-trigger-matrix.md. Then the primary coordinator uses direct complete with QC/QA and the engine-selected route's proof: iteration verifies the already-performed serial merge; standalone development verifies its registered source; report-only consumes matching policy fulfilment recorded before Done without invented Git. Task ledger completion is not row Done, and row Done does not close the workflow or discharge its outer delivery obligations → mstar-artifacts/references/plan-workflow-lifecycle-contract.md.

> **On dsh:** the plan QC tri MAY run through the native **`workflow`** tool instead of three `subagent` dispatches — take the `script` + `meta` (`meta.name: mstar-qc-tri`) from skill **`mstar-host`** → `references/dsh-workflow-scripts.md` (§ `mstar-qc-tri`); the three seats stay read-only and PM persists `{SDD_DIR}/review/qc1.md`…`qc3.md` from their returned envelopes. Independent ready implementers use background **`subagent`** dispatches with isolated writable tracks — the `workflow` channel is read-only fan-out only; when the tool is unmounted (`ptc` preset) dispatch the three seats as background `subagent` calls (skill **`mstar-host`** → `references/dsh.md`).

## Progress ledger（Evidence）

PM at start: `cat {SDD_DIR}/progress.md`. Tasks marked complete are DONE — do not re-dispatch after compaction.

PM appends on clean review: `Task N: complete (<base>..<head>, review clean, review: task-N-review.md)` — the entry names the L2 report path the review closed on.

Minor findings → `## Minor (for plan QC)` section in same file.

> **Engine check (when available):** import `readProgressLedger` from `@mstar-harness/engine` in a host hook to read the ledger above (no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Red flags (NEVER)

- Parallel implementers sharing a worktree, ownership, or session
- Paste plan, diffs, or task history into dispatch prompts
- Dispatch reviewer without diff file
- `HEAD~1` as review BASE
- Pre-judge reviewer ("do not flag", "at most Minor")
- Skip task review or accept missing verdict
- Accept the L2 verdict from the message alone, or write L2 output to the implementer's `task-N-report.md` (the report is `{SDD_DIR}/task-N-review.md`)
- Mark a task complete or release dependents while the assigned L2 review scope is uncovered
- Re-dispatch tasks listed complete in ledger
- PM thread implements instead of subagent dispatch
- Sticky **resume** for task reviewers
- Resume implementer without `host_agent_id` in `implementer-session.json`

## CLI

The SDD helpers are engine-backed commands under **`mstar sdd`**（引擎 CLI；原 bash 脚本已移除，行为语义不变）。Run the `mstar` binary from any checkout; env vars `MSTAR_CONTROL_ROOT` / `MSTAR_HARNESS_DIR` / `SDD_DIR` are honored exactly as before.

| Command | Usage |
|--------|--------|
| `mstar sdd workspace` | `PLAN_ID [CONTROL_ROOT]` → creates `{SDD_DIR}` under the verified main-worktree control harness (`MSTAR_CONTROL_ROOT` or 2nd arg when supplied); fail closed on Git main-worktree discovery failure or a supplied Git control root that is not main. `status.json` / snapshot existence is only a discovery probe, with directory / `.mstar` fallback; explicit non-Git standalone roots remain supported |
| `mstar sdd task-brief` | `PLAN_FILE TASK_N [OUTFILE]` |
| `mstar sdd review-package` | `BASE HEAD [OUTFILE]` |
| `mstar sdd check-context` | Action-seam gate against resolved SDD context; arguments and refusal recovery → command `--help` |

Developer check evidence: `mstar sdd evidence capture|verify` — capture runs an already-authorized argv once and retains raw evidence; verify is read-only. Command shapes, exit meanings and role boundaries → **`references/file-handoffs.md`** § Verification evidence. `mstar sdd exec` stays PM-only.

## References

- `references/file-handoffs.md` — paths and fix-loop evidence
- `references/sticky-implementer-session.md` — `fresh` vs `sticky`, ledger, host resume, micro-batch fallback
- `references/implementer-prompt.md`
- `references/implementer-continuation-prompt.md`
- `references/task-reviewer-prompt.md`
- `mstar-artifacts/references/plan-quality-bar.md` — plan self-containment standard (plans must meet this before SDD dispatch)
