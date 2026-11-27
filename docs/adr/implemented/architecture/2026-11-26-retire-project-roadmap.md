# ADR: Planning order is a local pointer board, not a stored roadmap document

Status: implemented — the roadmap domain is removed from the engine, the command surface, the collaboration schema and the remote protocol.
Date: 2026-11-26
Supersedes: 2026-10-02-roadmap-content-authority.md

Scope: the roadmap domain — `project_roadmaps` and its Markdown content authority, the `mstar roadmap` family, the dashboard `roadmap` view and the surfaces that read it, the remote snapshot's `project.roadmap` member, the `roadmap.*` codes and the `roadmap` catalog document kind — and its replacement, `{HARNESS_DIR}/planboard.md` with `mstar planboard check`. Milestones, issues, the iteration compass and the `mstar milestone` family keep their authority.

## Problem

The [2026-10-02 record](../../archived/architecture/2026-10-02-roadmap-content-authority.md) made one complete Markdown document the roadmap authority so that "what is this project's roadmap" had a single answer. Since then every fact that document was meant to own gained an authority elsewhere: open work became issues in the issue store at capture, structured goals became milestone records with linked issues, and the per-iteration position became the compass. What remained was a hand-written copy, and the copy stopped being written as a plan.

On 2026-11-26 the collaboration lane holds three roadmap records, and none contains an unstarted plan:

- `_default` — 13,247 chars, revision 19, updated 2026-11-24. Its only forward-looking statement restates milestone `9bae4aaa` (5.0.0, active, 11 linked issues); its `## Recent deliveries` table repeats compass and PR facts.
- `dsh-integration` — 2,455 chars, revision 4, frozen 2026-10-22. It is a copy of issue titles: its four unchecked task-list rows cite six issues, and all six are `resolved` in the issue store.
- `engine` — 1,337 chars, revision 2, frozen 2026-10-11. It is a delivered list.

The 42 distinct issue ids the three records cite all exist in the issue store. Every work item they name is a restatement of a record the store already owns and keeps current, and the store is the only one of the two that moves.

Nothing catches a document that has fallen behind. Only the frontmatter `project_id`, `title` and `status` are machine-checked; the body conventions are warnings that never flip `ok` to false. `dsh-integration` shows six resolved issues as four unchecked tasks, and no check reports the disagreement.

Keeping it costs about 1,700 lines — engine roadmap-store/content with its tests 1,061, the command family with its CLI test 491, and the embedded store-read, dashboard, remote and schema branches — against about 300 for the replacement. That count leaves out the `packages/ui` project screen and the dsh panel and gate that read the same authority. Every real read of the document in this repository had degraded to a rollup or a delivery log.

Without a decision the same divergence ships in 5.0: the collaboration cutover, the remote fidelity contract and the projection write point would each carry a document no reader trusts, while iteration start would still open it first to learn what comes next — the one question none of the three records answers. That ordering has no other home: the issue list sorts by severity and project, a milestone orders goals rather than issues, and the compass `## Roadmap Position` belongs to a single iteration.

## Decision

This record supersedes the [2026-10-02 record](../../archived/architecture/2026-10-02-roadmap-content-authority.md): the same change moved that record to `archived/architecture/` with an `Archived:` line, per the [superseded-records-archive record](../process/2026-11-26-superseded-records-archive.md).

### Remove the roadmap domain

5.0 is an authorized breaking major, so this is a hard removal: no deprecation window, no read-only reader, no fallback. The removal and its replacement are one decision, because the document's only remaining job — saying what comes next — moves to the board below.

**Removal surface.**

