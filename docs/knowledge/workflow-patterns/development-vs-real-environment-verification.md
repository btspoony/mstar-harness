---
module: development iteration scope vs real-environment verification (mstar-iteration, mstar-review-qc, PM Acceptance)
date: 2026-09-01
last_updated: 2026-11-09
problem_type: workflow_issue
category: workflow-patterns
severity: high
tags:
  - verification-scope
  - real-environment
  - acceptance-criteria
  - iteration-boundary
---

# Development iterations do not run real-environment verification

## The rule

A development iteration owns **implementation plus unit/component checks**. A containerised unit check is in scope when the unit under test genuinely needs a container.

**Real-environment verification belongs to a separately requested end-to-end flow** and is never a development Done, PM Acceptance or QC condition. Real-environment means any of:

- live third-party API calls (provider, model, payment, any external service);
- execution through a named host's executable or CLI path;
- installed-artifact or deployment runs;
- browser, device or OS-level integration.

A development plan's acceptance criteria, `QA gate` (the fixed `pm-acceptance` carrier) and QC scope must not require that evidence. The verification flow exists for it; pulling it into an iteration both stalls delivery and duplicates the flow.

## Why the narrower wording fails

A boundary phrased only as "no real browser / device / deployment E2E" does not stop an agent from gating on **live API calls** or **named-host runs**, because those are not literally browser/device/deployment. Observed failure: a plan's acceptance criterion demanded a live provider success receipt bound to the packaged executable digest, and a separate requirement was written as an "authenticated host" prerequisite even though the source contract only asked for a host *executable/CLI path* with recorded versions and exit outcome.

The narrower the wording, the more an agent can sincerely believe it is inside the rules while violating their intent.

## Failure modes seen

- **Live calls inside the iteration.** A calibration run made real provider calls during Phase 2, consumed significant wall-clock time, and surfaced a chain of unrelated integration defects that then had to be triaged inside the iteration. Its result was unqualified and, correctly, not used as an acceptance condition.
- **Assumption promoted to constraint.** An implementation choice (a container-based reviewer, requiring an account) was written into plans and the compass as if it were an external requirement. The source contract never asked for it. Credentials supplied by environment variables satisfied the actual requirement.
- **An acceptance seat failing a plan for missing out-of-scope evidence.** With no explicit prohibition, a PM Acceptance check can legitimately block a development plan for lacking live-environment proof. `mstar-roles/references/project-manager/acceptance.md` § Narrow acceptance-execution exception and the QC scope contract must both state the prohibition.

## How to apply it

1. **Prepare gate**: refuse an acceptance criterion that names real-environment evidence. Discovering this at execution time is the most expensive moment.
2. **Use one vocabulary** and say which phase owns each: `unit`, `component` (may be containerised when needed), `integration`, `real-environment`.
3. **State capability gaps instead of implying them.** When a capability genuinely cannot be demonstrated in-iteration, record it as an issue with what would be needed to close it, and say plainly that the in-iteration proxy (e.g. a supervisor-side path) is **not** evidence for the end-to-end claim.
4. **Hand over explicitly.** At iteration close, list what was deferred and why, so nothing is silently skipped and nothing is faked to make a plan look complete.
5. **Do not let the boundary hide a real defect.** "Out of scope" applies to *evidence*, not to broken code. A refusal path that a development test can exercise stays in scope.

## Origin

Established mid-iteration after the rule had already been violated, and recorded as GitHub issue #283 in `btspoony/mstar-harness`.
