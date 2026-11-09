# ADR: PR review scoring uses diminishing deductions, and the band never changes the verdict

Status: implemented — the score grades finding load with class caps; the count-driven verdict remains the merge signal.

Date: 2026-10-10

Scope: `computePrTally`, the score band helper, report validation, and every surface that renders a PR review score.

## Problem

The linear score (`100 − 40·must_fix − 15·should_fix − 3·nit − 10·unverified`, floor 0) collapsed on moderate finding counts: a handful of should-fix findings drove a review toward zero even though none blocked the merge. `unverified` had no cap, so a large unverified set could dominate the score. The posted report also labeled the finding-count-derived number "Confidence", which described a statistical confidence the score does not measure.

## Decision

- The verdict stays count-driven and unchanged: any must-fix is blocked; otherwise any should-fix is needs-fixes; otherwise ship-it. Score and band never change the verdict.
- Deductions diminish per finding within a class, with class caps:
  - must-fix: 45 for the first, 15 for each additional, no cap;
  - should-fix: `max(12 − 3·(n−1), 2)` — 12, 9, 6, 3, 2, 2, …;
  - nit: 2 for the first, 1 for each additional, capped at 8;
  - unverified: 5 each, capped at 15.
- `score_pct = max(0, 100 − Σ deductions)`, an integer floor at 0.
- Bands are a display annotation over the score: mergeable ≥ 90, good 80–89, pass 60–79, fail < 60. They render wherever the score renders. A count-derived verdict and a band may disagree — for example ship-it with a good band — because the band grades finding load while the verdict governs mergeability.
- One shared deduction helper is the only implementation; `computePrTally` and report validation both delegate to it.
- The frontmatter schema keeps `score_pct` only; the band is derivable. In the review envelope, `tally.band` is optional: absence is legacy-valid, presence must be a valid band token.
- The report heading uses "Score", not "Confidence". The per-finding evidence field named "Confidence" is a different concept and stays unchanged.

## Alternatives considered

- **Keep the linear schedule.** Rejected: it conflates finding count with severity of consequence and makes moderate review loads indistinguishable from blocked work.
- **Cap only `unverified`.** Rejected: it leaves the must-fix/should-fix collapse untouched.
- **Let the band drive the verdict.** Rejected: a display annotation would become a second merge authority and could contradict the count rule.
- **Rename "Confidence" only.** Rejected: the label was wrong because the score was wrong for its use; renaming alone would keep the collapse.
- **Make `tally.band` required.** Rejected: it would invalidate existing reports for a derived, display-only value.

## Consequences

- Nits and unverified findings alone can never drop the score below 77, so a review with no must-fix or should-fix cannot enter the fail band.
- The property is enforced by the shared helper and its calibration rows, not by each renderer.
- Any future schedule change updates one helper and its tables; renderers and the envelope stay unchanged.
- The score remains a finding-load grade, not a probability. Reports must not describe it as confidence.
