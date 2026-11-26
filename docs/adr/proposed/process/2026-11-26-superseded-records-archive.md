# ADR: A fully superseded record is archived, never left in implemented

Status: proposed — recorded before implementation: `adr.md` still says "`superseded` is not `archived`", `lintAdrTree` has no `implemented-superseded` rule, and no record moves until the implementing change lands.
Date: 2026-11-26

Scope: the `implemented → archived` lifecycle move of `skills/mstar-doc-corpus/references/adr.md` when the reason is a supersession, the `lintAdrTree` ADR rules in `packages/engine/src/lint.ts`, and the two existing records that already carry a `Superseded-by:` line.

## Problem

The ADR contract states two rules that contradict each other.

- Archive admission requires that "the decision is fully superseded or its mechanism is gone".
- Its own next section says the opposite: "`superseded` is not `archived`" — a superseded record "stays in its live bucket with both-way `Supersedes:` / `Superseded-by:` lines".

The second rule is the one the tree follows, so a record whose replacement is already implemented keeps sitting in `docs/adr/implemented/`:

- `docs/adr/implemented/architecture/2026-11-03-one-way-linear-push.md` carries `Superseded-by: 2026-11-19-host-owned-linear-io.md`. That replacement is implemented. The old record is still filed as a standing decision.
- PR 851 added `Superseded-by: 2026-11-26-retire-project-roadmap.md` to `docs/adr/implemented/architecture/2026-10-02-roadmap-content-authority.md` while the replacement was only proposed. A reader of the implemented tree was told the roadmap authority was already replaced, and would have been told so even if the proposal had been rejected.

The contract names `implemented/` as the bucket whose records are live statements a change must keep current. A reader or an agent that takes the bucket at its word gets a demoted record as current. A proposal can demote a live decision without anything having been decided. That is the defect: the bucket and the header disagree about what is current, and the validator does not look.

## Proposal

This record is not in force until it is implemented. Until then the contract text, the validator and the two records named above stay as they are.

**A fully superseded implemented record moves to `archived/<class>/`. It never stays in `implemented/`.**

### Move

When a replacement is promoted to `implemented/`, the same change does all of this, and lands none of it separately:

1. moves the replaced record to `docs/adr/archived/<class>/<same-filename>` — the filename is unchanged, only the bucket directory changes;
2. adds one bare line `Archived: YYYY-MM-DD — superseded by <replacement-file>` immediately below its Status line, which stays `Status: implemented — …` unchanged;
3. keeps its `Superseded-by: <replacement-file>` line.

The replacement carries `Supersedes: <replaced-file>`. Both lines stay after the move, so a supersession search over the whole tree still finds either record from the other.

This is the existing `implemented → archived` move with its reason fixed to the supersession. It adds no fourth transition and no new header key.

### Reader boundary

- `implemented/` is the only bucket a reader or an agent may take as current decisions. Anything filed there is a live statement.
- `archived/` is not authority. It may be read only through an explicit link that cites history.
- Active prose may point into `archived/`. It never summarizes an archived record as authority.

### Proposed never moves the target

While the replacement sits in `proposed/`, the standing record stays in `implemented/` untouched:

- no `Superseded-by:` line on the standing record;
- no `Supersedes:` header on the proposal. The proposal states the supersession in prose under `## Proposal` instead, naming the record it will archive.

The demotion happens once, in the change that promotes the replacement. A proposal that is rejected therefore leaves no trace on the record it would have replaced, and the ambiguous state — a rejected proposal that already demoted a live decision — cannot occur.

### Lint rule

`lintAdrTree` (packages/engine/src/lint.ts) fails any record under `implemented/` whose header carries a `Superseded-by:` line.

- **Failure code:** `adr.implemented-superseded`.
- **Scope:** single-file. It reads the record's own header and needs no cross-file lookup, so it does not judge whether the replacement exists or is implemented.
- **Refusal text:** names the file and states the exact recovery: move it to `docs/adr/archived/<class>/<same-filename>`, add `Archived: <date> — superseded by <replacement>`, keep `Superseded-by:`.

