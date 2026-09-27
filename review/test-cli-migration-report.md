# CLI test output migration report

## Status: BLOCKED

The JSON-envelope migration is incomplete. The latest full-suite run is in progress; its final result will be recorded after it completes. Worktree: `.worktrees/20260926-mcp-ci-fix`. No commit or push was made.

## Part 1 — behavior/fixture dispositions

1. **Workflow and iteration registration identity:** `workflow.register` and `iteration.register` expose explicitly supplied `--session-id` as invocation context. The CLI adapter maps declared context options into `InvocationContext.sessionId`; it does not infer authorization from `MSTAR_EXECUTION_IDENTITY` or a host spoof variable. Execution-workflow fixtures supply session IDs. Workflow registration passes the identity requirement, but broader active workflow tests still fail on remaining command/result-contract mismatches. Iteration registration now uses `--branch-target-iteration` and a JSON row payload; registration succeeds, but subsequent gate assertions remain failing.
2. **Store initialization:** `issue-cutover.test.ts` now uses a direct `initializeStore` fixture helper following plan-coordination setup rather than invoking unsupported `store init --json`. The fixture still fails at retired file-based plan-session setup against an active authority; it needs a current active DB binding fixture.
3. **Reviewer comma-list decoding:** schema-array options now decode JSON array/object forms and comma-separated strings. `review-cli.test.ts` migrates to envelope fields and passes (14/14).
4. **Retired backlog exit code:** `status.backlog-register` and `status.backlog-close` already return refused envelopes with `exitCode: 1`, code `status.verb-retired`; direct CLI capture confirmed. The earlier exit-2 observation was from issue-cutover fixture setup failing before those assertions. No implementation exit-code change was needed.
5. **Relative project-root/path cases:** unresolved. `iteration-plan-path.test.ts` still uses pre-envelope/pre-active-registration assumptions. The resolver contract in `packages/engine/src/plan-path.ts` accepts canonical absolute and normalized harness-relative paths, but tests have not reached that contract through a valid active registration input. No C-2 implementation defect or fix is claimed.

## Migration and verification evidence

- `review-cli.test.ts`: envelope status/code/data assertions; **14 pass, 0 fail**.
- `lease-verify.test.ts` + `review-cli.test.ts`: migrated command-result assertions to envelope fields, retaining actual Commander parser diagnostics for missing required options; **27 pass, 0 fail**.
- `slice4-cli.test.ts` host-detect matrix migrated to envelope data/message; targeted `bun test packages/cli/test/slice4-cli.test.ts --test-name-pattern 'host detect'` — **10 pass, 0 fail**.
- `issue-cutover.test.ts` now checks selected store refusals by envelope code, but remains blocked at active session fixture setup.
- `execution-workflow.test.ts` has partial envelope/argument migration, but targeted cases still fail on active transition/result input mismatches.
- `sdd-cli.test.ts`, `sdd-evidence.test.ts`, remainder of `slice4-cli.test.ts`, and other named files retain unmigrated prose assertions; full ~750 assertion migration is not complete.
- `bun run --cwd packages/commands build && bun run --cwd packages/cli build` succeeded before the last array decoder refinement.
- `bunx tsc --noEmit -p packages/cli` exited successfully after latest code edits.
- `bun scripts/drift-lint.ts` completed successfully.
- Latest `bun test packages/cli/test/` is running after the current test changes. Earlier full suite: **462 pass / 497 fail** (959 tests across 51 files), but that run preceded later migration edits and is not final evidence.

## Remaining blockers

- Zero-failure full-suite acceptance is unresolved.
- Current full-suite run has not yet returned its final summary.
- `issue-cutover.test.ts` needs an active DB coordinator/plan session fixture.
- `execution-workflow.test.ts` still has active transition and receipt-contract mismatches.
- `iteration-plan-path.test.ts` path cases remain unverified against valid active registration inputs.
- SDD, SDD-evidence and most slice4 prose-output assertions remain unmigrated.

## Status: BLOCKED — zero-failure acceptance and the remaining migrations above are unresolved.
