# ADR: Five store, ledger and annotation limits are accepted at their documented boundary instead of gaining mechanisms

Status: implemented — the limits already hold in the cited modules, so this record is the standing decision that accepts them; `I-000196` is carried under a project-manager waiver.
Date: 2026-11-12

Scope: `executionLifecycleOf` in `packages/engine/src/store-read.ts`, the terminal loop in `packages/engine/src/projection.ts`, `writeLedgerTempFile` in `packages/engine/src/execution-ledgers.ts`, the terminal fixtures in `packages/engine/src/dashboard-view.test.ts` and `packages/engine/src/projection.test.ts`, and the annotation identity fields read by `check-annotations` in `packages/judgment/scripts/evaluate.ts`.

## Problem

Five findings are true observations whose acceptances each ask for a mechanism. Terminal fixtures plant store state with raw SQL (`I-000906`); `executionLifecycleOf` answers `active` for a non-terminal projected row the registry does not list as active (`I-000907`); the projection reads every historical terminal iteration header with no retention rule (`I-000913`); a crashed compaction leaves `.compaction-*.tmp` files beside the ledger (`I-000939`); annotation rows carry no `model` or `assistance` (`I-000196`).

Meeting all five acceptances means a second fixture path, a new lifecycle value threaded through every consumer, a retention knob with store-history semantics, a sweep that cannot tell a dead writer's temp file from one a live writer is about to rename, and synthesized identity metadata for fields no producer emits. Each mechanism is a permanent surface maintained for a signal nobody has hit, and each changes behavior to describe a cost that could instead be stated. Left undecided, the reports stay open indefinitely or get closed ad hoc by whichever reader arrives first, and the modules that already rely on the current behavior have nothing to point at.

## Decision

The project accepts the five limits as they stand and records each one's reason and its reversal condition here, rather than adding a knob, a lifecycle value, a sweep or a fixture rewrite. No new schema, cache, validator or retention setting is introduced.

### `I-000906` — terminal fixtures keep planting state with raw SQL

The two terminal tests write `execution_workflows.state_json` and delete `execution_registry` rows directly, so they encode the exact end state the close writer leaves without booting a workflow graph through the public API to reach a terminal row.

**Reason:** the fixtures need a served graph, not a write path; driving the exported writers would require seeding whole workflows whose close path is already covered by the writer's own tests, and the state shape is asserted by those fixtures.

**What would change the decision:** the planted end state drifts from what the real close writer produces and a test passes on a state no writer can reach, or a third file needs the same planting. Then the fixtures move onto the exported writers.

### `I-000907` — a non-terminal projected row without an active registration reads as `active`

`executionLifecycleOf` maps any status that is not terminal to `active`, because `active_registration` is the registry's only claim about a workflow.

**Reason:** `active` is the closed non-terminal arm every consumer already handles; a distinct corruption arm would be a lifecycle value added to the dashboard and CLI surfaces for a row shape the store never writes.

**What would change the decision:** a real store produces that shape, or a consumer needs to present the difference between "active" and "present but unregistered". Then the arm is defined at that consumer, not guessed here.

### `I-000913` — every historical terminal iteration header is projected

The terminal loop reads every terminal header in the served graph unconditionally. Projected rows and refresh cost are linear in the store's whole terminal history.

**Reason:** the projection is a read of the served graph and the graph is the store's honest history; pruning needs a depth knob, and a bounded projection would make the read disagree with the store it serves.

**What would change the decision:** refresh latency on a real store becomes a reported problem, or the served graph stops being a read of the store. Then a retention rule is stated with its bound, and this record is superseded.

### `I-000939` — a crashed compaction leaves a `.compaction-*.tmp` file

`writeLedgerTempFile` removes its temporary on a write failure and on an abandoned rewrite. A process that dies between the write and the rename leaves the file behind.

**Reason:** a sweep cannot distinguish a dead writer's temp file from one a live writer is about to rename, so a time-based sweep would risk deleting live work; the residue is one file per crash, beside the ledger.

**What would change the decision:** the residue collides with a reader, or a long-lived control root accumulates enough of it to matter. Then a sweep scoped by ledger writer state, never by file age, becomes justified.

### `I-000196` — annotation rows carry no `model` or `assistance`

`packages/judgment/src/annotation-seat-gate.ts` emits `seat`, `shard` and `sessionId`; nothing in this repository writes `model` or `assistance`, and `assistance` has no defined meaning in this tree.

**Reason:** `check-annotations` cannot enforce fields no producer emits, and the landing step the acceptance names does not exist. Populating them would mean inventing identity metadata. The acceptance stays unsatisfied; a project-manager waiver of `model` and `assistance` only — their population at a landing step that does not exist, and `check-annotations` enforcement of those two fields — is accepted. The waiver does not reach `seat`, `shard` or `sessionId`: `check-annotations` still rejects a declared seat or shard that disagrees with the shard being read, and still reports all three per shard. It is not a resolution and must not be recorded as one.

**What would change the decision:** a producer for `model` and `assistance` is defined — for example annotation writers that know the model and the assistance level they ran under. Then the acceptance is met by that producer and the waiver is withdrawn.

## Alternatives considered

- **Implement all five acceptances.** Lost: five permanent surfaces — a second fixture path, a lifecycle value every consumer must handle, a retention knob with store-history semantics, a sweep that can delete a live writer's temp file, and synthesized metadata — bought to describe costs no user has reported. Each would then need its own tests, documentation and migration story.
- **One record per limit.** Lost: five files restating one judgment ("take the documented limit, add no mechanism"), and five paths for module comments to cite instead of one. The reasoning and the layer argument would be duplicated and drift.
- **Close the reports with a disposition and no record.** Lost: the acceptances explicitly allow a decision record, and a bare closure loses both the reason and the reversal condition, so the next reader reintroduces the mechanism without meeting the argument against it.
- **Put the limits in a knowledge document.** Lost: knowledge carries how-to and lessons learned; an accepted limit is a standing decision a future contributor must confront before adding the knob, which is what an ADR is for. A knowledge page would also be rewritten by the next capture pass.

## Consequences

- The ADR gate accepts this record under `implemented/architecture/`: `mstar lint docs/adr --type adr` and `bun scripts/adr-check.ts` (Guard 12) pass with it there, and it names `I-000906`, `I-000907`, `I-000913`, `I-000939` and `I-000196`.
- `I-000906`, `I-000907`, `I-000913` and `I-000939` are closed as accepted observations, with no mechanism added for them; `I-000196` remains waived with its acceptance still unsatisfied.
- Three of the five boundaries carry an in-code reference to this path: `I-000907` in `store-read.ts`, `I-000913` in `projection.ts`, `I-000939` in `execution-ledgers.ts`. `I-000906` (the terminal fixtures) and `I-000196` (the annotation identity fields) are recorded here only, with no comment in the modules they describe. No source change adds a knob, lifecycle value, sweep or fixture rewrite for any of them.
- These limits are documented, not enforced. Nothing fails if a future change adds the retention knob or lets a fixture drift, so each reversal condition above is a review obligation rather than a gate.
- The costs are real and accepted: refresh time grows with terminal history, crashed compactions leave dead temporaries, an unregistered non-terminal row reads as active, raw-SQL fixtures can encode state no writer produces, and blind-independence attribution for annotation rows depends on supervisor transcripts rather than the rows.
- `I-000196` carries the largest gap: the waiver accepts weaker attribution than its acceptance wanted, and nothing in the repository closes that gap without a producer for `model` and `assistance`.
- This record is a live statement about those paths: a change that moves a cited function, file or default updates this record in the same change.
