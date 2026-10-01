# Activation barrier fix report

## Root cause and fix

The reported reproduction showed 3 workflows staged versus 8 in the activation barrier's reviewed expectation. The mismatch was in `assertStagedGraphIsTheImport`: `expectedWorkflows` already omitted registered workflows with `exclusion !== undefined`, but `expectedPlans` and `expectedSessions` still included the excluded workflows' plans and owners. The equality checks were correct; their inputs were inconsistent.

The barrier now derives the expected workflow IDs from registered, non-excluded workflows, and derives expected plans and owners from all non-excluded workflows. Keeping unregistered terminal history in plans/sessions is intentional; excluded workflows contribute no rows. All three staged-vs-expected comparisons remain intact. A mixed valid-plus-excluded stage→activate regression passes and asserts the excluded workflow is absent from the execution graph.

Selected the smallest input-consistency fix (not activation-time rediscovery changes or comparison weakening). The reported pre-fix 3-vs-8 reproduction identifies the bug; after the fix, the fresh disposable-copy CLI acceptance completed successfully.

## `store.upgrade` CLI shape

Kept the existing unified orchestration: `store.upgrade` calls `stageStoreUpgrade` and then activates the returned staged migration. It does not duplicate preview/coverage in the command layer. Added `exclusions` and `normalizations` from `staged.manifest` to the successful result so the operator can see the migration decisions that were applied.

## Disposable-copy CLI acceptance

Rebuilt `/tmp/store-copy-root/.mstar` from the read-only live source using the supplied relocation/reset procedure, then ran from `/tmp`:

```sh
printf 'preserve for later review\n' | node /Users/bibi/workspace/ai/mstar-harness/.worktrees/snapshot-violation-resolutions/packages/cli/dist/mstar-harness.js store upgrade --harness /tmp/store-copy-root/.mstar --operator btspoony --attestation /Users/bibi/workspace/ai/mstar-harness/.worktrees/snapshot-violation-resolutions/.tmp/attestation.json
```

Observed CLI response:

```text
status=ok  code=store.upgrade.ok  exitCode=0
data.verdict=upgraded  schemaVersion=7  authorityState=active  sourcesRetired=true
data.exclusions: 6 records — 20260820-dsh-engine-status-slim, wf-20261001-audit10-001, wf-20261001-audit10-002, wf-20261001-audit10-004, wf-20261001-audit10-006, wf-20261001-audit10-007
data.normalizations: 45 records (each returned with workflowId and diagnostics)
```

The actual JSON result carried all 6 complete exclusion records (including reason codes, snapshot paths, and SHA-256 values) and all 45 normalization records with their diagnostics. `execution_meta.authority_state` in the copy is `active`; `execution_registry` has 5 registered workflows. None of the six excluded workflow IDs has a row in `execution_workflows`.

All 6 exclusion archive files exist under `/tmp/store-copy-root/.mstar/archived/execution-snapshot-exclusions/`. Their SHA-256 values exactly equal the corresponding digest in the manifest and archive filename, confirming archived bytes match. The manifest exclusions were `20260820-dsh-engine-status-slim`, `wf-20261001-audit10-001`, `wf-20261001-audit10-002`, `wf-20261001-audit10-004`, `wf-20261001-audit10-006`, and `wf-20261001-audit10-007`.

An earlier stale disposable copy contained a staged manifest pinned to the live root; its activation and abort correctly refused the root mismatch. No live `.mstar` bytes were changed. The copy was rebuilt using the documented prep procedure before the successful acceptance above.

## Verification

- `bun test packages/engine/src/execution-migrate.test.ts packages/engine/src/execution-coverage.test.ts packages/engine/src/execution-populated.test.ts packages/engine/src/execution-recovery.test.ts packages/engine/src/execution-ledgers.test.ts` — **142 pass, 0 fail, 1370 assertions**.
- `bun test packages/commands/src/families/store.test.ts` — **12 pass, 0 fail, 101 assertions** (includes assertions that successful upgrade results expose exclusions and normalizations).
- `bun run --cwd packages/cli build` — passed; produced the CLI bundle used for the copy acceptance.
- Disposable-copy full CLI upgrade — `status: ok`, `verdict: upgraded`, authority active, exclusions/normalizations present, archived exclusion bytes hash-matched.

## Commits

- Barrier fix and mixed excluded-workflow stage→activate regression: `965386c3`.
- CLI result fields and command contract assertions: `c4010783`.
- Command test output-type narrowing: `7c2117f7`.
