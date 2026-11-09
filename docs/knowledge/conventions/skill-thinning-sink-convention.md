---
module: skills corpus / drift-lint
date: 2026-08-20
last_updated: 2026-11-09
problem_type: convention
category: conventions
severity: medium
plan_id: 20260819-workflow-skills-thinning
applies_when:
  - "thinning or retiring skills whose contract prose is engine-enforced"
  - "moving displaced prose out of runtime skills"
  - "changing the shipped skill corpus (add/remove skills)"
  - "editing bilingual onboarding docs (README.md / README_CN.md)"
tags:
  - skill-thinning
  - engine-legacy
  - pointer-ization
  - bilingual-parity
  - sink-skill
---

# Skill-corpus thinning convention (conditional sink + pointer-ization)

> **Applicability clarification (2026-09-07):** This records v3 thinning, not measured efficacy on current models. Engine installation alone does not establish enforcement: evaluate each rule, host and action, including observed inputs and refusal channel. Preserve fallback where enforcement is absent or insufficient; planned trigger refinements require implementation and evidence. Repository AGENTS.md bilingual policy supersedes the historical equal-line-count rule.

## Context

Before v3.0.0 the skill corpus carried ~11k lines with heavy duplication: machine-contract prose (field tables, lease protocols, per-host restatements, checklists) that the TS engine already enforces at runtime. Model capability growth made thin judgment-only skills viable (compass ruling 6: thinning via a conditional `mstar-engine-legacy` sink; the final product goal is thin judgment skills + machine-enforced lifecycle state). The retirement inventory (`workflow-lifecycle-local-survey.md` §5.1) became the SSOT: every row lands as exactly one of retire / rewrite / keep.

## Guidance

1. **Inventory SSOT, 1:1 execution.** Every inventory row lands as exactly one action (retire / rewrite / keep); deviations need a documented justification. No silent extra deletions or rescopes.
2. **Retire = delete + zero-reference sweep.** Deleted surfaces (`done-compaction.md`, `notes.empty.json`, `plans-done.empty.json`, `archive-residuals`) are removed AND every reference in `skills/` is scrubbed — a `grep` sweep must return zero before the task closes.
3. **Rewrite = shorter in-place text pointing at the engine.** Surfaces whose mechanism moved (leases → snapshot, residuals → project register, paths → workflow/project dirs) are rewritten in place with engine-check blocks (`> **Engine check (when available):** …`). Every cited command must exist post-landing — verify each against the CLI surface parity list; never cite a command that hasn't landed.
4. **Conditional sink skill for displaced full prose.** The FULL contract text migrates into one sink skill (`mstar-engine-legacy`) with a trigger description scoped to engine-absent fallback only. A load-condition note in `mstar-harness-core` states it is NOT loaded when engine constraints are active / the host has engine capability — This describes the v3 trigger; the applicability clarification above prevents interpreting Engine presence as proof of rule/action coverage. 归档唯一性: the full text lives in the sink only; runtime skills must not re-carry it (regression = grep shows the displaced text gone from runtime skills). **Current sink scope (verified 2026-11-09):** `mstar-engine-legacy` is now the engine-absent **execution-state boundary** only and carries no `references/` — field tables, migration shapes and dispatch seats stay on the runtime side with the engine, so a new thinning wave must NOT re-open the sink as a prose dump.
5. **Pointer-ization contract.** Runtime skills keep a short pointer + the engine-check command; any remaining complete text lives in one home that the pointer names (for v3 that was the sink's `references/`). The sink does not rewrite contract semantics — displaced prose is archived verbatim (整理归档, not re-authoring).
6. **Corpus counts are readdir-derived, not pinned.** Drift-lint collects the corpus by `readdirSync` and derives checked counts (skills corpus, role corpus) — after retire/rewrite waves the drift pins sync to the derived numbers instead of hardcoded expected counts (QC wave W-D: "drift pin sync + readdir-derived counts").
7. **Bilingual semantic parity.** Apply the minimal corresponding change in both language files and re-record pairing hashes in the same change set, as AGENTS.md requires. Equal added/deleted line counts are not required; touching both files alone is not evidence of matching meaning.
8. **Naming discipline.** Rewritten prose uses landed engine/CLI names verbatim (`workflows/<id>/snapshot.json`, `projects/<id>/residuals.json`, `registerWorkflow`/`unregisterWorkflow`, `mstar iteration gate --workflow <id>`) — no invented synonyms for the same address; drift-lint cannot catch prose drift, so naming is a manual discipline.
9. **Validation after the wave.** `bun run validation:drift` + `lint:ascii-literals` + `mstar roles validate` + bundle-assets resync (gitignored mirrors) + routing-eval regression when routing-relevant text changed.

## Why This Matters

Duplicated contract prose is the worst kind of maintenance debt: it drifts (two copies of the same rule disagree), bloats every prompt that loads a skill, and survives engine enforcement as stale text. The conditional sink keeps engine-present hosts lean while preserving a complete fallback for engine-absent hosts — thinning without dropping capability. readdir-derived counts make the corpus size honest (a retire wave changes the derived number, not a stale pin), and semantic bilingual review catches one-sided updates that presence checks miss.

## When to Apply

- Any skill-thinning / retirement wave (retire/rewrite/keep rows with a survey SSOT).
- Adding a new engine-enforced contract to skills: put the full prose in one home and point from runtime skills.
- Any change to README.md/README_CN.md onboarding content (minimal semantic counterparts and updated pairing hashes in the same change).
- Any corpus change that alters skill counts (drift pins follow the derived numbers).

Related: `architecture-patterns/engineizing-prompt-workflows.md` — the [P]/[J]/[M] programmatic-split method that creates the engine-enforced subset; this convention covers the later thinning/retirement of the displaced prose. `conventions/skill-content-porting-discipline.md` covers the reverse direction (porting external skills into the `mstar-*` corpus).

## Examples

### Before (runtime skill carries the full contract)

```markdown
<!-- skills/mstar-plan-artifacts (pre-thinning) -->
## status.json fields
| field | severity | lifecycle | jq example | flock example | …
… (full field table duplicated from the engine schema)
```

### After (pointer + engine-check; full text in the sink)

```markdown
<!-- skills/mstar-plan-artifacts (thinned) -->
## status / residual addresses (v2)
Snapshots: `workflows/<id>/snapshot.json`; project registers: `projects/<id>/residuals.json`; severity/lifecycle semantics verbatim.
> **Engine check (when available):** `mstar status validate` (no `--path`; the file route is retired) — engine-absent hosts read the runtime field reference on the live side.
```
