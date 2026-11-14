---
module: Module mocks that outlive their test file in Bun
date: 2026-11-14
last_updated: 2026-11-14
problem_type: test_failure
category: test-failures
severity: medium
plan_id: 20261114-host-adapters
symptoms:
  - "A test file mocks a package specifier and passes alone, while other files in the same `bun test` run fail on the real module"
  - "The failures appear only when the mocking file runs first in the same process"
  - "`mock.restore()` in `afterAll` does not clear the failure"
root_cause: "`mock.module` replaces the module record for the whole process. `mock.restore()` does not drop that replacement, so every later file that imports the specifier gets the stub. Restoring the real namespace object does not work either — the override must be re-registered from a snapshot captured before the mock."
resolution_type: code_fix
applies_when:
  - "A test mocks a package specifier with `mock.module` rather than a local module or a function"
  - "The package runs more than one test file per process"
  - "A file passes in isolation but its neighbours fail in the suite"
tags:
  - bun
  - test-isolation
  - module-mocks
  - mock-module
  - test-failures
---

# Problem

One test file needed to replace a single export of a shared package so a runtime-floor refusal could be exercised without a real interpreter change. It passed on its own. Run with the package's other tests, the neighbours failed: they were loading the stub.

The first suspicion — test order — was half right: the failure is order-dependent, but the cause is process-wide state, not ordering discipline.

# Mechanism

`mock.module("<specifier>", factory)` swaps the module record for the lifetime of the process. `mock.restore()` resets spies and function mocks; it does not remove a module replacement. Two consequences:

- Any later file importing the specifier in the same process receives the stub.
- Re-registering the *live* namespace object does not restore the real module either; the override must be re-registered from a snapshot taken before the mock.

# Resolution

Capture the real exports before mocking, then re-register them in `afterAll`:

```ts
const realExports = { ...engine }
mock.module("@scope/pkg", () => ({ ...realExports, someExport: stub }))
afterAll(() => {
  mock.restore()
  mock.module("@scope/pkg", () => realExports)
})
```

The proof is a two-file run in one process, not a single-file run: the mocked file plus one neighbour that imports the same specifier must both pass. Before the fix that pair fails on the neighbour; after it, both pass.

# Rules for the next editor

- Prefer narrowing the mock to a local module or an injected constructor over replacing a shared package specifier.
- If you must replace a specifier, snapshot the real exports first and restore them in `afterAll`.
- Verify isolation with the two-file run; a single-file green proves nothing about the process.
- Leave a comment naming the constraint: a later file that mocks the same specifier must restore its own override.

# Self-check

- Does the mocking file run in a package with other test files?
- Is there an `afterAll` that re-registers a pre-mock snapshot, not the live namespace?
- Has the two-file run been observed green?
