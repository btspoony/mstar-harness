# Migration-source shapes

`mstar store upgrade` reads recognized v1/v2 execution sources directly and preserves original source bytes; standalone `mstar migrate` staging is retired, so every mention below describes a historical migration, never a command to run. **No execution route and no live writer exists for these files.** ACTIVE execution and open findings belong to `{HARNESS_DIR}/store.db`; project-register import uses the separate reviewed `mstar store migrate` flow. This reference is the migration map a `mstar store upgrade` operator reviews before converting a workspace.

## v1 root `status.json`

v1 held `{HARNESS_DIR}/status.json` as the SSOT for `plans[]` row status and open residual findings, with closed residuals archived to `{HARNESS_DIR}/archived/residuals/<plan-id>.json`. `mstar store upgrade` converts a recognized v1 root in memory (`discoverV1`); the legacy tree is never rewritten.

### v1 `plans[]` row fields

| Field | Meaning |
| --- | --- |
| `id` | Plan id (legacy alias `plan_id` read-compatible). |
| `title` / `file` | Display title / main plan path (`{PLAN_DIR}/…`). |
| `status` | `Todo \| InProgress \| InReview \| Blocked \| Done`; historical actors remain recorded as-is, while new Done authority belongs only to the primary PM. |
| `owner` / `agents` / `progress` / `tags` | PM ownership, role agents, progress 0–100, tags. |
| `created_at` / `updated_at` / `done_at` | `YYYY-MM-DD`; `done_at` set at Done. |
| `notes` | Per-plan timeline (string array recommended; legacy string OK). |
| `metadata` | Optional object (see below). |

### v1 `plans[].metadata` standard optional fields

| Key | Type | Purpose |
| --- | --- | --- |
| `findings_cleanup` | `zero-residual` \| `allow-residual` | Mirror of Assignment `Findings cleanup`. |
| `working_branch` | string | Implementation branch; aligns with Assignment `Working branch` (SSOT). |
| `spec_integration_branch` | string | (Multi-plan same Spec) integration branch; created from root `metadata.iteration_base_branch`. |
| `merge_target` | string | Next merge target; final PR target is root `metadata.target_branch`. |
| `branch_policy` | string | One-line policy per the runtime core's branch-policy rule. |
| `phase` / `priority` / `description` / `scope` | string | Program label; `high\|medium\|low`; one-line scope (pick one key per repo). |
| `gates` | object | Gate summary (`qc`, `qa`, `typecheck`, `tests`, `lint`, …). |
| `blocked_since` / `blocked_reason` / `blocked_by_plan_id` / `dependency` / `next_action` | string | Block bookkeeping + deps + next step. |
| `primary_spec` / `iteration_compass` / `iteration_refs` | string / string[] | Spec / compass pointers. |
| `qc_status` / `tests` / `commits` | string | InReview/Done snapshots — not a substitute for durable gate summaries or root `residual_findings`. |
| `sdd_dir` / `sdd_progress` / `review_bundle` / `task_commits` | string / array | SDD scratch path, progress ledger pointer, review bundle pointer, `{task_id,base,head}[]`. |

Older transports also recorded a per-plan cooperative holder and source checkout in `execution_lease`; the current coordinator cutover removes that admission/claim model, source facts live in row metadata, and an `InProgress` row without a historical lease is not an orphan admission failure.

### v1 root `metadata` standard optional fields

| Key | Type | Purpose |
| --- | --- | --- |
| `versioning` | object | Cross-plan conventions (team-defined). |
| `iteration_base_branch` | string | Branch/ref used to create `spec_integration_branch`; required for formal iterations. |
| `target_branch` | string | Final PR target after iteration-close; required for formal iterations. |
| `notes` | array | **Legacy** — superseded by the runtime notes ledger. |
| `residual_findings_history` | object | **Legacy** — superseded by `archived/residuals/<plan-id>.json`. |
| `tech_debt_summary` | object | Optional stored rollup over open R# (engine `techDebtRollup`, since removed). |
| `control_worktree_path` | absolute path string | **v1-historical (read-alias)** for canonical snapshot member `integration_worktree_path`; `readWorkflowSnapshot` normalizes the old key in memory with a medium diagnostic — canonical writers reject it. |
| `integration_merge_lease` | object | While one integration merge was owned; **absent** = unclaimed. Writers **delete** the key on release — never `null`/tombstones. |

## v1 archive shapes

`archived/residuals/<plan-id>.json` appended closed entries:

```json
{ "plan_id": "01-data-infrastructure", "schema_version": 1,
  "entries": [{ "id": "R1", "severity": "medium", "lifecycle": "resolved",
    "closed_at": "2026-04-06", "closure_note": "…",
    "closure_evidence": "PR #42 / commit …", "archived_at": "2026-04-07" }] }
```

`{HARNESS_DIR}/notes.json` carried cross-plan milestones, while `plans[].notes` carried the per-plan timeline:

```json
{ "schema_version": 1, "updated_at": "YYYY-MM-DD",
  "entries": [{ "at": "2026-04-08", "message": "Short milestone", "plan_id": "01-data-infrastructure" }] }
```

