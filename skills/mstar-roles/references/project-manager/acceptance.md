# PM Acceptance (L4)

Extension of `references/project-manager.md`. Read before acceptance or plan `Done`, for every feature size, bug fix, UI change, residual-bearing plan, ops deliverable and report-only route. The primary PM alone owns acceptance and sign-off; specialists supply evidence, never a second acceptance authority. L1 implementation, L2 task review and independent L3 QC remain separate.

## Evidence-first procedure

1. Confirm Prepare/Execute prerequisites and the registered completion route. Keep required L2/L3 review; report-only work may skip QC tri only when no implementation/test/config artifacts were committed, with an explicit reason.
2. Verify `plan_id`, `Review cwd` / `Worktree path`, `Working branch` and `Review range / Diff basis` against the locked QC scope and actual checkout. Use text-identical scope fields for the same change. Do not switch to another track to collect missing changes; integrate through the authorized coordinator flow or correct the scope first.
3. Read L1 Completion Reports, SDD verification evidence, relevant CI and prior acceptance/QA reports. QC reports supply findings and review verdicts, not runtime-test logs. A QC approval alone never satisfies an AC.
4. Map every required AC using the report table below. Reuse relevant evidence with its original input identity and applicability reason. Non-executable docs/policy may use `scoped-check` (`mstar-sdd/references/file-handoffs.md`), not a fabricated test run. A later HEAD or fix invalidates only affected evidence, not the whole evidence set.
5. Fill only named gaps under the execution exception below, or assign the existing dev/ops role a bounded evidence-producing task. Preserve every observed failure and mark unsupported ACs unverified; neither missing evidence nor a clean checked subset is a whole-scope pass.
6. Apply findings cleanup and issue disposition rules from `mstar-artifacts/references/status-and-residuals.md`. `Approve with residuals` and open issues do not select another acceptance route: disclose each issue, severity, tracking location, owner/target and blocker-defer status. Close only with verified disposition evidence; waivers retain PM + user/architect alignment. QC reviewers do not close issues or mark Done.
7. Land the report, preserve its compact AC mapping in the main plan's `## PM Acceptance Summary`, then use the ordinary primary-coordinator completion operation with independent QC and declared-route proof. Row Done does not discharge workflow delivery obligations.

## Narrow acceptance-execution exception

PM may directly perform a short, bounded acceptance check for a named AC/evidence gap. Before execution, name the AC, exact command or static/manual procedure, selector, checkout/environment, expected observable result and stopping bound; record the actual outcome and provenance afterward. Reuse covered evidence instead of re-running it. This exception does not permit product-code edits, test authoring, implementation, long-running suites, unrestricted verification, deployment or specialist environment work. Delegate those actions to the existing dev/ops roles; PM still accepts the result. Local full-suite permission remains user-owned and execution belongs to a separately assigned implementer/ops action, never this exception.

Scope/authorization authority → `mstar-harness-core` § 定向执行与验证边界. Real browser/device/installed-deployment/E2E work requires an explicitly authorized independent `mstar-e2e` workflow with ops execution. Development ACs demanding live APIs/provider receipts, named/authenticated hosts/accounts, installed plugins/artifacts or real-environment proof must be corrected during Prepare to isolated fixtures, relevant unit/component/integration checks or locally built CLI/MCP evidence. Record unverified real-environment behavior honestly; do not restore a development gate for it.

## Retained evidence and historical provenance

Consume retained `sdd evidence` bundles read-only; integrity-check and assess them through `mstar-sdd/references/file-handoffs.md` § Verification evidence without repeating the captured child command.

