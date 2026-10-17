# Migration-source shapes (historical archive)

This reference preserves retired execution transports and project-register shapes for historical interpretation and migration mapping only. **No execution route and no live writer exists for these files.** ACTIVE execution and open findings belong to `{HARNESS_DIR}/store.db`; without ACTIVE authority, execution is tracked in conversation (no-plan mode). Current operations and field authority remain in the runtime field reference, not this archive.

Recognized v1/v2 execution sources are read directly by `mstar store upgrade`, preserving original source bytes. Standalone `mstar migrate` staging is retired; mentions below describe historical migration, never a command to run. Project-register import uses the separate reviewed `mstar store migrate` flow.

## v2 root `status.json`

Historical `{HARNESS_DIR}/status.json` was a root register, not the current ACTIVE register:

```json
{
  "version": 2,
  "updated_at": "YYYY-MM-DD",
  "workflows": [
    {
      "id": "<plan-id-or-iteration-id>",
      "type": "plan | iteration",
      "started_at": "YYYY-MM-DD",
      "dir": "workflows/<id>"
    }
  ]
}
```

`dir` is harness-relative (`workflows/<id>`), never absolute. The register held active (`running` / `paused`) workflows; terminal workflows were removed from it. Live registration and close do not write this file.

## `workflows/<id>/snapshot.json`

Read-only import/history (`schema_version: 1`), validated with `validateWorkflowSnapshot`; no snapshot file writer remains:

```json
{
  "schema_version": 1,
  "id": "iter-demo",
  "type": "iteration",
  "status": "running",
  "started_at": "2026-08-30",
  "updated_at": "2026-08-30",
  "phase": "phase-2-execute",
  "plans": [
    {
      "id": "plan-id",
      "title": "Plan title",
      "file": "{PLAN_DIR}/plan-id-feature-name.md",
      "status": "InProgress",
      "owner": "@project-manager",
      "agents": ["@fullstack-dev"],
      "progress": 0,
      "tags": [],
      "created_at": "2026-08-29",
      "updated_at": "2026-08-30",
      "done_at": null,
      "notes": [],
      "metadata": {
        "worktree_path": "/abs/parent/repo.worktrees/demo-plan",
        "working_branch": "feature/demo-plan"
      }
    }
  ],
  "execution_policy": {
    "plan_parallelism": "serial",
    "worktree_mode": "",
    "push_policy": ""
  },
  "integration_merge_lease": {
    "holder": "omp:demo-session",
    "claimed_at": "2026-08-30T03:00:00Z",
    "plan_id": "plan-id",
    "source_branch": "feature/demo-plan",
    "target_branch": "iteration/iter-demo"
  },
  "branch": { "base": "main", "integration": "iteration/iter-demo", "target": "main" },
  "integration_worktree_path": "/abs/parent/repo.worktrees/iter-demo-integration",
  "legacy_metadata": {},
  "compass_ref": "iterations/iter-demo/delivery-compass.md"
}
```

The example illustrates a held workflow-wide integration exclusion, not a per-row holder. Release was represented by key absence, never null/empty object. Lifecycle and row status fields are scalar enums. Terminal statuses (`completed` / `failed` / `stopped`) require `ended_at` and no dangling leases. Unknown ordinary row fields survive domain updates; retired per-row session/transfer/seal metadata grants no admission.

### Migration-source top-level fields

| Field | Type | Historical semantics |
| --- | --- | --- |
| `integration_merge_lease` | object | While one integration merge was owned; absent = unclaimed. Release deleted the key, never `null` or tombstones. |
| `execution_policy` | object | `plan_parallelism` / `worktree_mode` / `push_policy`, copied from v1 root `metadata` at migration; values were accepted-but-opaque (no semantic gate). |
| `branch` | object | Iteration anchors: `base` (from `iteration_base_branch`), `integration` (`spec_integration_branch`), `target` (final PR target). |
| `integration_worktree_path` | absolute path string | Dedicated integration repository root (not `{HARNESS_DIR}`), on `branch.integration`, distinct from the main worktree. Main/control is Git-derived (`readMainWorktree`), not a snapshot field. Current registration uses the workflow domain operation, never a snapshot edit. |
| `compass_ref` | string | Relative iteration delivery-compass pointer. |
| `legacy_metadata` | object | Unmapped v1 root-`metadata` keys retained at migration. |

### Historical notes versus the runtime ledger

`plans[].notes` is a per-plan timeline preserved verbatim at migration, read-only and never a dual-write target. `{WORKFLOW_DIR}/<id>/notes.jsonl` is the plain append-only runtime ledger; new notes append there only. Direct execution import does not seed or rewrite note files from legacy arrays. The earlier `{HARNESS_DIR}/notes.json` cross-plan timeline is historical (shape in `references/status-field-history.md`), not the runtime ledger.

