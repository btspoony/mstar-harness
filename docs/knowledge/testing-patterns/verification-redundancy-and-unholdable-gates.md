---
module: CI gates and test design (verification that costs more than it proves)
date: 2026-09-24
last_updated: 2026-11-08
problem_type: testing_pattern
category: testing-patterns
severity: high
applies_when:
  - "A new gate or test asserts equality against a recorded digest, hash or snapshot"
  - "A check fails only in CI and passes on every local checkout"
  - "A test re-derives a value that a producer already owns"
  - "A build prerequisite must be satisfied by more than one caller of the same check"
  - "A CI job fails and the temptation is to push another fix immediately"
tags:
  - ci-gates
  - unholdable-invariant
  - duplicate-rule-implementation
  - merge-commit-checkout
  - push-cadence
  - actionable-failure
---

# Verification that cannot hold: the redundancy anti-patterns

## Context

A delivery loop spent many CI rounds on gates that could never be green, or that proved nothing a producer did not already prove. Each individual decision looked reasonable; together they cost hours of wall clock and, worse, buried two real defects (an environment-derived artifact hash and an inode-reuse identity check) inside a stream of noise. This document records the anti-patterns and the rules that replace them.

## Guidance

1. **One home per deterministic rule — never re-implement the owner's check in a test.** A test that walks a tree, hashes entries and compares digests is a second implementation of a producer's rule; the two can disagree on the same data, and when they do, neither is authoritative. Call the owner's check (a `--check` mode, an exported validator) and let the failure message come from it. Duplicating the walk also doubles the surface that must be maintained when the format changes.

2. **Never pin environment-derived bytes as a cross-environment invariant.** A recorded hash is only evidence if the artifact is a pure function of its declared inputs. Two ambient inputs bit here: `process.env.NODE_ENV` inlined into a bundle, and the build's working directory (bundlers print module ids relative to the cwd). Even after both were made explicit, one artifact's bytes still differed by platform (Linux `4016da67…` vs macOS `3763e7c0…`, each reproducible in its own environment) — so a single cross-platform pin was impossible by construction. For an artifact whose bytes belong to its producer, prove provenance by **re-derivation** (shipped bytes equal a fresh build from the declared inputs) and keep the artifact out of any recorded byte closure, naming it there so the exclusion is explicit.

3. **A recorded digest checked against a pull request's tree is not a PR gate.** A `pull_request` run checks out the MERGE of the base into the head. Any advance of the base branch inside a recorded closure therefore makes the *branch's own* recording look stale, while `git status` reports clean (the working tree matches that merge commit) — a signature that reads like a hashing mystery and blocks PRs that changed nothing. Before deep-diving such a diff: compare the base branch's file against the branch's, and check whether the base advanced inside the changed closure. Either keep such checks off PRs (run them where the tree IS the commit), or compare within one commit.

4. **Batch local fixes; push once per settled wave.** Every push starts a full CI wave; pushing each intermediate state multiplies wall clock and produces partial results that are hard to attribute. Fix locally, verify locally, and push when the batch is coherent — and let the previous wave settle before the next push.

5. **Verify the owning surface, not a neighbouring one.** A change to one package's panel locale has nothing to do with the CLI suite; running unrelated suites burns minutes and teaches nothing. Map the change to its owner, run that, and state the mapping.

6. **Construct invalid states semantically, never by raw bytes or filesystem side effects.** Two fixtures failed only on Linux: one corrupted the first 4096 bytes of a SQLite file (a no-op when the content lives in the WAL), another relied on `rm` + `write` producing a new inode (ext4 reuses the freed inode). Both were platform behavior smuggled into an assertion. Remove a required table, truncate through an open descriptor, or otherwise express the state in the domain's own terms.

7. **Make a failure name the offending entry.** A digest mismatch that prints only two hashes is not actionable; printing the tree's entries (in full for small trees) is what finally located a drifting file. The evidence belongs in the failure message, at the single implementation, not in a test-side copy.

