# Plan-scoped primary session

Drive **one** prepared plan from an independent terminal instead of the whole iteration. The scoped session binds a single plan through the CLI, runs the normal per-plan gates (implement → plan QC tri → QA gate), and stops at a durable **handoff**. `Done` and both lease releases stay with the iteration coordinator, which verifies the merge first.

> **Status: interface skeleton.** The command forms on this page are the frozen interface. Executable detail — flags, exit codes, JSON envelopes, rejection codes and the examples that depend on them — is owned by the CLI reference and is completed together with the `mstar plan` section of [`docs/cli.md`](cli.md). No statement on this page was verified by running a CLI command.

## Coordinator preparation

The coordinator holds one seat per workflow and registers the reviewed Assignment on the target row before any plan session starts.

```bash
mstar plan bind --coordinator --workflow <workflow-id> [--harness <absolute-path>] [--json]
mstar plan prepare --session <coordinator-session> --plan <plan-id> --assignment <absolute-md-path> --expect <revision> [--json]
```

`prepare` is preparation, not a second business plan: dependency and task readiness stay PM judgment. The prepared Assignment is immutable while the plan is claimed, so amending it means stopping the writable work, restoring the pinned file and re-preparing.

## Fresh scoped entry

```text
/iteration-drive --assignment <absolute-assignment-md-path>
/iteration-drive --workflow <workflow-id> --plan <plan-id>
/iteration-drive --resume <absolute-session-json-path>
```

The first two are the fresh addressing forms and resolve the same registered Assignment; the third resumes an already bound session and is the only resume form. Duplicate flags, unknown flags, positional arguments, missing or blank values, mixed forms and a partial `--workflow`/`--plan` pair fail closed before any claim — they never widen to the whole-iteration route. No arguments at all keep the existing whole-iteration route.

Each form binds once; the plan session is then re-read with `show` and constrained to the returned scope:

```bash
mstar plan bind --assignment <absolute-md-path> [--json]
mstar plan bind --workflow <workflow-id> --plan <plan-id> [--harness <absolute-path>] [--json]
mstar plan bind --resume <absolute-session-json-path> [--json]
mstar plan show --session <plan-session-json-path> [--json]
mstar plan show --session <coordinator-session-json-path> --plan <plan-id> [--json]
```

A second fresh entry for the same plan fails with the active holder; only explicit `--resume` of the original session continues, and the scoped session never passes a session credential to a child.

## Plan-local progress

```bash
mstar plan progress      --session <plan-session> --file <absolute-json-path> --expect <revision> [--json]
mstar plan residual-add  --session <plan-session> --file <absolute-json-path> --expect <revision> --expect-register <version> [--json]
mstar plan residual-close --session <plan-session> --entry <id> --note <text> --expect <revision> --expect-register <version> [--json]
mstar plan handoff       --session <plan-session> --file <absolute-json-path> --expect <revision> [--json]
```

`--expect` is the row revision read from `show`, not the snapshot schema version or a date. `handoff` is the scoped finish line: the row keeps `InReview` and its `execution_lease`, and the session stops there — including for the last unfinished plan. A plan session never writes `Done`.

## Coordinator completion

```bash
mstar plan accept             --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan return             --session <coordinator-session> --plan <id> --handoff <id> --reason <text> --expect <revision> [--json]
mstar plan integration-start  --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan integration-accept --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan complete           --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan reconcile          --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
```

Between `integration-start` and `integration-accept` the coordinator performs the pinned merge itself, as an argument-array Git call — never shell interpolation, no squash, no rebase, no branch-name merge:

```bash
git -C <integration-worktree-path> merge --no-ff --no-edit <pinned-source-sha>
```

`complete` is the single atomic write that sets `Done` and releases both leases. After a crash, `reconcile` observes Git ancestry and the recorded pins instead of trusting a success flag; merged but uncleaned state is not `Done`.

## Transport is optional

The second terminal is transport, not a dependency. Any terminal works; Herdr or tmux are optional ways to open one, and nothing in this route reads pane state, TTL or terminal labels to decide ownership.

## Reference

- Executable flags, exit codes and JSON envelopes: [`docs/cli.md`](cli.md) — the `mstar plan` section is delivered by the CLI task.
- Runtime route contract: `skills/mstar-iteration/references/plan-scoped-pm.md`.
- Row/session/handoff fields and ownership: `skills/mstar-artifacts/references/status-and-residuals.md`.
