# Status v1→v2 field history (archived contract prose)

> Engine-absent fallback: the full field tables displaced from `mstar-artifacts` when engine validators took over the same contract. Engine-present hosts read `mstar-artifacts/references/status-and-residuals.md` (v2) instead; this file is the historical + fallback full text.

## v1 `{HARNESS_DIR}/status.json` — full shape (historical)

`status.json` lived at `{HARNESS_DIR}/status.json` and was the **SSOT** for `plans[]` row status and open residual findings. Closed residuals were archived to `{HARNESS_DIR}/archived/residuals/<plan-id>.json`.

```json
{
  "version": 1,
  "updated_at": "YYYY-MM-DD",
  "plans": [
    {
      "id": "plan-id",
      "title": "Plan title",
      "file": "{PLAN_DIR}/plan-id-feature-name.md",
      "status": "Todo | InProgress | InReview | Blocked | Done",
      "owner": "@project-manager",
      "agents": ["@fullstack-dev"],
      "progress": 0,
      "tags": [],
      "created_at": "YYYY-MM-DD",
      "updated_at": "YYYY-MM-DD",
      "done_at": null,
      "notes": "",
      "metadata": {}
    }
  ],
  "residual_findings": {
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
        "detail_doc": "{PLAN_DIR}/residuals/plan-id/R1-short-label.md"
      }
    ]
  },
  "metadata": {}
}
```

Closed residual entries added: `lifecycle`, `closed_at`, `closure_note`; optional `closure_evidence`, `superseded_by`.

## v1 `plans[]` row fields

| Field | Meaning |
| --- | --- |
| `id` | Plan id (legacy alias `plan_id` read-compatible). |
| `title` / `file` | Display title / main plan path (`{PLAN_DIR}/…`). |
| `status` | `Todo \| InProgress \| InReview \| Blocked \| Done` (Done only by `@project-manager` / `@qa-engineer`). |
| `owner` / `agents` / `progress` / `tags` | PM ownership, role agents, progress 0–100, tags. |
| `created_at` / `updated_at` / `done_at` | `YYYY-MM-DD`; `done_at` set at Done. |
| `notes` | Per-plan timeline (string array recommended; legacy string OK). |
| `metadata` | Optional object (see below). |

## v1 `plans[].metadata` standard optional fields

| Key | Type | Purpose |
| --- | --- | --- |
| `findings_cleanup` | `zero-residual` \| `allow-residual` | Mirror of Assignment `Findings cleanup`. |
| `working_branch` | string | Implementation branch; aligns with Assignment `Working branch` (SSOT). |
| `spec_integration_branch` | string | (Multi-plan same Spec) integration branch; created from root `metadata.iteration_base_branch`. |
| `merge_target` | string | Next merge target; final PR target is root `metadata.target_branch`. |
| `branch_policy` | string | One-line policy per `mstar-harness-core`. |
| `phase` / `priority` / `description` / `scope` | string | Program label; `high\|medium\|low`; one-line scope (pick one key per repo). |
| `gates` | object | Gate summary (`qc`, `qa`, `typecheck`, `tests`, `lint`, …). |
| `blocked_since` / `blocked_reason` / `blocked_by_plan_id` / `dependency` / `next_action` | string | Block bookkeeping + deps + next step. |
| `primary_spec` / `iteration_compass` / `iteration_refs` | string / string[] | Spec / compass pointers. |
| `qc_status` / `tests` / `commits` | string | InReview/Done snapshots — not a substitute for durable gate summaries or root `residual_findings`. |
| `sdd_dir` / `sdd_progress` / `review_bundle` / `task_commits` | string / array | SDD scratch path, progress ledger pointer, review bundle pointer, `{task_id,base,head}[]`. |

### v1 `plans[].execution_lease` (iteration Phase 2)

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `holder` | non-empty string | Yes | Opaque cooperative owner identity (recommended `<host>:<stable-session-id>`, e.g. `cursor:bc-1234`); stable for claim lifetime; **no credentials**; used for ownership comparison — not `session_label`. |
| `claimed_at` | RFC 3339 UTC (`Z`) | Yes | Acquisition time (audit only; **not** an expiry clock). |
| `worktree_path` | absolute path string | Yes | Dedicated feature-worktree root; **MUST** differ from `metadata.control_worktree_path`. |
| `working_branch` | non-empty string | Yes | Feature branch at `worktree_path`; MUST agree with Assignment `Working branch`. |
| `session_label` | string | No | Human display only — **MUST NOT** authorize or compare ownership. |

Writers **delete** `execution_lease` on release; `null` and tombstone objects are invalid.

## v1 root `metadata` standard optional fields

| Key | Type | Purpose |
| --- | --- | --- |
| `versioning` | object | Cross-plan conventions (team-defined). |
| `iteration_base_branch` | string | Branch/ref used to create `spec_integration_branch`; required for formal iterations. |
| `target_branch` | string | Final PR target after iteration-close; required for formal iterations. |
| `notes` | array | **Legacy** — prefer `{HARNESS_DIR}/notes.json`. |
| `residual_findings_history` | object | **Legacy** — prefer `archived/residuals/<plan-id>.json`. |
| `tech_debt_summary` | object | Optional rollup over open R# (engine `techDebtRollup`). |
| `control_worktree_path` | absolute path string | Iteration Phase 2: canonical repository root checked out to active `spec_integration_branch`; coordination + serial merge cwd. |
| `integration_merge_lease` | object | While one integration merge is owned; **absent** = unclaimed. Writers **delete** the key on release — never `null`/tombstones. |

