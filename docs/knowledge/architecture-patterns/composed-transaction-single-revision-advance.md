---
module: engine transaction boundary (execution-store, execution-coordination, execution-registration, catalog, issue)
date: 2026-09-21
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: 20260920-consumer-surfaces-catalog
applies_when:
  - "composing two domains' writes into one transaction on the DB authority"
  - "a helper that used to own its own transaction is called from inside a larger one"
  - "a spec says a multi-domain transaction advances a shared revision once"
tags:
  - transactions
  - revision-arithmetic
  - composed-writes
  - authority
last_updated: 2026-09-21
---

# One accepted transaction advances the shared revision once — make composed helpers participate, never bump

## Context

The execution-authority cutover composes several domains into single SQLite transactions: a plan mutation with catalog rows, a registration with a workflow graph, a residual operation with issue rows and links. Each domain already had its own revision counter, and the helpers that mutate it were written when each owned its own transaction. Under composition the naive call graph advances the shared `store_meta.revision` **once per helper call** — and primary spec §3.1 requires **one** advance per accepted multi-domain transaction.

This produced Critical findings in two independent tasks of the same iteration (`W3` issue/residual composition, `S1` catalog/execution registration), both with the same root cause and the same fix. It is worth stating once, as a rule.

## Guidance

- **Name the owner of the advance.** The enclosing transaction owns it; composed helpers participate. Implement it as an explicit caller-owned handle threaded into the helper (`ComposedTransactionRevision` for issues, `ComposedStoreRevision` for catalog) rather than as a module-level flag, a "already bumped" boolean, or a second counter.
- **Keep the public verb unchanged.** A public one-transaction helper called directly still bumps the counter itself. The optional handle is the *only* difference between the two callers — no behaviour change, no signature change for existing callers.
- **Prefer an optional parameter over a field on the authorization struct.** One attempt put the handle on the object that public calls also construct, which would have let a crafted public call suppress its own advance at runtime. A parameter cannot be reached that way.
- **Read back the revision the transaction actually produced** when the caller needs it for a receipt or a token — do not re-derive it from a pre-transaction snapshot. A receipt that reports a pre-advance revision is not a witness of the committed change, and a same-id replay then returns a stale token while a fresh read observes the new one (a separate Critical in the same iteration, in terminal workflow close).
- **Check the arithmetic on the no-op and replay branches too.** A retry with a fresh operation id that returns the unchanged row still consumed revisions elsewhere; a first accepted no-op that returns the pre-advance token violates the same rule as an over-bumping helper. Decide explicitly whether a no-op is "an accepted operation" (advance once, witness it) or "exact replay" (advance none, record nothing) — and assert the choice.
- **Assert deltas, not values.** The regression that catches this class is `revision_after − revision_before === 1` for one accepted multi-domain transaction, `=== 0` for an exact replay, and a token-difference assertion (`returned.token !== pre_token`) plus a rejection of the pre-token afterwards. Value assertions (`=== 2`) are what let the defect ship: they pin whatever the implementation happened to produce.

## Why This Matters

The revision counter *is* the CAS token basis. Over-bumping is not merely wasteful: it invalidates tokens a caller legitimately holds, so a correct caller's next operation fails while the operation that over-bumped appears to succeed. Under-bumping is worse — it lets a caller submit a second mutation with a token that should have been consumed. Both directions were found by review, not by tests, because the tests asserted values rather than deltas.

## When to Apply

Any composed write on the DB authority; any helper whose callers change from "owns a transaction" to "called inside a larger transaction"; any new domain added to an existing composed transaction; any receipt/token that is supposed to witness a revision advance.

## Examples

- `W3` (fix round): the DB residual path advanced the shared revision once per composed issue helper. Fix: `ComposedTransactionRevision{committedStoreRevision}` threaded as an optional 4th parameter into `captureIssueOn` / `linkIssueOn` / `closeIssueOn`, which join the caller's single advance; public verbs keep 3 args and their own bump.
- `S1` (fix round): one registration advanced `store_revision` once in execution creation plus once per catalog row (`+2`, `+5` in the implementer's own red evidence). Fix: `ComposedStoreRevision` + `bumpCatalogRevisions(db, composed?)`, with the enclosing frame performing the single advance and passing the produced revision to every catalog write.
- Terminal workflow close (same iteration, separate finding): the receipt was built from the pre-advance metadata, so it stored a stale root revision and `updated_at`; fixed by re-reading `execution_meta` on the caller's own handle after the membership write.
