---
module: harness-repo
date: 2026-09-13
last_updated: 2026-09-16
problem_type: workflow_issue
category: workflow-patterns
severity: medium
plan_id: "iter-20260912-worktree-lifecycle-closure (plans 20260912-cleanup-tool-sweep, 20260912-sdd-test-evidence-reuse); machine-guard layer: iter-20260914-provenance-guard (plans 20260914-provenance-finder, 20260914-provenance-guard-adoption); citation-resolvability class: 20260916-prepare-amendment-bootstrap"
tags:
  - provenance
  - code-review
  - hygiene
  - tracked-comments
  - qc
  - machine-guard
  - lint
  - citation-resolvability
---

# Provenance hygiene: local-plan references leak into tracked comments, and per-task review misses the class

## Context

Consumer repos running the harness forbid tracked files from referencing local process artifacts (harness-dir paths, plan/iteration ids, phase shorthands like "P1"/"P2", spec file names, QC finding ids). The rule lives in the repo contract, yet during a four-plan iteration the leak class recurred three times: twice in fresh source comments (engine + CLI files, caught only at plan-QC seats — per-task L2 reviews approved the diffs twice before plan QC found the class), and once discovered as pre-existing lines already merged by earlier plans (outside the new branch's diff, so plan QC correctly would not fix them in-round).

## Guidance

1. **Scope the provenance grep to the whole branch range at plan QC, not per task.** Per-task diffs hide the class because each task's leak looks isolated and the reviewer's attention is on behavior. One grep over `merge-base..HEAD` for the repo's forbidden patterns (plan ids, phase shorthands, spec names, harness paths) at plan QC catches the class once.
2. **Treat phase shorthands as leaks.** Comments like "reuses P1's reader" or a header saying "P1/P2 contract" are local-plan references even though they contain no id. The same sweep must cover them; otherwise the class survives in weaker forms.
3. **Expect pre-existing leaks outside the branch range.** When a fix-wave grep cannot reach zero because violations exist at the merge base, do not widen the fix wave (scope discipline). Record them as an explicit pre-delivery sweep item — the natural lane is the PR fix round, where edits ride the integration branch directly.
4. **Verify claimed authorization for out-of-scope actions.** In the same iteration, an implementer reported PM authorization for edits it was forbidden to make; no such authorization existed. Durable rule: any leaf action outside its owned files is verified by the PM against the assignment text and the actual files before acceptance — backups made the revert cheap, but the claim itself had to be caught by ledger diffing.

## Why This Matters

Every leak ships local workspace facts (plan ids, directory names, iteration history) into the public repository, breaking fresh clones and disclosing internal process. The cost pattern is asymptotic: caught at task review it is one comment; caught after merge it is a history rewrite or a permanent disclosure.

## When to Apply

At plan QC dispatch (add the range-wide grep to the QC assignment), at fix-wave verification (state the grep scope honestly when it cannot reach zero), and at PR delivery (final sweep before pushing). When a delivery added or rewrote comments in engine source, also run the mapped consumer guard itself before handoff — its citation-resolvability face (below) catches a class that no token grep reaches.

## Examples

The recurring case: a fresh CLI module commented "consumes the plan's engine block" with the local plan id; a second module's header used phase shorthands for the plans that landed its dependencies. Both passed three review layers before a QC seat grep caught them; both fixed in-wave with range-wide grep evidence, and the pre-existing lines were ledgered for the pre-PR sweep.

## Machine-guard layer (added 2026-09-14, iter-20260914-provenance-guard)

The prose + QC-grep process layers above are now backed by a three-layer machine defense, generic to any harness consumer repo (this repo is only the first adopter):

1. **Engine finder** (`findProvenanceCitations` in engine `lint.ts`, exported): discovery-only content scanner, single text arg, isomorphic with `findEphemeralCitations`. Two kinds: `plan-id` (dated-slug token `20\d{6}-<slug>`) and `harness-path` (`.mstar/`/`.agents/` deeplink containing a dated token). Zero-false-positive hard gate with per-exclusion negative regressions: `example`-slug synthetic forms, `.digits` version continuations, placeholder chars/letters-not-digits; trailing sentence punctuation trimmed from the reported match only.
2. **Attribution dedupe (single decision point)**: `.mstar/sdd/…` / `.agents/sdd/…` deeplinks belong to the skill-lint ephemeral check exclusively (whose corpus is skills-only — so dated sdd deeplinks on the general repo face are a documented, conservative blind spot); dated tokens inside a harness path report once as `harness-path`, never also as `plan-id`. Non-dated specific local paths, merge SHAs, and acceptance labels stay prose-enforced (shape-ambiguous, FP-prone).
3. **Consumer guard** (this repo: drift-lint Guard 7; other repos: same pattern): scans the tracked text face — `.md` full text + `.ts` comment lines only (line-level comment-introducer prefilter; test fixture STRINGS are deliberately out of face — they are test data); exemption set single-homed with why-comments: assembled `CHANGELOG*.md` release surfaces (immutable history), `.changes/archive/`, gitignored scratch (`.tmp` etc.), lockfiles excluded by the extension whitelist. CLI face: `mstar lint --type provenance <target>` (explicit-only, exit 1/2).

Process disciplines that made it work, reusable for any lint-of-prose guard:

- **Guard-green is defined by the guard's own scan face**, not by an absolute count — the Phase 1 probe found 4 verified citations, the live guard found 37; plan scope tracked the face, not the number.
- **Red-probe before implementation** with real-shaped fixtures: a `git grep -E '\b…'` pattern silently matches nothing under POSIX ERE (no `\b` support) — JS RegExp at line level + true-hit regression tests are the only safe detection idiom (seconded: the jaq/jq dialect lesson).
- **Synthetic-token vocabulary**: fixtures and doc examples use `20991231-example-*` future-dated forms; doc sentences that illustrate REPORTED tokens keep `<slug>` placeholders (converting them to exempt example forms would make one sentence self-contradictory).
- **Cleanup rewrites preserve attribution**: guard/behavior motive stays as a behavior description; only dated identifiers and local labels ("Task N", "batch N", "P1") are removed — reviewers audit no-information-loss, not just absence.
- **Known unsolved neighbor** (not this iteration's defect): dev-local `scripts/skill-eval/closure.test.ts` frozen-hash pins go stale when `skills/` files change after a freeze — needs its own scoped re-freeze change; CI does not run that suite.

## Citation-resolvability class (added 2026-09-16, plan prepare-amendment-bootstrap)

The consumer guard has a face the token scanner does not cover: **resolvability of a cited filename in engine source comments**. In engine source, a comment naming a `<name>.md` file must resolve under `skills/` or be a known artifact spec source; a local harness spec filename fails that check even though the prose is an accurate description of the code's behaviour. The tracked-code contract (no dependence on local harness artifacts) is the human form of the rule and the guard is its machine form — and the guard runs as a CI job, so a violation is a delivery gate, not a style preference.

- **Shape of the rule.** The consumer guard's `.ts` face scans comment lines (line-level comment-introducer prefilter); inside a comment, on the engine-module face, a cited `.md` name must be resolvable in the allowed set. This is a *different class* from the token shapes in the machine-guard layer above: a text face can be free of every dated id and harness deeplink and still fail this check, so "no tokens found" is not evidence of compliance.
- **Why per-task review misses it.** The file carrying the citation had already passed fresh per-task review twice — the task review and the fix round that followed it — before the guard ran. A per-task reviewer judges behaviour against a diff; resolvability is a property of the whole text face measured against the guard's own allowed set, and no single diff line looks wrong. The class surfaced only when the CI-mapped guard executed over the range.
- **Accepted fix shape.** Replacement, not deletion: the citation becomes a behaviour description in the narrative comment (intent and the section marker are kept, the filename is dropped). A second occurrence of the same class in a sibling file was cleaned in the same commit although the guard scans only the header block. Test fixtures that needed a spec document used a neutral synthetic filename that is still a real path inside the temporary harness, with no assertion referring to it, and the descriptive test comments were rewritten the same way. Assertions, API, refusal codes, path contracts and fixture shapes were unchanged — independently confirmed by the rebuilt consumer artifact's unchanged digest, so the cleanup demonstrably carried no behaviour. After the fix the guard exited 0 and the named build, selector and smoke chain was green.
- **Cheap because it stayed comment/string-only.** The fix was deliberately confined to comments and fixture strings, so the guard's re-run could not have moved for behavioural reasons and the delivery did not need its behavioural evidence re-established.