- **Storage.** The `project_roadmaps` table, in the lane's admission inventory and in the cutover's table and count lists. The `projection_roadmaps` residue: the table exists in no live schema and every live reference is gone. The one exception is a technical constraint, not a retained capability: the execution store's checksum-verified migration texts stay byte-identical — the ones that create and drop it included — because `store-db.ts` verifies recorded checksums and editing them breaks every applied store. The lane's forward-only migration bodies and the hook bundles that inline these texts follow the same rule.
- **Catalog vocabulary.** The `roadmap` member of `CatalogDocumentKind` in `packages/engine/src/catalog.ts`, the `roadmap: true` entries of both `DOCUMENT_KINDS` tables, the `catalog_entities` CHECK constraint and every CLI or schema enum that lists the value. SQLite cannot alter a CHECK in place, so a collaboration-schema rebuild migration recreates `catalog_entities` without the value and rewrites an existing `document_kind = 'roadmap'` row to `other`. The registration is kept: a catalog row is never deleted to satisfy an enum. This repository holds no such row; the migration must still be correct for a lane that does.
- **Engine.** `roadmap-store.ts`, `roadmap-content.ts` and their exports (`RoadmapError`, `RoadmapRead`, `readRoadmapAuthority*`, `listRoadmapAuthority`, `parseRoadmapContent`, `validateRoadmapContent`, `ROADMAP_STATUSES`); the `RoadmapDTO` and the `roadmap` view of `store-read.ts` and `dashboard-view.ts`; the roadmap frontmatter schema and the `roadmap.md` file references of `project.ts`, `catalog-import.ts` and `iteration.ts`; `remoteRoadmapRead` and `remoteRoadmap` of `collaboration-remote-read.ts`.
- **Commands.** `mstar roadmap show | import | replace | export` with its definitions, index, owning-skill and MCP summaries; the `/api/roadmap` route; the `roadmap.*` codes: `corrupt`, `engine-refused`, `invalid-content`, `operation-conflict`, `project-mismatch`, `project-not-found`, `revision-conflict`, `schema-outdated`, `source-missing`, `store-not-active`.
- **Surfaces.** The dashboard `roadmap` view, its navigation entry and its `#roadmap` destination in `packages/cli/web`; the Roadmap feature of the project screen in `packages/ui` and of the dsh panel; the dsh catalog gate's `RoadmapSourceView` and its roadmap-based project rollup.
- **Remote protocol.** `RemoteRoadmap`, `submission.snapshot.project.roadmap`, the `roadmap` member of the project document in `remote-documents.ts`, and the roadmap carrier of the `project-replace` freeze.
- **Contracts that describe it.** The roadmap chapter of `mstar-project-governance`, the read and write points named below, the projection reconciliation in `workflow-close.md`, the artifact path table, the collaboration and store specs, `docs/commands.md`, `docs/runtime-reference.md`, `docs/migration-5.0.md` and the `.mstarc` comment.

**Not in it.** Milestones and the `mstar milestone` family; the compass `## Roadmap Position`; the `roadmap §…` citations in engine comments, which refer to a design document.

### Store pointers, not prose

`{HARNESS_DIR}/planboard.md` belongs to the control checkout. It is gitignored, never mirrored and never sent to a provider: it sits on the execution side of the collaboration split, is local to that checkout and that machine, and is lost with it. It holds pointers only and never state.

| Line | Means | What owns the fact it points at |
| --- | --- | --- |
| `- I-xxxxxx — <ordering reason>` | a captured issue, in the order the PM intends to take it | the issue store |
| `- ? <candidate> — <evidence path, ADR or I-id>` | an uncaptured candidate | the evidence it names |

```markdown
review_after: 2026-12-10

## Captured

- I-004201 — unblocks the cutover ladder; smallest of the three fixes

## Candidates

- ? split the export into two files — docs/adr/implemented/architecture/2026-11-21-collaboration-state-authority.md
- ? re-triage the panel locale drift — I-004202
```

- Two sections, each at most once: `## Captured` holds issue lines and `## Candidates` holds candidate lines. Either may be absent.
- One `review_after: yyyy-mm-dd` line before the first heading: the date by which every candidate has been captured or dropped.
- No checkbox, status, delivery history or milestone name. Nothing in the file is true or false; it says only where to look and in what order.
- A board line is never the tracking location for deferred work. The Durable Roadmap Gate still requires a store issue or a milestone, and an `I-` line can only point at an issue that was already captured.

### `mstar planboard check`

`mstar planboard check` is the one new verb. It reads the board and the issue store, writes nothing, never fails on what it finds and is not a gate. It reports:

- `stale` — an issue line whose issue is not open;
- `missing` — an issue line whose id is not in the issue store;
- `overdue` — a candidate line once the date is past `review_after`;
- `malformed` — a checkbox, a second issue id on one line, a candidate line without evidence, a section over 20 entries, or any line outside the grammar above, so status, history and milestone names cannot return as prose;
- `unverified` — an issue line the issue store would not answer. A refused or incomplete read is never taken as "open"; the finding carries the store's code.

The verb exits 0 whatever it reports; a malformed invocation keeps the CLI's usage exit. A missing or unparsable `review_after` line is one file-level `malformed` finding, and `overdue` is then not decided. An absent file is a clean board.

