# QC1 / QC2 Fix Report

- Status: DONE_WITH_CONCERNS

## Step 1 — barrel export

Added `export { upgradeStoreWithRecoveryPoint } from "./store-upgrade.js";` as a distinct one-line statement immediately after the `store-upgrade-state.js` export. Shell verification reported `packages/engine/src/index.ts | 1 +` and `1 insertion(+)`, with zero deletions.

## Step 2 — recovery point and no-files authority behavior

Both schema-only upgrade routes in `packages/commands/src/families/store.ts` use `upgradeStoreWithRecoveryPoint`. The schema-pending/no-legacy route and the no-schema-pending/no-legacy route are now mutually exclusive in one invocation: completing the schema-only route returns instead of falling through to a second recovery/upgrade call. A schema-only path initializes execution authority through the existing guarded, create-only `initializeExecutionAuthority` only when the post-schema state is `legacy`; active and staged authority are not initialized or flipped. Schema-only paths still do not request attestation, inventory, operator confirmation, or execute migration.

Updated `probeStoreUpgradeState` to report an active, empty execution authority as `up-to-date` without a retirement record only when `execution_workflows` is empty and legacy execution files are absent. An active authority with recorded active retirement remains `upgrade-required`.

## Step 3 — command-level evidence

The schema-only test checks the backup directory contains exactly one `*-pre-schema.db` recovery point, reads the copied database through a raw read-only SQLite connection, and asserts the stored schema version is the pre-upgrade version. The ACTIVE-with-recorded-retired case also verifies the pre-upgrade schema version. The no-legacy-files test verifies the first run reaches active authority and the second reports `up-to-date`. Added a probe-level test for empty active authority without migration retirement history.

## Verification: exact commands and actual output

- `bun test packages/commands/src/families/store.test.ts`
  - `12 pass`, `0 fail`, `95 expect() calls`; ran across `1 file`.
- `bun test packages/engine/src/store-upgrade-state.test.ts`
  - `8 pass`, `0 fail`, `15 expect() calls`; ran across `1 file`.
- `bunx tsc -p packages/commands/tsconfig.json --noEmit`
  - Passed; no diagnostics.
- `bun run --cwd packages/engine build`
  - Passed: bundled 215 modules to `engine.js` (2.0 MB), 181 modules to `audit.js` (160.82 KB); `bunx tsc` completed.
- Engine `test/**` explicit typecheck, using temporary `packages/engine/tsconfig.verify-tests.json` (removed after the run): `bunx tsc -p packages/engine/tsconfig.verify-tests.json`
  - Did not pass: TypeScript reported 127 diagnostics across 16 files. Examples include existing test/type mismatches in `status.test.ts`, `workflow.test.ts`, and `coordination.test.ts`; `packages/engine/test/store-upgrade.test.ts` also reports that `schemaBackup` and `backup` do not exist on `StagedStoreUpgrade` after the sibling-owned engine seam change. No `packages/engine/test/**` files were changed in this fix round.

## Files changed / commit

- `packages/engine/src/index.ts`
- `packages/commands/src/families/store.ts`
- `packages/commands/src/families/store.test.ts`
- `packages/engine/src/store-upgrade-state.ts`
- `packages/engine/src/store-upgrade-state.test.ts`

Implementation commit: `4ced7a06` (`fix(store): make schema-only upgrade single path`).

## Residuals disclosure

The requested engine `test/**` typecheck is not green because it surfaces 127 diagnostics across 16 files, including errors outside this assignment's owned paths and two diagnostics in the sibling-owned `packages/engine/test/store-upgrade.test.ts`. The required command-level suite, engine build, commands typecheck, and probe test all pass. Sibling worktree modifications to `packages/engine/src/execution-migrate.ts` and `packages/engine/src/execution-migrate.test.ts` were not staged or included in the implementation commit.

## Self-review notes

Kept the pre-schema assertion intact and strengthened it to require exactly one recovery point. The earlier full-file failure was caused by one schema-pending/no-legacy invocation falling through to a second no-legacy route and creating a second, post-schema backup. The route now returns after the schema-only work; the full command test suite passes. Active authority with incomplete retirement remains outstanding, and staged authority is not touched by the create-only initializer. Worktree used: `/Users/bibi/workspace/ai/mstar-harness/.worktrees/20260930-store-upgrade-single-path`.