8. **When a step is skipped, replay it locally — but only that step.** Fail-fast hides every later step, so one failing job can conceal several defects; running the affected commands locally collapses the frontier. Running whole unrelated suites to "be safe" does the opposite.

9. **A prerequisite that several callers must satisfy by hand has no home — put it inside the command they call.** Three workflows each carried their own copy of the declaration-build chain a typecheck needs (`engine` → `judgment` → `commands` dists, all gitignored). One caller was updated when a package began importing another; the other two kept the old chain. No release was attempted for the next eighteen days, so nothing reported the drift — and when `Release prep` was finally run on 2026-10-14 it failed immediately on the missing `@mstar-harness/commands` declarations. The fix was not to repair the stale copies but to delete them: the prerequisite now lives inside `bun run typecheck` itself, so a caller cannot forget it. Duplicated prerequisites are the same defect as duplicated rules — the copies disagree silently, and only the copy that runs says anything at all.

10. **A package's inlined-bundle consumers are part of the changed surface.** Several packages are compiled INTO committed artifacts: the engine is inlined into `hooks/session-context.mjs` and `hooks/mstar-write-gate.mjs` by `bun run hooks:build`, and host bundles inline their own entry points. A source change in such a package therefore also changes a committed bundle, and the freshness gate compares the regenerated bundle against the committed one. Treat "who inlines this package?" as part of the change scope when writing a fix brief: name the regeneration step and the artifact in the verification list, or CI discovers it for you one round later. The dependency runs one way (artifact ← package), so a targeted unit run cannot catch it — only the bundle rebuild can.

11. **A literal-scan gate and the changelog that reports the removal cannot both be satisfied, and a fail-closed rewrite changes what an old probe means.**

    Two instances from one plan closing a design-system check chain:

    - A plan's Done criterion read "no `STRICT_*` / `PROTOTYPE_PANELS` name remains", scoped to the tree. The required changelog fragment must NAME the flags and exports it reports as removed, so the literal scan hits the release note while no code surface matches. The criterion was unholdable as written; the fix is to write the criterion in its real scope (`-- ':!.changes'`) rather than to strip the names out of the release note. When writing a "no X remains" criterion, decide up front whether the removal is *reported* somewhere the same scan covers, and scope the scan accordingly.
    - After the comparators became fail-closed (a missing baseline exits 1), an existing manual mutation harness that asserted "this check exits non-zero when the defect is present" now also passes when the baseline is simply unreadable — the same exit code means two different things. Changing a script's failure vocabulary means re-reading every probe that keys on its exit status; assert the message, not just the code.

## Why This Matters

- An unholdable invariant does not just fail; it teaches the team to ignore it. The cost is not the red run but the credibility of every other gate that shares the pipeline.
- Duplicated rules make failures unattributable: when two implementations disagree, the first hour goes into deciding which one is right.
- The two real defects in this round were found by reading code and by a targeted experiment — not by the gates that were failing. Noise is the enemy of that work.

## When to Apply

- Designing any gate, snapshot test or manifest check.
- Wiring a check into CI: decide explicitly which event's checkout it describes.
- The moment a check "fails only in CI": treat that as a statement about the checkout or the environment, not about the code, and look for an ambient input before looking for a bug.

## Examples

- **Duplicate rule**: a test re-derived a producer's tree digests; the producer's own `--check` was the only place that could report the real reason. Cutting the test-side copy removed ~230 lines and the disagreement.
- **Unholdable pin**: a shipped browser bundle was byte-pinned while its producer read `NODE_ENV` and the caller's cwd. Making those explicit fixed the environment dependence; the platform difference remained and is now handled by a re-derivation proof plus a recorded, named exclusion.
- **Merge-tree gate**: a manifest check failed on a PR whose branch was simply behind the base in one file; the fix was to merge the base and re-record, and to stop running that check on PRs at all.
- **Platform fixture**: an "uninventoriable store" fixture corrupted raw pages (a no-op under WAL) and passed locally while failing in CI; removing a required authority table made it deterministic everywhere.
- **Prerequisite drift**: a release workflow typechecked with only the engine built while CI built engine, judgment and commands; the absent `@mstar-harness/commands` declaration dist surfaced as `TS2307` plus an implicit-`any` cascade. Moving the chain into the shared command deleted three copies of it and the failure class with them.

