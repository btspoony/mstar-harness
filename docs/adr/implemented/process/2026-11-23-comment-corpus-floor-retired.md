# ADR: Retire the whole-tree comment corpus floor

Status: implemented — CI runs the changed-lines ratchet only, and the detector's behavior is pinned by its own lint CLI tests.
Date: 2026-11-23

Scope: `.github/workflows/ci.yml` (comment steps), `skills/mstar-coding-behavior/references/comments.md` § Gate steps and range, `references/comment-cleanup.md` § Measurement, and the command docs that described the two-step gate.

## Problem

CI carried a second comment step over the whole tree: it linted `packages/` and `scripts/` as corpora and asserted a per-root lower bound on the unclassified-comment count (12,790 and 800), the value recorded beside the measurement in `comments.md` § Gate steps and range.

The bound is meant as a collapse detector — a scanner that silently stops finding comments drops the count by orders of magnitude. In practice it cannot make that distinction. A genuine cleanup deletes comments, and the same run reports the deletion exactly as it reports a detector regression: a number below a floor. The two are not separable from the count alone, so every genuine cleanup had to lower a threshold in the same change, and the change policy otherwise restricts gate-threshold edits because a widened gate is not a fix. The result was a maintenance tax paid by the honest cleanup and by nothing else: the step never caught a comment defect the ratchet would have missed, because it asserted only a number.

The cost is concrete. The recorded baseline had to be re-measured and rewritten on each cleanup, twice on one commit (a CI and a developer-checkout measurement differed by a few dozen comments — an environment delta baked into a threshold), and the workflow carried a copy of the numbers the contract owned. A threshold that moves with the corpus and differs between environments is a drift surface, not a guardrail.

## Decision

CI runs one comment step: the ratchet (`mstar lint <file> --diff-base <ref>`), which resolves the merge base, keeps only the findings whose comment lines the diff touches, and fails them. Its base order (pull request base → merge-group base → push before → default-branch branch point) and its NUL-safe file selection are unchanged, and `scripts/comment-gate-select.sh` remains the single selection implementation shared with `packages/engine/test/comment-gate-pipeline.test.ts`.

No corpus count is asserted anywhere. A whole-tree run (`mstar lint <dir> --type code`) remains available and still fails an unbounded marker over the corpus; it is a local and review tool, not a CI threshold. The cleanup pass continues to report the measured `unclassified-comment net change` per root, quoted with the command and commit, as its own evidence — a report, never a gate.

Detector behavior is pinned by `packages/cli/test/lint-cli.test.ts` instead of by a count: unclassified detection and its stderr count line, `why:` acceptance, doc-block handling (an exported declaration's block is exempt, a local one is not), the `--diff-base` ratchet over added, untouched and interior-moved block lines. A detector or collector regression fails those assertions at the level where the behavior lives, and the corpus is free to move for any reason — a cleanup, a refactor, or a new package.

## Alternatives considered

- **Auto-derive the floor from the previous run.** Lost: a derived floor follows any drop, so it detects nothing; pinned to `HEAD~1` it fails the first legitimate cleanup instead. It also adds state (a stored count, its refresh job, its failure mode) to replace a check that was not earning its keep.
- **Re-measure per cleanup and lower the floor.** Lost: this is the status quo, and it is the tax the decision removes — a workflow edit and a contract edit for every honest deletion, on a threshold whose only signal is a number that a deletion also moves. It also keeps two copies of the measurement (workflow and contract) in sync by hand.
- **Keep the floor and add a re-measure script so the edit is mechanical.** Lost: mechanical or not, the edit still widens a gate in the same change as the artifact it exempts, which is exactly the self-approval shape the gate-surface policy exists to prevent; and the threshold still cannot separate the cases it was introduced for.
- **Promote the whole-tree step to the full rule set (fail every unclassified comment over the corpus).** Lost: that is the blanket ban this corpus rejects — it fails changes for comments they never touched and needs a bulk rewrite before any unrelated change can land.
- **Keep the whole-tree step but assert only the marker rules, with no count.** Lost: the ratchet already fails an unbounded marker on any changed line, and the corpus-wide marker sweep has never produced a finding the ratchet would miss; keeping the step would cost a full-tree lint per run for a signal already covered.

## Consequences

- A genuine cleanup needs no workflow edit: deleting comments lowers the count, and nothing fails. The contract no longer records measured baselines, so there is no number to drift out of date.
- A detector or collector regression that stops finding comments now fails `packages/cli/test/lint-cli.test.ts` rather than a CI count. That is narrower in reach — the test covers the rules it asserts, not every extension the collector walks — and broader in precision: it fails on the broken behavior, naming the rule, instead of on an unexplained number.
- The corpus-wide marker sweep is no longer a CI gate. A pre-existing unbounded marker in a file a change merely reads stays unfound by CI; when the change edits that marker's line, the ratchet fails it.
- The `comments.md` line ceiling (Guard 9) is unchanged: the gate section shrank, and no re-measured round-up is needed.

## Risks

- **A silent collector regression that the lint CLI tests do not model.** Borne by narrowing what the count ever proved: it proved "the scanner still found roughly this many", not "the scanner still finds this shape". Coverage for a new extension belongs in the lint CLI tests, next to the rules it feeds.
- **A change that deletes a whole subsystem's comments with no reviewer-visible signal.** Borne by the cleanup pass's measured net-change report, which states the per-root figures with the command and commit, and by the ratchet on the lines the change actually shaped.
