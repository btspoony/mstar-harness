# `{HARNESS_DIR}/status.json` and Residual Findings (Morning Star)

> **Load order (same as other `mstar-*` skills):** Before changing SSOT / residual fields using this reference, Read **`mstar-harness-core`** (SKILL.md; same-repo branches and worktrees → **`mstar-branch-worktree`**). On conflict, **`mstar-harness-core` wins**; skill index in that SKILL.md.

`status.json` lives at **`{HARNESS_DIR}/status.json`**. It is the **single source of truth (SSOT)** for **`plans[]` row status** and **open residual findings**.  
Canonical vs legacy residual definitions → **`mstar-plan-artifacts` SKILL.md** (“`status.json` and open residual (summary)”); this file covers **fields, severity, lifecycle, archive, and `jq` examples**.  
**Closed** residuals should not accumulate here long-term; authoritative archive → **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`** (see “Residual findings lifecycle”).

**Why this matters:** The open list and `archived/residuals/` are the **cross-session handoff surface** for risk and decisions. Non-blocking conclusions that stay only in chat or a single QC report **without SSOT** cannot be inherited reliably; `Done` drifts from visible known debt. **`@project-manager`** should register trackable open items soon after review closure; **`@qa-engineer`** and PM should close and archive after verification or explicit waiver — flexible timing, but **not** “said in chat is enough.”

## Basic structure

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
        "source": "QC-#1, QC-#3, review, …",
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

**Empty-repo templates:** **`templates/status.empty.json`**; optional **`templates/notes.empty.json`** → `{HARNESS_DIR}/notes.json`. See **`templates/README.md`**.

**Closed entries** add: `lifecycle`, `closed_at`, `closure_note`; optional `closure_evidence`, `superseded_by`. See “Residual findings lifecycle”.

**Open `detail_doc` (optional):** repo-relative path under **`{PLAN_DIR}/residuals/<plan-id>/`** matching **`id`** (e.g. `R1`); omit if prose layer unused (`knowledge-and-designs.md`).

## Residual findings: `severity` (SSOT, machine field)

Each `residual_findings[<plan-id>][]` entry’s **`severity`** must be from this enum (legacy read paths → **`jq` examples** at end). QC report Markdown **Critical / Warning / Suggestion** are **section titles** — **do not** copy them verbatim into JSON `severity`.

### 1. Allowed values

Only these five, **lowercase English**:

`critical`, `high`, `medium`, `low`, `nit`

### 2. Total order (heavy → light)

`critical` > `high` > `medium` > `low` > `nit`

- **`nit` is always lighter than `low`** — never invert or equate.
- **Forbidden** in JSON: `warning`, `Major`, non-English, or any value not listed.

### 3. Meaning and gate relationship

| `severity` | Meaning |
| ---------- | ------- |
| `critical` | Merge-blocking; maps to QC **Critical** findings. |
| `high` | Not blocking but high impact (security, correctness, data, significant tech debt); fix, escalate, or open residual with PM follow-up. |
| `medium` | Should address this or next milestone; may be open residual. |
| `low` | Small impact, cheap fix; may be open residual. |
| `nit` | Style, naming, wording, non-behavior doc nits; **lighter than `low`**. PM may omit from `residual_findings` if no tracking needed. |

Summary vs `mstar-review-qc`: unresolved **`critical`** → usually `Request Changes`; **`high`** often “fix or explicit decision before merge”; **`medium` / `low` / `nit`** may ship with residual tracking (final **Verdict** = PM consolidation).

### 4. QC report section → JSON `severity`

When registering into root **`residual_findings`** (template in `mstar-review-qc`):

| Report Findings section | JSON `severity` |
| ----------------------- | --------------- |
| **Critical** | Default `critical`. PM may record `high` if “not blocking this merge but follow up soon” — state reason in `title`/`scope`. |
| **Warning** | `high` or `medium`: security/correctness/data → `high`; other substantive non-blocking → `medium`; **when unsure, use `high`**. |
| **Suggestion** | `low` or `nit`: substantive improvement → `low`; pure style/optional → `nit`. |

**Common mistake:** report **Warning** is not a valid `severity` string; there is no `warning` in the enum (see legacy below).

### 5. Legacy `"severity": "warning"`

In old JSON, **`"severity": "warning"`** is read and rolled up as **`low`**. **Forbidden** on new entries.

---

## `plans[].metadata` standard optional fields

| Key | Type | Purpose |
| --- | --- | --- |
| `working_branch` | string | Implementation branch; aligns with Assignment **`Working branch`** (SSOT) |
| `spec_integration_branch` | string | (Multi-plan same **Spec**) integration branch name; created from root `metadata.iteration_base_branch`; plan branches merge here before final PR (`mstar-plan-conventions`) |
| `merge_target` | string | Next merge target; multi-plan + Spec → usually `spec_integration_branch`; final PR target is root `metadata.target_branch` |
| `branch_policy` | string | One-line policy per `mstar-harness-core` |
| `phase` | string | Program/roadmap label |
| `priority` | `high` \| `medium` \| `low` | PM scheduling |
| `description` / `scope` | string | One-line scope; pick one key per repo |
| `gates` | object | Gate summary (`qc`, `qa`, `typecheck`, `tests`, `lint`, …) |
| `blocked_since` | `YYYY-MM-DD` | When `status` is `Blocked` |
| `blocked_reason` | string | Block reason |
| `blocked_by_plan_id` | string | Blocking **`plans[].id`** |
| `dependency` | string | Other dependencies |
| `next_action` | string | Next step after unblock/review |
| `primary_spec` | string | Main spec path (`{KNOWLEDGE_DIR}/…`, `{SPECS_DIR}/…`) |
| `iteration_compass` | string | Optional `{ITERATION_DIR}/…` |
| `iteration_refs` | string[] | Optional multiple compass paths |
| `qc_status` / `tests` / `commits` | string | InReview/Done snapshots; not a substitute for `{PLAN_DIR}/reports/` |
| `sdd_dir` | string | SDD scratch path, e.g. `.mstar/sdd/<plan-id>/` (gitignored; `mstar-sdd`) |
| `sdd_progress` | string | Optional pointer to `{SDD_DIR}/progress.md` ledger |
| `task_commits` | array\<object\> | SDD recovery: `{ "task_id": "T1", "base": "<sha>", "head": "<sha>" }` per completed task |

### Optional delivery ledger (`phase` + `batches` + `verification`)

For multi-batch or multi-role plans:

| Key | Type | Purpose |
| --- | --- | --- |
| `phase` | string | Delivery phase label |
| `batches` | array\<object\> | Per-batch task coverage, owner, status, commits, self-audit |
| `verification` | object | Command-level verification snapshot |

Recommended `batches[]` subfields: `index`, `covers`, `status`, `owner`, `commits`, `a2_self_audit` (or synonym), `verification`.

> `batches` / `verification` are evidence indexes — not replacements for `{PLAN_DIR}/reports/` or root `residual_findings`.

### `plans[].notes` vs `{HARNESS_DIR}/notes.json`

- `plans[].notes`: per-plan timeline (string array recommended).
- `{HARNESS_DIR}/notes.json`: cross-plan program milestones.

Legacy string `plans[].notes` is OK; new repos should use arrays with time + event + evidence anchor.

## Root `metadata` standard optional fields

| Key | Type | Purpose |
| --- | --- | --- |
| `versioning` | object | Cross-plan conventions (team-defined) |
| `iteration_base_branch` | string | Branch/ref used to create `spec_integration_branch`; required for formal iterations |
| `target_branch` | string | Final PR target after iteration-close; required for formal iterations |
| `notes` | array | **Legacy** — prefer **`{HARNESS_DIR}/notes.json`** |
| `residual_findings_history` | object | **Legacy** — prefer **`archived/residuals/<plan-id>.json`** |
| `tech_debt_summary` | object | Optional rollup over open R#; maintain via script (below) |

**Formal iteration example** (root `metadata`; values are project-specific — **do not** copy `main` by default):

```json
"metadata": {
  "iteration_base_branch": "release/1.76",
  "target_branch": "release/1.77"
}
```

Plan row (per active iteration plan):

```json
"metadata": {
  "spec_integration_branch": "iteration/v1.77-live-teels",
  "merge_target": "iteration/v1.77-live-teels",
  "iteration_refs": ["v1.77"]
}
```

## General constraints

- Each `plans[]` row may include optional **`metadata`** (`{}` or omit).
- Init with `"residual_findings": {}`; **no dual-write** with legacy side (see SKILL.md). Program timeline → **`notes.json`**, not long `metadata.notes` in `status.json`.
- **`plans[].id`** keys must align with root **`residual_findings`** keys (and `reports/<plan-id>/`). Do not store `residual_findings_plan_id`.
- **Empty `plan-id` key:** when no open items remain, **delete** the key from root **`residual_findings`** (and legacy side if present) — no `"plan-id": []`. Whether **`plans[]`** keeps the row is separate (`done-compaction.md`).
- **`residual_summary` (optional):** one-line human summary of **open** items only.

---

## Residual findings lifecycle (close, archive, remove)

### `lifecycle` (optional; default open)

| `lifecycle` | Meaning | `closure_note` should explain |
| ----------- | ------- | ----------------------------- |
| `open` | Not closed (omit field = open) | — |
| `resolved` | Fixed in code/config/docs and **verified** | What changed; how verified |
| `waived` | Explicit decision not to fix | Who decided; why; optional `tracking` Issue |
| `superseded` | Replaced by new finding/spec/refactor | `superseded_by` |
| `duplicate` | Duplicate of another R# | Canonical `id` or mistake note |

**On close:** set **`closed_at`** (`YYYY-MM-DD`) and **`closure_note`**; recommend **`closure_evidence`** (PR, commit, test, doc anchor).

### Who updates when

| Action | Owner | When |
| ------ | ----- | ---- |
| Implement fix | `@fullstack-dev` / assignee | Completion Report cites R# + evidence |
| Verify | `@qa-engineer` | Regression / acceptance |
| Write `status.json` | **`@project-manager`** or **`@qa-engineer`** | After verification; waivers after PM + user/architect alignment |

Do not claim “R3 fixed” in chat/plan only without SSOT update.

PM should register open items after **`Approve with residuals`**; QA should state each related R# (open / resolved this round / needs waiver).

### Recommended: archive to `archived/residuals/<plan-id>.json`

After **`closed_at`**, **`closure_note`**, and PM/QA confirm close:

1. **Append** to **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`**.
2. **Remove** from open list (root **`residual_findings[<plan-id>]`**; legacy side if used). Delete empty **`plan-id`** keys.
3. Update root **`updated_at`**; optional milestone in **`notes.json`**.

