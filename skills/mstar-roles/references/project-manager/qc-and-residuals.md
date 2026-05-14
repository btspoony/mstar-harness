# Project Manager QC & Residuals Reference

Use this reference when PM is dispatching QC, consolidating review verdicts, or managing residual findings lifecycle.

## QC Tri-Review Minimal Flow

0. Pre-dispatch read gate: read `mstar-review-qc` for this round.
1. Dispatch three independent QC assignments.
2. Collect reports and verify alignment fields:
   - `plan_id`
   - `Review range / Diff basis`
   - `Review cwd / Worktree path`
   - `Working branch`
3. Verify runtime identity/model mapping for three distinct QC roles.
4. De-duplicate findings and resolve conflicts by evidence strength.
5. Emit one consolidated gate decision.
6. Assign fix owners when needed; send back to dev -> QC/QA revalidation.

## QC / Residual NEVER (PM)

- **NEVER** consolidate tri-review into `Approve` when any QC report’s `plan_id`, `Review range / Diff basis`, `Review cwd / Worktree path`, or `Working branch` **differs** from the PM Assignment text (character-level mismatch).
- **NEVER** register or rewrite residual `severity` values outside the machine enum in `mstar-plan-conventions`.
- **NEVER** drop residual tracking to chat-only when `Approve with residuals` applies—canonical open list lives under `{HARNESS_DIR}/status.json` `residual_findings[<plan-id>]`.
- **NEVER** archive or delete open residual rows from `status.json` without the documented close + `{HARNESS_DIR}/archived/residuals/` workflow.
- **NEVER** treat “two of three QC reports arrived” as sufficient for a parallel tri-review wave—missing reviewer => `Blocked` or explicit PM decision, not silent `Approve`.

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
- Severity enum must follow `mstar-plan-conventions` SSOT.
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
