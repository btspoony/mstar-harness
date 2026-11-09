---
module: engine migrate / harness layout
date: 2026-08-20
problem_type: architecture_pattern
category: architecture-patterns
last_updated: 2026-11-09
severity: high
plan_id: <plan-id>
applies_when:
  - "one-shot layout/schema migration with hard cutover (no dual-read)"
  - "the legacy root file must survive the migration for forensics"
  - "migration runs on a live tree whose rows carry unknown/legacy fields"
  - "a failed migration must be recoverable by re-run, not by manual repair"
tags:
  - migration
  - hard-cutover
  - commit-point
  - v2-layout
  - idempotent
---

# Harness layout migration pattern (v1 → v2, commit-point ordering)

## Context

v3.0.0 replaced the single-file global `status.json` + root `agent-flow.jsonl` layout with a per-lifecycle runtime layer (`workflows/<id>/snapshot.json`, `notes.jsonl`, `agent-flow.jsonl`) plus a project layer (`projects/<id>/residuals.json`, `roadmap.md`). The cutover is hard (compass ruling 7: no v1/v2 dual-read, no auto-migrate on boot) and shipped as a one-shot `mstar migrate` built on the engine's `migrateHarnessTree` (pure planner) + `applyMigratePlan` (executor).

> **Status (2026-11-09): the executable half is retired.** `mstar migrate` now refuses without mutation ("Retired command; refuses without mutation" — it points at `mstar store upgrade --operator <name>`), and `migrateHarnessTree` / `applyMigratePlan` / the root `withStatusWriteLock` write phases are gone with the pre-activation file route. What survives is `convertLegacyV1Tree` in `packages/engine/src/migrate.ts` — a PURE converter (it writes nothing) consumed by the direct `store upgrade` importer. Guidance 1–4 and 9 below describe the retired executor; read them as the reasons the store route does not restage files, not as a route to re-implement. Guidance 5–8 still bind the live converter verbatim. The observed legacy tree at fixture freeze (2026-08-19) carried 40 plan rows, 23 compass-registered ids already compacted away, 12 standalone rows, and 13 root-`metadata` keys — a shape-rich corpus that forced explicit rules for every field class.

## Guidance

1. **Planner/executor split with dry-run as a first-class contract.** The planner reads the legacy tree and returns a full step list (source → destination per step); `--dry-run` prints the steps and applies zero writes. The executor applies the same deterministic plan — a dry-run is the operator's review surface before touching a live tree.
2. **Additive-first ordering; the root replacement is the LAST step — the commit point.** Archive copy → workflow snapshots → notes ledgers → project register → roadmap seeds are all additive. Only then is the root file replaced. A failure before the commit point leaves the v1 tree intact; the re-run applies the same deterministic plan. This is free rollback: no undo machinery.
3. **Idempotent re-run.** Re-running on a v2 root (`version === 2`) is a no-op with an explicit message. The version re-check is re-executed INSIDE the root-file write lock — a stale plan racing a concurrent committed migrate turns into a no-op instead of overwriting a root that may already hold registered workflows.
4. **Archive-first, never delete.** The live v1 root is copied to `archived/status.v1.json` before anything else touches it; the copy is never removed. Legacy `archived/residuals/*.json` are history and are NOT lifted into the new registers.
5. **Grouping uses an explicit SSOT, never guessing.** Every row lands in exactly one snapshot: the iteration whose `iterations/<id>/delivery-compass.md` frontmatter registers its id (`delivery-compass.<role>.md` review-chain variants are NOT grouping sources). Registered-but-missing ids (compacted away) are recorded on the owning snapshot's `legacy_metadata.compact_missing[]` — never fabricated as rows. Duplicate v1 plan ids are refused fail-loud. Unregistered rows become standalone plan-type snapshots.
6. **Field-lift rules: known → first-class, unknown → preserved, nothing dropped silently.** Root-`metadata` execution-policy keys (`plan_parallelism`/`worktree_mode`/`push_policy`) lift to the snapshot `execution_policy` (first-class, not opaque legacy metadata); branch anchors and `control_worktree_path` lift to snapshot `branch` / `control_worktree_path`; `program_roadmap` seeds `projects/<id>/roadmap.md` with its `no_intermediate_releases`/`deferred_beyond` fields preserved in the seed body; every other/unknown key lands in `legacy_metadata`. Residual entries keep v1 multi-finding array semantics verbatim, with `source_plan`/`registered_at` provenance added and `lifecycle_id` when the plan groups into an iteration.
7. **Deterministic output.** All timestamps derive from legacy data (`updated_at` folds into the v2 root; per-snapshot dates pick deterministically from candidate legacy dates); no clock reads — re-runs produce byte-identical plans.
8. **Path safety enforced twice.** The planner refuses any lifecycle id (row `id`/`plan_id`, compass `iteration_id`, project id) that fails `assertSafePathComponent` BEFORE producing a step list; the executor re-enforces the "no fs writes outside the harness dir" invariant on every planned destination, so even a hand-built plan cannot escape `plan.root`.
9. **Writer-as-validator.** Snapshots are validated fail-closed inside `writeWorkflowSnapshot`; the apply loop does not pre-validate — a separate gate would run the same O(rows) pass twice per snapshot. The register and v2 root are validated before their writes (different writers, different enforcement points).

