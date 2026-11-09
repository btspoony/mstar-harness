---
module: severity-axis SSOT, SQL CHECK migration discipline, and axis separation
date: 2026-10-14
last_updated: 2026-11-09
problem_type: tooling_decision
category: tooling-decisions
severity: high
plan_id: 20261014-severity-vocabulary-nit
applies_when:
  - "A vocabulary (severity, status, class) is declared in more than one module"
  - "A SQL CHECK constraint must change in the harness store"
  - "A stored enum value must be replaced across existing rows"
  - "A `nit`/`info`-style wording question resurfaces in an issue or a review"
tags:
  - severity-vocabulary
  - ssot
  - sqlite-check
  - migration-discipline
  - axis-separation
---

# One severity axis, one word, one appended migration

## Context

The harness severity axis is **`critical | high | medium | low | nit`**, owned by `packages/engine/src/core.ts` (`Severity` + `SEVERITY_ORDER`). What happened around it:

1. **2026-09-18** — the store/issue-capture work introduced a second severity declaration in the issue domain (`packages/engine/src/issue.ts`), the SQL CHECK on `issues.severity`, and a `MIGRATION_VOCABULARY` entry mapping the legacy register literal `nit` to `info`. The legacy files themselves carry `nit` (fixtures: `status.real-shape.json`, `migrate-real/…/00000722-iter-wt-lease.json`).
2. **PR #478** — the engine SSOT, the residual validator and the skill reference were moved to `info`, because an issue had reported a "documentation says `nit`, engine says `info`" drift and the target was assumed to be `info`. That assumption was wrong: it propagated the issue domain's mistake into the axis that everything else follows.
3. **2026-10-14** (`20261014-severity-vocabulary-nit`) — the axis was restored to `nit` end to end (engine types, validation tables, ORDER BY ladders, CLI/MCP payloads, dsh view/schema, dashboard map, docs, fragments, generated bundles) and the 9 stored `info` rows were converted.

## Guidance

1. **`core.ts` is the severity SSOT.** Any other declaration of the same axis (`issue.ts`, a JSON-schema enum, a dsh union, a dashboard map) must agree with it. Two declarations of one vocabulary is how this started; a second vocabulary is a defect even when both sides "work".
2. **Do not confuse axes.** These are different fields and must not follow a severity change: PR-review merge class (`must-fix|should-fix|may-fix|nit`, `MERGE_CLASSES` in `prreview.ts:32`), the deliberately refused PR-review inspector vocabulary (`INSPECTOR_SEVERITIES`), audit severity ranks (`informational|low|medium|high|critical`), knowledge frontmatter severity (`KNOWLEDGE_SEVERITIES`), and log levels (`info|warn|error`). A grep for `info` finds all of them; the judgement is per site.
3. **A SQL CHECK change is an appended migration, never an edit.** SQLite cannot alter a CHECK: rebuild the table (create → `insert … select` with the value converted → `drop` → `rename`), following `MIGRATION_9_SQL`'s precedent. Historical migration statements keep their exact bytes — `schema_version` records name/checksum as provenance, and rewriting an applied statement diverges from every existing store.
4. **Convert stored values inside the migration**, not with a validator compatibility branch and not by hand-editing data. The migration is the only writer.
5. **After merging a sibling track's source, rebuild the gitignored build output before re-measuring.** A stale `packages/*/dist` in a track worktree makes a correct diff look red (and vice versa) — see `worktree-dependency-dist-isolation.md`. PM owns this environment step for every track it merges into.
6. **Transient during such a delivery:** once the control store's `schema_version` is ahead of the CLI you are running, that CLI refuses with `store.schema-unsupported`. Operate the store with a CLI built from the delivery head; the primary checkout recovers by rebuilding after the merge.

## Why This Matters

The axis is consumed by capture, validation, storage, sorting, counters, refusal text, dashboards, host gates and release notes. A half-cutover is silent where it is cheapest and loudest where it is most expensive: a producer writing the new word while a consumer's enum still lists the old one fails at the store boundary, and a report silently loses a bucket. Direction matters too — the issue that triggered #478 was itself evidence of a real drift, but its assumed direction was wrong, and the cheap fix (edit the doc) would have created a *new* drift because the validator on the other side would still have refused the documented value.

## Source

Delivery `20261014-severity-vocabulary-nit` (`wf-20261014-severity-vocabulary-nit`). Change list from three read-only surveys (`local://severity-data-migration.md` holds the data/migration one); migration 12 (`MIGRATION_12_SQL`, `store-db.ts:1570`) with its table rebuild and conversion test in `store-db.test.ts`; migration proof on a store copy in `qa-acceptance.md`; the corrected dispositions of the two issues closed under the wrong rationale (store revision records). Related: `worktree-dependency-dist-isolation.md`.
