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

### Captured evidence mapping (`sdd evidence`)

Retained `sdd evidence` bundles are consumed read-only: QA integrity-checks and maps the evidence — it never repeats the captured child command (exact command shapes and exit meanings → `mstar-sdd/references/file-handoffs.md` § Verification evidence). Map every AC with all columns:

| AC | run/manual reference | original input identity | integrity | outcome | target applicability and reason | coverage judgment | targeted gap |
| --- | --- | --- | --- | --- | --- | --- | --- |

- **Run/manual reference**: `{SDD_DIR}/evidence/<run-uuid>/` with the record and raw `stdout.log`/`stderr.log` paths — or the manual report/CI citation with provenance.
- **Original input identity**: the recorded run's Git HEAD plus declared-input digest from `record.json` — the basis any target comparison reuses.
- **Coverage judgment** is reviewer reasoning: the assessment always reports `review-required`, supplies no pass/fail counts and no automatic coverage inference; skips and behavior coverage need raw-log/code review when material.
- Evaluate candidate assumptions, never inherit them: a `reviewed` declaration, an empty environment allowlist, or a lockfile-only dependency rationale is the caller's assumption, not automatic completeness — name the unverified scope as the targeted gap when material.
- Reuse outcomes: tested bytes equal after a later commit → reuse, no rerun; docs-only change → reuse; a changed shared runtime/config/fixture/dependency input → name the affected gap instead of rerunning everything; failed/incomplete or unknown-scope proof stays uncertain; no assessed target → `not-assessed`.
- A pre-fix failing run keeps outcome `failed` and is never relabeled a pre-feature baseline; the fix needs its own passing evidence for the affected AC.
- Manual historical evidence is unverified/manual — cite it with provenance and reviewer reasoning; NEVER convert it into a v1 runner record.

## Fill only the affected gap

Scope authority → `mstar-harness-core` § 定向执行与验证边界. All QA modes remain unit-only; a mode, risk level or absent evidence does not grant wider execution.

- Missing behavior-critical evidence: name the uncovered AC and its targeted unit-test check; run only that assigned check, or return the concrete gap to PM if it is not specified.
- A fix or changed `Review range`: invalidate only evidence affected by the fix; preserve the rest. Resolved R# items need only their corresponding unit-test evidence or scoped documentation/policy evidence.
- Missing screenshot or other real-environment evidence: record the unverified behavior and a pending independent E2E request for PM. Never launch a browser/device/E2E, change roles, or block/reopen routine iteration QA solely for that separate workflow. Unit acceptance cannot claim real-environment acceptance.
- User-authorized local full-suite execution belongs to a separate implementer/ops action; QA may consume its result but has no `full` mode. Refer the authorization scope to PM instead of executing it here.

## Budget stop and coverage readback

Ceiling and scope authority → **`mstar-harness-core`** § 定向执行与验证边界; the role wording is in `references/qa-engineer.md` § Budget and Stopping. Honour the Assignment **`Budget`** / **`Return shape`** and never widen the core default. A bound stop keeps the AC outcomes and findings already verified and never invents elapsed time or file counts.

- **Label only a real cut.** Emit `- Truncated coverage: <budget reached; specific ACs/interfaces not covered>` in the report `## Scope` only when a bound actually stopped expansion, naming the required ACs/interfaces left unchecked, and record those ACs as unverified. Omit the line on a complete run — a negation value is still a line, and consumers read the label's presence, not its wording.
- **Exhaustion is not a channel failure.** A cap stop never rewrites an observed result, never becomes `Unconfirmed`, and never invents new QA vocabulary. A required evidence channel that is unavailable is a verification gap, handled by the existing `Blocked` result.
- **Coverage readback, per assigned AC.** A checked AC keeps its observed outcome and its evidence reference, including a witnessed failure; a required AC left without supported evidence is recorded as unverified and is not a pass.

| Readback | Required coverage | Result |
| --- | --- | --- |
| Every assigned AC has supported evidence | covered | ordinary acceptance may proceed |
| A required AC has no supported evidence (unverified, or its channel unavailable) | uncovered | return the existing **`Blocked`**; name the uncovered ACs and hand PM the targeted remaining scope |
| An assigned AC failed with witnessed evidence | covered — the finding is retained | report the observed failure with its evidence; coverage ending never turns it into a coverage-only conclusion |

A clean checked subset with `findings: []` is compatible with `unverified` ACs: `findings: []` describes the checked scope only and is never presented as full mandatory acceptance or `Done`.

## Durable acceptance mapping (before Done)

The landed report is the raw record; its landing obligation is defined once in `references/qa-engineer.md` § QA Report Landing and Template and is unchanged when the Assignment names no output path. Before `Done`, the report's compact AC → evidence → result mapping is preserved in the existing durable main-plan **`## QA Gate Summary`** (`mstar-artifacts/references/plan-files-and-reports.md`) — per-AC result, evidence reference, coverage/gap disclosure and the exact report pointer — which QA supplies from its report.

Reuse that existing summary: no second archive, manifest or report format is created. Retain the raw report while the gate is active, so a later permitted bundle cleanup never leaves the only AC mapping in a deleted file.

## Unchanged hard duties

Before sign-off or Done recommendation:

- Validate phase-gate prerequisites and Assignment metadata alignment (`Review cwd`, `Working branch`, `plan_id`, `Review range`)
- Verify open R# status; close/archive per `mstar-artifacts` when fixes confirmed
- Update plan task checkboxes for QA scope
- Return `Blocked` when checkout alignment or evidence gaps cannot be resolved

## Report-only

Use template in `references/qa-engineer.md`. May skip QC tri only when no implementation/test/config artifacts were committed.

`report-only` is a mode, not the landing condition: the mandatory landing, scope/truncation disclosure and coverage readback above are unchanged, and an advisory report acquires no acceptance authority from its filename.

## Related

- PM trigger matrix: `references/project-manager/qa-trigger-matrix.md`
- Checkout alignment: `mstar-branch-worktree` SKILL.md
- Residual lifecycle: `mstar-artifacts/references/status-and-residuals.md`