- **Inlined bundle**: an engine source change (a binding read gaining one field) left `hooks/session-context.mjs` stale; every scoped test was green, and the freshness job failed after a full CI cycle. Adding "rebuild the inlined hooks bundle and commit it" to the wave brief's verification list makes it a pre-push step instead.

11. **A wall-clock sleep is not a synchronization primitive — and a fixture that owns the async seam can
   gate it deterministically.** A new suite synchronized six sites with `settleSeam = () => new
   Promise(resolve => setTimeout(resolve, 10))` ("one tick for the child's apply to resolve"). That is the
   retry anti-pattern wearing a different hat: it forbids the class in the constraints and then waits it out
   in the code, and on a loaded runner the assertion runs before the install lands. The replacement: the
   stub's `open` returns a `Promise.withResolvers()` gate the fixture settles, and the observable signal is
   the *product's own* install point (the seam is installed synchronously right after `table()`), so the
   test awaits real work rather than elapsed time. For a fire-and-forget durable write whose fake medium
   applies at call time, one microtask flush is deterministic; where the fixture owns the call, await the
   promise the production API already returns. When review asks a test to drop an assertion (a vacuous
   "the medium survives" on a no-op stub), replace it with the product read it duplicated — never delete
   coverage without naming the read that now covers it.

## Source

Phase-5 (PR merge-ready) loop of the execution-authority cutover iteration, 2026-09-23/24: the CI frontier advanced one step per push across ~13 rounds before these rules were applied; the two genuine defects it surfaced are recorded separately (the ledger identity check and the environment-derived artifact).

Added 2026-10-15 from the `Release prep` repair: guidance item 9 and its example come from a release pipeline that had been unable to typecheck since the CLI began importing the commands package, because only CI's copy of the prerequisite chain was updated.

Added 2026-10-20 from the dsh-channel adoption PR #541 waves: guidance item 10 and its example come from an engine change whose inlined hooks bundle was only discovered by the CI freshness gate.

Added 2026-11-08 from the skill ritual-trim wave: guidance items 12 and 13 come from the callout-marker collapse (one scanner left behind, passing on zero hits) and from the QC round that reviewed a checkout the coordinator was still advancing.

Added 2026-10-23 from the dsh issue-sweep iteration: guidance item 11 and its example come from a new
durable-persistence suite that used a fixed 10 ms timer to wait out an asynchronous plugin apply; the
implementation's own install point plus a fixture-owned `Promise.withResolvers` gate replaced it.

12. **A guard that finds its subject by a literal must move with that literal — or it silently checks nothing.** Three separate scanners located "engine-check callouts" by the same string: the drift-lint citation guard, its duplicate-body guard, and the standalone smoke. Collapsing 46 callouts to a new form renamed the marker in the text and in one scanner; the other scanner kept the retired literal, matched zero callouts and exited 0 — a green guard over an empty subject. The fix is structural, not textual: extract the literal into one dependency-free module both scanners import, and make the assertion refuse a zero-match run, so a rename either updates every consumer or fails loudly. The same shape applies to any "is there one of these, and is it well formed" check: assert the population is non-empty before asserting properties of the population.
13. **A shared review checkout is not a frozen snapshot.** Three QC seats reviewed a range on a checkout the coordinator kept using; a merge landed mid-round, so the seats' `file:line` evidence pointed at different commits than the declared range and one seat correctly refused to approve. Freeze the reviewed commit before dispatching seats, do all bookkeeping outside the reviewed checkout, and state the frozen SHA in the assignment. If the tree must advance, re-declare the range and re-review the delta — do not let two seats read two commits under one range label.
