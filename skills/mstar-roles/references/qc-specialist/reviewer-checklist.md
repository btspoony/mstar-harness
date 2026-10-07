# QC Reviewer Checklist

Extension of `references/qc-specialist-shared.md`. Use during step 5 of `reviewer-workflow.md`.

Apply only affected items by **reading the assigned changed diff and directly related source** — do not run project test/build/lint suites to tick these boxes (see `reviewer-workflow.md`).

## Code quality

- [ ] Naming is clear and consistent.
- [ ] Responsibilities are not overly mixed.
- [ ] Error handling is explicit and actionable.
- [ ] Comments explain intent, not trivial implementation noise.

## Security and correctness

- [ ] Inputs are validated; boundary checks are explicit.
- [ ] No obvious injection, path traversal, or permission issues.
- [ ] Sensitive data is handled appropriately.
- [ ] Invariants and state transitions are coherent.
- [ ] LLM/Agent boundary: untrusted input does not drive privileged ops; prompt-injection surfaces identified.

## Performance and reliability

- [ ] Hot paths avoid avoidable overhead.
- [ ] Resource lifecycles are correct.
- [ ] Unbounded operations are addressed.
- [ ] Degradation and failure behavior is observable.

## Maintainability

- [ ] Contracts and interfaces remain understandable.
- [ ] New dependencies are justified.
- [ ] Breaking changes include migration guidance.
- [ ] Reuse preferred over duplicate logic.

## Evidence and planning attribution (affected changes only)

- [ ] Independently assess whether changed executable behavior has meaningful consumer-visible test coverage or invariant/boundary/regression evidence; accept applicable existing L1/L2 evidence, without running tests or requiring a new test for each edit.
- [ ] Keep product-behaviour assertions and fails-first regression defences; flag incidental / source-shape / wiring / environment-constant assertions (wording/source-shape pins, forwarding echoes, duplicated producer checks, environment-dependent bytes) for deletion — deleted, never renamed or re-pinned. Report the non-product-assertion class and conclude "delete, or replace with a product-behaviour assertion". PR #280 counter-examples: manifest parity guard, platform build-byte pins, raw-SQLite fixture, test-only header regression; judge assertions against production-owner contracts, not names. Docs/policy changes use scoped static or before/after evidence, not prose tests (`mstar-coding-behavior` § Evidence).
- [ ] For touched delivery compass, plan, spec, or knowledge documents, verify local edit attribution includes seat, model, ISO-8601 timestamp, and iteration; `unknown` is valid for an unavailable model ID, not a reason to infer it from this reviewer session.

## High-risk ops (when Assignment marks high-risk)

Applies to migrations, prod config, destructive data ops, cert rotation, shared-env scripts, etc.

- [ ] Impact scope and maintenance window (or user impact) documented.
- [ ] Rollback steps are executable and reviewed.
- [ ] Backup/snapshot or equivalent recovery confirmed (if applicable).
- [ ] Change and verification steps are auditable (commands, pipeline, runbook — not a black box).
- [ ] Application code changes still follow default dev gates — not skipped as “ops only.”
