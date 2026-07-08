# Project Manager Plan Management Reference

Use this reference for `{HARNESS_DIR}` / `{PLAN_DIR}` initialization, status syncing, and plan lifecycle operations.

## Directory Discovery

Follow `mstar-plan-conventions` for canonical discovery.
Preferred layout:

- `{HARNESS_DIR}`: `.mstar/` by default; existing `.agents/` projects remain valid.
- `{PLAN_DIR}`: `.mstar/plans/` by default; existing `.agents/plans/` projects remain valid.

Legacy fallbacks:

- `.plans/`
- `plans/`

## Initialization Checklist (when plan management is required)

1. Create `{HARNESS_DIR}` and `{PLAN_DIR}` when absent.
2. Initialize `{HARNESS_DIR}/status.json` from template if available.
3. Ensure `{HARNESS_DIR}/sdd/` is gitignored; per-plan `{SDD_DIR}/review/` is created by the SDD/review flow when needed.
4. Initialize residual archive path: `{HARNESS_DIR}/archived/residuals/`.
5. **Profile B** only: `{HARNESS_DIR}/archived/plans/` and `archived/plans-done.json` from `mstar-plan-artifacts/templates/plans-done.empty.json` (`{ "plans": [] }` only; see `done-compaction.md`).
6. Optional: `{HARNESS_DIR}/notes.json`, `{HARNESS_DIR}/knowledge/README.md`.

If legacy plan directories already exist, reuse them; avoid dual-structure duplication.

## Git Tracking Policy

- Default: track `{HARNESS_DIR}` files in repo for reproducible handoff.
- If project policy requires local-only, explicitly record it and ensure no required artifact depends on ignored files.

## PM Responsibilities

- On plan create/update: sync `{HARNESS_DIR}/status.json` in same coordination round.
- Before first non-trivial implement dispatch: ensure main plan file exists and `plan_id` is registered.
- After each Completion Report: update status before next dispatch (`report-to-status` hard gate).
- On entering `InReview`: ensure review bundle path (`{SDD_DIR}/review/`) and aligned review metadata are set; write durable gate summaries back to the main plan/status artifacts.
- On `Done`: ensure residual lifecycle state is consistent (open vs archived).

## PM Plan / Status NEVER

- **NEVER** let `status.json` and on-disk plan truth drift within the same coordination round—update both or mark `Blocked` until reconciled.
- **NEVER** skip the `report-to-status` sync after a Completion Report when the next dispatch or gate depends on that state.

## Stage Transitions

- Non-hotfix path: `specify -> clarify -> plan -> tasks -> implement -> InReview -> Done`
- Hotfix path may be compressed, but requires post-fix clarify/RCA follow-up note.
- New constraints during implement: write back to plan before continuing.

## Hard Blocks

- Missing plan file / missing status registration before first implement in active harness projects
- Missing PM task board for non-trivial plan before implement dispatch
- Missing report-to-status update between Completion Report and next dispatch