### Where the read and write points move

- **Iteration start** (`mstar-iteration` §1.1 step 4) reads the board through `mstar planboard check` beside `mstar milestone list` and the open-issue list, in place of `mstar roadmap show`. The PM then edits the board: stale and missing lines are removed, overdue candidates are captured with `mstar issue add` or dropped, and `review_after` is reset.
- **Iteration close** (§3.3) replaces the roadmap projection candidate with the same edit.
- **Workflow Close Out** keeps the milestone half of its projection reconciliation — `mstar milestone update` once the whole chain is proven — and loses the roadmap replacement.

### Milestone surfaces are re-sourced

The milestone timeline and the milestone write forms of the dashboard project screen and the dsh panel are published features that live under the Roadmap feature. The Roadmap feature is removed, not renamed: both surfaces keep the milestone timeline and the milestone write forms only, reading the milestone rollup directly, and the direction text, the goal list and the present-or-absent document state go with it. No tab, route or label named roadmap survives.

### Migration and recovery

- 4.x is the last line that can run `mstar roadmap export`. The 5.0 `mstar store upgrade` removes the domain; after it nothing can read or write a roadmap.
- The 5.0 migration only drops roadmap content. A forward-only lane migration removes `project_roadmaps` and copies nothing out, and the execution store keeps no copy after its cutover. The one write it makes is the catalog reclassification above; no roadmap text is carried forward.
- Nothing is imported afterwards. Work that an exported document still describes is captured as issues with `mstar issue add`, a goal becomes a milestone with `mstar milestone add`, and direction prose belongs in `STRATEGY.md`. The exported file stays history.

### Remote protocol consequence

- `RemoteRoadmap`, `submission.snapshot.project.roadmap`, the `roadmap` member of the project document in `remote-documents.ts` and the roadmap carrier of the `project-replace` freeze are all removed, with no compat branch. The observe submission and the project-journal event are both `version: 1` documents, and both lose `project.roadmap`.
- Neither shape was released: `v4.9.0` ships no remote mode. The version therefore stays `1` and the shape is revised in place, as the 5.0 line already did when it retired the milestone `target` field: in a submission a `project.roadmap` key is a named refusal, and its absence is the only accepted shape. The host plugin and the CLI move to 5.0 together.
- A 5.0 build freezes no `project-replace` event that carries a roadmap. A journal written by a development build is development data and is re-bootstrapped; no read-side tolerance branch is kept for it.

### Relationship to the collaboration authority record

The [collaboration authority record](../../implemented/architecture/2026-11-21-collaboration-state-authority.md) lists roadmaps among the data collaboration owns — in its Problem, in "Separate the domains", in the `remote` fidelity paragraph and in the "All read models and gates" criterion. This decision removes roadmaps from all four sites: collaboration owns issues, milestones and portable identity, not roadmap prose. Nothing else in that record changes, and the board sits on the execution side of its split by design.

## Alternatives considered

- **Keep the document and enforce its body contract.** Turning the warnings into refusals would make the document honest, at the price of making the PM rewrite, under a gate, a text whose facts the issue store and the milestones already own and keep current. It buys a readable narrative and no reader: the three records show what the narrative degrades into once every fact lives elsewhere.
- **Deprecate in 5.0 and remove in 6.0.** A deprecation window costs one more major of the surface, the cutover and the remote fidelity work, to spare users a break that 5.0 already makes: the collaboration cutover has no dual-write window and no rollback, and a 4.x build cannot open the store afterwards.
- **Remove the roadmap and add nothing.** This is the smallest change. The issue list orders by severity and project and a milestone orders goals, so "what the PM takes next, in which order" would return to conversation or to a compass section that belongs to one iteration — the untracked place the Durable Roadmap Gate exists to forbid.
- **Store the ordering in the collaboration authority.** An ordinal on issues would survive clones and machines, and would also have to enter the cutover, the mirror, the remote fidelity contract, the revision guards and a migration. That is the path by which a local planning judgement became the roadmap document. A gitignored file that holds only pointers needs none of it; what it loses with a machine is an order, not a state.
- **Make `planboard check` a gate.** A stale line is the normal state of a board between iterations, not a failure. A gate would be passed by keeping the board empty, which removes the ordering without removing the verb.
- **Keep the dashboard view under its old name.** A `roadmap` view that holds no roadmap keeps a retired concept alive in a route, a view name and an error namespace, and invites the document back. The milestone board takes a name that says what it is.
- **Bump the remote documents to `version: 2`.** A version bump separates two released shapes. Here there is no released shape that carries a roadmap, so the bump would only leave a version 1 that no build shipped in that form.

