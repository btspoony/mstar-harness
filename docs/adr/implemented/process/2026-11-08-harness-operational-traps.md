# ADR: Treat a tooling refusal as a version question before a data question

Status: implemented — three recurring harness traps each reported a symptom that pointed at the wrong component.

## Problem

One iteration hit three failures whose message named a cause other than the real one:

1. **A store that reads as corrupt.** Every store verb refused with `store.corrupt … completion.review_base must be a full Git object id`, naming a *different* workflow's row. The row was well-formed (`json_type` → `null`, `json_valid` → 1); an engine change had made `review_base` optional and written `null`, and the reading build predated it. The refusal's wording invites restoring a backup, which would discard concurrent work.
2. **A packaging digest that re-stales on every skills commit.** `scripts/packaging-manifests/*.json` records a digest over the whole `skills/` tree, so any skills edit invalidates it and `execution-consumer-manifest --check` refuses until the producer re-runs. In a multi-plan iteration it went stale three times because peer commits landed between the producer's read and its write.
3. **A merge that nobody reviewed.** Per-task and per-plan reviews cover the feature branch; a merge commit that resolves conflicts by hand is new content outside them. Both conflicted files can look fine individually while a sentence from the losing side silently disappears.

## Decision

Before acting on any of these refusals, establish **which component's version is authoritative** — reader or data, producer or consumer, branch or merge — and only then repair.

Concretely:

- **Store refusals.** First `sqlite3 {HARNESS_DIR}/store.db "select json_type(coordination_json,'$.completion.review_base'), json_valid(coordination_json) from execution_plans where plan_id='<id>';"`. A `null | 1` result means the row is fine and the reader is old. Then run `status validate` through the checkout whose engine last touched the schema; `status.ok` there settles it. Never hand-edit `coordination_json`, and never restore a backup to fix a reader.
- **Generated artefacts.** Regenerate through the producer, once, **after** the last edit to the source it digests, then require `--check` to exit 0. Never hand-edit a manifest. A large diff from a correct regeneration is generated output, and the change description must say so.
- **Merges.** Resolve by semantics: ask of each hunk whether the losing side's *meaning* survives in the merged tree, not whether the merged file looks coherent. Then review the merge commit itself against both parents. Green `validation:drift` proves the corpus is self-consistent, not that both sides survived.

## Alternatives considered

**Repair the data because the message says the data is corrupt.** Rejected: the message names a symptom class ("store.corrupt"), not a cause. Acting on it costs a backup restore and the concurrent work inside it. The check that distinguishes the two cases is one `json_type` query, so there is no cost to checking first.

**Keep the digest fresh continuously by regenerating after every skills commit.** Rejected: it multiplies the work and each regeneration is invalidated by the next peer commit. One regeneration at the end is both cheaper and the only state CI actually verifies.

**Accept "drift is green" as merge acceptance.** Rejected: drift validates self-consistency of the resulting corpus. A hand resolution that drops a sentence produces a perfectly self-consistent tree with one fact missing, which is precisely the failure mode being guarded against.

## Consequences

- Recovery for all three begins with the same move, which is why they are recorded together rather than as three notes.
- The store trap requires knowing which checkout wrote it. That is a per-iteration fact worth recording in the iteration's own notes, not a property of the repository.
- The merge trap adds one review seat per merge commit that resolves a conflict by hand. In practice that is rare, and its absence is invisible until a fact is already missing.
- Local `{HARNESS_DIR}/knowledge/` is **not** tracked (`.mstar/` is gitignored). Knowledge recorded there serves the machine it was written on; anything that must survive a clone belongs here or in `docs/`.
