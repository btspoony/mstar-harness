---
name: mstar-design-system
description: Use when an implementation must be walked into alignment with an existing baseline — a prototype, a design export, an existing product's markup, or a written design contract — and each difference has to be judged as defect, decision, or phantom. Not for designing from nothing, and not for authoring or auditing `DESIGN.md` itself (that is `mstar-design-md`).
---

## Load Order

**Before the first Read of this skill: Read `mstar-harness-core` (SKILL.md)** — lifecycle, authorization, and conflict authority. The design contract, when the baseline *is* a written contract, is owned by `mstar-design-md`; this skill assumes an authoritative baseline exists and never restates that contract's rules.

| Also Read | When |
|-----------|------|
| `mstar-design-md` | any difference touches tokens, completeness levels, light/dark, or the baseline-vs-document authority rule |
| `mstar-coding-behavior` | the round ends in code changes rather than document changes |

On conflict, **`mstar-harness-core` wins**; on a design-contract question, `mstar-design-md` wins.

## Scope

In scope: an authority already exists and an implementation has to be converged onto it — locating and making the baseline readable, deriving the machine-readable fixture, measuring parity per layer, triaging each difference, closing it in one direction, and reporting what was actually compared.

| Out of scope | Where it belongs |
|--------------|------------------|
| Designing a system where no baseline exists | not this skill — decide the contract first |
| `DESIGN.md` sections, token naming, completeness levels, light/dark rules | `mstar-design-md` |
| Prototype-vs-document authority and its one-directional sync | `mstar-design-md` § Prototype vs document — read it there; this skill only applies it |
| The comparators, CI jobs, and generators of a specific repository | that repository's own checks |

## Workflow

1. **Baseline** — name the authority: its kind, its location, whether it is readable and tracked, and what was redacted before it was committed. No baseline → stop, this skill does not apply.
2. **Machine** — derive what can be derived instead of typing it: fixture, snapshot, extraction. Record the regeneration command *and* its check mode in the same place.
3. **Parity** — compare per layer: structure, appearance, behaviour. Every finding carries the count it was measured on; a probe that matched nothing says so instead of reporting zero defects.
4. **Triage** — classify every difference as defect, decision, or phantom. A decision is written into the contract record with its reason, never silently into the implementation.
5. **Close** — change the implementation, or amend the baseline when triage recorded a decision. The fixture is regenerated, never hand-edited.
6. **Evidence** — return what `## Evidence` below describes; a verdict without its counts is not one.

## Decision Rules

1. **A baseline that is not in the repository is not a baseline.** Tracked, redacted, and read by the comparators. A baseline in a chat transcript, a screenshot, or a gitignored working directory cannot be converged onto — convert it into a tracked file first, or state that the round has no baseline.
2. **A baseline that no CI job reads is also not a baseline.** Committing closes one of three links: committed → every comparator points at it and strict mode is the default → a CI job actually calls it. Never declare a check live before all three close; a fixture only a human runs is documentation.
3. **Generated artifacts are never hand-edited.** Which artifact wins and which direction the sync runs is `mstar-design-md`'s rule — this skill applies it, it does not restate it.
4. **Do not invent the baseline.** No rounding a source value, no adding a component the source does not define, no drawing an asset it does not ship, no inference from an unreadable source. Silence in the baseline is a decision, recorded with its reason.
5. **A check that cannot say what it covered did not pass.** Empty probe ≠ zero overflow. Every verdict names the count it compared — **including the failure path**: "baseline missing" must also state how much was owed, or it reads as a pass at exit 0.

## Evidence

A finished round returns three things:

- **The classified list** — every difference labelled defect / decision / phantom, with the unit it belongs to; a decision also names where it was recorded.
- **The coverage statement** — counts compared per layer, plus what was skipped and why. "Everything matches" without a count is not a coverage statement.
- **The strict-mode run** — the comparator invoked with failure fatal, output pasted as run, not summarized.

A screenshot, a rendered page, or a green check with no count is not evidence for any of the three.

## References

| When | Open |
|------|------|
| choosing a baseline kind, making it machine-readable, closing the three-link chain, redacting before committing | `references/baseline.md` |
| comparing structure / appearance / behaviour, choosing a measurement, the `@media` vs `@container` trap | `references/parity.md` |
| classifying a difference, recording a decision, checking a suspected finding against the phantom catalogue | `references/triage.md` |
| the normative design contract, token rules, completeness levels, baseline-vs-document authority | `mstar-design-md` |
