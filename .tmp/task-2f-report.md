# Task 2f implementation report

## Status

**Incomplete / blocked on required recovery semantics.** The command regressions below are fixed and the scoped command test passes, but no archive-and-complete implementation was made. I will not represent a refused damaged-state upgrade as success or silently discard bytes. The required per-damaged-state complete-and-archive tests and unwritable-archive negative case therefore remain unimplemented.

## Archive design

Not implemented. No archive location, layout, or audit record is claimed. An acceptable implementation must persist original bytes (including SQLite sidecars and every displaced staged/source artifact) outside live store paths, verify completeness before mutation, and fail closed with a cause-specific refusal if archive persistence or verification fails.

## Damaged-state table

| Damaged state | Archived material | Recovery | Upgrade-completion test |
|---|---|---|---|
| Unreadable/invalid database | Not implemented | Not implemented | Missing |
| Missing/inconsistent staged record | Not implemented | Not implemented | Missing |
| Missing staged manifest | Not implemented | Not implemented | Missing |
| Unretirable pending registration | Not implemented | Not implemented | Missing |
| Schema drift/unsupported readable store | Not implemented | Not implemented | Missing |

No damaging state was exercised against a live store; tests must use isolated fixtures as assigned.

## Regression fixes

- `packages/commands/src/families/store.ts`: added distinct operator-facing diagnostics for missing, unreadable, and malformed attestation files; preserved the `usage` envelope for these operator-input errors rather than collapsing them into generic invalid-input wording.
- `packages/commands/src/families/store.test.ts`: updated conflict recovery assertions to forbid aborting an operation protected by the execution guard and require the supported catalog-reconciliation flow.
- Corrected `execution.coverage-incomplete` recovery so inventory is advised only when discovery inventory is the missing item.
- Corrected `execution.migration-conflict` recovery: it no longer recommends an abort that the snapshot/root-registration guards reject.

Evidence: `bun test packages/commands/src/families/store.test.ts` → `12 pass, 0 fail, 98 expect() calls`.

## Completion blockers requiring further implementation

The current command starts by calling `probeStoreUpgradeState(context)` at `packages/commands/src/families/store.ts:204`; that probe immediately opens an existing database at `packages/engine/src/store-upgrade-state.ts:43` and can throw before the command has a recovery boundary to archive unreadable database bytes. The damaged-state flow then propagates through existing typed store errors, not through an archive-and-rebuild primitive. Staged failures are only classified in command failure mapping (`store.ts` around lines 136–150); they have no archive-first repair path.

The task explicitly prohibits weakening guards. In particular, `packages/engine/src/catalog-registration.ts:1711-1715` rejects abort for operations with a snapshot or root registration; abort cannot be used as a generic cleanup escape hatch. `assertBackupDescribesStore` is also explicitly protected by the assignment and cannot be weakened to permit unsupported restore. A correct solution needs a separate archive-first retirement/recovery path that preserves/verifies complete bytes before any mutation and then re-establishes valid store/execution authority through supported engine transitions. That end-to-end path and its fixtures were not completed here.

## Verification / commit

- Command: `bun test packages/commands/src/families/store.test.ts`
- Actual result: `12 pass, 0 fail, 98 expect() calls` (Bun 1.4.0).
- Archive-completion and archive-failure tests: not run; not implemented.
- Commit SHA: `fccec86c` (command regression fixes; archive-and-complete requirement remains incomplete).