```ts
// RETIRED executor skeleton — kept as the shape record only. No such writer exists today.
// (historical — packages/engine/src/migrate.ts)
if (plan.dryRun) return { applied: false, message: `dry-run: ${plan.steps.length} steps planned, zero writes` };
if (readJson(statusPath).version === 2) return { applied: false, message: "no-op: already v2" };
assertAllDestinationsInside(plan.root);          // defense-in-depth, apply boundary
copyFileSync(statusPath, archiveFile);           // 1. archive first — never deleted
for (const s of plan.snapshots) await writeWorkflowSnapshot(s.data, dirname(s.file)); // 2. additive
// 3. notes ledgers, 4. register (validated), 5. roadmap seeds — all additive
return withStatusWriteLock(statusPath, () => {   // 6. COMMIT POINT, last step
  if (readJson(statusPath).version === 2) return { applied: false, message: "no-op" }; // in-lock re-check
  writeJson(statusPath, plan.rootV2.data);
  return { applied: true, message: "migrated N lifecycles into workflows/, project layer seeded" };
});
```

## Why This Matters

With hard cutover, an operator's only recovery from a botched migration is the migration itself. Commit-point ordering converts "rollback" into "re-run the same deterministic plan", and the archive copy keeps the v1 evidence alive for forensics after the live root is v2. The field rules matter because a one-shot migration is the only chance to classify legacy data — silent drops or invented rows would corrupt every downstream consumer (CLI, hooks, dsh) permanently.

## When to Apply

- Reasoning about the v1 tree's conversion rules: the grouping/field-lift/determinism/path-safety rules (5–8) are the live contract for `convertLegacyV1Tree`.
- A future store-level layout migration: use the store's own manifest route (`planStoreMigration` / `applyStoreMigration`), gated by `architecture-patterns/store-authority-staged-lifecycle.md` — the file-staging executor this doc records was retired, not replaced.
- Consumer repos migrating their own v1 harness trees.
- Any one-shot migration with hard cutover: additive-first ordering, idempotent re-run, and path-safety double enforcement generalize directly.

## Examples

### Before (v1 root `status.json`)

```json
{
  "version": 1,
  "plans": [ { "id": "<plan-id>", "status": "Done", "notes": ["…"] } ],
  "metadata": { "plan_parallelism": "serial", "iteration_base_branch": "main", "program_roadmap": { "…": "…" } },
  "residual_findings": {}
}
```

### After (migrated tree)

- `archived/status.v1.json` — byte-identical copy, never deleted.
- `workflows/<id>/snapshot.json` — one per lifecycle; `execution_policy` first-class; row statuses verbatim; `legacy_metadata.compact_missing[]` for registered-but-gone ids.
- `workflows/<id>/notes.jsonl` — lifted per-plan `notes` arrays as initial lines.
- `projects/_default/residuals.json` — open residual entries verbatim + provenance.
- `projects/_default/roadmap.md` — seeded from `program_roadmap`, preserved fields intact.
- Root `status.json` — `{ "version": 2, "updated_at": …, "workflows": [ … ] }` (the only v2 shape; empty list until lifecycles re-register).
