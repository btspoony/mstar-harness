# Plan-scoped primary session

Drive **one** prepared plan from an independent terminal instead of the whole iteration. The scoped session binds a single plan through the CLI, runs the normal per-plan gates (implement → plan QC tri → QA gate), and stops at a durable **handoff**. `Done` and both lease releases stay with the iteration coordinator, which verifies the merge first.

The scope rides on the `mstar plan` verb family. Thirteen verbs ship, and who may call them is the whole point of the feature:

| Caller | Verbs | What it owns |
|--------|-------|--------------|
| Coordinator seat | `bind --coordinator`, `prepare` | one seat per workflow; registers the reviewed Assignment on the target row |
| Fresh scoped entry | `bind --assignment` / `bind --workflow --plan` | the first claim of a prepared row |
| Resumed session | `bind --resume`, `show` | reading the row, its scope and its allowed operations |
| **Plan session writes** | `progress`, `residual-add`, `residual-close`, `handoff` | its own row and its own register bucket only |
| **Coordinator transitions** | `accept`, `return`, `integration-start`, `integration-accept`, `complete`, `reconcile` | the lifecycle around the merge |

Exact flags, JSON envelopes, rejection codes and exit codes live in the CLI reference — [`mstar-harness plan`](cli.md#mstar-harness-plan) — and are not repeated here. Session identity is never a flag: `--session <absolute-json>` names an engine-generated envelope that the engine re-checks against the snapshot inside its lock. There is no `--force`, no holder input, no takeover and no lease-release verb.

## Coordinator preparation

The coordinator holds one seat per workflow. It runs `bind --coordinator` once, then `prepare` for the plan, which registers the reviewed Assignment on that row and releases its dependencies. That is preparation, not a second business plan: dependency and task readiness stay PM judgment. The prepared Assignment is immutable while the plan is claimed, so amending it means stopping the writable work, restoring the pinned file and re-preparing.

## Fresh scoped entry

```text
/iteration-drive --assignment <absolute-assignment-md-path>
/iteration-drive --workflow <workflow-id> --plan <plan-id>
/iteration-drive --resume <absolute-session-json-path>
```

The first two are the fresh addressing forms and resolve the same registered Assignment; the third resumes an already bound session and is the only resume form. Duplicate flags, unknown flags, positional arguments, missing or blank values, mixed forms and a partial `--workflow`/`--plan` pair fail closed before any claim — they never widen to the whole-iteration route. No arguments at all keep the existing whole-iteration route.

Each form binds once, and the session then re-reads with `show` and is constrained to the returned scope: the loaded skills, the child Assignments, the backlog, the goal text and every writable path. A second fresh entry for the same plan fails with the active holder; only explicit `--resume` of the original session continues, and the scoped session never passes a session credential to a child.

## What a scoped session may not touch

A scoped session owns one **row**, not the workflow. It reads with `show` and writes only `progress`, `residual-add`, `residual-close` and `handoff`, plus its own bucket in the project register. Sibling rows, the snapshot's lifecycle anchors, the root `status.json` register, the shared knowledge/iteration indexes, the iteration PR and Phase 3–6 stay with the coordinator; no scoped verb performs a raw snapshot or register write.

The writable surface, the field ownership and the lock rules are stated once, in [`skills/mstar-iteration/references/plan-scoped-pm.md`](../skills/mstar-iteration/references/plan-scoped-pm.md) and [`skills/mstar-artifacts/references/status-and-residuals.md`](../skills/mstar-artifacts/references/status-and-residuals.md).

## Every mutation carries the revision it read

Every mutating verb takes the row revision it read from `show` — passed as `--expect`, and `0` for a row whose coordination record is still absent, never the snapshot schema version or a date — and the residual verbs additionally take the project register's byte version from the same call (`--expect-register`, the literal `absent` before that register exists). `bind` is the only verb without that precondition, because it reads, checks and claims atomically against current ownership.

A write whose precondition no longer holds is refused instead of overwriting, so a stale retry refreshes with `show` first. Row revision and document byte versions are separate preconditions and never substitute for each other.

## Completion belongs to the coordinator

`handoff` is the scoped finish line: the row keeps `InReview` and its `execution_lease`, and the session stops there — including for the last unfinished plan. A plan session never writes `Done`, and a request to mark `Done` before the merge is rejected: completion comes from the coordinator's `complete` after a verified merge.

The coordinator half is a fixed order: `accept` (execution ownership transfers, still no merge) → `integration-start` (pins the attempt and its base before Git runs) → the pinned merge → `integration-accept` (records the verified result, both leases still held) → `complete` (the single atomic write that sets `Done` and releases both leases). `return` hands a submitted or accepted handoff back to the plan owner with a reason.

The merge is the coordinator's own Git action — an argument array, never shell interpolation — with no squash, no rebase and no branch-name merge:

```bash
git -C <integration-worktree-path> merge --no-ff --no-edit <pinned-source-sha>
```

`--handoff <id>` must be the row's live handoff id — the one `plan handoff` minted and `show` reports — and the row stays the authority, so a different id is refused rather than trusted. After a crash, `reconcile` observes Git ancestry and the recorded pins instead of trusting a success flag; merged but uncleaned state is not `Done`, and an interrupted attempt is classified (retry-ready, completed, or a refusal that preserves every lease) without a second merge.

## Transport is optional

The second terminal is transport, not a dependency. Any terminal works; Herdr or tmux are optional ways to open one, and nothing in this route reads pane state, TTL or terminal labels to decide ownership.

## Reference

- Executable flags, exit codes, JSON envelopes and rejection codes: [`mstar-harness plan`](cli.md#mstar-harness-plan) in the CLI guide.
- Runtime route contract, scope boundary and coordinator sequence: [`skills/mstar-iteration/references/plan-scoped-pm.md`](../skills/mstar-iteration/references/plan-scoped-pm.md).
- Row/session/handoff fields and ownership: [`skills/mstar-artifacts/references/status-and-residuals.md`](../skills/mstar-artifacts/references/status-and-residuals.md).
