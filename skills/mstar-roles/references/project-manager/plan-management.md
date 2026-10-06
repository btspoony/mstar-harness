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
- **Default gitignored** (local coordination): `store.db`, `archived/`, `iterations/`, `plans/`, `sdd/`, `workflows/`, `projects/`; `status.json` is pre-activation bootstrap only.
- Under **ACTIVE** execution authority, root registry, workflow/plan rows, sessions, leases and frozen inputs live in `{HARNESS_DIR}/store.db`; read via `mstar status validate` / `mstar plan show`, mutate only through public workflow/plan verbs. `status.json` / snapshot / session files are refused for reads and writes (`execution.consumer-not-ready` / `execution.direct-write-refused`); they are only pre-activation / engine-absent fallback. Keep authored main plan markdown current on disk, but do not default `git add` / `git commit` for cross-clone handoff. Open findings are store issues; project registers are migration history, never write targets. Promote durable decisions into tracked knowledge/specs/`AGENTS.md`.
- If a project explicitly opts into tracking process artifacts, record that policy in `{HARNESS_DIR}/AGENTS.md` and ensure team alignment.

## PM Responsibilities

- On plan create/update: use `mstar workflow register` / the appropriate `mstar plan` verb to maintain the store-backed registry and workflow/plan rows in the same coordination round; keep the authored main plan aligned. File synchronization is pre-activation fallback only.
- Before first non-trivial implement dispatch: ensure main plan file exists and `plan_id` is registered.
- After each Completion Report: update status before next dispatch (`report-to-status` hard gate).
- On entering `InReview`: ensure review bundle path (`{SDD_DIR}/review/`) and aligned review metadata are set; write durable gate summaries back to the main plan/status artifacts.
- On `Done`: ensure the plan's findings state is consistent — every confirmed finding captured as an issue linked to it, closures carrying their disposition and evidence (capture contract → `mstar-project-governance`「Issue capture」).
- At plan commitment: register the workflow through the authorized producer (ACTIVE: DB registry/workflow/plan rows under a transaction; pre-activation: create-only snapshot + root `workflows[]` under one lock) and declare its delivery kind — `development`, or `verification/report-only` with its recorded completion policy:
  ```text
  mstar workflow register --workflow <id> --plan-id <id> --plan-title <title> --plan-file plans/<id>.md
    --delivery-kind <development|verification/report-only> [--project <id>]
    [--branch-source <branch> --branch-target <branch> | --completion-policy <text>]
    [--started-at <ts>] [--harness <dir>]                                   # pre-activation file route
    --expect <the store's root execution token> --operation <id>            # active: the root-token creation form
  ```
  The active form runs under an independently acquired identity and takes no `--session-ref` (no session row exists before the workflow does); on a harness whose execution authority is active it is the only form that writes. The kind is declared here, never inferred (§1): `development` requires `--branch-source` + `--branch-target`, `verification/report-only` requires `--completion-policy`. The same `--delivery-kind` input is required by the specialized producers `audit promote` and (for the ACTIVE plan snapshots it lifts) `migrate` — and it is ONE delivery identity, so a `migrate` run whose lift creates 2+ ACTIVE standalone plans is refused (ids listed) and the tree migrates in batches of one declared plan. An **ACTIVE** `type: plan` snapshot that predates this (no registered kind — e.g. an old audit promotion or v1 lift) is repaired ONCE, before its close, on the **pre-activation** route (the DB creation route declares its kind at registration, so no active form exists and the declaration is never disguised as one):
  ```text
  mstar workflow evidence --workflow <id> --declare-kind <development|verification/report-only>
    [--branch-source <branch> --branch-target <branch> | --completion-policy <text>] [--session <path>]
  ```
  The declaration is one-time (a second one, even with the same kind, is refused) and refuses a terminal snapshot; a supplied `--branch-source`/`--branch-target` fills a MISSING anchor or restates the registered one — a value conflicting with an anchor the snapshot already carries is refused (the registered anchor is the delivery identity, never overwritten); delivery evidence itself is recorded with `mstar workflow evidence --workflow <id> --file <payload.json>` — active: plus `--session-ref <wire> --expect <the workflow's full execution token> --operation <id>` under an independently acquired coordinator identity; pre-activation: plus `--session <path>` (PR identity recorded once; `head`/`target` must be the registered `branch.source`/`branch.target`).
- **Row completion routes (engine-selected):** after `accept`, the coordinator follows one of three routes — never inferred from missing integration anchors.
  - **Iteration** (`type: iteration`, or any non-standalone workflow): `integration-start` → coordinator merge in the recorded integration checkout → `integration-accept` → `complete`. `complete` sets the row `Done`, completes the handoff, and releases the row `execution_lease` and the workflow `integration_merge_lease`.
  - **Standalone development** (`type: plan`, `delivery_kind: development`, exactly one owned row): `complete` directly from the accepted handoff with no integration verbs. `complete` sets `Done`, completes the handoff, retains cleanup metadata, releases only the row `execution_lease`, and leaves the workflow `running` until the delivery tail and `status workflow-close`.
  - **Standalone report-only** (`type: plan`, `delivery_kind: verification/report-only`, exactly one owned row): record the fulfilment of the registered completion policy first (`mstar workflow evidence --workflow <id> --file <payload.json>` — active: plus `--session-ref <wire> --expect <full execution token> --operation <id>`; pre-activation: plus `--session <coordinator envelope>`; payload `{"completion":{"policy":"<the registered policy>","evidence":"<reference>"}}`), then `complete` directly from the accepted handoff — no integration verbs, no PR, no merge. `complete` sets `Done`, completes the handoff with no integration record, releases only the row `execution_lease`, and leaves the workflow `running` until `status workflow-close`. The completion and the close both consult that same recorded fulfilment, so an absent or nonmatching policy refuses with no write; the report-only route invents no merge, no integration branch and no integration checkout for a workflow that authored none.
