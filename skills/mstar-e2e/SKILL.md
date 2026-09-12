---
name: mstar-e2e
description: Runs separately requested E2E, real-browser, device, or installed-deployment verification and produces scoped evidence. Loads only for an explicit user request or amazing-e2e-check entry; never from routine QA, UI changes, missing screenshots, or review recommendations.
---

# Independent E2E Verification

## Load Order

Read `mstar-harness-core` first. PM follows `mstar-roles` → `references/project-manager.md` and the existing dispatch/path contracts; the assigned executor reads `mstar-roles` → `references/ops-engineer.md`. Resolve available host tools through `mstar-host` only when needed. No external skill, CLI, or MCP is a required dependency.

## Scope

This is an explicitly requested verification workflow, separate from development iterations and routine QA. Trigger phrases include “run these E2E scenarios”, “verify on this device”, “check the installed deployment”, and `/amazing-e2e-check`. A UI diff, missing screenshot, failed unit test, or reviewer suggestion does not authorize it.

## Workflow

1. **PM scopes the request.** Record the existing user authorization, build/ref, environment/device, named scenarios and expected results, permitted side effects, capability, and report path. Ask only for missing required inputs; never infer production, accounts, or devices. Reuse relevant knowledge without a new global scan.
2. **PM registers independent work.** Use existing workflow `type: plan`, its own workflow/plan IDs and working context. Snapshot states are `running | paused | completed | failed | stopped`; plan rows use `Todo → InProgress → InReview → Done/Blocked`. Do not insert an iteration phase, ordinary QA gate, or automatic QC tri-review into a verification-only run.
3. **PM dispatches ops.** Use `Execute as: ops-engineer`, `Task category: ops`, `Delegation: forbidden`, and the existing Scope / Inputs / Constraints / Evidence Required / Acceptance Criteria fields. Pass the concrete report path under `{WORKFLOW_DIR}/<workflow-id>/reports/e2e.md`. Ops executes only the named scenarios and records actual results using `references/report-template.md`.
4. **Run independent scenarios concurrently** when sessions, devices, data, and writable state are isolated. Serialize shared state. Stop when the assigned scenarios finish; new environments or broader suites need matching user authorization.
5. **PM reviews the scoped report and closes.** `InReview` means report acceptance against the scenario list, not another broad code review. Ops returns evidence and cannot mark Done. PM owns the final plan/workflow state and any bounded repair handoff; preserve the originating iteration's state and unit-test evidence.

## Decision Rules

- Global scope and full-test permission remain in `mstar-harness-core` → `## 定向执行与验证边界`. Explicit E2E permission authorizes only its named scenarios; it does not authorize a full suite. Permission for a full unit suite does not imply E2E permission.
- QA never executes this workflow or launches its browser/device runner. PM dispatches ops directly; `report-only` and `Skill presets: none` do not change the executor boundary.
- Verification-only work produces the E2E report, not a Deploy Plan. Production changes, installs, restarts, destructive steps, or deployment/rollback actions require scope-specific authorization; the ops role does not create that authorization.
- A missing capability or input is `blocked` or `not-run`, never a simulated pass. Report the exact missing prerequisite without improvising another environment.
- A failed product scenario can be a completed verification run when all assigned scenarios have determinate results and findings are handed off. `workflow completed` does not mean `product passed`. Unresolved execution blocks stay explicit.
- Defects go to bounded repair assignments/plans. Repairs use affected unit checks; any real scenario retest stays in this separate workflow. Findings do not automatically reopen or block the originating iteration.

## Evidence

Use actual build/environment identity, actions or commands, output/artifact links, and one outcome per scenario: `passed | failed | not-run | blocked`. State excluded scenarios and unavailable capabilities. Never substitute mocks, static checks, old-build screenshots, or workflow status for real scenario results. Keep secrets out of the report.

## References

- `references/report-template.md` — load when preparing or accepting the independent verification report.
- `mstar-harness-core` → `## 定向执行与验证边界` — shared scope and authorization policy.
