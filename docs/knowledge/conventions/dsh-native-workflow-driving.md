---
module: packages/dsh
date: 2026-09-11
last_updated: 2026-11-09
problem_type: convention
category: conventions
severity: medium
tags:
  - dsh
  - driving-discipline
  - native-workflow
  - goal-loop
  - critical-path
  - settle-notification
applies_when:
  - driving a Morning Star iteration or session on the dsh host
  - evaluating a proposal to use /goal or a goal round loop for progress on dsh
  - writing PM dispatch text, host references, or role notes for dsh
---

# Driving a dsh iteration: native workflow, never a goal round loop

## Context

Morning Star already owns a scheduler for its work: the workflow snapshot phases, plan rows and leases, the dispatch gates, the agent-flow ledger, and **subagent settle notifications**. On the dsh host there is also a host-level goal mechanism (`/goal` plus the upstream `goal-round-driver`), and a loop that drives progress is the natural-looking shortcut for "keep going until done".

It is the wrong driver here, for mechanical reasons rather than taste:

1. **Two schedulers over one body of work.** A goal round loop is a second scheduler over work the harness state machine is already scheduling. Round admission cannot see harness state, so it can re-open work that is already dispatched.
2. **Round admission is blind to the critical path.** `goal-round-driver` opens a round whenever the goal is `active` + `armed` and the agent is `idle`; it has no notion of a dispatched subagent owning the critical path. The agent is legitimately idle while a child works, so rounds fire during the wait — and the only honest output of a waiting round is "still waiting", which pushes the loop toward re-running verification and bookkeeping that already exists.
3. **A plugin-side goal writer can defeat an explicit human `pause`.** Upstream `create` and `resume` arm a goal; `edit` preserves activation; the model-facing tools refuse to resume a paused goal (`GOAL_TOOL_RESUME_PAUSED`). So any plugin that writes a goal objective automatically becomes an armer, and no amount of "only on drift" branching makes that a safe edge — it only makes it rarer.
4. **A wait is a legitimate state, not a gap to fill.** When a dispatched subagent owns the critical path, the truthful action is to wait for its settle notification.

## Guidance

- **Drive dsh progress with the native workflow.** Progression signals are the workflow snapshot phases, the dispatch gates, and subagent settle notifications. mstar arms no goal on dsh: the surviving goal integration is advisory-only (a blocked-goal warn with a residual pointer; zero goal reads, zero goal writes).
- **Never use `/goal`, a goal objective, or a goal round loop as the progression driver on dsh.** Do not instruct an operator or a future agent to "set a goal and let it run" here. The rule is about the driver, not about the goal feature in general: a human may still create a goal for their own purposes, but mstar work must not depend on its rounds.
- **Phase 2 continuous execution is a PM-local loop**: dispatch → **wait for the child's settle notification** → next dispatch. It is not a host round loop, and it does not re-enter the same work unit between dispatches.
- **A dispatched child owns the critical path until it settles.** The correct action is to **wait** — not to open another unit of work against the same worktree, and not to start work that assumes the child's result.
- **A wait with no new information produces nothing.** Do not re-run existing verification or re-account for work already evidenced just to make the wait look productive. (This is the PM-local loop's discipline; the upstream driver's behavior is outside this repo's control.)
- **Do not claim more than the mechanism delivers.** Stopping mstar's own arming does not make a manually armed `/goal` spin-free, and it does not constrain third-party plugins that write goal state. The four upstream-only semantics that would make goal rounds safe — critical-path-aware readiness (or a wait/on-settle mode), durable human pause against any automatic re-arm, per-round cost visible and counted by work unit, and a skip that does not increment the round count — are deferred rows with owner + trigger + completion definition on the store-authoritative `dsh-integration` roadmap (project roadmap lives in `{HARNESS_DIR}/store.db`: `mstar roadmap export --project dsh-integration`). They are coordination targets, not implemented upstream behavior.
- **Keep one home per statement.** The operational wording lives in the tracked reading sites: `skills/mstar-host/references/dsh.md` § Progress discipline (the host rule), `skills/mstar-host/SKILL.md` (the `/goal` applicability rule carries an explicit dsh exception), and `skills/mstar-roles/references/project-manager.md` (the PM note). This doc holds the rationale and the boundary; do not restate the rule in a fourth place.

## Why This Matters

The failure mode is silent and expensive: rounds fire while a dispatched child owns the critical path, each round emits the cheapest plausible output instead of nothing, and the loop keeps a session busy without advancing the iteration — observed as round padding on a long autonomous session, well past the point where the work had already been scheduled. The native-workflow rule removes the second scheduler and makes waiting an explicit, honest state instead of a gap the loop tries to fill.

The safety half matters just as much: as long as mstar writes no goal state, a human `pause` cannot be undone by an mstar decision edge, and a `complete`-phase goal cannot be revived by a mirrored objective. That property disappears the moment a bridge writes goal state "just to keep the objective in sync".

## When to Apply

- Driving any Morning Star iteration, workflow, or plan cycle on the dsh host.
- Evaluating a feature or fix that proposes goal writes, objective mirroring, or round-driven progress on dsh.
- Writing or reviewing dispatch text, host references, or role notes that mention `/goal` on dsh.
- Diagnosing a dsh session that stays busy while a dispatched child is still running.

## Examples

- Contracts and evidence: `.mstar/iterations/iter-20260911-dsh-ledger-goal-discipline/specs/dsh-progress-driver.md` (the locked driving contract, C1–C4) and `.mstar/plans/20260911-dsh-goal-discipline.md` (the zero-write removal inventory, the red-first paused + drifted pin, and the four deferred upstream rows).
- Host semantics relied on: `deepseek-harness` `goal/src/index.ts` (`create` / `resume` arm; `edit` preserves activation; `pause` / `complete` / `block` disarm), `goal-round-driver/src/index.ts` (active + armed + idle readiness with no subagent awareness).
- Deferred upstream work: the `dsh-integration` project roadmap in `{HARNESS_DIR}/store.db` (owner `project-manager`; read with `mstar roadmap export --project dsh-integration`).
