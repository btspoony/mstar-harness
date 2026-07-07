# Project Manager QC & Residuals Reference

Use this reference when PM is dispatching QC, consolidating review verdicts, or managing residual findings lifecycle.

## SDD path: mandatory plan QC tri-review (L3)

**When:** `Execution mode: sdd` — **all** multi-task implement flows (single plan **or** `mstar-iteration` Phase 2).

**Per-task (L2):** task reviewer only — **not** `qc-specialist`. One reviewer subagent per task (spec + quality on task diff).

**After all tasks (L3):**

0. Pre-dispatch: read `mstar-review-qc`.
1. `review-package MERGE_BASE HEAD` → branch diff under `{SDD_DIR}` or PM path.
2. Dispatch **three** QC seats in **one** message (**N=3**), **`QC mode: full tri-review`**:
   - QC#1 `qc-specialist` → `qc1.md` (architecture / maintainability)
   - QC#2 `qc-specialist-2` → `qc2.md` (security / correctness) — **cross-review** same branch diff
   - QC#3 `qc-specialist-3` → `qc3.md` (performance / reliability) — **cross-review** same branch diff
3. Alignment fields text-identical across three reports and Assignment.
4. PM writes `qc-consolidated.md`; gate decision from consolidated + three originals.
5. After fixes: targeted re-review per seat (default) or `QC re-review: full tri-review` for new wave files.

**NEVER** end an SDD plan with only a single final `qc-specialist` unless user override: `QC mode: single — override: <reason>`.

## Inline / hotfix: single-seat QC (exception)

**When:** `Execution mode: inline` or explicit hotfix routing.

1. Branch review-package path on dispatch.
2. **One** `qc-specialist` → `qc.md` (**N=1**).
3. Targeted re-review updates same `qc.md`.

## QC / Residual NEVER (PM)

- **NEVER** dispatch plan QC without a **branch** review-package file path (MERGE_BASE..HEAD).
- **NEVER** use single-seat `qc.md` after **`Execution mode: sdd`** without documented user override.
- **NEVER** dispatch only QC#2 and QC#3 while skipping QC#1 on initial SDD tri wave — full **N=3** cross-review required (all three seats).
- **NEVER** consolidate tri-review into `Approve` when any QC report's alignment fields differ from Assignment (character-level).
- **NEVER** register or rewrite residual `severity` outside `mstar-plan-artifacts` machine enum.
- **NEVER** drop residual tracking to chat-only when `Approve with residuals` applies.
- **NEVER** treat "two of three QC reports arrived" as sufficient — missing seat → `Blocked`.
- **NEVER** re-dispatch all three after routine fix when only one or two had blockers — **targeted re-review** unless `QC re-review: full tri-review`.
- **NEVER** create `qc1-rev2.md` for **targeted** re-review; update original `qcN.md` in place.

## Consolidated Decision Template

```markdown
## QC Consolidated Decision

**Decision**: Approve | Request Changes | Needs Discussion
**Blocking Items**: {list or None}
**Residual Findings**: {list with owner/target date, or None}
**Assigned Fix Owners**: {role list}
**Next Step**: {back to dev fix | to QA verification}
```

## Quick Decision Rules

- Any unresolved `Critical` -> `Request Changes`
- No `Critical`, but unresolved high-impact warning with disagreement -> `Needs Discussion`
- Otherwise -> `Approve`

## Residual Findings (Mandatory)

When blocking issues are fixed but non-blocking warnings/suggestions remain:

- Must register residual findings (do not leave as chat-only).
- Severity enum must follow `mstar-plan-artifacts` SSOT.
- Canonical store: `{HARNESS_DIR}/status.json` -> root `residual_findings[<plan-id>]`.
- Optional mirrored index in main plan is allowed, but never replace canonical entry.

Each residual record should include:

- `id`, `title`, `severity`, `source`, `scope`, `decision`, `owner`, `target milestone/date`, `tracking link`

`Approve with residuals` is only valid when no unresolved blocking items remain.

## Residual Closure & Archive

After a residual is fixed/accepted/replaced:

- Update closure fields
- Archive to `{HARNESS_DIR}/archived/residuals/<plan-id>.json`
- Remove closed record from open `residual_findings` list in `status.json`

Do not hard-delete open records without archival semantics.
