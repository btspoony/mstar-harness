# QA Acceptance Gate (L4)

Extension of `references/qa-engineer.md`. Read when PM dispatches you with **`QA gate: mandatory`** or **`QA gate: report-only`**.

Layer **L4** runs after the QC gate. **`QA gate: pm-acceptance`** is PM-only — see **`references/project-manager/qa-trigger-matrix.md`**.

**Do not collapse L4 into L3.** QC reviewers do not close residuals or mark plan `Done`.

## Scope (L4 vs L3)

| L3 Plan QC (`qc-specialist*`) | L4 QA (`qa-engineer`) |
| --- | --- |
| **Code review** — independent lenses on branch **diff** (logic, security, contracts) | Acceptance against plan DoD + review bundle + **L1** evidence |
| Find defects in source; `Request Changes` / residual registration via PM | Verify fixes, R# lifecycle, run only assigned **targeted unit tests** when needed, Done recommendation |
| **Does not** run test/build suites (shared tri worktree) | May run named unit-test checks; default **reuse L1 / prior QA evidence** |

**Do not collapse L4 into L3.** QC reviewers do not close residuals, mark plan `Done`, or produce the runtime test log that acceptance depends on — that is L1 (implement) and/or L4 (QA).

## QA modes

| `QA mode` | When | Behavior |
| --- | --- | --- |
| **`acceptance-only`** (default) | Most `mandatory` dispatches | Map DoD to **dev Completion Report / SDD TDD / CI** evidence; re-run only gaps listed below |
| **`targeted`** | A specific changed behavior or unit-test evidence gap | Run only named affected unit-test files/cases/selectors |
| **`report-only`** | `QA gate: report-only` | Structured findings within assigned evidence/unit-test scope; no business-code edits unless allowed |

## Evidence reuse first (`acceptance-only`)

When **`QA mode: acceptance-only`**:

1. Read implementer Completion Report(s) / SDD verification evidence and relevant CI links. Map each item to **`Review range / Diff basis`**; older-range evidence is reusable when its covered behavior remains unchanged, with the original range and applicability reason recorded. Read QC consolidated (or `qc.md`) for **findings and “Needs L4/QA verification”** notes — **not** as a substitute test log (QC is diff review).
2. If **L1** (or prior QA/CI) already provides reproducible relevant evidence → **verify mapping** to plan Acceptance Criteria; do not re-execute covered checks. Non-executable docs/policy may supply `scoped-check` evidence (`mstar-sdd/references/file-handoffs.md`), not a fabricated test log.
3. Document in Completion Report **Validation**: which ACs are covered by reused evidence vs newly executed checks.

## Fill only the affected gap

Scope authority → `mstar-harness-core` § 定向执行与验证边界. All QA modes remain unit-only; a mode, risk level or absent evidence does not grant wider execution.

- Missing behavior-critical evidence: name the uncovered AC and its targeted unit-test check; run only that assigned check, or return the concrete gap to PM if it is not specified.
- A fix or changed `Review range`: invalidate only evidence affected by the fix; preserve the rest. Resolved R# items need only their corresponding unit-test evidence or scoped documentation/policy evidence.
- Missing screenshot or other real-environment evidence: record the unverified behavior and a pending independent E2E request for PM. Never launch a browser/device/E2E, change roles, or block/reopen routine iteration QA solely for that separate workflow. Unit acceptance cannot claim real-environment acceptance.
- User-authorized local full-suite execution belongs to a separate implementer/ops action; QA may consume its result but has no `full` mode. Refer the authorization scope to PM instead of executing it here.

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
