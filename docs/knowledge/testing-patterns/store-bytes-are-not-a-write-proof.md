---
module: packages/engine populated-store recovery fixtures + the SQLite execution store
date: 2026-09-23
problem_type: testing_pattern
category: testing-patterns
severity: high
plan_id: "20260921-execution-consumer-readiness"
applies_when:
  - "Asserting that a refused operation wrote nothing to a WAL-mode SQLite store"
  - "Choosing the observable for a no-write or artifact-unchanged claim"
  - "One assertion keeps failing intermittently inside an otherwise green suite"
tags:
  - wal-mode
  - sqlite
  - refusal-assertion
  - flaky-test
  - logical-state
  - regression-honesty
---

# A refused write into a WAL store is proven by logical state, not by store-file bytes

## Context

The populated-store recovery fixture in plan `20260921-execution-consumer-readiness` proved "the refused preview wrote nothing" by hashing the main `store.db` file before and after the refusal. Two refusal assertions in the populated fixture and two in the recovery suites used that form, and one recorded run showed 8 pass / 0 fail, which the plan carried as acceptance evidence.

That single run was not stable. A re-measurement taken during plan QC observed 6–7 pass with 1–2 failures across twelve runs, always in the same assertions. The cause is a runtime property of SQLite in WAL mode: the checkpoint that folds the journal into the main database file, and the removal of the now-empty `-wal`/`-shm` sidecars, happens when the **last connection handle is collected** — not at `close()`. So a store file can be rewritten between the two hashes with no engine write at all. The assertion was not wrong about the engine; it was asserting a proposition the runtime does not guarantee.

## Guidance

**Assert the contract, not the file.** "Nothing was written" on a store backed by the execution authority means *logical state unchanged*, so compare what the engine's own reader observes across the refusal:

```ts
// Before — the refusal is "proven" by bytes the runtime may rewrite on its own
const before = createHash("sha256").update(readFileSync(storePath)).digest("hex");
expect(() => previewExecutionRestore(context, request)).toThrow(/refused/);
expect(createHash("sha256").update(readFileSync(storePath)).digest("hex")).toBe(before);

// After — the refusal is proven on the state the store actually serves
const before = readExecutionState(context);          // CAS token + epoch
expect(() => previewExecutionRestore(context, request)).toThrow(/refused/);
const after = readExecutionState(context);
expect(after.casToken).toBe(before.casToken);
expect(after.epoch).toBe(before.epoch);
```

Byte equality stays correct for artifacts the runtime does **not** rewrite on its own — in the same plan, the `VACUUM INTO` backup image and plain-file retained bodies kept their whole-bytes comparisons, and those assertions were retained. The rule is per-artifact: name the mechanism that may change the bytes first, then pick the observable.

Two supporting disciplines come from the same episode:

- **One green run is not evidence of a stable fixture.** A count that matters is a repeated measurement (the plan settled on ten owner runs plus three coordinator runs). Where a suite mutates shared state, run it several times and record the range, not one sample.
- **A flaky assertion is a defect in the assertion.** The repair was on the assertion side — no retry, no quarantine, no isolation-shaped pass — and the suite then measured stable across runs.

## Why This Matters

A byte-as-proof assertion fails in both directions of credibility. Intermittently it fails *red* for a reason unrelated to the change, which costs a fix round and teaches future readers to treat the suite as noisy. And even when it passes it binds a shape (the exact bytes of a file the runtime may rewrite) rather than the contract the refusal is supposed to defend, so the next legitimate runtime-side rewrite breaks it again. The same confusion — "the artifact looks unchanged" read as "the operation refused" — is what `testing-patterns/load-bearing-regression-proof.md` calls out from the opposite side: the assertion must discriminate the mechanism the case names, which is here the engine's refusal, not a filesystem side effect of garbage collection.

## When to Apply

- Any no-write refusal assertion against `{HARNESS_DIR}/store.db`, or any other SQLite artifact, while the store is in WAL mode.
- Choosing the observable for "unchanged" claims in general: name the writer that could change the artifact before comparing bytes.
- When a suite is intermittently red in a way that clusters on one assertion — suspect the assertion's assumption before the code under test.
- Reusing a recorded green as acceptance evidence: check how many times the count was measured, and what the assertion compared.

## Examples

### Before

`expect(readFileSync(storePath)).toEqual(beforeBytes)` across a refusal — quiesced-WAL stores take a long-lived GC-dependent window in which the main file is rewritten and both sidecars disappear, with no engine write.

### After

`readExecutionState(context)` before and after the refusal, asserting the CAS token and epoch are identical, plus a non-WAL control (the `VACUUM INTO` image) whose bytes are legitimately compared; the populated fixture then ran stable across repeated executions.

## Source

Iteration `iter-20260921-execution-2b-cutover`, plan `20260921-execution-consumer-readiness`. Evidence: the plan QC consolidated and the L4 QA report in `{SDD_DIR}/review/` for that plan (the flakiness measurement, the assertion rewrite, and the retained non-WAL byte comparisons), and `{SDD_DIR}/review/qa.md` for the repeated stability runs. Related: `testing-patterns/load-bearing-regression-proof.md`, `testing-patterns/mechanical-check-corpus-honesty.md`.