Archive file shape (append to `entries`):

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

- Each archived entry needs **`archived_at`** (`YYYY-MM-DD`).
- Closed records live in archive + QC `reports/`; not in open list.
- After batch archive/close, **refresh `tech_debt_summary`** (script below).

### Short in-place close (transition only)

May set `lifecycle` / `closed_*` in open list for one PR; **same milestone** move to archive + delete from open list.

### Legacy `metadata.residual_findings_history`

Prefer **`archived/residuals/`**; migrate and delete history key when possible.

### Hard delete

- **Forbidden** for **open** entries.
- Do not delete archived entries; correct via new entry or new R# referencing old `id`.
- Mistaken open-only entry: PM may delete or mark **`duplicate`** then close/archive.

### Query open and archived (examples)

```bash
# Replace .mstar with your resolved {HARNESS_DIR}; legacy projects may use .agents.
jq '.residual_findings["01-data-infrastructure"] // .metadata.residual_findings["01-data-infrastructure"]' .mstar/status.json
jq '.entries[] | select(.id == "R1")' .mstar/archived/residuals/01-data-infrastructure.json
bash skills/mstar-plan-artifacts/scripts/tech-debt-rollup.sh .mstar/status.json
```

(`//` right-hand side = legacy read path.)

---

## `{HARNESS_DIR}/notes.json` (optional program timeline)

