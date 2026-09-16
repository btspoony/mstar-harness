# Phase 2 proactive parallel scheduling policy

**Product-locked.** The rescheduling checkpoint and its decision procedure for iteration Phase 2, on every host: when the coordinator re-evaluates independent ready work, how it picks a complete candidate, and when it deliberately waits instead. The OMP-side bounded reminder and the conditional extra primary sessions are specified in `mstar-host/references/omp-phase2-instances.md`; the Phase 2 execution checklist stays in `mstar-iteration/references/phase-2-worktree-lease.md`.

## Background

During iteration Phase 2 the coordinator narrates a linear per-plan lifecycle, so unrelated ready work waits behind a busy child. Existing contracts already permit interleaving — `mstar-sdd` requires concurrent dispatch of independent ready tasks after L2 isolation, `phase-2-worktree-lease` permits interleaving plans with serial integration merges, and `mstar-dispatch-gates` requires starting the complete ready batch before waiting — but none names an explicit moment to re-evaluate. This contract makes the rescheduling checkpoint and its decision procedure explicit in the shared Morning Star skills. The OMP-side bounded reminder and conditional extra primary sessions are specified in `mstar-host/references/omp-phase2-instances.md`.

## Target Users

Morning Star coordinators (PM role executors) on any host during iteration Phase 2, and the specialists they schedule.

## User Stories

1. As PM, while background children run, I reconsider independent ready plans and tasks **before** entering a wait, so unrelated work is not serialized behind a busy lifecycle.
2. As PM, when results settle or dependency/ownership/capacity facts change, I re-run the scheduling check rather than waiting for an entire unrelated lifecycle to finish.
3. As PM, when nothing useful and authorized is ready, I wait for the native notification and state the concrete dependency/capacity/ownership reason once — no timer loop, no repeated self-reminders.
4. As PM, I keep a true dependency blocked until its reviewed prerequisite commits exist in the dependent's assigned base, and I never re-split dispatched work.

## Locked user decisions

Do not re-ask:

| # | Decision | Product reading |
|---|---|---|
| 1 | Acceleration applies only during iteration Phase 2 | No Phase 1 review parallelism; no Phase 3–6 lifecycle behavior changes; no automatic PR merge |
| 2 | Complete candidate chosen | Proactive scheduling policy + bounded OMP opportunity reminders + conditional multi-instance orchestration; the two OMP parts are owned by the sibling instances plan |
| 3 | Re-evaluate independent plans and independent tasks while existing children run in the background | A numbered per-plan lifecycle is not a serialization requirement for unrelated work |
| 4 | Native background tasks remain the default task-level parallelism | Extra primary sessions are optional plan-level tools, never a replacement for leaf-task background concurrency |

## Product rules (derived; no user re-ask)