## v1 residual entry contract (9 required fields + severity/lifecycle)

Entry keys mirroring engine `RESIDUAL_REQUIRED_FIELDS`: `id`, `title`, `severity`, `source`, `scope`, `decision`, `owner`, `target`, `tracking` (+ optional `detail_doc`). Malformed entries (non-object, missing any required field, or severity outside enum) were rejected fail-loud by `validateResidual` / `validateStatus` — never silent pass-through.

### Severity (machine enum, lowercase English only)

`critical` > `high` > `medium` > `low` > `nit`. `nit` is always lighter than `low`. Forbidden in JSON: `warning`, `Major`, non-English. Legacy `"severity": "warning"` read+rolled up as `low`. QC report **Critical / Warning / Suggestion** are section titles — never copied verbatim into JSON.

### Lifecycle states

`open` (default; omit field) · `resolved` · `waived` · `superseded` · `duplicate`. On close set `closed_at` (`YYYY-MM-DD`) + `closure_note`; recommend `closure_evidence` (PR/commit/test/doc anchor). Owners: fix → implementer; verify → QA (when `QA gate: mandatory`) else PM; write SSOT → PM or QA.

## v1 archive shapes (historical)

**`archived/residuals/<plan-id>.json`** (append to `entries`):

```json
{
  "plan_id": "01-data-infrastructure",
  "schema_version": 1,
  "entries": [
    {
      "id": "R1",
      "severity": "medium",
      "lifecycle": "resolved",
      "closed_at": "2026-04-06",
      "closure_note": "…",
      "closure_evidence": "PR #42 / commit …",
      "archived_at": "2026-04-07"
    }
  ]
}
```

**`{HARNESS_DIR}/notes.json`** (append-only program timeline):

```json
{ "schema_version": 1, "updated_at": "YYYY-MM-DD",
  "entries": [{ "at": "2026-04-08", "message": "Short milestone", "plan_id": "01-data-infrastructure" }] }
```

`plans[].notes` = per-plan timeline; `notes.json` = cross-plan milestones.

## v1 jq / flock examples (legacy read paths)

```bash
# Replace .mstar with your resolved {HARNESS_DIR}; legacy projects may use .agents.
jq '.plans[] | select(.id == "01-data-infrastructure")' .mstar/status.json
jq '.residual_findings["01-data-infrastructure"] // .metadata.residual_findings["01-data-infrastructure"]' .mstar/status.json
jq '.entries[] | select(.id == "R1")' .mstar/archived/residuals/01-data-infrastructure.json
```

Legacy read paths (root `residual_findings` / `metadata.residual_findings` / `archived/residuals/<plan-id>.json`) were **legacy read-only**; `mstar migrate` moved open entries into the register.

## v2 destinations (where each v1 surface landed)

| v1 surface | v2 home |
| --- | --- |
| root `plans[]` rows | `{WORKFLOW_DIR}/<id>/snapshot.json` → `plans[]` (legacy PlanRow shape verbatim) |
| root `plans[].execution_lease` | snapshot plan row `execution_lease` |
| root `metadata.integration_merge_lease` | snapshot top-level `integration_merge_lease` |
| root `metadata.control_worktree_path` | snapshot top-level `control_worktree_path` |
| root `metadata.iteration_base_branch` / `target_branch` / `spec_integration_branch` / `merge_target` | snapshot top-level `branch.{base,integration,target}` |
| root `metadata.plan_parallelism` / `worktree_mode` / `push_policy` | snapshot `execution_policy` |
| root `metadata.notes` / legacy row `notes` | `{WORKFLOW_DIR}/<id>/notes.jsonl` (runtime ledger; row `notes` kept verbatim as legacy copy) |
| root `residual_findings` | `{PROJECT_DIR}/<id>/residuals.json` → `entries[<plan-id>]` (array semantics preserved) |
| `archived/residuals/<plan-id>.json` | register **close in place** (lifecycle/closed_at/closure_note on the entry) |
| `metadata.tech_debt_summary` | derived `mstar status tech-debt <project-dir>` rollup (v1 stored drift path dead) |
| root `version: 1` | root `version: 2` + `workflows[]` (active-only registry; terminal rows removed after snapshot write) |
| v1 root `plans[]`/`residual_findings` trees | migrated first via `mstar migrate [--dry-run] [--path <root>]` |

Root v2 shape:

```json
{ "version": 2, "updated_at": "YYYY-MM-DD",
  "workflows": [{ "id": "<plan-or-iteration-id>", "type": "plan | iteration", "started_at": "YYYY-MM-DD", "dir": "workflows/<id>" }] }
```

## Compatibility

- Read: accept `id` or `plan_id`; write: one canonical key (prefer `id`).
- Document the canonical key in `{HARNESS_DIR}/AGENTS.md` if migrating.