A record under `implemented/` that carries `Supersedes:` is unaffected: a replacement stays in `implemented/` for as long as it is current.

### Contract edit

In `skills/mstar-doc-corpus/references/adr.md`:

- the section `## \`superseded\` is not \`archived\`` is removed.
- the lifecycle gains one sentence: a fully superseded record is archived with the supersession reason; `superseded` is not a bucket.

The remainder of that section is already stated elsewhere in the contract or in this record: archived records are frozen and linked only to cite history, and a change that alters what a live record states updates the record. No bucket is added and no status mapping changes.

### Migration of the existing tree

- `docs/adr/implemented/architecture/2026-11-03-one-way-linear-push.md` moves to `docs/adr/archived/architecture/2026-11-03-one-way-linear-push.md` in the implementing change: `2026-11-19-host-owned-linear-io.md` is already implemented and supersedes it. It gains `Archived: <date> — superseded by 2026-11-19-host-owned-linear-io.md` and keeps its `Superseded-by:`.
- `docs/adr/implemented/architecture/2026-10-02-roadmap-content-authority.md` does not move in the implementing change. It moves only when the roadmap record is promoted, in that same change.

## Alternatives considered

- **Add a `superseded/` bucket.** It duplicates the role `archived/` already has, and it needs a new status mapping in the validator, a new entry in `ADR_BUCKETS`, a new skeleton decision and a new rule in the contract. The fate of a superseded record is already "no longer guides future work, keeps historical value", which is the archive admission.
- **Keep the current both-way-lines-in-place rule.** It leaves a demoted record in the bucket the contract calls live. Readers treat it as current, which is the defect; the rule is what produced it.
- **Delete the superseded body and keep a stub.** The archive exists to keep history. A stub loses the decision and the alternatives it beat, so a later contributor can reintroduce the bypass the record was written to stop, and the frozen `rejected/` bucket is already the home for proposals that never shipped.
- **Demote the record's Status line in place.** The status must match the bucket, and the validator enforces it: a `Status: superseded` record under `implemented/` is `lint.adr.status-mismatch`. Making the status legal would make `superseded` a state without a bucket, and the directory — not a header a reader can miss — is the reader boundary.

## Acceptance criteria

A future implementation must demonstrate the following.

- `lintAdrTree` refuses an implemented record that carries a `Superseded-by:` line with code `adr.implemented-superseded`, and the refusal names the file and the move to `docs/adr/archived/<class>/<same-filename>`.
- No record under `docs/adr/implemented/` carries a `Superseded-by:` line.
- `docs/adr/archived/architecture/2026-11-03-one-way-linear-push.md` exists with its `Archived:` line and its `Superseded-by:` line, and no copy remains under `implemented/`.
- The roadmap record is promoted and `docs/adr/archived/architecture/2026-10-02-roadmap-content-authority.md` exists, both in the same change.
- `skills/mstar-doc-corpus/references/adr.md` states one rule: a fully superseded record is archived with the supersession reason, and `superseded` is not a bucket. The section "`superseded` is not `archived`" is gone.
- Links that pointed at `docs/adr/implemented/architecture/2026-11-03-one-way-linear-push.md` resolve to its new path; the body of `2026-11-19-host-owned-linear-io.md` needs no edit, because an archived record's inbound links are the ones that move.
- `checkAdrTree` passes.

## Risks

- **A reader can still grep `archived/`.** The directory is the boundary, not an access control. A search that does not exclude `archived/` returns records that are not authority; the `Archived:` line on each one says so at the top of the file.
- **The lint cannot judge whether the replacement is really implemented.** It refuses the line, not the truth of it. A change that archives a record before its replacement is promoted passes the lint and is a review finding.
- **Archived bodies are frozen.** A later correction to an archived record needs a new record, or an un-archive move that the contract does not define. That is the cost of every archived record, and it is the reason the move waits for the promotion.
- **The migration touches links from `2026-11-19`.** `2026-11-19-host-owned-linear-io.md` carries `Supersedes: 2026-11-03-one-way-linear-push.md` as a bare filename, so it needs no edit; the proposal that links to the one-way mirror's path does, and the implementing change must find every such link with a search for the old path.
