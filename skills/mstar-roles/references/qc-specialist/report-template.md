# QC Report Template and Verdict

Extension of `references/qc-specialist-shared.md`. Frontmatter and path rules remain in the shared role file.

## Report body template

Write under **`{PLAN_DIR}/reports/<plan-id>/qc#.md`** (`qc1`…`qc3` or `qc.md`). YAML frontmatter first (see `qc-specialist-shared.md`), then:

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
- Tools run: {list}

## Findings
### 🔴 Critical
- {issue} -> {fix}

### 🟡 Warning
- {issue} -> {fix}

### 🟢 Suggestion
- {improvement}

## Source Trace
- Finding ID: {F-001}
- Source Type: {git-diff | linter | static-analysis | doc-rule | manual-reasoning | deep-lens: <name>}
- Source Reference: {command/snippet/file}
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

### CI supplement

- CI failures in scope (build, test, lint, types) default to **≥ Warning** — must fix or escalate before `Approve`
- Flaky CI requires reproducible evidence in the report; until PM records disposition → `Needs Discussion` or `Request Changes`

## Evidence rules

- Critical findings: trigger condition, impact scope, fix suggestion
- Low-confidence findings: follow-up verification steps
- Repeated cross-task patterns: mark as recurring in findings
