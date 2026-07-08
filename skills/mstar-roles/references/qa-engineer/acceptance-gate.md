# QA Acceptance Gate (L4)

Extension of `references/qa-engineer.md`. Read when PM dispatches you with **`QA gate: mandatory`** or **`QA gate: report-only`**.

Layer **L4** runs after the QC gate. **`QA gate: pm-acceptance`** is PM-only — see **`references/project-manager/qa-trigger-matrix.md`**.

**Do not collapse L4 into L3.** QC reviewers do not close residuals or mark plan `Done`.

## Scope (L4 vs L3)

| L3 Plan QC | L4 QA (`qa-engineer`) |
| --- | --- |
| Independent cross-review lenses on branch diff | Acceptance against plan DoD + review bundle QC consolidated input |
| Find defects; `Request Changes` / residual registration | Verify fixes, R# lifecycle, Done recommendation |
| Typically read-only on product code | May run targeted checks; default **evidence reuse** |

## QA modes

| `QA mode` | When | Behavior |
| --- | --- | --- |
| **`acceptance-only`** (default) | Most `mandatory` dispatches | Map DoD to QC/dev evidence; re-run only gaps listed below |
| **`full`** | High-risk ops, user override, or gaps below | Full verification commands for assigned scope |
| **`report-only`** | `QA gate: report-only` | Structured findings; no business-code edits unless allowed |

## Evidence reuse first (`acceptance-only`)

When **`QA mode: acceptance-only`**:

1. Read `{SDD_DIR}/review/qc-consolidated.md` (or `{SDD_DIR}/review/qc.md`) **Tools run** and dev Completion Report / SDD TDD triple.
2. If QC report includes **reproducible test commands + output** for the same **`Review range / Diff basis`** as Assignment → **verify mapping** to plan Acceptance Criteria; **do not** default to a full suite re-run.
3. Document in Completion Report **Validation**: which ACs are covered by reused evidence vs newly executed checks.

## Mandatory full re-run

Run full verification (or escalate to **`QA mode: full`**) when **any** applies:

- Assignment says **`QA mode: full`**
- QC report lacks reproducible test evidence for behavior-critical ACs
- Post–fix-wave scope: `Review range` changed since QC consolidated
- UI observable gate required and QC/dev left no screenshot, preview URL, or equivalent
- Open R# marked resolved this round — verify each with targeted repro/tests

## Unchanged hard duties

Before sign-off or Done recommendation:

- Validate phase-gate prerequisites and Assignment metadata alignment (`Review cwd`, `Working branch`, `plan_id`, `Review range`)
- Verify open R# status; close/archive per `mstar-plan-artifacts` when fixes confirmed
- Update plan task checkboxes for QA scope
- Return `Blocked` when checkout alignment or evidence gaps cannot be resolved

## Report-only

Use template in `references/qa-engineer.md`. May skip QC tri only when no implementation/test/config artifacts were committed.

## Related

- PM trigger matrix: `references/project-manager/qa-trigger-matrix.md`
- Checkout alignment: `mstar-branch-worktree` SKILL.md
- Residual lifecycle: `mstar-plan-artifacts/references/status-and-residuals.md`