- **Run/manual reference:** cite `{SDD_DIR}/evidence/<run-uuid>/`, record and raw `stdout.log` / `stderr.log`, or the manual report/CI citation with its producer, time and scope.
- **Original input identity:** retain the recorded Git HEAD and declared-input digest from `record.json`; manual evidence keeps its actual original identity, never a manufactured runner record.
- **Integrity / outcome:** preserve the recorded result. A pre-fix failure remains failed, never a pre-feature baseline or a pass; its affected AC needs separate passing proof.
- **Target applicability:** record the assessed target and reason for reuse. Equal tested inputs or docs-only changes may reuse evidence; changed shared runtime/config/fixture/dependency inputs create only their affected gaps. Unknown scope, incomplete/failed proof or no target assessment stays uncertain / `not-assessed`.
- **Coverage judgment:** remains reviewer reasoning (`review-required`), not automatic pass/fail counts. Review raw logs/code where skips or behavior coverage matter. Caller assumptions (`reviewed`, empty environment allowlist, lockfile-only rationale) are not completeness proofs.
- Preserve prior QA report authorship, completion actors, timestamps and stored records. Historical evidence may support current acceptance with an explicit applicability judgment; it is never relabeled as PM-executed verification.

## Coverage and stopping

Keep acceptance scoped to the required ACs and directly affected interfaces. A bounded check stops at its declared bound. Record `Truncated coverage: <actual bound; unchecked ACs/interfaces>` in `## Scope` only when coverage was actually cut; omit the line entirely otherwise. Never invent file counts or elapsed time. A bound stop preserves witnessed failures and supported outcomes and is not an `Unconfirmed` evidence-channel failure.

| Readback | Acceptance consequence / recovery |
| --- | --- |
| Every required AC has relevant supported passing evidence | Acceptance may pass after QC, cleanup and declared-route prerequisites hold |
| Required AC unsupported, evidence channel unavailable, or alignment unverified | `Blocked`; identify the AC, exact gap and bounded remaining check or corrected checkout/scope |
| Witnessed AC failure | Retain failed outcome and finding; assign the affected fix/check, then reconsider only invalidated evidence |
| Clean checked subset, including `findings: []`, with required ACs unverified | Not a full pass and never Done; finish the named uncovered scope |

## Report landing and durable summary

Write `{SDD_DIR}/review/qa.md` by default, or an explicitly chosen same-directory basename. The existing `qa.md` name is a report carrier, not a role or QA mode. No named output path is not an exemption: acceptance is never conversation-only. Retain the raw report while the gate is active. Before Done, preserve per-AC evidence/result, applicability, coverage/gaps, reused versus new checks, issue dispositions and the exact report pointer in the main plan's `## PM Acceptance Summary` (`mstar-artifacts/references/plan-files-and-reports.md`). Reuse that summary, not a second archive or manifest.

```markdown
# PM Acceptance Report

## Scope
- Acceptance owner: project-manager
- QA gate: pm-acceptance
- plan_id: <plan-id>
- Review range / Diff basis: <locked scope>
- Working branch (verified): <branch>
- Review cwd (verified): <actual checkout root>

## Acceptance Criteria (AC → evidence → result)
| AC | run/manual reference | original input identity | integrity | outcome | target applicability and reason | coverage judgment | targeted gap |
| --- | --- | --- | --- | --- | --- | --- | --- |

## QC and issue dispositions
## Reused evidence / newly executed checks
## Findings
## Not tested / verification gaps
## Acceptance decision
```

Every required AC gets all eight columns; use `n/a` / `not-assessed` where genuinely inapplicable, never omit a column. `report-only` is a delivery kind, not an acceptance mode: PM accepts the scoped specialist report against its criteria and registered fulfilment policy. An advisory filename alone confers no pass or Done authority.

## Public completion and recovery

The existing completion carrier stays `qa: {gate: "pm-acceptance", decision: "pass", report: "<real report path>"}`. The `qa` spelling is wire/storage history, not role dispatch. Missing report or non-pass evidence cannot complete; supply the real passing report after closing the named evidence gap, then retry the same completion entry. An optional `qaGate` is a checked fixed-value constraint (`pm-acceptance`), never an owner selector; no QA mode is used.

New/default prepare uses PM Acceptance. Retired `mandatory` submissions must retry with `pm-acceptance`. For an existing active row still configured as `mandatory`, use ordinary `mstar plan prepare --workflow <workflow-id> --plan <plan-id> --qa-gate pm-acceptance`, then resubmit PM acceptance evidence through ordinary completion. Prepare preserves progress, issues, source metadata and unrelated rows; never repair SQL or rewrite completed history. Completed historical QA reports/configurations remain truthful readable evidence, not a live alternative route.