## v1 → v2 destination mapping

The v2 file transport itself is retired: these facts now live in `{HARNESS_DIR}/store.db` (`execution_*`), and the file surfaces below are migration sources only.

| v1 surface | v2 home |
| --- | --- |
| root `plans[]` rows | `{WORKFLOW_DIR}/<id>/snapshot.json` → `plans[]` (legacy PlanRow shape verbatim) |
| Historical row `execution_lease` | Removed admission model; source scope is current row metadata, not a holder protocol |
| root `metadata.integration_merge_lease` | snapshot top-level `integration_merge_lease` |
| root `metadata.control_worktree_path` | snapshot top-level `integration_worktree_path` (v1 key is a read-alias; canonical writers emit only the new name) |
| root `metadata.iteration_base_branch` / `target_branch` / `spec_integration_branch` / `merge_target` | snapshot top-level `branch.{base,integration,target}` |
| root `metadata.plan_parallelism` / `worktree_mode` / `push_policy` | snapshot `execution_policy` |
| root `metadata.notes` / legacy row `notes` | `{WORKFLOW_DIR}/<id>/notes.jsonl` (runtime ledger; row `notes` kept verbatim as legacy copy) |
| root `residual_findings` | `{PROJECT_DIR}/<id>/residuals.json` → `entries[<plan-id>]` (array semantics preserved) |
| `archived/residuals/<plan-id>.json` | register **close in place** (lifecycle/closed_at/closure_note on the entry) |
| `metadata.tech_debt_summary` | derived `mstar status tech-debt <project-dir>` rollup (v1 stored drift path dead) |
| root `version: 1` | root `version: 2` + `workflows[]` (active-only registry; terminal rows removed after snapshot write) |
| v1 root `plans[]` / `residual_findings` trees | converted in memory by `mstar store upgrade`; the legacy tree is never rewritten |

## v2 root `status.json`

Historical `{HARNESS_DIR}/status.json` was a root register, not the current ACTIVE register:

```json
{ "version": 2, "updated_at": "YYYY-MM-DD",
  "workflows": [{ "id": "<plan-id-or-iteration-id>", "type": "plan | iteration",
                  "started_at": "YYYY-MM-DD", "dir": "workflows/<id>" }] }
```

`dir` is harness-relative (`workflows/<id>`), never absolute. The register held active (`running` / `paused`) workflows; terminal workflows were removed from it. Live registration and close do not write this file.

## `workflows/<id>/snapshot.json`

Read-only import/history (`schema_version: 1`), validated with `validateWorkflowSnapshot`; no snapshot file writer remains. Minimal shape — a row also carried `progress`, `tags`, `created_at`, `updated_at`, `done_at` and `notes`:

```json
{ "schema_version": 1, "id": "iter-demo", "type": "iteration", "status": "running",
  "started_at": "2026-08-30", "phase": "phase-2-execute",
  "plans": [{ "id": "plan-id", "title": "Plan title", "file": "{PLAN_DIR}/plan-id-feature-name.md",
              "status": "InProgress", "owner": "@project-manager",
              "metadata": { "worktree_path": "/abs/parent/repo.worktrees/demo-plan",
                            "working_branch": "feature/demo-plan" } }],
  "execution_policy": { "plan_parallelism": "serial", "worktree_mode": "", "push_policy": "" },
  "branch": { "base": "main", "integration": "iteration/iter-demo", "target": "main" },
  "compass_ref": "iterations/iter-demo/delivery-compass.md"
}
```

The example illustrates a held workflow-wide integration exclusion, not a per-row holder. Release was represented by key absence, never null/empty object.

### Migration-source top-level fields

| Field | Type | Historical semantics |
| --- | --- | --- |
| `integration_merge_lease` | object | While one integration merge was owned; absent = unclaimed. Release deleted the key, never `null` or tombstones. |
| `execution_policy` | object | `plan_parallelism` / `worktree_mode` / `push_policy`, copied from v1 root `metadata` at migration; values were accepted-but-opaque (no semantic gate). |
| `branch` | object | Iteration anchors: `base` (from `iteration_base_branch`), `integration` (`spec_integration_branch`), `target` (final PR target). |
| `integration_worktree_path` | absolute path string | Dedicated integration repository root (not `{HARNESS_DIR}`), on `branch.integration`, distinct from the main worktree. Main/control is Git-derived (`readMainWorktree`), not a snapshot field. Current registration uses the workflow domain operation, never a snapshot edit. |
| `compass_ref` | string | Relative iteration delivery-compass pointer. |
| `legacy_metadata` | object | Unmapped v1 root-`metadata` keys retained at migration. |

Lifecycle and row status fields are scalar enums. Terminal statuses (`completed` / `failed` / `stopped`) require `ended_at` and no dangling leases. Unknown ordinary row fields survive domain updates; retired per-row session/transfer/seal metadata grants no admission.

### Historical notes versus the runtime ledger

