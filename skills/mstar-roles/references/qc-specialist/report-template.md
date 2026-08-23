# QC Report Template and Verdict

Extension of `references/qc-specialist-shared.md`. Frontmatter and path rules remain in the shared role file.

## Report body template

Write under the Assignment-provided **`{SDD_DIR}/review/qc#.md`** (`qc1`…`qc3` or `qc.md`). YAML frontmatter first (see `qc-specialist-shared.md`), then:

```markdown
# Code Review Report

## Reviewer Metadata
- Reviewer: @qc-specialist | @qc-specialist-2 | @qc-specialist-3
- Runtime Agent ID: {qc-specialist | qc-specialist-2 | qc-specialist-3}
- Runtime Model: {provider/model-id}
- Review Perspective: {role-specific primary focus}
- Report Timestamp: {ISO-8601}

## Scope
- plan_id: {same as Assignment — or `N/A` + Feature / scope label from Assignment}
- Review range / Diff basis: {exact copy from Assignment}
- Working branch (verified): {name}
- Review cwd (verified): {path from git rev-parse --show-toplevel}
- Files reviewed: {count}
- Commit range (if not identical to Review range line, explain): {hash..hash}
- Analysis methods: {e.g. git-diff, read, grep, deep-lens: <names> — not test/build runs}

## Findings
### 🔴 Critical
- {issue} -> {fix}
  - Verification: {re-run repro | log comparison | input-output comparison | dual-path comparison | diff/read/grep anchor}
  - Expected vs observed: {expected state} vs {actual observation}

### 🟡 Warning
- {issue} -> {fix}
  - Verification: {re-run repro | log comparison | input-output comparison | dual-path comparison | diff/read/grep anchor}
  - Expected vs observed: {expected state} vs {actual observation}

### 🟢 Suggestion
- {improvement}
  - Verification: {diff/read/grep anchor}
  - Expected vs observed: {expected state} vs {actual observation}

### ⚪ Unconfirmed
- {finding} — channel gap: {reason}

## Source Trace
- Finding ID: {F-001}
- Source Type: {git-diff | read | grep | doc-rule | manual-reasoning | deep-lens: <name> | assignment-ci-note}
- Source Reference: {path/snippet — not a test/build log you produced}
- Confidence: High | Medium | Low
- Note: every finding carries `Verification` + `Expected vs observed` — see the Findings entry format above

## Summary
| Severity | Count |
|----------|-------|
| 🔴 Critical | {n} |
| 🟡 Warning | {n} |
| 🟢 Suggestion | {n} |
| ⚪ Unconfirmed | {n} |

**Verdict**: Approve | Request Changes | Needs Discussion | Unconfirmed
```

Report **Critical / Warning / Suggestion** sections are human-readable; PM maps to machine **`severity`** in the project register (`projects/<id>/residuals.json`) per `mstar-artifacts/references/status-and-residuals.md`.

## Verdict rules (reviewer applies)

- Evidence channel failure (Review range cannot be established / key file unreadable) → `Unconfirmed` — report states the failure reason; PM-side handling per `mstar-review-qc` consolidated
- **Partial** evidence-channel failure → mark only the affected findings **Unconfirmed** (keep verifiable findings; state channel gaps in Summary)
- Any `Unconfirmed` finding (with or without Critical/Warning) → verdict `Unconfirmed`, never `Approve`; `Approve` additionally requires every finding's evidence channel intact
- Unresolved **Critical** or **Warning** → `Request Changes`
- No Critical/Warning but high-impact unresolved trade-off (often architectural Suggestion) → `Needs Discussion`
- **Approve** only when Critical = 0 and Warning = 0 (unresolved)

### CI / runtime evidence (read-only notes — do not re-run)

- If Assignment or review-package **already cites** failing CI (build, test, lint, types) for this **`Review range`**, treat as **≥ Warning** (or Critical when security/data) — do **not** re-run CI/build/test to reproduce.
- If CI status is unknown: judge from the diff; note `Needs L4/QA verification` when runtime proof is required. Absence of a green CI link is **not** itself a Critical finding.
- Flaky CI disposition belongs to PM / QA after recorded evidence — QC does not chase flakes with local suite runs.

## Evidence rules

- **If you cannot state a verifiable cross-check, do not report the finding** (prefer omission to fabrication)
- **A failed evidence channel is not "no problem"** — when the review-package is missing, the diff cannot be parsed, or a referenced file is unreadable, mark the affected scope **Unconfirmed**; never default to "no findings"
- Critical findings: trigger condition, impact scope, fix suggestion (from source reasoning)
- Low-confidence / runtime-only doubts: follow-up steps for **L4 QA** or implementer — not self-executed suites
- Repeated cross-task patterns: mark as recurring in findings
