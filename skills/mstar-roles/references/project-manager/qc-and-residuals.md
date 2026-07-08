# Project Manager QC & Residuals Reference

Use this reference when PM is dispatching QC, consolidating review verdicts, or managing residual findings lifecycle.

**Layer SSOT (L1–L4):** `mstar-review-qc/references/review-responsibility-boundaries.md`. Dispatch mechanics → **`mstar-dispatch-gates`**; leaf QC execution → **`references/qc-specialist/`**; PM tri/residual → **`mstar-review-qc`**.

## SDD path: mandatory plan QC tri-review (L3)

**When:** `Execution mode: sdd` — **all** multi-task implement flows (single plan **or** `mstar-iteration` Phase 2).

**Per-task (L2):** task reviewer only — **not** `qc-specialist`. One reviewer subagent per task (spec + quality on task diff).

**After all tasks (L3):** see **`mstar-review-qc/references/review-responsibility-boundaries.md`** · **`mstar-dispatch-gates`** (N=3 same message, branch review-package under `{SDD_DIR}/review/`, `qc1`…`qc3` + consolidated). PM checklist:

0. Pre-dispatch: read `mstar-review-qc`.
1. `review-package MERGE_BASE HEAD` → branch diff under `{SDD_DIR}/review/`.
2. Dispatch **three** QC seats in **one** message (**N=3**); alignment fields text-identical across reports and Assignment.
3. PM writes `{SDD_DIR}/review/qc-consolidated.md` + main plan durable summary; after fixes → targeted re-review (default) or `QC re-review: full tri-review` for new wave files.

**NEVER** end an SDD plan with only a single final `qc-specialist` unless user override: `QC mode: single — override: <reason>`.

## Inline / hotfix: single-seat QC (exception)

**When:** `Execution mode: inline` or explicit hotfix routing.

1. Branch review-package path on dispatch.
2. **One** `qc-specialist` → `{SDD_DIR}/review/qc.md` (**N=1**).
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
- **NEVER** create `qc1-rev2.md` for **targeted** re-review; update original bundle `qcN.md` in place.

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
- Required durable gate summary in main plan should list R# ids and decisions, but never replace canonical entries.

Each residual record should include:

- `id`, `title`, `severity`, `source`, `scope`, `decision`, `owner`, `target milestone/date`, `tracking link`

`Approve with residuals` is only valid when no unresolved blocking items remain.

## Residual Closure & Archive

After a residual is fixed/accepted/replaced:

- Update closure fields
- Archive to `{HARNESS_DIR}/archived/residuals/<plan-id>.json`
- Remove closed record from open `residual_findings` list in `status.json`

Do not hard-delete open records without archival semantics.
