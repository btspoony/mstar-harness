---
module: packages/engine + packages/cli test suites (regression-case proof)
date: 2026-09-15
problem_type: testing_pattern
category: testing-patterns
severity: high
plan_id: <plan-id>
applies_when:
  - "A fix's acceptance criteria require a named regression case"
  - "A case's red is being used as proof that the fix is what makes it pass"
  - "A guard or lint ships with a red-probe"
tags:
  - load-bearing-test
  - surgical-revert
  - red-probe
  - regression-evidence
  - discriminating-assertion
---

# Load-bearing regression proof: a revert must disable exactly the guarded behaviour

## Context

Plan acceptance criteria commonly say "each Critical finding maps to a named regression case". The case is then shipped with a green run as its evidence — which proves nothing unless the case actually fails when the fix is absent. Reviewing only the case's text cannot tell the difference: a case that pins a surface's *shape* passes with and without the fix, because it asserts the default path the fix never changed.

A review seat's severity bar names this class blocking — **"a test that would pass even if the behaviour it names were broken"** — and a closure re-review of one plan found three landed source fixes whose cases were all non-load-bearing: reverting each fix left its case green. Making them load-bearing changed nothing in the source and everything in what the suite proves.

## Guidance

**The four-part proof.** For each case that claims to defend a behavior:

1. **Surgical revert of only the target behaviour** — restore the removed code path (that function, that ordering of two statements, that comparison), never "roll back the file".
2. **Observe RED**, and read the failure: the case must fail *at the assertion that names the guarded behaviour*.
3. **Restore, then verify byte-identity** before recording anything: `cmp` the working file against `git show HEAD:<path>` (a `git checkout --` plus a `cmp` exit 0 is the usual form).
4. **Observe GREEN** on the committed tree, and state which build the run used.

**A red for the wrong reason is not evidence.** Three measured failure modes of the proof itself:

- *Revert too broad.* A whole-file rollback of the changed source also reverted a second, unrelated fix, so the fixture failed in an earlier setup assertion and the proof path under test was never reached. The fix is to restore only the function/statement pair in question plus its direct call sites, then re-run.
- *Tamper on the default path.* The case changed a value that the pre-fix writer already refused by default, so it asserted the untouched default branch. Supply the removed behavioural option (the test-boundary cast is acceptable where the option no longer exists on the type) so the tamper reaches exactly the widened path.
- *Fixture on the canonical slot.* Cases that seed the canonical key/ordering pass with or without the guard being tested. Seed the alias or legacy slot the guard is supposed to cover, and add one fixture per writer that has that guard.

**Assertions must discriminate the mechanism, not the symptom class.** An exit-code-only assertion is often order-insensitive: two different failure sources share the code, so the case stays green when the ordering it names is reverted. Assert the *refusal source* (the message or machine code produced by the intended guard), assert the input was not consumed (bytes captured before, re-read after), and add a **positive control** that gets past the guard and fails later for an unrelated, expected reason — the control is what rules out "the input was unusable anyway".

**Preservation claims need exact bytes, not substrings.** When a case's claim is "this artifact was left untouched", a `toContain(oldFragment)` assertion cannot distinguish "unchanged" from "rewritten elsewhere while keeping the old fragment" — the very partial-rewrite bug the case exists to catch passes. Capture the complete bytes (or their digest) **after the fixture is planted and before the operation**, then compare whole values. The iteration that found this demonstrated it rather than asserting it: with a one-byte mutation of the preserved artifact in place, the previous substring form **passed** while the captured-bytes form failed on the same bytes.

**Spend the discriminating leg.** In the flag-ordering case below, the "valid existing input" leg was *not* discriminating (both orderings refuse with the same message); the "missing input" leg is what goes red, and the positive control makes that red unambiguous. Say so in the case comment so a future reader does not delete the leg that carries the proof.

**Keep the test-only round honest.** A round that only strengthens cases must leave the source untouched: record `git status --porcelain` / `git diff --stat` showing 0 lines of non-test diff, and keep the existing case name and assertions while adding the discriminating leg.

## Why This Matters

A non-load-bearing case is worse than no case. It certifies the contract while pinning an adjacent surface, so the suite's green is read as evidence that the fix works when it is evidence about nothing — and the next change to the guarded behaviour ships without a red anywhere. The proof is cheap (one revert, one restore, one `cmp`) and it is the only thing that converts a green run into evidence.

## When to Apply

- Any fix whose acceptance names a regression case — in particular the Critical findings of a plan QC round.
- Any guard/lint that ships with a red-probe (corpus guard, drift guard, refusal-code guard).
- Cases written while a parallel slice is still changing the other half of the contract: a case can be valid at authoring time and stop discriminating after the merge, which is one of the defect classes a merged-state seam review is meant to catch (`workflow-patterns/merge-state-seam-review.md`).

## Examples

- *Ordering guard (CLI).* The case asserted `exitCode === 2` against a payload path that did not exist. With the guard reverted (payload read first) the run still exited 2 — from the missing-file error — so the case was green either way. Made load-bearing by writing a real, parseable payload file, covering both payload states × malformed tokens, asserting the flag's refusal message and that the file was not consumed, plus a positive control with the valid token that proceeds to a later, unrelated failure.
- *Behaviour widened then removed (engine writer).* The case tampered with lifecycle scalars but supplied no authority option, so the pre-fix writer refused it too. Made load-bearing by supplying the removed option at the test boundary and asserting the refusal code plus byte preservation.
- *Legacy-key guard (engine register helpers).* The existing cases seeded rows with the canonical `id`, so the pre-fix `id`-only guard passed as well. Made load-bearing by seeding the coordinated row with the legacy key only, once per writer, and asserting the ownership refusal plus unchanged register bytes.
- *Cross-domain preservation (engine + CLI).* A scenario claiming that leftover root-register / snapshot / session bytes are never promoted asserted `toContain` over the old fragment. Made load-bearing by capturing each planted artifact's complete bytes before the reads under test and comparing whole values, with a one-byte mutation proving the new form fails where the old one passed.
- *Invalid revert, recorded.* The whole-file rollback of the changed source was rejected as a proof because it also reverted a second fix; the valid revert was the proof path only (function body plus the two call sites that pass the pinned HEAD), and the restoration was `cmp`-verified against the commit before the green was recorded.

## Source

Iteration `iter-<plan-id>`, plan `<plan-id>`. Proof rounds are recorded in the plan's SDD bundle: the bounded test-hardening brief (`test-hardening-brief.md`) and the appended `## Verification round: test hardening` sections of `task-1-fix2-report.md` / `task-2-report.md`; the invalid whole-file revert and the valid proof-path-only revert are documented in the same fix report's integration-HEAD proof round. Related: `testing-patterns/mechanical-check-corpus-honesty.md` (red-probe for corpus guards — the same obligation applied to markdown-corpus lints).