Append-only log for merge closure, batch archive, `tech_debt_summary` refresh, etc. Does not compete with **`plans[].status`** / open residual SSOT.

```json
{
  "schema_version": 1,
  "updated_at": "YYYY-MM-DD",
  "entries": [
    { "at": "2026-04-08", "message": "Short milestone", "plan_id": "01-data-infrastructure" }
  ]
}
```

- **`@project-manager`** maintains; do not rewrite past `entries` — add correction as new entry.
- **`plans[].notes`**: per-plan; **`notes.json`**: cross-plan.

---

## `metadata.tech_debt_summary` (optional rollup)

**Role:** Cross-plan aggregate over **open** R# in root **`residual_findings`** (and legacy read path if present). Does **not** replace per-entry SSOT.

**Compute (canonical):** run the read-only script (do **not** hand-count):

```bash
# From repo root; pass path to status.json if not .mstar/status.json
bash skills/mstar-plan-artifacts/scripts/tech-debt-rollup.sh .mstar/status.json
```

- Prints computed `total_open`, `by_severity`, `by_target`, `by_plan`.
- Prints **PASS** / **DRIFT** vs stored `metadata.tech_debt_summary`.
- Script **does not write** `status.json` — PM copies computed values into `metadata.tech_debt_summary` after DRIFT or milestone refresh.