- **Legacy delivery-source repair (not a normal step):** `mstar plan repair-delivery-source` applies only when a pre-fix snapshot registered `branch.source === branch.target` while the accepted handoff names the true feature branch. It replaces only `branch.source` under the row revision lock, derived from the sealed handoff — no user-supplied branch, no `Done`, no delivery-evidence rewrite. Continue with ordinary `complete` after repair. Future registrations must record the true delivery source at `workflow register` time; `workflow evidence --declare-kind --branch-source` cannot amend an already-registered anchor (one-time kind declaration only).
- **Holder release and reacquisition:** the active `mstar plan release` verb releases only the acquired holder's own execution claim and does not read Assignment content. To continue, use an explicit same-holder `mstar plan bind --execution` before repair/prepare/progress; release does not discard an accepted handoff or integration attempt.

- Delivery tail (standalone `development` plans, after Done): compound disposition (`created` / `updated` / reasoned `skipped`; review → **`mstar-compound`**) on the delivery branch before the PR head is finalized → submit PR with its identity (repo / head / target) recorded → merge-ready declared (resumable milestone; workflow stays registered) → PM-verified merge (provider evidence; never the close verb) → common close reusing the post-merge-close ordering (`mstar-iteration/references/phase-6-post-merge-close.md`). Stage semantics and failure behavior → frozen contract `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`.
- Delivery tail (standalone `verification/report-only` plans, after Done): the completion-policy fulfilment was already recorded before Done, so the tail is the close itself — `mstar status workflow-close --workflow <id>` (active: `--session-ref <wire> --expect <full execution token> --operation <id> --reason <text>`; pre-activation: `--session <coordinator envelope> [--ended-at <date>]`) writes `completed` from that same evidence and unregisters the root entry, then the read-only `mstar iteration gate --phase 6 --workflow <id>` projection must pass. There is no compound-before-PR, no PR and no merge stage: do not invent one for a kind that declared it has none.
- Active own-scope mutations and `status workflow-close` may omit session reference, current token, and operation id when the caller identity unambiguously selects the current scope; the CLI derives the scope token and generates one fresh operation id. Explicit references/tokens are checked constraints. Registration remains distinct: it consumes the root creation token; workflow writes consume workflow tokens, and plan writes consume plan tokens.
- **`failed` / `stopped` exposure: the ACTIVE CLI route is public; the pre-activation JSON form is not.** The DB lifecycle carries the terminal branch, and `mstar workflow lifecycle --status failed|stopped --reason` runs against it under the acquired coordinator identity (sparse own scope; the session reference, current workflow token and operation id are defaults or checked constraints, exactly like other active writes). What stays limited is the **pre-activation JSON/file** terminal form: it has no `failed`/`stopped` writer, and no cancellation subsystem is added. A workflow that must become terminal on that pre-activation path is a named blocker for its owner: reported as such, never hand-edited and never closed as `completed`.
- **Merge-ready precondition — standalone `development` plans only.** Before merge-ready is declared, run the read-only close-state gate and record its output with the milestone (`mstar iteration gate --phase 6 --workflow <id> [--harness <absolute-path>]`; same implementation as the close's delivery-evidence consultation, no `--compass`). Pre-merge the snapshot is still `running`, so `PHASE6_NOT_TERMINAL` / `PHASE6_ROOT_ENTRY_PRESENT` are the expected readings and the recorded note says so; any other code (`PHASE6_INVALID_SNAPSHOT`, `PHASE6_INVALID_ROOT`) is a real defect to clear before merge-ready. Iteration workflows are unaffected — they keep their own Phase 4/5 exit checklist (`mstar-iteration/references/phase-4-5-pr-delivery.md` §5.2).

## PM Plan / Status NEVER

- **NEVER** let store-backed workflow/plan rows and authored main plan markdown drift within the same coordination round—reconcile through public engine verbs and plan edits or mark `Blocked`; never patch ACTIVE root/snapshot files.
- **NEVER** skip the `report-to-status` sync after a Completion Report when the next dispatch or gate depends on that state.

## Stage Transitions

- Non-hotfix path: `specify -> clarify -> plan -> tasks -> implement -> InReview -> Done`
- Standalone development plans: row `Done` is not workflow completion — the delivery tail (see PM Responsibilities) runs to verified merge + terminal close before the workflow closes.
- Standalone report-only plans: row `Done` is likewise not workflow completion — the close (`status workflow-close`) plus the phase-6 projection finish it, and no PR or merge exists on this kind.
- Hotfix path may be compressed, but requires post-fix clarify/RCA follow-up note.
- New constraints during implement: write back to plan before continuing.

## Hard Blocks

- Missing plan file / missing status registration before first implement in active harness projects
- Missing PM task board for non-trivial plan before implement dispatch
- Missing report-to-status update between Completion Report and next dispatch
