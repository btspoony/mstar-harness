# Architecture decision records

The record contract — when a record is required, the bucket and class semantics, the header rules, the skeletons, the lifecycle moves and the named absences — is stated once in [`skills/mstar-doc-corpus/references/adr.md`](../../skills/mstar-doc-corpus/references/adr.md). This page is that contract's instance in this repository: the tree it governs and the gate that enforces it.

## The tree

`.mstarc` declares `adr_dir=docs/adr`, so `{ADR_DIR}` resolves here and skips the candidate chain (`resolveAdrDir`; symbol definitions → `mstar-conventions`).

```
docs/adr/{bucket}/{class}/yyyy-mm-dd-topic.md
```

- Buckets: `proposed/`, `implemented/`, `rejected/`, `archived/`.
- Classes: `feature/`, `bug-fix/`, `simplification/`, `architecture/`, `process/`, `testing/`.
- `docs/adr/proposed/TEMPLATE.md` and `docs/adr/implemented/TEMPLATE.md` are the skeletons a new record copies; `rejected/` reuses the proposed shape.

## Where the trigger lives

The contract's required/optional test is the only admission test. The runtime surfaces that point at it, so a decision is recorded in the change that makes it rather than at a later cleanup:

- `mstar-phase-gates` § Prepare — the `clarify` closing summary marks each settled decision that meets the test, or states `ADR: none`.
- `mstar-phase-gates` § plan and `mstar-iteration` Phase 1 — a decision not implemented this round and expected to outlive it is written to `proposed/` before implementation; iteration start reads those proposals as direction candidates, and the change that implements one promotes it to `implemented/`.
- `mstar-artifacts/references/plan-files-and-reports.md` — a plan's `## Review Gate Summary` carries `ADR: <path>` or `ADR: none` before `Done`, for iteration and standalone plans alike; PM Acceptance checks the line and that a named record exists in the delivery branch.
- `mstar-iteration/references/phase-3-iteration-close.md` §3.2 — iteration close writes anything the plans left unrecorded, then checks freshness and supersession.

`compound` is knowledge capture and never hosts the judgement: its scoring could skip the step entirely.

Mechanical edits, local edits whose rationale is visible in code or the change description, and decisions already recorded stay exempt.

## What the gate checks, and what it cannot

`bun run validation:drift` (Guard 12, `scripts/adr-check.ts` over the engine's `lintAdrTree`) checks membership, filename shape, `Status` agreeing with the directory for the three live buckets (and an `Archived:` line, with `Status: implemented`, for `archived/`), balanced code fences (an unterminated fence fails the record instead of hiding its tail), and the required and banned sections per bucket. The record-format checks walk `{bucket}/{class}/`, so a stray `.md` directly under `docs/adr/` or directly under a bucket root is invisible to them and review catches it rather than CI; the `INDEX.md` ban covers the whole tree, so an index at either level still fails.

What no tree walk can check stays a review duty: whether `Problem` carries real stakes instead of restating the change, whether `Alternatives considered` lists options genuinely weighed rather than strawmen built afterwards, the rejected-body and archived-body freezes, the same-PR freshness duty for live records, the supersession search and its links, and the title form.
