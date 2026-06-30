# QC Deep Review Persona Catalog

When PM requests **deep review** in the QC Assignment, each QC reviewer may dispatch up to 3 sub-personas (as Task subagents in Cursor) to cover additional angles beyond their primary focus. This is **optional** — default QC still uses single-reviewer mode.

## When to use deep review

- High-risk changes (data migrations, auth changes, payment flows)
- Large PRs touching multiple modules
- First implementation of a new architectural pattern
- PM explicitly requests in Assignment: `QC mode: deep`

## Persona dispatch rules

1. Each QC reviewer can dispatch 1-3 personas in parallel.
2. Persona subagents run in read-only mode — they analyze code, not modify it.
3. Each persona returns a structured finding list.
4. The QC reviewer merges persona findings into their own report, attributing sources.
5. Persona findings that align with the reviewer's own findings strengthen confidence.

## Persona catalog

### Architecture & Maintainability (QC1 primary + these personas)

| Persona | Focus | When to use |
|---------|-------|-------------|
| **Modularity Reviewer** | Cohesion/coupling, module boundaries, dependency direction | Multi-module changes |
| **API Contract Reviewer** | Interface stability, backwards compatibility, versioning | API changes, new endpoints |
| **Data Migration Reviewer** | Migration safety, rollback, data integrity | Schema changes, data migrations |

### Security & Correctness (QC2 primary + these personas)

| Persona | Focus | When to use |
|---------|-------|-------------|
| **Authentication/Authorization Reviewer** | Auth flows, permission boundaries, session handling | Auth-related changes |
| **Input Validation Reviewer** | Sanitization, injection prevention, boundary checks | User-input changes, API endpoints |
| **Error Handling Reviewer** | Error propagation, logging sensitivity, fail-safe defaults | Error path changes |

### Performance & Reliability (QC3 primary + these personas)

| Persona | Focus | When to use |
|---------|-------|-------------|
| **Database Query Reviewer** | N+1 queries, index usage, query efficiency | Database query changes |
| **Memory/Resource Reviewer** | Leaks, unbounded growth, resource lifecycle | Long-running processes, caches |
| **Concurrency Reviewer** | Race conditions, deadlocks, atomicity | Concurrent/async code |

### Cross-cutting (any QC can use)

| Persona | Focus | When to use |
|---------|-------|-------------|
| **Testing Adequacy Reviewer** | Test coverage gaps, edge cases, integration test coverage | Any change |
| **Previous Comments Reviewer** | Prior PR feedback addressed, regression prevention | Re-review, follow-up PRs |
| **Project Standards Reviewer** | Convention compliance, code style, documentation | Any change |

## Persona prompt structure

Each persona receives:

1. The diff scope (same `Review range` as the main reviewer)
2. Their specific focus area
3. A structured output format: `Findings → Severity → Evidence → Recommendation`
4. A constraint: "Only report findings within your focus area. Skip findings that belong to another persona."

## Integration with QC report

In the main QC report, add a section after `## Findings`:

```markdown
## Deep Review Personas
| Persona | Dispatched | Findings |
|---------|------------|----------|
| <name> | Yes/No | <count> findings, <summary> |
```

Persona findings are merged into the main `## Findings` sections (Critical/Warning/Suggestion) with the persona name as source.
