---
module: packages/cli/src/index.ts
date: 2026-08-22
problem_type: workflow_issue
category: workflow-patterns
severity: medium
applies_when:
  - "A residual/audit finding is registered as open but the fix already landed in a prior iteration"
  - "Planning an iteration whose direction is a list of deferred residuals"
plan_id: <plan-id>
last_updated: 2026-11-09
tags:
  - residual
  - closure-verification
  - audit
  - cli
  - deferred-work
  - registration-lag
---

# Closure-verification plans: prove the command surface exists before re-implementing

## Context

`iter-<plan-id>` opened with 7 `decision: defer` residuals. One — audit-004 ("5 validators lack a `mstar …` CLI command") — had actually been **resolved a prior iteration**: `iter-<plan-id>` landed all five commands (`status tech-debt`, `status findings-cleanup`, `lease verify-integration`, `worktree qc-alignment`, `host skill-root`), with `docs/cli.md` sections and skill callouts updated. The residual register lagged the code: `decision: defer, target: next iteration` persisted even though the work was done.

The compass originally planned audit-004 as a **re-implementation** (5-command fixture plan). A pre-plan grep (`packages/cli/src/index.ts` + `docs/cli.md` + skill callouts) showed all 5 already present, so the plan was re-scoped mid-Phase-1 to a **closure-verification plan** — smoke each command runnable from the dist build, confirm no stale import-only callouts, add a `.changes` fragment only if missing, close the residual in-place. No command code was written.

## Guidance
1. **Grep before you plan**: when a residual claims "import-only / no CLI form yet", grep the CLI surface + docs + skill callouts *in the current checkout* first. Residuals register against the base revision at audit time; commits since then may have closed the gap. A plan that re-implements an existing command is wasted work — and a QC tri will catch it.
2. **Re-scope, don't drop**: turn the re-implementation into a closure-verification plan (smoke the real dist build, verify exit semantics against `docs/cli.md`, check callouts, fill the changeset gap, close the residual in place). Keep the residual's AC but rewrite the wording to "verified runnable + closed", never "implemented".
3. **Smoke from the real artifact**: `node packages/cli/dist/mstar-harness.js …` after a fresh build — never a possibly-stale global bin (`mstar` in `~/.nvm` etc. may lack new commands). Document the exact invocation (`MSTAR_HARNESS_DIR=… node packages/cli/dist/mstar-harness.js <command> …`) in the closure_note so the evidence is reproducible.
4. **Closure evidence must be complete**: every report-table row (including negative-path probes that exit non-zero) needs a persisted output section with an explicit `EXIT=<n>`. A smoke file that omits the non-zero probe is incomplete — QC flagged this (Request Changes → evidence reconcile).
5. **Close in place**: close the finding through the issue store's closure authority (`mstar issue close --disposition resolved` with the smoke evidence cited) — the legacy `projects/<id>/residuals.json` register is migration history with no live writer (`skills/mstar-conventions/references/artifact-storage-paths.md`).

## Why This Matters
Audits and residuals are snapshots at a point in time; the register is a lagging indicator. A maintainer (or future PM) who trusts the residual text and re-implements discovers the duplication only at QC — costing a plan + review cycle. The closure-verification pattern turns "deferred" into a cheap proof step.

## When to Apply
- Any residual whose fix may have landed since registration (esp. "import-only CLI" claims).
- Before allocating a plan to a "new command" whose command name already appears in `docs/cli.md`.
- At iteration scope definition: grep the 5-command surface for the residual set before fixing the plan list.

## Examples
### Plan re-scope (compass diff)
```
- **audit-004** 5 个 validator 的 CLI 命令面缺 mstar … CLI（import-only）— 本迭代实现
+ **audit-004** 5 个 validator 的 CLI 命令面 —— 已确认全部落地（iter-<plan-id>）——本迭代闭环验证（smoke + changeset + residual close）
```
### Smoke evidence (partial)
```
$ node packages/cli/dist/mstar-harness.js status tech-debt {HARNESS_DIR}/projects
total_open: 0
EXIT=0
$ node packages/cli/dist/mstar-harness.js worktree qc-alignment ...   # mismatch probe
FAIL (2 violations) ... EXIT=1   # documented exit semantics per docs/cli.md
```

## Result
Plan `<plan-id>` (inline, verification-only, no command code) — QC tri 3/3 Approve (qc2 Request Changes → evidence reconcile → Approve), acceptance pass under the then-current QA route, audit-004 residual closed, register now 0 open. Fragment: `.changes/unreleased/validator-closure.md`.