`plans[].notes` is a per-plan timeline preserved verbatim at migration, read-only and never a dual-write target. `{WORKFLOW_DIR}/<id>/notes.jsonl` is the plain append-only runtime ledger; new notes append there only. Direct execution import does not seed or rewrite note files from legacy arrays, and the earlier `{HARNESS_DIR}/notes.json` cross-plan timeline is historical.

## `projects/<id>/residuals.json` register

Migration history only: entries are keyed by plan id and each value is an **array**.

```json
{ "entries": { "plan-id": [
  { "id": "R1", "title": "Finding title", "severity": "critical | high | medium | low | nit",
    "source": "QC-#1 qc1.md F-001 @ <review-range>, QA qa.md, review, …",
    "scope": "Affected file or component", "decision": "defer | accept | risk-accepted",
    "owner": "@fullstack-dev", "target": "Before plan 02 / YYYY-MM-DD / milestone",
    "tracking": "Issue URL or null",
    "detail_doc": "{PLAN_DIR}/residuals/plan-id/R1-short-label.md",
    "source_plan": "plan-id", "registered_at": "YYYY-MM-DD",
    "lifecycle_id": "<workflow id when owned by an iteration>" } ] } }
```

- `entries[<plan-id>]` preserves v1 `residual_findings[plan-id]` multi-finding semantics verbatim: a plan may hold two or more open residuals.
- Each entry is the v1 residual entry verbatim plus provenance: required non-empty `source_plan` equals its entries key; required `registered_at` is `YYYY-MM-DD`; optional non-empty `lifecycle_id` identifies the owning workflow when an iteration owns the plan. Mismatched provenance is a violation.
- Project-less flows use `_default` (`projects/_default/`). Optional `detail_doc` is repo-relative under `{PLAN_DIR}/residuals/<plan-id>/`, matching `id` (for example `R1`); omit it when the prose layer is unused.

### Document validation and severity history

`validateResidual(entry)` validates each entry and `validateProjectRegister(doc)` validates the register. The v2 root and migration-source snapshot use `validateStatus` / `validateWorkflowSnapshot` inside migration tooling, not a file-path argument to `mstar status validate` (which reads ACTIVE authority only).

The nine required entry fields mirror `RESIDUAL_REQUIRED_FIELDS`: `id`, `title`, `severity`, `source`, `scope`, `decision`, `owner`, `target`, `tracking`. Non-object entries, missing required fields, or values outside the severity/decision enums are rejected (`ok:false` + violation; `status.residual.invalid-severity` / `status.residual.invalid-decision`), never silently passed through, downgraded or written then patched. A lifecycle value such as `resolved` in `decision` invalidates the whole register. dsh-derived finding keys were mapped before validation; they never entered the schema.

The severity order is `critical` > `high` > `medium` > `low` > `nit`; decision is `defer | accept | risk-accepted`. Legacy **`"severity": "warning"`** is read and rolled up as **`low`**, but is forbidden on new entries. QC Critical / Warning / Suggestion remain report section titles, not JSON severity values; current severity meaning and gate mapping belong to the runtime field reference.

### In-place closure shape of migrated records

| `lifecycle` | Historical meaning | `closure_note` explained |
| --- | --- | --- |
| `open` | Not closed; omitted / `false` / `null` mapped to open | — |
| `resolved` | Fixed in code/config/docs and verified | What changed and how verified |
| `waived` | Explicit decision not to fix | Who decided, why, optional tracking issue |
| `superseded` | Replaced by finding/spec/refactor | `superseded_by` |
| `duplicate` | Duplicate of another R# | Canonical id or mistake note |

Closed records add `lifecycle`, `closed_at` (`YYYY-MM-DD`) and non-empty `closure_note`; optional `closure_evidence` (PR/commit/test/doc anchor) and `superseded_by`. Missing close fields on a non-open record are a violation. Original records and durable plan summaries remain historical evidence.

Old in-place close, empty-key removal, `residual_summary` and deletion rules explain migration inputs only; they create no update/delete duty. Plan ids aligned with register entry keys; no separate `residual_findings_plan_id` was stored. The register is replacement-retired in every authority state (`coordination.store`): do not close or delete entries or update the root. Live items close only through authorized issue dispositions (`mstar plan issue-close` / `mstar issue close | waive | duplicate | supersede`). The retired `mstar status archive-residuals` entry refuses and points to those issue verbs; it does not recreate v1 archives.

### Plan-key compatibility

Historical readers accepted `id` or `plan_id` in v1 rows and entries. Historical writers used one canonical key (prefer `id`) and documented that choice in `{HARNESS_DIR}/AGENTS.md` when migrating. This compatibility note grants no writer or file execution route.

## Retired register-walking tech-debt rollup

The removed `techDebtRollup` walked `{PROJECT_DIR}/<id>/residuals.json` and produced register-era `by_target` / `by_plan` aggregates. It is no longer exported, and the v1 stored-summary drift check (`metadata.tech_debt_summary`) is a dead path. Current `mstar status tech-debt` reads open issues through `readIssueRollup` (`total_open` / `by_severity` / `by_project`), without writing anything; migrated registers are mapping history only.
