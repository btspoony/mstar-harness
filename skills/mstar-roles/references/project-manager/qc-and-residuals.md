# Project Manager QC & Findings Reference

Use this reference when PM is dispatching QC, consolidating review verdicts, or running the findings lifecycle (capture the confirmed ones as issues; close with a disposition).

**Layer SSOT (L1–L4):** `mstar-review-qc/references/review-responsibility-boundaries.md`. Dispatch mechanics → **`mstar-dispatch-gates`**; leaf QC execution → **`references/qc-specialist/`**; PM tri / findings → **`mstar-review-qc`**; capture contract → **`mstar-project-governance`「Issue capture」**.

**L3 reminder:** QC = **code review** (diff + lenses). Do **not** ask seats to run test/build/lint on the shared `Review cwd`. Missing runtime evidence → `QA gate` / L1, not extra QC commands.

## SDD path: mandatory plan QC tri-review (L3)

**When:** `Execution mode: sdd` — **all** multi-task implement flows (single plan **or** `mstar-iteration` Phase 2).

**Per-task (L2):** task reviewer only — **not** `qc-specialist`. One reviewer subagent per task (spec + quality on task diff).

**After all tasks (L3):** see **`mstar-review-qc/references/review-responsibility-boundaries.md`** · **`mstar-dispatch-gates`** (N=3 same message, branch review-package under `{SDD_DIR}/review/`, `qc1`…`qc3` + consolidated). PM checklist:

0. Pre-dispatch: read `mstar-review-qc`.
1. `review-package MERGE_BASE HEAD` → branch diff under `{SDD_DIR}/review/`.
2. Dispatch **three** QC seats in **one** message (**N=3**); alignment fields text-identical across reports and Assignment.
3. PM writes `{SDD_DIR}/review/qc-consolidated.md` + main plan durable summary; after fixes → targeted re-review of affected findings and fix delta; three seats only when all three have affected findings (new wave files do not broaden scope).

**NEVER** end an SDD plan with only a single final `qc-specialist` unless user override: `QC mode: single — override: <reason>`.

## Inline / hotfix: single-seat QC (exception)

**When:** `Execution mode: inline` or explicit hotfix routing.

1. Branch review-package path on dispatch.
2. **One** `qc-specialist` → `{SDD_DIR}/review/qc.md` (**N=1**).
3. Targeted re-review updates same `qc.md`.

## QC / Findings NEVER (PM)

- **NEVER** dispatch plan QC without a **branch** review-package file path (MERGE_BASE..HEAD).
- **NEVER** use single-seat `qc.md` after **`Execution mode: sdd`** without documented user override.
- **NEVER** dispatch only QC#2 and QC#3 while skipping QC#1 on initial SDD tri wave — full **N=3** cross-review required (all three seats).
- **NEVER** consolidate tri-review into `Approve` when any QC report's alignment fields differ from Assignment (character-level).
- **NEVER** write a non-canonical `severity` on a captured issue — the machine enum comes from `mstar-artifacts` (`references/status-and-residuals.md`).
- **NEVER** under `Findings cleanup: zero-residual`, use `Approve with residuals` or leave an issue open for a fixable finding — fix-now + re-review; an open issue only for true blocker-defer + roadmap.
- **NEVER** drop finding tracking to chat-only when `Approve with residuals` applies — confirmed findings are captured as issues per the capture contract.
- **NEVER** treat "two of three QC reports arrived" as sufficient — missing seat → `Blocked`.
- **NEVER** re-dispatch all three after routine fix when only one or two had blockers — **targeted re-review**; the `full tri-review` label changes seats, never the allowed delta.
- **NEVER** create `qc1-rev2.md` for **targeted** re-review; update original bundle `qcN.md` in place.

## Consolidated Decision Template

```markdown
## QC Consolidated Decision

**Decision**: Approve | Request Changes | Needs Discussion | Unconfirmed
**Blocking Items**: {list or None}
**Open findings**: {each open issue: id + severity + tracking location + owner/target date, or `N/A — none open`}
**Assigned Fix Owners**: {role list}
**Next Step**: {back to dev fix | to QA verification}
```

## Quick Decision Rules

- Any seat `Unconfirmed` (evidence-channel failure) -> Decision: `Unconfirmed` (supplement evidence, then re-converge); never falls through to `Approve`
- Any unresolved `Critical` -> `Request Changes`
- No `Critical`, but unresolved high-impact warning with disagreement -> `Needs Discussion`
- Otherwise -> `Approve`

## Findings (Mandatory)

Read Assignment **`Findings cleanup`** first (`mstar-artifacts` — Findings cleanup modes). Capture contract and authorization → **`mstar-project-governance`「Issue capture」**.

### When `Findings cleanup: zero-residual` (explicit opt-in)

- Prefer **fix-now + targeted re-review** for Critical / Warning / Suggestion that can be fixed this session.
- **NEVER** park fixable findings as open issues or use `Approve with residuals` for them.
- Capture an open issue **only** for true blocker-defers (`decision: defer` + Durable Roadmap + `target` next iteration/milestone) — never a `critical` (`mstar-artifacts` Findings cleanup modes).
- `nit`: fix or drop (no issue).
- Plan Done: prefer an empty open list; any remaining open issue must all be blocker-defer + roadmap — never a `critical` (`mstar-artifacts` Findings cleanup modes).

### When `Findings cleanup: allow-residual` (default)

The default mode (iteration Phase 2 included; `zero-residual` is the explicit opt-in). When blocking issues are fixed but non-blocking warnings/suggestions remain:

- Confirmed findings must be captured as **issues linked to this plan** before the plan leaves InReview (do not leave as chat-only) — plan-scoped `mstar plan issue-add`, unscoped `mstar issue add`.
- Severity on each captured issue must follow `mstar-artifacts` SSOT.
- Where the findings live: issues in `{HARNESS_DIR}/store.db`, linked to this plan; the project `residuals.json` register is migration history with no write path.
- Required durable gate summary in main plan should list issue ids and decisions, but never replace the store as the SSOT.
- Every consolidated QC decision, Completion Report, and Status Update discloses the open-finding situation — the list, each issue's severity, and its tracking location (`N/A — none open` when none). Silence about open findings is a gate violation.
- Close-time artifacts (main plan `## Review Gate Summary`, compass `## Quality Gate Summary`, PR body) carry the same list plus a blocker-defer flag; a close without these disclosures is not a close. Disclosure never closes an issue and never overrides critical blocking or explicit `zero-residual` rules.

Each captured issue should include:

- `title`, `severity`, `source`, `scope`, plus the evidence the capture input carries

`Approve with residuals` is only valid when no unresolved blocking items remain (and under `zero-residual`, only when leftovers are blocker-defers).

## Finding Closure

After a finding is fixed/accepted/replaced:

- Close the issue through the closure authority (issue contract §4): plan-scoped `mstar plan issue-close --issue <id> --disposition <resolved|waived|duplicate|superseded> --file <evidence.json>`, or unscoped `mstar issue close|waive|duplicate|supersede`.
- The disposition and its closure evidence are the durable record; the retired register's `lifecycle` / `closed_at` / `closure_note` fields only describe migrated rows, and the v1 `archived/residuals/` archive path plus the residual-archival command are removed.

Do not leave a confirmed finding uncaptured.
