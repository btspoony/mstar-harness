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

### 🟡 Warning
- {issue} -> {fix}

### 🟢 Suggestion
- {improvement}

## Source Trace
- Finding ID: {F-001}
- Source Type: {git-diff | read | grep | doc-rule | manual-reasoning | deep-lens: <name> | assignment-ci-note}
- Source Reference: {path/snippet — not a test/build log you produced}
- Confidence: High | Medium | Low

## Summary
| Severity | Count |
|----------|-------|
| 🔴 Critical | {n} |
| 🟡 Warning | {n} |
| 🟢 Suggestion | {n} |

**Verdict**: Approve | Request Changes | Needs Discussion
```

Report **Critical / Warning / Suggestion** sections are human-readable; PM maps to machine **`severity`** in `status.json` per `mstar-plan-artifacts/references/status-and-residuals.md`.

## Verdict rules (reviewer applies)

- Unresolved **Critical** or **Warning** → `Request Changes`
- No Critical/Warning but high-impact unresolved trade-off (often architectural Suggestion) → `Needs Discussion`
- **Approve** only when Critical = 0 and Warning = 0 (unresolved)

### CI / runtime evidence (read-only notes — do not re-run)

- If Assignment or review-package **already cites** failing CI (build, test, lint, types) for this **`Review range`**, treat as **≥ Warning** (or Critical when security/data) — do **not** re-run CI/build/test to reproduce.
- If CI status is unknown: judge from the diff; note `Needs L4/QA verification` when runtime proof is required. Absence of a green CI link is **not** itself a Critical finding.
- Flaky CI disposition belongs to PM / QA after recorded evidence — QC does not chase flakes with local suite runs.

## Evidence rules

- Critical findings: trigger condition, impact scope, fix suggestion (from source reasoning)
- Low-confidence / runtime-only doubts: follow-up steps for **L4 QA** or implementer — not self-executed suites
- Repeated cross-task patterns: mark as recurring in findings