- **Rescheduling checkpoints.** PM runs the decision procedure (a) immediately before entering any wait, (b) after results settle (child completion or review return), and (c) when dependency, ownership or capacity facts change.
- **Checkpoint checklist.** Consider: unconsumed returned results that can release dependencies or reviews; already-ready independent tasks in the current plan; prepared independent plans that can acquire distinct leases/worktrees; non-mutating preparation of an undispatched future task whose contract is already locked.
- **Waiting is valid.** With no useful authorized action, wait for the native notification and state one concrete dependency/capacity/ownership reason. Do not re-prove an unchanged empty ready set and do not create work merely to stay busy.
- **Re-split only undispatched work.** Changed dependencies/interfaces are written back before dispatch; active task scope and BASE_SHA stay fixed; integration merges stay serial under the existing integration lease.
- **No fabricated engine semantics.** `execution_policy` values (for example a template's `serial`) are accepted-but-opaque; never describe them as an engine-enforced linear scheduler. Derive actual policy from the current user/plan and preserve explicit serial constraints.
- **Standalone `mstar` preserved.** Optional Herdr/tmux skill discovery never becomes a mandatory load-order dependency of the `mstar-*` skill set.
- **Evidence honesty.** Before/after routing scenarios on affected cases are the behavioral proof; static policy-fixture validity alone is not evidence and never proves model compliance.

## Acceptance Criteria (observable)

Plan PA1–PA7 is binding; product phrasing:

| ID | Observable result |
|---|---|
| PA1 | At a Phase-2 rescheduling checkpoint, an independent ready task or plan is dispatched before waiting for an unrelated running child |
| PA2 | Task review and unrelated implementation overlap; ready work does not wait for an entire unrelated lifecycle to finish |
| PA3 | A dependent task stays blocked until its reviewed prerequisite commits exist in its assigned base |
| PA4 | PM never duplicates owned/running/completed work, steals a lease, mutates an active task's base, or treats pane state as ownership |
| PA5 | No useful ready work produces a justified native wait; the same unchanged facts never produce repeated reminder/replanning loops |
| PA6 | Scope-dependent primary sessions prepare only their own tasks; only the coordinator considers sibling plans and controls integration/lifecycle closure |
| PA7 | Before/after evidence covers the above and the directly affected routing cases; unsupported claims are reported, not scored Pass |

## Target State

An explicit, shared Phase-2 rescheduling checkpoint procedure embedded in the existing authoritative skills, with before/after routing evidence — no new scheduler infrastructure, no second ready-state register, no engine schema growth.

## Roadmap / Release Slices

- **Scope:** the shared policy and its affected routing evidence, consumed by the OMP instances contract for its bounded reminder and transport decisions.
- **Next iteration:** none required. Generic DAG scheduling, dependency-graph inference and automatic dispatch remain non-goals unless a new user request demonstrates a concrete missing executable fact.

## Deferred Scope and Tracking

No confirmed product requirement is deferred. Engine-side additions (for example a read-only ready-set projection) are explicitly not proposed; if implementation later demonstrates a concrete missing fact, PM records it as new scope before any engine change.

## Non-Goals

- Generic DAG/ready-set scheduler, dependency-inference engine, second status register, terminal-derived ownership.
- Phase 1 review parallelism; Phase 3–6 lifecycle changes; automatic PR merge.
- OMP runtime behavior, settings or transport (owned by `mstar-host/references/omp-phase2-instances.md`).
- Timer/periodic polling, repeated unchanged-state reminders, duplicate completion notifications.
- Mandatory external skill dependencies for standalone `mstar`.

## Priority

P1 — the policy is the contract the OMP instances plan consumes; all four plans share one iteration.

## Effort (agent-oriented)

Each work item above closes in one focused round. No human calendar estimates are used.

## Prepare Package (Product)

### Specify

- **Problem:** Phase-2 coordinators wait linearly because no contract names when to re-evaluate ready work, so unrelated plans/tasks serialize behind a busy child.
- **User value:** unrelated ready work starts earlier; true dependencies still block; waiting is justified and quiet.
- **Scope:** shared skill policy at existing authoritative topics + affected routing-eval cases and evidence.
- **Non-goals:** listed above.
- **Target state:** listed above.
- **Roadmap if split:** the policy body and the pointer alignment may land separately; both proof obligations stay.
- **Draft DoD:** PA1–PA7 observable in before/after evidence.

### Clarify

- **Open questions:** none requiring the user; the locked decisions above stand.
- **Decisions:** checkpoints and checklist above; waiting-is-valid; re-split limits; no fabricated engine semantics; standalone preservation.
- **Architecture decision:** frozen below; no new engine scheduler, ready-state schema or reminder setting.

## Architecture contract

### Selection and ownership

**Option A (selected):** one prose decision procedure in `skills/mstar-iteration/references/phase-2-worktree-lease.md` §2.4, with short pointers from `mstar-sdd` Ready-task scheduling and the PM role. This preserves existing task/lease mechanisms and exposes the missing decision point. **Option B (rejected):** code deriving a DAG/ready set, dispatching automatically or storing another scheduling status.

`Rescheduling checkpoint` is the stable name. Its reason vocabulary is `before-wait`, `result-settled`, `dependency-changed`, `ownership-changed`, `capacity-changed`. `result-settled` is a **PM observation**, not a new host event. Native result delivery, a settled `hub jobs`/`hub wait` response or a real review return may supply it; the result is consumed once. OMP reminder text points to this procedure, never copies its decision matrix.

### Decision procedure

1. Respect user steering and report real blockers before any scheduling continuation. Consume returned results once; classify their acceptance rather than interpreting job completion as accepted work.
2. Consider the current scope: an iteration coordinator considers **both** its prepared independent plans and task-local work; a scoped plan primary considers only its own tasks. Neither promotes itself into the other's authority.
3. Exclude already dispatched, owned, terminal, unprepared, contract-drifting and genuinely dependent work. A prerequisite is satisfied only when accepted/reviewed commits are in the dependent task's assigned base. Active Assignment scope and `BASE_SHA` are immutable; re-split/resequence only undispatched work and write its interfaces/dependencies before dispatch.
4. For remaining useful work, apply current user/plan serial policy, task capacity, plan-primary capacity where applicable, engine scope/revision/lease checks, same-host lock and L1/L2 isolation. A shared file/session/ledger or missing integrated API is a specific serialization edge; task number and unrelated QC/QA are not.
5. Start the complete authorized ready batch through native background tasks. Prepared independent plans may use the conditional primary transport, but disabling/unavailable transport does not disable task concurrency. Only coordinator-owned integration merges serialize.
6. If no useful authorized action remains, enter the native wait once and state its actual reason (`dependency`, `ownership`, `capacity`, `user-blocked`, or `no-ready-work`). Do not poll, manufacture work or re-run the same reasoning because a turn ended. An explicit user message, new accepted result or changed dependency/ownership/capacity observation reopens the checkpoint.

The decision is not a persisted ready set. A compact result in the normal PM transcript/ledger is enough: reason, considered scope, dispatched IDs or a concrete wait/block reason. Do not add redundant completion messages, tick counters or “still waiting” reports. `ctx.isIdle()` means not streaming; it says nothing about outstanding task/bash/eval jobs or plan primaries. Native adaptive waits and completion delivery remain in control.

### OMP consuming boundary

The instances spec defines `mstar_phase2` and a bounded native snapshot reminder. The tool's explicit checkpoint receipt records only that PM evaluated this procedure against sampled facts, with a decision and reason. Runtime may remind once if the current owner/Phase-2 observation has not been acknowledged, but cannot infer that a dependency is ready or choose a dispatch. `phase2PlanInstances` gates **additional primary starts only**, never this policy or its bounded reminder. Model policy is independent.

### Concrete future evidence (not executed during Prepare)

Use the existing `.cursor/skills/mstar-routing-eval/` case format and evaluation method on six new scheduling cases plus the directly affected `plan-scope-duplicate`, `plan-scope-last-plan` and `plan-scope-leaf` cases only. Do not introduce a permanent evaluator framework. For each before/after arm, load identical scenario facts and frozen policy text into an isolated completion via the host `completion` facility; retain exact prompt, policy revision/hash, model identifier when available, raw output and scored action sequence in the plan SDD report. No live processes or business artifacts are mutated. If the host cannot run the completion, report missing behavioral evidence rather than passing from JSON/text validation.

| Case ID | Supplied facts | Required observed decision |
|---|---|---|
| `phase2-ready-before-wait` | Task A is running; B independent with isolated worktree and capacity; prepared plan C also independent | Consider B and C, start all authorized ready work before waiting for A; optional transport limits apply only to C |
| `phase2-review-overlap` | A implementation accepted for task review; unrelated B implementation ready | Dispatch fresh L2 reviewer and B without waiting for A's entire plan lifecycle |
| `phase2-base-dependency` | B depends on A; A reviewed but commit not yet in B's pinned base | Do not release B; arrange prerequisite integration before a new B assignment, never alter active B |
| `phase2-owned-and-capacity` | B already owned; a pending launch fills the last primary slot; native task slot is free | No duplicate B/primary; consider independent native task work |
| `phase2-quiet-wait` | No ready work, A running, unchanged facts repeated after wait | One reasoned wait, no new task/continuation loop or redundant completion notice |
| `phase2-scoped-primary` | Scoped primary on B sees C ready elsewhere | Drive only B; no sibling claim, coordinator merge or Phase 3–6 |

Score actual decision ordering, unauthorized side effects proposed and evidence limits, not exact prose. Baseline may already pass some cases; report that truthfully, no fabricated improvement or speedup. Candidate must preserve safety and satisfy PA1–PA7. Policy/source pointer checks complement but cannot replace these traces. Exact future targeted static command: `bun -e 'const x=await Bun.file(".cursor/skills/mstar-routing-eval/assets/routing-evals.json").json(); const ids=["phase2-ready-before-wait","phase2-review-overlap","phase2-base-dependency","phase2-owned-and-capacity","phase2-quiet-wait","phase2-scoped-primary"]; for(const id of ids) if(x.cases.filter(c=>c.id===id).length!==1) throw new Error(id); console.log(ids.join("\\n"));'` — case presence only, explicitly not compliance proof.

### Delivery boundary

This contract owns no OMP manifest, README or host-reference edits. Rollback is the scoped policy/case change, not a lease/workflow reset.
