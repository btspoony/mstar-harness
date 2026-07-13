# Iteration package README (template)

Optional index inside `{ITERATION_DIR}/<iteration-id>/`. Copy when the package has more than a few files beyond `delivery-compass.md`.

```markdown
# <iteration-id>

Iteration package — `delivery-compass.md` + specs/guides. Not `{KNOWLEDGE_DIR}/`. Worthy content is **promoted** at iteration-close via `mstar-compound`.

## Documents

| Document | Kind | Description | Status |
|----------|------|-------------|--------|
| [delivery-compass.md](delivery-compass.md) | compass | Scope, plans, branch policy | active / locked / completed |
| [guides/<name>.md](guides/<name>.md) | guide | <purpose> | draft / active / promoted |
| [specs/<name>.md](specs/<name>.md) | spec | <purpose> | draft / locked-in-{SPECS_DIR} / promoted |

## Promotion log (filled at iteration-close)

| Source | Promoted to | Date | Notes |
|--------|-------------|------|-------|
| | | | |
```

**Kind**: `compass` | `guide` | `spec` | `other`

**Status values**: `draft` | `active` | `locked` | `completed` | `promoted` (link knowledge path) | `superseded` | `snapshot-only`
