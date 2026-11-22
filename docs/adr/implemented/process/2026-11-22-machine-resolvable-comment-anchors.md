# ADR: Comment shapes require a machine-resolvable anchor
Status: implemented — the gate, the cleanup pass and the corpus migration landed in one change
Date: 2026-11-22
Scope: comment gate (`mstar lint --type code`), comment cleanup pass, comment corpus

## Problem

The comment gate accepted a "declared prefix" — `why:`, `invariant:`, `safety:` or `note:` — as a shape. The prefix asserted that the comment states a fact, but nothing checked the assertion, so it became the cheapest way to pass the gate. A cleanup pass over an existing corpus then had no reason to delete anything: relabelling an unprovable comment satisfied both the gate and the pass, and a batch could report a clean result while every comment stayed.

The cost is measurable. A classification batch on a release line added hundreds of `note:` lines in one commit and described the commit as giving every touched comment "one declared shape". The corpus count moved because the pass reshaped comments, not because it removed them, and the close-out metric mixed deletion with relabelling. A reader still had to trust prose that the code could contradict.

No file-based check can decide whether prose states a true fact. What a check can decide is whether a comment points at something that resolves at HEAD.

## Decision

A non-documentation comment survives only when it carries a machine-resolvable anchor, in one of four shapes:

1. A bounded marker (`simplify:`, `shortcut:`, `temporary:`) with its bound.
2. A contract pointer to a resolvable repository path (`docs/`, `skills/`, `packages/`, `scripts/`), an `ADR-<n>` record under `docs/adr/`, or a URL.
3. `@generated`.
4. A `TODO`/`FIXME` with a tracking reference that opens the comment content.

A natural-language rationale is not a shape. `why:`, `invariant:`, `safety:` and `note:` are no longer accepted: they name a kind of statement without proving it, and the gate cannot tell a fact from a restatement. `plans/`, `#<n>`, `issue <n>` and `contract §` are no longer pointer shapes either, because the linter cannot resolve them; a reason worth keeping moves to an ADR, spec or docs page and the comment keeps only the `see` pointer.

The cleanup pass deletes or points, never relabels. A comment with no resolvable anchor is a deletion target; a batch that only adds or rewrites prefixes is rejected at acceptance, and its close-out reports the added-prefix count, which must be zero. The existing natural-language corpus is the deletion backlog, worked one path or subsystem per PR, with the measured `unclassified comments: <n>` count as progress; issue capture owns durable tracking, so no separate backlog file is introduced.

## Alternatives considered

- **Keep `note:` and constrain only the cleanup pass.** Rejected: `note:` remains an untyped declaration that every other entry point can still use, so the gate keeps certifying prose it cannot check.
- **Remove only `note:`, keep `why:`/`invariant:`/`safety:`.** Rejected: the removed prefix was the most convenient one, not the only unprovable one. A narrower list would move the relabelling to `why:` without changing the evidence.
- **Keep all prefixes and review prose quality by hand.** Rejected: review already carries that duty, and the measured relabelling shows it does not hold at corpus scale. A rule a check cannot enforce is not a gate.
- **Ban comments outright.** Rejected: it deletes the contract pointer that keeps one rule in one place, the bounded marker that records a ceiling, and the `@generated` warning that prevents an edit. Those are exactly the anchors that do resolve.
- **Require every comment to carry a pointer.** Rejected as too strong for the bounded marker and the tracked TODO, which resolve through their bound or their tracking entry rather than an external document.

## Consequences

The advisory corpus count can rise when this lands, because `#<n>`, `plans/…`, `issue <n>` and `contract §` stop counting as shapes. That rise is the backlog becoming visible, not a detector regression; the per-root floor stays a lower bound and the ratchet still judges only changed lines.

Every change that touches a line carrying an unprovable comment must delete it or give it a resolvable anchor, because the ratchet reads changed lines. The migration is incremental by construction: one path or subsystem per PR, measured before and after, with no bulk rewrite implied.

Two boundary facts are recorded rather than hidden. A marker's `upgrade:` clause is a condition a reader evaluates, and a tracking reference such as `plans/<file>` is not resolved by the linter, so marker boundedness stays a review duty. A URL pointer is not fetched, so its target is verified by review when the claim matters. Both remain review obligations that this record does not claim to automate.

The 4.7.2 comment-classification record and its archive entry describe the superseded shape list; they stay as history. Records in another release line that still carry the old prefixes become backlog when that line reaches this gate, not part of this change.
