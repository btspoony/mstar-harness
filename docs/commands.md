# Command reference

The slash commands this repository ships live in [`commands/`](../commands). This page indexes all seven: what each one does, the argument form it accepts, which sibling to reach for, and the skill that owns its semantics.

Two boundaries hold across the page. All seven are **user entry points** — a command boots `project-manager` in your current session, and none of them is a subagent target: a leaf executor that receives one refuses it on role grounds. And this page is a **router, not a second protocol home** — every behavioural rule stays with its owning skill, while the `mstar-harness` binary reference — the `plan` verbs, flags and exit codes — stays with the **`mstar-use-cli`** skill, and install / `init` / `doctor` with [`INSTALL.md`](../INSTALL.md).

For project roadmap content, use the CLI `mstar roadmap` family (not a slash command): show, reviewed import, revision-guarded replace and transport export. The authoring/read/write rules live only in `mstar-project-governance`; `mstar-use-cli` indexes the family and the built command's `--help` owns its options.

## Store CLI upgrade and recovery

`mstar store upgrade --operator <name> [--harness <path>]` is the single default path for importing legacy workflow state. It creates or opens the local store, imports recognizable records, activates execution authority, and reports unrecognized or unresolvable items without moving them from their original paths. Stop writers and align consumers before upgrading an existing store; this is not an online production cutover.

The six `store` verbs administer project harnesses, including the main worktree's canonical control root. `--harness <path>` selects that project explicitly; omitting it uses normal discovery from the working directory. CLI and MCP use the same domain operations and retain their maintenance locks, verified-backup checks and migration/activation guards.

For an existing store, retain a verified recovery image before upgrading:

```text
mstar store backup --harness {HARNESS_DIR} --out <absolute-backup.db>
mstar store upgrade --harness {HARNESS_DIR} --operator <name>
```

If a retired held claim requires the operator's full stop attestation, construct the document using `mstar schema --command store.upgrade` and retry the same upgrade with `--attestation <absolute-json>`. Do not hand-edit the store or replace the project target with a fixture to evade a refusal.

The remaining `store` verbs are `init`, `migrate`, `backup`, `activate`, and `retire`. `migrate` / `activate` / `retire` remain the separate issue/catalog migration flow. The only remaining `store execution` verbs are `restore-preview`, `restore`, and `export`: restore previews and restores use a standalone `store backup` image; export reports the current execution state. Staged execution preview/apply/activate/retire/abort and the safe-upgrade verb are removed.

