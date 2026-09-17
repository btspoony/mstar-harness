# Project Manager Plan Management Reference

Use this reference for `{HARNESS_DIR}` / `{PLAN_DIR}` initialization, status syncing, and plan lifecycle operations.

## Directory Discovery

Follow `mstar-conventions` for canonical discovery.
Preferred layout:

- `{HARNESS_DIR}`: `.mstar/` by default; existing `.agents/` projects remain valid.
- `{PLAN_DIR}`: `.mstar/plans/` by default; existing `.agents/plans/` projects remain valid.

Legacy fallbacks:

- `.plans/`
- `plans/`

## Initialization Checklist (when plan management is required)

1. Create `{HARNESS_DIR}` and `{PLAN_DIR}` when absent.
2. Initialize `{HARNESS_DIR}/status.json` from template if available.
3. Ensure Morning Star **process-artifact** gitignore set is present (canonical snippet → `mstar-conventions` SKILL.md「Git 跟踪策略」): `{HARNESS_DIR}/archived/`, `iterations/`, `plans/`, `sdd/`, `status.json`, `workflows/`, `projects/` (legacy `.agents/` equivalents when applicable). Per-plan `{SDD_DIR}/review/` is created by the SDD/review flow when needed.
4. Optional: `{HARNESS_DIR}/knowledge/README.md`. `workflows/` / `projects/` subdirs are created on demand by engine writers — no pre-creation.

If legacy plan directories already exist, reuse them; avoid dual-structure duplication.

## Git Tracking Policy

**Principle:** process stays local; results are shared with the team. Full rules → `mstar-conventions` SKILL.md「Git 跟踪策略」.

- **Default tracked** under `{HARNESS_DIR}`: `AGENTS.md`, `{KNOWLEDGE_DIR}/**`, `{SPECS_DIR}/**` (resolved specs path; default `{HARNESS_DIR}/specs/`).
- **Default gitignored** (local session SSOT / coordination): `archived/`, `iterations/`, `plans/`, `sdd/`, `status.json`, `workflows/`, `projects/`.
- `status.json` (v2 root), workflow snapshots, project registers and main plan files remain **local session SSOT** — PM must keep them current on disk, but **do not** default `git add` / `git commit` for cross-clone handoff. Promote durable residuals and decisions into tracked `knowledge/` / `specs/` / `AGENTS.md` (compound) when they must survive clone.
- If a project explicitly opts into tracking process artifacts, record that policy in `{HARNESS_DIR}/AGENTS.md` and ensure team alignment.

## PM Responsibilities

- On plan create/update: sync the workflow snapshot (`workflows/<id>/snapshot.json`) + root `{HARNESS_DIR}/status.json` (`workflows[]`) in the same coordination round.
- Before first non-trivial implement dispatch: ensure main plan file exists and `plan_id` is registered.
- After each Completion Report: update status before next dispatch (`report-to-status` hard gate).
- On entering `InReview`: ensure review bundle path (`{SDD_DIR}/review/`) and aligned review metadata are set; write durable gate summaries back to the main plan/status artifacts.
- On `Done`: ensure residual lifecycle state is consistent (open vs archived).
- At plan commitment: register the workflow through the authorized producer (create-only snapshot + root `workflows[]` entry under one lock) and declare its delivery kind — `development`, or `verification/report-only` with its recorded completion policy:
  ```text
  mstar workflow register --workflow <id> --plan-id <id> --plan-title <title> --plan-file <path>
    --delivery-kind <development|verification/report-only> [--project <id>]
    [--branch-source <branch> --branch-target <branch> | --completion-policy <text>]
    [--started-at <ts>] [--harness <dir>]
  ```
  The kind is declared here, never inferred (§1): `development` requires `--branch-source` + `--branch-target`, `verification/report-only` requires `--completion-policy`. The same `--delivery-kind` input is required by the specialized producers `audit promote` and (for the ACTIVE plan snapshots it lifts) `migrate` — and it is ONE delivery identity, so a `migrate` run whose lift creates 2+ ACTIVE standalone plans is refused (ids listed) and the tree migrates in batches of one declared plan. An **ACTIVE** `type: plan` snapshot that predates this (no registered kind — e.g. an old audit promotion or v1 lift) is repaired ONCE, before its close:
  ```text
  mstar workflow evidence --workflow <id> --declare-kind <development|verification/report-only>
    [--branch-source <branch> --branch-target <branch> | --completion-policy <text>] [--session <path>]
  ```
  The declaration is one-time (a second one, even with the same kind, is refused) and refuses a terminal snapshot; a supplied `--branch-source`/`--branch-target` fills a MISSING anchor or restates the registered one — a value conflicting with an anchor the snapshot already carries is refused (the registered anchor is the delivery identity, never overwritten); delivery evidence itself is recorded with `mstar workflow evidence --workflow <id> --file <payload.json>` (PR identity recorded once; `head`/`target` must be the registered `branch.source`/`branch.target`).
- Delivery tail (standalone `development` plans, after Done): compound disposition (`created` / `updated` / reasoned `skipped`; review → **`mstar-compound`**) on the delivery branch before the PR head is finalized → submit PR with its identity (repo / head / target) recorded → merge-ready declared (resumable milestone; workflow stays registered) → PM-verified merge (provider evidence; never the close verb) → common close reusing the post-merge-close ordering (`mstar-iteration/references/phase-6-post-merge-close.md`). Stage semantics and failure behavior → frozen contract `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`.
- **Merge-ready precondition — standalone `development` plans only.** Before merge-ready is declared, run the read-only close-state gate and record its output with the milestone (`mstar iteration gate --phase 6 --workflow <id> [--harness <absolute-path>]`; same implementation as the close's delivery-evidence consultation, no `--compass`). Pre-merge the snapshot is still `running`, so `PHASE6_NOT_TERMINAL` / `PHASE6_ROOT_ENTRY_PRESENT` are the expected readings and the recorded note says so; any other code (`PHASE6_INVALID_SNAPSHOT`, `PHASE6_INVALID_ROOT`) is a real defect to clear before merge-ready. Iteration workflows are unaffected — they keep their own Phase 4/5 exit checklist (`mstar-iteration/references/phase-4-5-pr-delivery.md` §5.2).

## PM Plan / Status NEVER

- **NEVER** let the workflow snapshot / root status and on-disk plan truth drift within the same coordination round—update both or mark `Blocked` until reconciled.
- **NEVER** skip the `report-to-status` sync after a Completion Report when the next dispatch or gate depends on that state.

## Stage Transitions

- Non-hotfix path: `specify -> clarify -> plan -> tasks -> implement -> InReview -> Done`
- Standalone development plans: row `Done` is not workflow completion — the delivery tail (see PM Responsibilities) runs to verified merge + terminal close before the workflow closes.
- Hotfix path may be compressed, but requires post-fix clarify/RCA follow-up note.
- New constraints during implement: write back to plan before continuing.

## Hard Blocks

- Missing plan file / missing status registration before first implement in active harness projects
- Missing PM task board for non-trivial plan before implement dispatch
- Missing report-to-status update between Completion Report and next dispatch