**When to refresh:** after QC waves, batch archive of resolved items, or release freeze. Optional `notes.json` entry: “refreshed tech_debt_summary”.

**Recommended stored shape** (`cross_cutting` optional; script does not compute `cross_cutting` — maintain manually if used):

```json
{
  "tech_debt_summary": {
    "updated_at": "YYYY-MM-DD",
    "total_open": 29,
    "by_severity": { "critical": 0, "high": 10, "medium": 10, "low": 5, "nit": 1 },
    "by_target": { "V1.0": 5, "V1.1": 18 },
    "by_plan": { "domain-models": 4, "cli-daemon-foundation": 11 },
    "cross_cutting": [
      {
        "id": "DEBT-X1",
        "title": "Cross-plan theme",
        "severity": "high",
        "relates_to": ["CLI-R9", "SYNC-R4"]
      }
    ]
  }
}
```

- **`by_plan`** keys: short labels or `plans[].id` prefixes per repo convention.
- **`cross_cutting`**: themes spanning plans/R#; explain intentional count differences in `notes.json` or here.

---

## Pre-merge: `status.json` should match reality

Before merge/PR, **`@project-manager`** (or delegate) should verify: `plans[].status`, `metadata.gates`, root **`residual_findings`** (no accidental dual-write), **`tech_debt_summary`** (if used — run script), **`notes.json`** (if used), vs review/CI.

**Common gaps:**

- R# added/closed but **`tech_debt_summary` not refreshed** (script shows DRIFT).
- Finding only in **`plans[].notes`** or chat, not in **`residual_findings[<plan-id>]`**.
- Major milestone with no **`notes.json`** entry when team uses program timeline.

## Compatibility: plan key names

- Read: accept `id` or `plan_id`.
- Write: one canonical key (prefer `id`).
- Document canonical key in `{HARNESS_DIR}/AGENTS.md` if migrating.

## Common queries

```bash
jq '.plans[] | select(.id == "01-data-infrastructure")' .mstar/status.json
jq '.residual_findings["01-data-infrastructure"] // .metadata.residual_findings["01-data-infrastructure"]' .mstar/status.json
```