| Command | Purpose | Owning skill |
|---------|---------|--------------|
| [`/iteration-start`](#iteration-start) | Start an iteration: interactive direction lock, then the full lifecycle | `mstar-iteration` |
| [`/iteration-drive`](#iteration-drive) | Drive/resume the selected locked iteration with one primary coordinator | `mstar-iteration` |
| [`/iteration-loop`](#iteration-loop) | The same lifecycle end to end, autonomous lock, minimal human intervention | `mstar-iteration` |
| [`/codebase-audit`](#codebase-audit) | Read-only survey of a codebase → prioritized improvement plans | `mstar-audit` |
| [`/amazing-test-audit`](#amazing-test-audit) | Read-only test-suite audit → plans to delete / repair / consolidate tests | `mstar-audit` (`tests` focus) |
| [`/amazing-pr-review`](#amazing-pr-review) | Read-only pre-merge review of a PR / branch / diff → one verdict | `mstar-audit` (`pr` variant) |
| [`/amazing-e2e-check`](#amazing-e2e-check) | Explicitly requested E2E / browser / device / deployment verification | `mstar-e2e` |

iteration-start locks interactively, iteration-drive resumes an already locked iteration, and iteration-loop runs Phase 1→6 autonomously. None launches a per-row PM.

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
/iteration-drive
```

**Purpose** — drive the active iteration to completion: Phase 2 Autonomous Execute → Phase 3 iteration-close → Phase 4 Create PR → Phase 5 PR merge-ready → Phase 6 post-merge close. Done is Phase 6 §6.1–§6.4 complete; neither the close, nor an open PR, nor a merged PR is Done by itself.

**When/arguments** — resume or advance an already locked iteration, with no arguments. Reject every nonempty argument shape before boot; never reinterpret unsupported input as whole-iteration authorization. PM stays in the primary session; a leaf receiving this command refuses it.

**Defined in** — [`commands/iteration-drive.md`](../commands/iteration-drive.md); phase route and transition gates → `mstar-iteration` (`references/phase-2-worktree-lease.md`, `references/phase-3-iteration-close.md`, `references/phase-4-5-pr-delivery.md`, `references/phase-6-post-merge-close.md`); Phase 5 helper-skill discovery → `references/phase5-helper-discovery.md`.

### Direct row operations

The primary coordinator uses ordinary `show`, revisable `prepare`, `progress`, `issue-add`, `issue-close` and direct `complete`. Source facts live in row metadata. Defaults are mandatory QA and allow-residual cleanup; configuration remains revisable during active execution, and valid metadata/defaults need no ceremonial prepare record. Leaf Assignments retain task identity/scope/worktree/evidence, not sealed plan admission.

All rows use the same workflow coordinator, transaction/CAS/receipt discipline and declared-route completion:

| Route | Direct completion proof | Outer obligation |
|---|---|---|
| Iteration/non-standalone | Reviewed source/QC/QA and real already-performed serial two-parent integration merge in recorded target checkout, with actual base/result SHAs | Parent compound/PR/verified merge/terminal close; no child PR |
| Standalone development | Reviewed source/QC/QA and clean registered source checkout/ref, without iteration integration inputs | Own compound/PR/verified merge/terminal close |
| Standalone report-only | Explicit registered-policy fulfilment recorded before Done plus QC/QA, without invented Git/integration | Evidence-backed terminal close, no PR/merge |

Completion never performs Git merge or an ownership transfer. The coordinator explicitly merges once in the recorded integration checkout and then complete verifies the actual result. Lost output means retry complete against actual facts, not a second merge. Resolve/abort a real conflict in Git. Exact replay preserves completion timestamps. Recovery replaces only the explicitly stopped workflow coordinator; row-specific sessions/launches are removed.

Runtime sequence → `mstar-iteration/references/phase-2-worktree-lease.md`; fields/lifecycle → `mstar-artifacts`; exact flags/JSON/exit codes → `mstar-use-cli/references/plan-and-workflow.md`.


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

**When** — before `/iteration-start`, to discover what is worth doing; or standalone, to build a prioritized backlog. Findings feed the normal Prepare → Execute flow. `/amazing-pr-review` reviews an existing change rather than surveying the codebase, `/amazing-test-audit` audits the test suite rather than the whole codebase, and `/amazing-e2e-check` verifies behaviour rather than reading code.

**Args** — an optional keyword narrows the pass (a category focus such as `bug`, `security`, `perf`, `tech-debt`); the `simplify` variant runs a debt-focused deep pass over dead, duplicated, speculative and over-built surfaces.

**Hosts** — on dsh, the large-repo fan-out runs through the native `workflow` tool rather than `subagent`; other hosts keep their own invoke tool.

**Defined in** — [`commands/codebase-audit.md`](../commands/codebase-audit.md); procedure → `mstar-audit` (common core in the skill, full-audit detail in `references/codebase-audit.md`); dsh fan-out script → `mstar-host` → `references/dsh-workflow-scripts.md`.

## /amazing-test-audit

```text
/amazing-test-audit [scope|subsystem] [quick|deep] [campaign]
```

**Purpose** — a read-only audit of the existing test surface: sweep for junk patterns (assertion-free probes, source restatements, mock-tested mocks, test-only production seams), grade every candidate against the value/retention bar, and produce prioritized plans to delete, repair, consolidate, or relocate tests. No test edits, no source edits, no state machine, no commits: the audit is advisory and its output is plan *candidates*. A baseline test failure is reported as a suspected product bug, never silently deleted.

**When** — when the suite itself is the question: pruning or repairing test debt before an iteration, after a test-heavy change, or as a standalone backlog pass. `/codebase-audit` surveys the whole codebase rather than the test surface, and `/amazing-pr-review` reviews an existing change rather than the suite.

**Args** — a `scope|subsystem` token narrows the sweep to that area; `quick` / `deep` set the effort level (the audit effort table shared with `/codebase-audit`) and default to a whole-repo sweep; the `campaign` token switches to a whole-subsystem campaign that marks every test declaration in an `R` / `F` / `C` / `D` ledger before any plan is written. `quick` and `campaign` are mutually exclusive — campaign breadth is always the whole subsystem, so the combination hard-stops and asks the user to drop one token.

**Hosts** — the lane fan-out follows `/codebase-audit`: read-only `scout` / `explore` seats per lane under the assignment's read-only delegation grant; each host keeps its own invoke tool (no native dsh `workflow` script ships for this entry).

**Defined in** — [`commands/amazing-test-audit.md`](../commands/amazing-test-audit.md); procedure → `mstar-audit` (common core in the skill, test-suite detail in `references/test-audit.md`); lane fan-out routing → `commands/amazing-test-audit.md` (Routing, mirrors `/codebase-audit`).

## /amazing-pr-review

```text
/amazing-pr-review [pr|branch|scope] [quick|default|deep]
```

**Purpose** — a read-only, evidence-first review of a PR / branch / diff that decides whether a change is safe to ship: one verdict — `ship it` / `needs fixes` / `blocked`, computed from the finding tally, never chosen, with a display-only score band (`mergeable` / `good` / `pass` / `fail`) — plus the findings, and a posted GitHub review whenever a PR number is given (posting is mandatory then). It never auto-approves, never requests changes and never merges.

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
