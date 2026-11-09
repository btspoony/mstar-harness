---
module: coordination scope resolution under unavailable Git (session root authority)
date: 2026-09-16
last_updated: 2026-11-09
problem_type: logic_error
category: logic-errors
severity: high
plan_id: 20260916-plan-engine-capacity-gate
symptoms:
  - "Git-less child run refuses with `coordination.scope-mismatch` comparing the correct root against `<harness-root>/plans`"
  - "The public operation never reaches the code under test (handoff proof, gitRead)"
  - "The wrong root is always the real root plus one path segment (`.mstar/plans`), on every real-layout harness"
root_cause: "`sessionScope` re-derived the harness root through Git-dependent probes despite a bind-time-validated session root; a swallowed probe failure let the candidate walk start inside `.mstar` and match `.mstar/plans` as a wrong non-null root"
resolution_type: code_fix
applies_when:
  - "Exercising coordination mutations (plan sessions, handoff, lease verbs) in an environment where the git executable is missing or failing"
  - "A public operation refuses with a scope error before reaching the code under test"
  - "Deciding whether a code path may re-derive a harness root through environment probes"
tags:
  - git-unavailable
  - harness-root
  - scope-resolution
  - degraded-environment
  - session-authority
---

# Problem

The R2 regression work (prove `gitRead` subprocess-failure classification through a public coordination call) could not reach the handoff proof in a child process with an isolated empty `PATH`: the operation died with `coordination.scope-mismatch` ("Assignment Control harness root <root>/.mstar does not match the process harness root <root>/.mstar/plans") before `gitRead` ever ran.

# Symptoms

- Child run with no `git` executable surfaces `coordination.scope-mismatch`, never `coordination.git-unavailable`.
- The mismatch compares the correct root against `<harness-root>/plans` — the resolver walked *from inside* `.mstar` and matched the first candidate directory.
- Real harnesses always contain `{HARNESS_DIR}/plans/`, so the mis-walk is structural, not fixture-specific.

# What Didn't Work

- Test-side workarounds: a genuinely missing binary cannot be "present for scope probes, absent for `gitRead`" without mocking `execFileSync` (banned); removing `.mstar/plans` from the fixture would dodge the real-layout shadow and manufacture coverage deployments never get.
- Treating it as a fixture bug: the causal chain is production code — `sessionScope` re-derived the harness root via the single-arg `resolveProcessHarnessDir(cwd)` even though the resumed session already carried a bind-time-validated root. With Git unavailable, `readMainWorktree`'s probe failure was swallowed, the workspace boundary fell back to the start directory (inside `.mstar`), and the candidate walk matched `.mstar/plans` as a wrong non-null root.

# Solution

One behavioral line in `scopeFromAssignment` (`packages/engine/src/coordination.ts`; the file-execution route that carried it was retired — the live embodiment of the rule is `resolveIntentRoot(context, association)` in the same file): the Git-dependent process-root re-derivation runs only when the caller brings no trusted root. All session-scoped paths (resume/read/bind/session scope/coordinator scope) treat the session's recorded, bind-time-validated root as authoritative via the existing cross-check against `RootAssociation` (`root` + `source`). A Git-less child then proceeds to the real Git read and surfaces `coordination.git-unavailable` with the ENOENT cause, as intended.

Current shape in `resolveIntentRoot` source order: `context.controlRoot` (never re-derived), then the `association` root (Git-independent, cross-checked against `probeProcessRoot(context.cwd)` when that probe answers — two durable statements that disagree refuse `coordination.scope-mismatch`, never a silent pick), then the process probe (the only Git-dependent source). When the probe is unreadable but an association exists, the associated root stands and `coordination.git-unavailable` is reported as a warning beside it, not promoted to a refusal.

# Why This Works

A validated session root is strictly more trustworthy than a fresh environment probe: it was checked at bind time against the assignment. Re-deriving it through Git-dependent probes converts any Git outage into a misleading scope error and, worse, can guess a *wrong* root from a degraded vantage point. Skipping only the re-derivation (never the cross-check) preserves all Git-available behavior — the full coordination suite stays green unchanged.

# Prevention

- Prefer session/pinned authority over environment re-derivation inside long-running operations; re-derive only when no validated value exists, and fail loud (`git-unavailable`) instead of guessing when the probe environment is degraded.
- A swallowed probe failure that falls back to candidate walking is a wrong-root generator, not a benign fallback.
- When a test cannot reach the code under test through a public operation, file the structural defect (STOP + minimal fix proposal) instead of reshaping the fixture around it.
- Known follow-up: the `prepare` operation still takes the no-`chosenRoot` path (registered residual, `engine` register R2 of plan 20260916-plan-engine-capacity-gate). Superseded as stated: `prepare` now runs inside the ACTIVE execution authority whose root is read back from the store's own path (`controlHarnessRoot` in `execution-coordination.ts` derives it from `storeDbPath(context)`), so the residual no longer describes live code.

Related: `tooling-decisions/worktree-cleanup-ignored-artifact-gate.md` (archived) (the same iteration's Git/worktree-environment honesty lessons), `architecture-patterns/dsh-harness-root-boundary.md` (workspace-root stop boundary).
