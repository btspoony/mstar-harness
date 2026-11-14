---
module: Store tests reading a closed SQLite store under a newer Bun
date: 2026-11-14
last_updated: 2026-11-14
problem_type: test_failure
category: test-failures
severity: low
plan_id: <plan-id>
symptoms:
  - "`bun test packages/engine/src/store-db.test.ts` reports `unable to open database file` on a read-only open that passes under the CI-pinned interpreter"
  - "The failures cluster on cases that open an existing store file read-only after a clean close"
  - "The same file opens fine when the harness opens it through its own read path"
root_cause: "A clean close leaves the WAL header in place with no `-wal` sibling. `node:sqlite` creates that journal itself on a read-only open; Bun refuses the open instead. The product read path already prepares the journal, so only raw test-support opens see the difference."
resolution_type: code_fix
applies_when:
  - "A test opens a store file read-only with a raw driver instead of the product read path"
  - "A local red disappears under the CI-pinned interpreter without any source difference"
  - "Writing a test helper that must read a store left behind by another process"
tags:
  - sqlite
  - wal
  - bun
  - read-only
  - store-tests
  - interpreter-drift
---

# Problem

Three store-suite cases failed locally under a newer Bun while passing under the CI pin. The message was `unable to open database file`, which reads as a missing or corrupt store and invites a hunt for a product defect. The store was fine.

# Mechanism

A store closed cleanly can keep a WAL-mode header with no `-wal` file beside it. On a read-only open:

- `node:sqlite` (the pinned interpreter's driver) creates the journal it needs and the open succeeds.
- Bun refuses the open, so the raw test-support read throws before any assertion runs.
- The product read path (`openStore(…, "read")`) already prepares that journal, which is why only test-support opens saw the failure.

The distinguishing shape is mechanical: header bytes 18/19 equal 2, and neither `-wal` nor `-shm` exists next to the file. That is a *quiesced* WAL store — closed, no live writer.

# Resolution

Give the test-support raw read one bounded fallback: try the plain read-only open, and only for the quiesced-WAL shape retry with `file:<path>?immutable=1`. Every other error re-throws unchanged.

Two rules keep the fallback honest:

1. **Shape-gate it.** `immutable=1` asserts nobody will write the file. Applying it to an arbitrary unreadable file would hide a genuinely broken store rather than report it.
2. **Keep the assertion.** The fallback must let the case reach its own assertion, never replace it with a skip. A skip that does not name the interpreter is a false green.

Where a case cannot be made interpreter-independent, the failure output must name the runtime, version and binary that ran, plus the supported pin. A red that says "this interpreter is not the supported one" is evidence; a silent skip is not.

# Self-check

- Did a read-only store test fail locally with `unable to open database file` while CI is green? Check the quiesced-WAL shape before suspecting the product read path.
- Is a fallback you added gated on that shape, and does it re-throw everything else?
- Does the suite still fail loudly when the supported interpreter is absent?
