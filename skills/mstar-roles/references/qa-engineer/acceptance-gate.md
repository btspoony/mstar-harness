# QA Acceptance Gate (L4)

Extension of `references/qa-engineer.md`. Read when PM dispatches you with **`QA gate: mandatory`** or **`QA gate: report-only`**.

Layer **L4** runs after the QC gate. **`QA gate: pm-acceptance`** is PM-only — see **`references/project-manager/qa-trigger-matrix.md`**.

**Do not collapse L4 into L3.** QC reviewers do not close residuals or mark plan `Done`.

## Scope (L4 vs L3)

| L3 Plan QC (`qc-specialist*`) | L4 QA (`qa-engineer`) |
| --- | --- |
| **Code review** — independent lenses on branch **diff** (logic, security, contracts) | Acceptance against plan DoD + review bundle + **L1** evidence |
| Find defects in source; `Request Changes` / residual registration via PM | Verify fixes, R# lifecycle, run **targeted/full** checks when needed, Done recommendation |
| **Does not** run test/build suites (shared tri worktree) | May run verification commands; default **reuse L1 / prior QA evidence** |

**Do not collapse L4 into L3.** QC reviewers do not close residuals, mark plan `Done`, or produce the runtime test log that acceptance depends on — that is L1 (implement) and/or L4 (QA).

## QA modes

| `QA mode` | When | Behavior |
| --- | --- | --- |
| **`acceptance-only`** (default) | Most `mandatory` dispatches | Map DoD to **dev Completion Report / SDD TDD / CI** evidence; re-run only gaps listed below |
| **`full`** | High-risk ops, user override, or gaps below | Full verification commands for assigned scope |
| **`report-only`** | `QA gate: report-only` | Structured findings; no business-code edits unless allowed |

## Evidence reuse first (`acceptance-only`)

When **`QA mode: acceptance-only`**:

1. Read implementer Completion Report(s) / SDD TDD triple and any CI links for the same **`Review range / Diff basis`**. Read QC consolidated (or `qc.md`) for **findings and “Needs L4/QA verification”** notes — **not** as a substitute test log (QC is diff review).
2. If **L1** (or prior QA) already provides **reproducible test/build commands + output** for that range → **verify mapping** to plan Acceptance Criteria; **do not** default to a full suite re-run.
3. Document in Completion Report **Validation**: which ACs are covered by reused evidence vs newly executed checks.

## Mandatory full re-run

Run full verification (or escalate to **`QA mode: full`**) when **any** applies:

- Assignment says **`QA mode: full`**
- **Implementer / prior evidence** lacks reproducible commands+output for behavior-critical ACs (QC noting a gap counts as a signal to run, not as evidence)
- Post–fix-wave scope: `Review range` changed since QC consolidated
- UI observable gate required and QC/dev left no screenshot, preview URL, or equivalent
- Open R# marked resolved this round — verify each with targeted repro/tests

## Unchanged hard duties

Before sign-off or Done recommendation:

- Validate phase-gate prerequisites and Assignment metadata alignment (`Review cwd`, `Working branch`, `plan_id`, `Review range`)
- Verify open R# status; close/archive per `mstar-artifacts` when fixes confirmed
- Update plan task checkboxes for QA scope
- Return `Blocked` when checkout alignment or evidence gaps cannot be resolved

## Report-only

Use template in `references/qa-engineer.md`. May skip QC tri only when no implementation/test/config artifacts were committed.

## Related

- PM trigger matrix: `references/project-manager/qa-trigger-matrix.md`
- Checkout alignment: `mstar-branch-worktree` SKILL.md
- Residual lifecycle: `mstar-artifacts/references/status-and-residuals.md`