## Consequences

This record is implemented; the following hold.

- **The removal is total across the named surface.** A search for the retired names — `roadmap-store`, `roadmap-content`, `project_roadmaps`, `projection_roadmaps`, `RoadmapDTO`, `RemoteRoadmap`, `roadmapBody`, `RoadmapSourceView`, `/api/roadmap`, `#roadmap`, the `roadmap.*` codes — names only immutable migration texts, the execution store's and the collaboration lane's, the hook bundles that inline them and the ADR tree. `mstar roadmap` is an unknown command; no engine module, command definition, host gate, remote document or catalog enum describes a roadmap authority, and the specs and knowledge pages that carry the change's subject have dropped it. A page outside that set that still mentions a roadmap is stale prose, not a surviving authority.
- **No table remains.** After the migration neither database admits a lane or store that carries `project_roadmaps`, and no cutover manifest reports a roadmap count.
- **The catalog kind is gone.** A catalog write with `documentKind: "roadmap"` is refused, no row carries the value, and it is absent from every published enum. A lane that held such rows migrates each one to `other` with its registration intact.
- **The migration page states the route.** `docs/migration-5.0.md` says that 4.x is the last line that can run `mstar roadmap export`, that the 5.0 `mstar store upgrade` removes the domain, and that after it nothing can read or write a roadmap.
- **`mstar planboard check` reports and does nothing else.** Against fixture boards it reports each of `stale`, `missing`, `overdue`, `malformed` and `unverified` with its line, exits 0 for each, and leaves the store revision, the board's bytes and the file list of `{HARNESS_DIR}` unchanged.
- **The grammar is closed.** A checkbox, a second issue id, a candidate without evidence, a 21st entry in a section, an unknown line and a line under the wrong heading are each `malformed`; an absent file and a file with no pointer line report nothing.
- **A refused store is not read as open.** With the issue store refusing, every issue line is `unverified` and carries the store's code, and no line is reported `stale` or `missing`.
- **Milestones still work end to end.** The dashboard project screen and the dsh panel still create, edit, assign and retire milestones after the `roadmap` view is gone, under no tab, route or label named roadmap; `mstar milestone status | list` rollups are unchanged, and Workflow Close Out still marks a milestone `delivered` once its chain is proven.
- **The read and write points moved.** Iteration start reads the board where it read the roadmap, iteration close cleans the board, and no phase writes a roadmap document.
- **The remote documents are consistent.** An observe submission that carries `project.roadmap` is refused by name at that path, one without it is accepted, and no frozen `project-replace` event carries a roadmap.
- **Adjacent records are brought into line.** The collaboration authority record no longer lists roadmaps as collaboration data — the word is gone from its Problem, "Separate the domains", the `remote` fidelity paragraph and the "All read models and gates" criterion, not rephrased — the dashboard projects-view record no longer names a roadmap entry, and this record is promoted.

### Accepted risks

- **The removal destroys content that is not recovered.** An operator who skips the export loses the roadmap text at the upgrade. The migration page's warning is the only guard; the facts worth keeping have owners elsewhere, and the exported file stays readable as a file.
- **The board can become a second roadmap.** Nothing forces the PM to run `check`, and prose written into an ordering reason or a candidate is not machine-judged. The closed grammar, the 20-entry cap and the two edit points are the whole defense; a board that grows status again is a review finding, not a refusal.
- **A candidate exists nowhere else.** The board is local to one machine and is not recovered with collaboration data. An uncaptured candidate lost with the checkout is lost; `review_after` exists to make capture the normal outcome before that can matter.
- **Remote judgments are only as good as the observation.** In `remote` mode `stale` and `missing` describe the admitted snapshot, not the provider. The verb is not a gate, so a stale observation cannot block work, only misreport a board.
- **The milestone surfaces change host.** Moving the timeline and the write forms off the roadmap read touches published screens in two hosts. A regression there loses milestone writing from every surface at once, which the end-to-end milestone criterion exists to catch.
- **A reader of the older collaboration record could still rebuild roadmap storage.** That record no longer names roadmaps as collaboration data, but any copy taken before it was brought into line carries the obsolete list.
