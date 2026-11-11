# Category mapping: problem_type → directory under {KNOWLEDGE_DIR}

## Bug track

| problem_type | directory | track |
|---|---|---|
| `build_error` | `build-errors/` | bug |
| `test_failure` | `test-failures/` | bug |
| `runtime_error` | `runtime-errors/` | bug |
| `performance_issue` | `performance-issues/` | bug |
| `database_issue` | `database-issues/` | bug |
| `security_issue` | `security-issues/` | bug |
| `ui_bug` | `ui-bugs/` | bug |
| `integration_issue` | `integration-issues/` | bug |
| `logic_error` | `logic-errors/` | bug |
| `config_error` | `config-errors/` | bug |

## Knowledge track

| problem_type | directory | track |
|---|---|---|
| `best_practice` | `best-practices/` | knowledge |
| `convention` | `conventions/` | knowledge |
| `architecture_pattern` | `architecture-patterns/` | knowledge |
| `design_pattern` | `design-patterns/` | knowledge |
| `tooling_decision` | `tooling-decisions/` | knowledge |
| `testing_pattern` | `testing-patterns/` | knowledge |
| `api_design` | `api-design/` | knowledge |
| `workflow_issue` | `workflow-patterns/` | knowledge |
| `developer_experience` | `developer-experience/` | knowledge |
| `documentation_gap` | `documentation/` | knowledge |

## Rules

1. The `category` field in frontmatter must match the directory name (without trailing slash).
2. Prefer the narrowest applicable `problem_type`. Use `best_practice` only when no narrower knowledge-track value fits.
3. When creating a new directory under `{KNOWLEDGE_DIR}`, add it to this mapping and create an empty directory.