## `projects/<id>/residuals.json` register

Migration history only: entries are keyed by plan id and each value is an **array**.

```json
{
  "entries": {
    "plan-id": [
      {
        "id": "R1",
        "title": "Finding title",
        "severity": "critical | high | medium | low | nit",
        "source": "QC-#1 qc1.md F-001 @ <review-range>, QA qa.md, review, …",
        "scope": "Affected file or component",
        "decision": "defer | accept | risk-accepted",
        "owner": "@fullstack-dev",
        "target": "Before plan 02 / YYYY-MM-DD / milestone",
        "tracking": "Issue URL or null",
        "detail_doc": "{PLAN_DIR}/residuals/plan-id/R1-short-label.md",
        "source_plan": "plan-id",
        "registered_at": "YYYY-MM-DD",
        "lifecycle_id": "<workflow id when owned by an iteration>"
      }
    ]
  }
}
```

- `entries[<plan-id>]` preserves v1 `residual_findings[plan-id]` multi-finding semantics verbatim: a plan may hold two or more open residuals.
- Each entry is the v1 residual entry verbatim plus provenance: required non-empty `source_plan` equals its entries key; required `registered_at` is `YYYY-MM-DD`; optional non-empty `lifecycle_id` identifies the owning workflow when an iteration owns the plan. Mismatched provenance is a violation.
- Project-less flows use `_default` (`projects/_default/`).
- Optional `detail_doc` is repo-relative under `{PLAN_DIR}/residuals/<plan-id>/`, matching `id` (for example `R1`); omit it when the prose layer is unused.

### Document validation and severity history

`validateResidual(entry)` validates each entry and `validateProjectRegister(doc)` validates the register. The v2 root and migration-source snapshot use `validateStatus` / `validateWorkflowSnapshot` inside migration tooling, not a file-path argument to `mstar status validate` (which reads ACTIVE authority only).

The nine required entry fields mirror `RESIDUAL_REQUIRED_FIELDS`: `id`, `title`, `severity`, `source`, `scope`, `decision`, `owner`, `target`, `tracking`. Non-object entries, missing required fields, or values outside severity/decision enums are rejected (`ok:false` + violation; `status.residual.invalid-severity` / `status.residual.invalid-decision`), never silently passed through, downgraded or written then patched. A lifecycle value such as `resolved` in `decision` invalidates the whole register. dsh-derived finding keys were mapped before validation; they never entered the schema.

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

Old in-place close, empty-key removal, `residual_summary` and deletion rules explain migration inputs only; they create no update/delete duty. Plan ids aligned with register entries keys; no separate `residual_findings_plan_id` was to be stored. The register is replacement-retired in every authority state (`coordination.store`); do not close/delete entries or update the root. Live items close only through authorized issue dispositions (`mstar plan issue-close` / `mstar issue close | waive | duplicate | supersede`). The retired `mstar status archive-residuals` entry refuses and points to those issue verbs; it does not recreate v1 archives.

## v1 read paths and jq examples

Historical readers used root `residual_findings`, `metadata.residual_findings`, and `archived/residuals/<plan-id>.json`. Historical migration moved open entries into the register; both old sources and register entries are now superseded by store issues (`mstar issue list` / `mstar issue show`). Full v1 field and archive shapes remain in `references/status-field-history.md`.

```bash
# Read retained files only; replace the placeholder with the resolved harness root.
jq '.plans[] | select((.id // .plan_id) == "plan-demo")' '{HARNESS_DIR}/status.json'
jq '.residual_findings["plan-demo"] // .metadata.residual_findings["plan-demo"]' '{HARNESS_DIR}/status.json'
jq '.entries[] | select(.id == "R1")' '{HARNESS_DIR}/archived/residuals/plan-demo.json'
```

### Plan-key compatibility

Historical readers accept `id` or `plan_id` in v1 rows/entries. Historical writers used one canonical key (prefer `id`) and documented that choice in `{HARNESS_DIR}/AGENTS.md` when migrating. This compatibility note grants no writer or file execution route.

## Retired register-walking tech-debt rollup

The removed `techDebtRollup` walked `{PROJECT_DIR}/<id>/residuals.json` and produced register-era `by_target` / `by_plan` aggregates. It is no longer exported. The v1 stored-summary drift check (`metadata.tech_debt_summary`) is a dead path. Current `mstar status tech-debt` reads open issues through `readIssueRollup` (`total_open` / `by_severity` / `by_project`), without writing anything; migrated registers are mapping history only.
