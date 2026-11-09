---
module: harness-plan-workflow
date: 2026-10-08
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
tags:
  - workflow-registration
  - standalone-development
  - delivery-anchors
  - sdd
  - skill-eval
  - bounded-resolution
  - mcp
title: Standalone plan workflow registration anchors and bounded-resolution evidence mechanics
source: plan 20261008-bounded-resolution-guess-path (wf-20261008-bounded-resolution-guess-path-2, issue #368)
status: active
last_updated: 2026-10-16
---

# Standalone development anchors + bounded-resolution evidence mechanics

## 1. Registration anchors: `branch.work` is the delivery branch, not the base

`workflow register --delivery-kind development` must register `--branch-work <delivery branch>` (the feature branch the plan row's `working_branch` records), not the merge base. The plan's three anchors name three different things: `branch.base` is the branch the workflow was created from (the protected merge anchor), `branch.work` is the delivery branch the delivery PR comes from, and `branch.target` is the branch the delivery merges into. `--branch-source` is accepted only as a deprecated alias of `--branch-work`: it records the same `branch.work`. An iteration keeps its own shape, `{base, integration, target}`.

`branch.source` is the pre-rename spelling of the delivery branch. A row registered before the rename still carries it, and one resolver serves every reader — `deliveryBranchOf(branch)` = `work ?? source` (`workflow.ts`) — so such a row closes exactly like a new one. Registration and repair write `work` only, so no row ever carries both spellings and no migration path exists.

`plan complete` (standalone development route) refuses `coordination.scope-mismatch` when the recorded working branch ≠ the registered delivery branch (`execution-coordination.ts`: `standaloneDeliveryAnchors` runs the same `deliveryBranchOf` over `snapshot.branch`). That refusal has two reachable causes and its `details` discriminate them: a row with no recorded worktree/branch scope carries `{worktree_path, working_branch}` and no anchor pair, while a real anchor mismatch carries `{expected, actual}` naming the two branches — the `plan complete` recovery text branches on exactly that pair. The refusal message itself is literal by contract: `scripts/lint-help-reachability.ts` (Rule #341 class 4) refuses a `CoordinationError` message that both carries an unresolved runtime substitution and advertises an `mstar …` command, so the two requirements are mutually exclusive by construction and the values travel in `details`.

A running workflow's anchors are repaired in place with `mstar workflow delivery-anchors --workflow <id> [--branch-base <branch>] [--branch-work <branch>] [--branch-target <branch>] --reason <text>`. Each of the three anchors is independently optional — an anchor the operation does not name keeps the value the workflow already registers — and the write merges into the stored `branch`, so members the operation does not own survive (an iteration's `base` / `integration`). `--reason` is required and is part of the operation's intent fingerprint, the correction is revisable and repeatable, and the operation runs under the workflow CAS token. Stop-and-re-register remains the heavier alternative for a workflow that is no longer running — `workflow lifecycle --status stopped --reason <honest cause>` plus a fresh create-only registration (new workflow id, same plan id), then re-bind, re-prepare, re-progress, re-complete.

Registering `work=main, target=main` copies the iteration semantics onto a standalone plan and cannot complete: such a pair names no delivery PR, and the recorded working branch of the plan row will not match it. `workflow register` reports that shape as a non-blocking advisory in the ok envelope's `data.warnings`; the registration itself succeeds, so the advisory is not a substitute for reading the anchors.

## 2. SDD `context.json`: `controlHarnessRoot` is the harness directory, not the repo root

`sdd.ts` passes `context.controlHarnessRoot` straight into `assertPlanWritingPath(planFile, controlHarnessRoot)`, which calls `resolvePlanDir(<value>)` = `<value>/plans`. With the repo root the gate resolves `{PLAN_DIR}` to `<repo>/plans` and refuses `plan-path.outside-plan-dir`; the correct value is `<main-repo-root>/.mstar` (the harness dir). Other fields: `planId` is required; `planFile`/`sddDir` must resolve inside the control harness; the gate verifies the control root sits inside a git checkout and canonicalizes `sddDir` against `resolveSddDir`. A missing field surfaces only when a context-consuming helper runs (`review-package`/`task-brief`), not at write time — validate with `mstar sdd check-context` before dispatch.

## 3. Bounded-resolution real runs: authored scenario manifest vs frozen corpus

`prepareManifest` requires the frozen 30-case corpus (`cases.json`); the bounded-resolution scenario set (`bounded-resolution.manifest.json`) is a separate authored artifact. A real evaluator run bridges them by deriving a disposable two-case run manifest (guess-path case + negative control) with preserved config integrity (real full-SHA source ref, CLI identity + helpHash) and executing it through `selectCases`/`executeManifest`/`buildReport`. Do not modify `runner.ts` scoring or `cases.json`.

Evidence-chain mechanics that made the run trustworthy:
- The scripted MCP-client adapter must emit the runner's NATIVE event-record schema (`mcp_tool_call`/`command_execution` shapes with complete identity + outcome). `gradeCallsWithin` grades `unverified` (never pass) on missing identity — but does NOT reject `unknownOutcome` alone, so a protocol-invalid response must map to a FAILED outcome, never unknown.
- Close/timeout must record interrupted invocations at SEND time; rejecting before recording undercounts.
- Archive the run's actual working-tree SHA; when later commits touch only driver/docs, state the revision-provenance explicitly (surface-based, not SHA-pinned) instead of re-running or re-labeling.
- A run driver must propagate graded failures (`max(run.exit, report.exit)`); derive paths from `import.meta.url` + env overrides so the documented command is clone-portable.

## 1b. Registration redo leaves ambiguous cleanup ownership — fixed upstream

The stopped-superseded-registration recovery (§1) leaves both workflows' plan rows pointing at the same `metadata.worktree_path` / `working_branch`. The terminal-owner ambiguity is fixed upstream: cleanup resolves the retained claim to the completed owner and no longer refuses the eligible worktree as foreign. Ordinary dry-run cleanup now plans the merged worktree for `remove` (`cleanup.remove.merged`). It may still report the associated branch as `refuse(checked-out)` in that same dry-run because the worktree must be removed first; per the cleanup contract, rerun the dry-run after worktree removal to plan branch deletion. Do not hand-delete past the guard.

[local ignored record: 2026-10-08T10:10:04Z | fullstack-dev | openai-codex/gpt-6-luna | 20261008-cleanup-terminal-claims | docs/knowledge/architecture-patterns/standalone-anchors-and-bounded-resolution-evidence.md§1b]

## Non-lessons

- The frozen corpus, runner scoring semantics, and the 12 CLI-arm scenarios are evaluation invariants — untouched here by design.
- Model compliance remains unverified (scripted client, no LLM); the evidence claim is the call bound, nothing more.
