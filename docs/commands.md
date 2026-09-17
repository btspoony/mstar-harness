# Command reference

The slash commands this repository ships live in [`commands/`](../commands). This page indexes all six: what each one does, the argument form it accepts, which sibling to reach for, and the skill that owns its semantics.

Two boundaries hold across the page. All six are **user entry points** — a command boots `project-manager` in your current session, and none of them is a subagent target: a leaf executor that receives one refuses it on role grounds. And this page is a **router, not a second protocol home** — every behavioural rule stays with its owning skill, while the `mstar-harness` binary reference — the `plan` verbs, flags and exit codes — stays with the **`mstar-use-cli`** skill, and install / `init` / `doctor` with [`INSTALL.md`](../INSTALL.md).

| Command | Purpose | Owning skill |
|---------|---------|--------------|
| [`/iteration-start`](#iteration-start) | Start an iteration: interactive direction lock, then the full lifecycle | `mstar-iteration` |
| [`/iteration-drive`](#iteration-drive) | Drive or resume the active iteration — or, with a scope, one prepared plan | `mstar-iteration` |
| [`/iteration-loop`](#iteration-loop) | The same lifecycle end to end, autonomous lock, minimal human intervention | `mstar-iteration` |
| [`/codebase-audit`](#codebase-audit) | Read-only survey of a codebase → prioritized improvement plans | `mstar-audit` |
| [`/amazing-pr-review`](#amazing-pr-review) | Read-only pre-merge review of a PR / branch / diff → one verdict | `mstar-audit` (`pr` variant) |
| [`/amazing-e2e-check`](#amazing-e2e-check) | Explicitly requested E2E / browser / device / deployment verification | `mstar-e2e` |

Between the three iteration commands: `iteration-start` covers Phase 1 with an interactive lock and then continues on its own; `iteration-drive` re-enters or resumes an already locked iteration and carries the scoped route; `iteration-loop` runs Phase 1→6 without the interactive step.

## /iteration-start

```text
/iteration-start [direction] [pause]
```

**Purpose** — Phase 1 of an iteration: research, interactive direction lock with `grill-me`, compass and plans, the Review & Edit chain, PM lock, integration branch — then auto-continue into Phase 2→6.

**When** — you are starting a new iteration and want to converge on its direction with the PM. `pause` stops after Phase 1 (lock + integration worktree) so you can inspect the artifacts and continue later with `/iteration-drive`; `/iteration-loop` is the same lifecycle with an autonomous lock instead.

**Args** — `direction` is a free-text hint that narrows the candidate scope and seeds `grill-me`; it is not a lock, and the lock stays interactive. A token that is exactly `pause` (case-insensitive) is the flag; the remaining tokens join into `direction`, so `/iteration-start pause` is a pause with an empty hint.

**Hosts** — Cursor Plan mode takes the alternate Phase 1 path (empty CreatePlan scaffold → feedback loop → deferred grill) instead of the sections below; every other host runs the plain path. It is the only command that reads the bundled, non-`mstar-*` `skills/grill-me/` skill.

**Defined in** — [`commands/iteration-start.md`](../commands/iteration-start.md); semantics → `mstar-iteration` (`references/phase-1-prepare.md` for Phase 1 detail, `references/command-shared-invariants.md` for the Phase 2–5 shared invariants); host dispatch → `mstar-host`.

## /iteration-drive

```text
/iteration-drive [no args] | --assignment <absolute-md-path> | --workflow <id> --plan <id> | --resume <absolute-session-json-path>
```

**Purpose** — drive the active iteration to completion: Phase 2 Autonomous Execute → Phase 3 iteration-close → Phase 4 Create PR → Phase 5 PR merge-ready → Phase 6 post-merge close. Done is Phase 6 §6.1–§6.4 complete; neither the close, nor an open PR, nor a merged PR is Done by itself.

**When** — resuming or advancing an already locked iteration. No arguments keep that whole-iteration route unchanged; a scope flag takes the scoped route below. Every other non-empty shape — duplicate or unknown flags, positional arguments, missing or blank values, mixed forms, a half `--workflow`/`--plan` pair — **fails closed** before `bind` and before boot, and never falls back to the whole-iteration route.

**Hosts** — the scoped route boots the PM in your **primary session**, never as a subagent; a leaf executor that receives this command refuses it.

**Defined in** — [`commands/iteration-drive.md`](../commands/iteration-drive.md); phase route and transition gates → `mstar-iteration` (`references/phase-2-worktree-lease.md`, `references/phase-3-iteration-close.md`, `references/phase-4-5-pr-delivery.md`, `references/phase-6-post-merge-close.md`); Phase 5 helper-skill discovery → `references/phase5-helper-discovery.md`.

### Scoped plan session

Drive **one** prepared plan from an independent terminal instead of the whole iteration. The scoped session binds a single plan through the CLI, runs the normal per-plan gates (implement → plan QC tri → QA gate), and stops at a durable **handoff**. A plan session never writes `Done`; the coordinator runs `complete` after `accept` — on the **iteration** route after a verified merge, on the **standalone development** route straight from the accepted handoff (no merge, only the row execution lease).

The scope rides on the `mstar plan` verb family; the table below enumerates each verb and who may call it — that ownership model is the whole point of the feature:

| Caller | Verbs | What it owns |
|--------|-------|--------------|
| Coordinator seat | `bind --coordinator`, `prepare` | one seat per workflow; registers the reviewed Assignment on the target row |
| Fresh scoped entry | `bind --assignment` / `bind --workflow --plan` | the first claim of a prepared row |
| Resumed session | `bind --resume`, `show` | reading the row, its scope and its allowed operations |
| **Plan session writes** | `progress`, `residual-add`, `residual-close`, `handoff` | its own row and its own register bucket only |
| **Coordinator transitions** | `accept`, `return`, `integration-start`, `integration-accept`, `complete`, `reconcile`, `repair-delivery-source` | the lifecycle around completion: `integration-start` / `integration-accept` are iteration-route only, and the repair verb is a legacy exception rather than a normal step |

Session identity is never a flag: `--session <absolute-json>` names an engine-generated envelope that the engine re-checks against the snapshot inside its lock. There is no `--force`, no holder input, no takeover and no lease-release verb.

#### Entry forms

```text
/iteration-drive --assignment <absolute-assignment-md-path>
/iteration-drive --workflow <workflow-id> --plan <plan-id>
/iteration-drive --resume <absolute-session-json-path>
```

The first two are the fresh addressing forms and resolve the same registered Assignment; the third resumes an already bound session and is the only resume form. No arguments at all keep the whole-iteration route above.

Each form binds once, and the session then re-reads with `show` and is constrained to the returned scope: the loaded skills, the child Assignments, the backlog, the goal text and every writable path. A second fresh entry for the same plan fails with the active holder; only explicit `--resume` of the original session continues, and the scoped session never passes a session credential to a child.

#### Coordinator preparation

The coordinator holds one seat per workflow. It runs `bind --coordinator` once, then `prepare` for the plan, which registers the reviewed Assignment on that row and releases its dependencies. That is preparation, not a second business plan: dependency and task readiness stay PM judgment. The prepared Assignment is immutable while the plan is claimed, so amending it means stopping the writable work, restoring the pinned file and re-preparing.

#### Scope boundary

A scoped session owns one **row**, not the workflow. It reads with `show` and writes only `progress`, `residual-add`, `residual-close` and `handoff`, plus its own bucket in the project register. Sibling rows, the snapshot's lifecycle anchors, the root `status.json` register, the shared knowledge/iteration indexes, the iteration PR and Phase 3–6 stay with the coordinator; no scoped verb performs a raw snapshot or register write.

The writable surface, the field ownership and the lock rules are stated once in the runtime contract and the field reference — see *Ownership and references* below.

#### Revision preconditions

Every mutating verb takes the row revision it read from `show` — passed as `--expect`, and `0` for a row whose coordination record is still absent, never the snapshot schema version or a date — and the residual verbs additionally take the project register's byte version from the same call (`--expect-register`, the literal `absent` before that register exists). `bind` is the only verb without that precondition, because it reads, checks and claims atomically against current ownership.

A write whose precondition no longer holds is refused instead of overwriting, so a stale retry refreshes with `show` first. Row revision and document byte versions are separate preconditions and never substitute for each other.

#### Finish and completion

`handoff` is the scoped finish line: the row keeps `InReview` and its `execution_lease`, and the session stops there — including for the last unfinished plan. A plan session never writes `Done`, and a request to mark `Done` before the lifecycle completes is rejected: completion comes from the coordinator's `complete` — after a verified merge on the iteration route, or straight from the accepted handoff on the standalone development route.

The coordinator half starts the same way on both routes — `accept` (execution ownership transfers, still no merge) — and then follows the route the engine selects from the workflow's own type and delivery kind, never from anchors that happen to be missing. On the **iteration** route: `integration-start` (pins the attempt and its base before Git runs) → the pinned merge → `integration-accept` (records the verified result, both leases still held) → `complete`. On the **standalone development** route `complete` runs straight from the accepted handoff, with no integration record and no merge lease. `complete` is the single atomic write that sets `Done`: it releases both leases on the iteration route and only the row's execution lease on the standalone route, where the workflow stays running until its delivery evidence and the close. `return` hands a submitted or accepted handoff back to the plan owner with a reason.

On the iteration route the merge is the coordinator's own Git action — an argument array, never shell interpolation — with no squash, no rebase and no branch-name merge:

```bash
git -C <integration-worktree-path> merge --no-ff --no-edit <pinned-source-sha>
```

`--handoff <id>` must be the row's live handoff id — the one `plan handoff` minted and `show` reports — and the row stays the authority, so a different id is refused rather than trusted.

#### After a crash

`reconcile` observes Git ancestry and the recorded pins instead of trusting a success flag. Merged but uncleaned state is not `Done`, and an interrupted attempt is classified — retry-ready, completed, or a refusal that preserves every lease — without a second merge.

#### Transport

The second terminal is transport, not a dependency. Any terminal works; Herdr or tmux are optional ways to open one, and nothing in this route reads pane state, TTL or terminal labels to decide ownership.

#### Ownership and references

- Runtime route contract, scope boundary and coordinator sequence: the **`mstar-iteration`** skill → `references/plan-scoped-pm.md`.
- Row, session and handoff fields and ownership: the **`mstar-artifacts`** skill → `references/status-and-residuals.md`.
- Executable flags, exit codes, JSON envelopes and rejection codes: the **`mstar-use-cli`** skill → `references/plan-and-workflow.md`.

## /iteration-loop

```text
/iteration-loop [direction] [scale]
```

**Purpose** — the whole lifecycle Phase 1→6 with minimal human intervention: code-first research and an **autonomous** direction lock (no `grill-me`), then the same execute → close → PR → merge-ready → post-merge close chain. Done is Phase 6 §6.1–§6.4 complete.

**When** — unattended or cloud runs that should not wait on a direction dialogue. `/iteration-start` locks interactively and `/iteration-drive` resumes an already locked iteration.

**Args** — `direction` is free text that constrains the lock; it may be empty. A trailing token of exactly `S` / `M` / `L` / `XL` (case-insensitive) is `scale`, and the remaining text joins into `direction`, so a lone scale token means an empty direction.

**Scale** — budgets the iteration's **business** plans: `S` 1, `M` 2–3, `L` 3–4, `XL` more than 4. The budget rules — including what the budget does not count — live in `mstar-iteration`.

**Defined in** — [`commands/iteration-loop.md`](../commands/iteration-loop.md); semantics → `mstar-iteration` (`references/phase-1-prepare.md` and `references/autonomous-direction-lock.md` for Phase 1; Phase 2–6 are delegated to the `/iteration-drive` route) plus `references/command-shared-invariants.md`.

## /codebase-audit

```text
/codebase-audit [simplify]
```

**Purpose** — a read-only survey of a codebase as a senior advisor, producing prioritized, self-contained improvement plans in the plans directory (`{PLAN_DIR}/audit-<date>/`). No source edits, no state machine, no commits: the audit is advisory and its output is plan *candidates*.

**When** — before `/iteration-start`, to discover what is worth doing; or standalone, to build a prioritized backlog. Findings feed the normal Prepare → Execute flow. `/amazing-pr-review` reviews an existing change rather than surveying the codebase, and `/amazing-e2e-check` verifies behaviour rather than reading code.

**Args** — an optional keyword narrows the pass (a category focus such as `bug`, `security`, `perf`, `tech-debt`); the `simplify` variant runs a debt-focused deep pass over dead, duplicated, speculative and over-built surfaces.

**Hosts** — on dsh, the large-repo fan-out runs through the native `workflow` tool rather than `subagent`; other hosts keep their own invoke tool.

**Defined in** — [`commands/codebase-audit.md`](../commands/codebase-audit.md); procedure → `mstar-audit` (common core in the skill, full-audit detail in `references/codebase-audit.md`); dsh fan-out script → `mstar-host` → `references/dsh-workflow-scripts.md`.

## /amazing-pr-review

```text
/amazing-pr-review [pr|branch|scope] [quick|default|deep]
```

**Purpose** — a read-only, evidence-first review of a PR / branch / diff that decides whether a change is safe to ship: one verdict — `ship it` / `needs fixes` / `blocked`, computed from the finding tally, never chosen — plus the findings, and a posted GitHub review whenever a PR number is given (posting is mandatory then). It never auto-approves, never requests changes and never merges.

**When** — assessing a change you did not author. Do not use it to self-check your own work.

**Tiers** — `quick` (single pass, one seat) / `default` (the no-flag landing tier, two seats) / `deep` (the full three-stage pipeline). An explicit token wins over size- and sensitivity-based inference; two tier tokens together hard-stop and ask the user. Tier contracts and their wall-clock budgets live in `mstar-audit` → `references/pr-review.md`.

**Hosts** — on dsh, the `deep` tier's seats run through the native `workflow` tool while `default` and `quick` keep `subagent`; other hosts keep their own invoke tool.

**Batch** — one session reviews one PR; remaining PRs from a multi-PR input are registered as audit todos, one session each.

**Defined in** — [`commands/amazing-pr-review.md`](../commands/amazing-pr-review.md); procedure → `mstar-audit` (`references/pr-review.md`, the `pr` variant: tier resolution, pipeline, worktree isolation, posting, report archive); findings that need fixing become plans through the shared plan-output contract in `mstar-audit`.

## /amazing-e2e-check

```text
/amazing-e2e-check [environment/device] [scenarios]
```

**Purpose** — run explicitly requested E2E, browser, device or installed-deployment scenarios as an independent verification workflow. The owning skill covers registration, evidence, scope boundaries and closure.

**When** — on an explicit user request only. It is never a routine iteration QA gate, and routine QA never triggers it.

**Execution** — the PM orchestrates and the assigned `ops-engineer` executes; the entry itself does not authorize E2E from routine QA and does not insert it into an iteration.

**Defined in** — [`commands/amazing-e2e-check.md`](../commands/amazing-e2e-check.md); semantics → `mstar-e2e`.
