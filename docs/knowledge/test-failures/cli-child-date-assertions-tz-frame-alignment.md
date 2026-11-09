---
module: CLI child-process date assertions vs runner TZ handling (slice4/sdd-evidence class)
date: 2026-09-16
last_updated: 2026-11-09
problem_type: test_failure
category: test-failures
severity: medium
plan_id: <plan-id>
symptoms:
  - "Date-string assertions on CLI child output fail only in full-suite or certain runs, pass in file isolation"
  - "Failures cluster on frames straddling the local 00:00–08:00 (+8) boundary"
  - "The literal in-suite red cannot be reproduced on a newer runner (bun 1.4.0 pins UTC when TZ is unset)"
root_cause: "The CLI child's date fill is env-TZ-sensitive (`TZ` from `cliEnv`, else the runner default), while the test asserted against the test process's local zone — two independent clocks. Bun changed its unset-TZ behavior (system zone before 1.4, UTC pin at 1.4), so which frame diverges is runner-version-dependent; the first diagnosis (test order dependence) was wrong."
resolution_type: code_fix
applies_when:
  - "Any test asserting dates/timestamps produced by a spawned CLI child"
  - "A flake that passes in isolation, fails in suite, and will not reproduce after a runner upgrade"
  - "Writing new child-process test helpers that format or compare dates"
tags:
  - timezone
  - cli-tests
  - child-process
  - flaky-tests
  - frame-alignment
---

# Problem

`slice4-cli` backlog date assertions failed in the full suite during PR #243 CI-adjacent runs and locally near the +8 midnight boundary, while passing in isolation — first misdiagnosed as test order dependence. `sdd-evidence.test.ts` carried four more cases of the same class (register residual R5 of plan <plan-id>). Both files are gone today (`mstar sdd evidence capture|verify` was deleted; the CLI suites consolidated onto `packages/cli/test/harness.ts`), so read this as the mechanism, not a live file list.

# What Didn't Work

- Order-dependence hypothesis: full-suite A/B on the stashed diff showed identical failures on clean base — not order.
- Reproducing the literal red after a runner upgrade: bun 1.4.0 pins the child to UTC when `TZ` is unset, masking the mechanism that produced the original wave failures.

# Solution

Make assertion and child share one clock by construction: the child env helper pins `TZ = process.env.TZ ?? "UTC"` and the assertion helper formats with the identical expression (`todayInChildFrame()` in the suite that raised the finding — that file has since been folded into the shared `packages/cli/test/harness.ts`; the surviving, live half is `cliEnv()`'s `env.TZ = process.env.TZ ?? "UTC"` line, so any new date assertion must format through that same expression itself). Frames coincide under every ambient TZ and either runner behavior; the product's own local-date fill is unchanged and remains covered by explicit TZ-varied runs.

# Why This Works

Two frames derived from one expression cannot diverge; removing the runner's local-zone handling from the assertion path removes the runner-version axis entirely. The diagnosis stays honest by tracking the unexplained bun 1.4.0 red as a residual instead of force-fitting the model.

# Prevention

- Every child-process test helper that touches dates must derive assertion frames from the same TZ expression it puts in the child env — never from the test process's local zone.
- When a flake's red stops reproducing after an environment change, keep the residual open and record the mechanism boundary, rather than declaring the fix proven by a green run.
- Sweep sibling suites for the same pattern when one instance is found (`sdd-evidence` was found exactly this way).

Related: `tooling-decisions/worktree-cleanup-ignored-artifact-gate.md` (archived) (same iteration's other environment-honesty lesson).
