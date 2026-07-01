---
name: mstar-execution-practices
description: Morning Star execution practices for root-cause debugging, test-first behavior changes, plan execution checkpoints, review feedback handling, and evidence-backed completion. Read when fixing bugs, implementing non-trivial behavior, executing a written plan, responding to review feedback, or claiming work is complete. This is mstar-native and does not require external skill plugins.
---

# Morning Star Execution Practices

This skill distills reusable execution practices into Morning Star's own runtime contract. It does not depend on external skill plugins and does not override `mstar-harness-core`, `mstar-phase-gates`, `mstar-branch-worktree`, or `mstar-review-qc`.

## Load Order

Read `mstar-harness-core` first. Then read the topic skill that owns the gate you are operating in:

| Situation | Also read |
|---|---|
| Phase gate, clarify, plan, or implement GO | `mstar-phase-gates` |
| Branches, commits, worktrees, QC/QA checkout | `mstar-branch-worktree` |
| Formal QC/QA review | `mstar-review-qc` |
| Code edits, refactors, debugging | `mstar-coding-behavior` |

This skill defines execution discipline inside those gates.

## Scope

Use this skill when the assignment needs stronger execution discipline than the base role prompt:

- A bug, failed test, build failure, CI failure, regression, flaky behavior, or unexpected runtime state needs diagnosis.
- A non-trivial behavior change needs a test-first or equivalent verification path.
- A written plan is being executed step by step.
- Review feedback must be interpreted, verified, and applied.
- A role is about to claim work is complete, fixed, passing, ready for QC, or ready for merge.

Do not use this skill as a dispatch authority, branch policy, plan storage contract, or QC report template. Those are owned by the topic skills listed in Load Order.

## Mstar-Native Principles

- Evidence before claims.
- Root cause before fix.
- One hypothesis and one change at a time.
- Test behavior before implementation when practical.
- Execute written plans through visible checkpoints.
- Verify review feedback against codebase reality before editing.
- Record skipped checks and residual risk explicitly.

## 1. Root-Cause Debugging

When handling a bug, failed test, build failure, performance issue, integration issue, or unexpected behavior:

1. Read the complete error, stack trace, logs, and failing command output.
2. Reproduce or collect enough evidence to explain why reproduction is not currently possible.
3. Check recent diffs, dependency/config changes, environment changes, and call sites.
4. Trace data flow backward from the observed bad value or failing boundary until the source is identified.
5. State one hypothesis at a time: "I think X is the root cause because Y."
6. Test one variable at a time.
7. Fix the root cause at the narrowest shared point, not only the symptom path.

Stop and escalate when three fix attempts fail or each attempted fix reveals a different shared-state/coupling problem. At that point the likely issue is architectural or underspecified, not another local patch.

Red flags:

- Proposing a fix before identifying the failing boundary.
- Adding a guard without understanding why the bad state exists.
- Changing multiple things before rerunning a targeted check.
- Treating flaky or non-reproducible behavior as "probably fixed" without evidence.

## 2. Test-First Behavior Changes

For new behavior, bug fixes, and non-trivial refactors, prefer the smallest executable check before implementation:

1. Write a minimal failing test or runnable reproduction for the behavior.
2. Run it and confirm it fails for the expected reason.
3. Implement the smallest durable change that passes it.
4. Run the targeted check again.
5. Run the relevant broader regression check.

Valid exceptions:

- User or project policy explicitly forbids TDD.
- The change is documentation-only, metadata-only, or a trivial one-line correction.
- The codebase has no practical test seam for the current slice; in that case, state why and provide a substitute verification command, script, manual reproduction, or static check.

Do not preserve prewritten production code as "reference" when the intended method is test-first. If you already wrote implementation before the failing check, either revert the speculative portion or explicitly disclose the deviation and produce a regression check before claiming completion.

## 3. Written Plan Execution

When a written plan exists:

1. Read the full plan before editing.
2. Check for blockers, missing paths, conflicting instructions, vague steps, or verification gaps.
3. If the plan is executable, convert it into a visible task checklist.
4. Execute one step at a time.
5. Run the verification specified for that step before marking it complete.
6. If the plan becomes wrong, update the plan/status artifact before continuing.

Stop instead of guessing when:

- A step refers to missing files, undefined APIs, or unclear ownership.
- A verification command fails repeatedly.
- The plan contradicts `mstar-harness-core`, branch policy, QC/QA gates, or user instructions.

Plan tasks should be bite-sized, but not toy-sized: each task should produce a coherent, reviewable slice with exact file paths and exact verification commands.

## 4. Review Feedback Handling

When receiving review feedback:

1. Read all feedback before editing.
2. Restate unclear requirements or ask for clarification before partial implementation.
3. Verify each suggestion against codebase reality.
4. Apply technically correct feedback one item at a time.
5. Test each fix individually where practical.
6. Push back with evidence when feedback is incorrect, obsolete, risky, or violates scope/YAGNI.

Do not perform agreement. State the technical action or the technical reason for disagreement.

Feedback priority:

| Feedback type | Handling |
|---|---|
| Security, correctness, data loss, build/test failure | Fix or escalate before proceeding. |
| Scope mismatch, reviewer misunderstanding, obsolete assumption | Verify and push back with evidence. |
| Style-only suggestion | Apply only if it matches project conventions or is requested by the user/PM. |
| New feature disguised as review | Route through PM/plan unless explicitly in scope. |

## 5. Evidence Before Completion

Before claiming work is complete, fixed, passing, ready, or safe to merge:

1. Identify the claim.
2. Identify the command, artifact, diff, screenshot, or reproduction that proves it.
3. Run or inspect it fresh in the current context.
4. Read the full output and exit status.
5. Report the actual result, including failures or unverified parts.

Do not claim success from:

- A previous run before the latest edits.
- A partial command that does not cover the claim.
- A subagent's summary without checking the diff or artifact.
- "Should", "probably", "looks good", or equivalent confidence language.

Completion reports should include:

- What changed.
- Why it changed.
- Verification evidence with command/output summary.
- Known gaps, skipped checks, or residual risks.

## 6. Native Morning Star Mapping

Use these mstar-native equivalents instead of external skill names in Assignments and reports:

| Intent | Write this in Morning Star artifacts |
|---|---|
| Root-cause investigation | `Execution practices: RCA before fix; evidence: repro/log slice + hypothesis` |
| Test-first work | `Execution practices: test-first where practical; evidence: red/green or substitute check` |
| Completion gate | `Execution practices: evidence before completion; evidence: command/output or reproduction` |
| Parallel work | `Dispatch: independent tracks; see mstar-dispatch-gates` |
| Same-repo concurrent writes | `Worktree isolation: required; see mstar-branch-worktree` |
| Review feedback | `Review response: verify feedback before edits; evidence: itemized fixes or pushback` |
| Plan execution | `Plan execution: task checklist + per-step verification` |

Never add an external-skill dependency line to Morning Star Assignments. If a user has external skills installed, they may use them manually, but Morning Star artifacts must remain self-contained.
