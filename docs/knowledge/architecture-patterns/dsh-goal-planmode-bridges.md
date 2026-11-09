---
module: packages/dsh
date: 2026-08-16
last_updated: 2026-11-09
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
tags:
  - dsh-goals
  - plan-mode
  - goal-lifecycle
  - advisory-only
  - root-agent
  - steering-helpers
related_components:
  - packages/dsh/src/gates/goal-bridge.ts
  - packages/dsh/src/gates/plan-mode-bridge.ts
  - packages/dsh/src/gates/steering.ts
  - deepseek-harness packages/core/goal
  - deepseek-harness packages/core/plan-mode
applies_when:
  - registering a ctx.goals or ctx.planMode consumer in a dsh plugin
  - deciding whether a plugin may write host goal state
  - walking agent lineage to find root-like agents
plan_id: "20260816-dsh-nb2-goal-bridge, 20260911-dsh-goal-discipline"
---

# dsh planMode mirror + advisory-only goal bridge: host goal semantics, root-agent walks, and the Prepare-window flag

## Context

Two dsh integrations live side by side in `packages/dsh`, and their postures differ:

- **planMode bridge** (`gates/plan-mode-bridge.ts`) — a live ONE-WAY mirror of the harness Prepare window into the host session state `ctx.get('planMode')` (structural view, no peer dependency): read `{HARNESS_DIR}` → write the `plan/mode` session event. Unchanged by the goal-discipline cutover.
- **goal bridge** (`gates/goal-bridge.ts`) — **advisory-only**: it registers one `session/event` listener that warns when a goal is blocked. It never reads or writes goal state.

The design is driven by upstream goal semantics (still true of the `@deepseek-ai/dsh-goal` service):

1. **`create` and `resume` ARM a goal** (both commit `activation: 'armed'`); **`edit` preserves the current activation**; **`pause` / `complete` / `block` disarm**. The model-facing tools cannot resume a paused goal (`GOAL_TOOL_RESUME_PAUSED`), so a plugin-side write is the only *automatic* path from a human `pause` back to `active` + `armed`.
2. **`goals.edit` preserves `roundsStarted` and `phase`** (edit merges objective/cap only; `clear` is the sole round reset). CAS-editing a drifted objective therefore (a) revives a `complete`-phase goal with the new objective while the phase stays `complete` — a false done-state in the goal UI; and (b) carries the previous iteration's round budget into the new one, so a multi-iteration session can exhaust its round cap on inherited debt.
3. **`create` replaces a completed goal** and starts the fresh goal at `roundsStarted = 0` (it throws `GOAL_ALREADY_EXISTS` only for a live non-complete goal).
4. **`goal-round-driver` opens a round whenever the goal is `active` + `armed` and the agent is `idle`** — it has no knowledge of a dispatched subagent owning the critical path. A goal loop is therefore a SECOND scheduler over work the harness state machine already schedules (snapshot phases, plan rows, leases, dispatch gates, settle notifications), and it pads rounds while a child is mid-flight.

Those facts are why the earlier mirror-shaped design (write the iteration objective into `ctx.goals` at each decision point, rebuilding on drift) cannot be made safe on mstar's side, and why mstar writes no goal state at all.

## Guidance

- **mstar NEVER writes dsh goal state.** `registerGoalBridge(ctx: Context, resolver: HarnessResolver): void` registers exactly ONE `session/event` listener. No `create` / `edit` / `complete` / `pause` / `resume`, no goals-service lookup, no round cap, no config gate, no compatibility export and no switch that re-enables the removed behavior. Consequences to rely on: a goal a human paused is never re-armed *by mstar*, and a `complete`-phase goal is never revived *by mstar*. The guarantee is scoped to this plugin — it says nothing about a manual `/goal` or a third-party writer.
- **The advisory contract.** Filter the durable `goal/change` envelopes: `data.version === 1` (unknown wire version → silent skip, never a half-read), `operation === 'block'` OR `goal.phase === 'blocked'`, and non-empty `blockedReason.code` / `message` / `objective`. Then log ONE `mstar/goal-bridge` warn per QUALIFYING ENVELOPE — a later mutation while the goal is still blocked (e.g. an `edit`) warns again, so it is one warn per qualifying envelope, not one per goal lifetime. The warn carries the code, the sanitized (`normalizeWorkflowName` — control chars stripped) and capped (`truncateLedgerField`; 512 / 512 / 128 for message / objective / code) values, and the project-register pointer (`projects/<id>/residuals.json`, first register present else `_default`) so the operator can act without reverse-engineering the host. An unresolvable workspace (no `header.cwd`, resolver returns `null`) → silent skip; every listener body is try/catch-contained, so a throwing seam degrades to one log line and never breaks a session.
- **No configuration surface.** The old `Config.maxGoalRounds` (interface member + Schemastery field) is removed with its only production reader. A retired raw key may survive as an inert unknown key — the installed Schemastery object resolver validates declared keys and merges unknown keys in non-strict mode — but that is a validation artifact, NOT a compatibility path: do not add a parser, a reject-all-unknown policy, or a default-off gate that would preserve the removed behavior.
- **planMode is a pure predicate over harness state**: ON iff a steering compass is `active|locked` AND the SELECTED workflow snapshot (`workflows/<id>/snapshot.json`) has ≥1 plan row in `Todo` (the Prepare window). `planMode.set(agent, target)` is idempotent (`'committed' | 'queued' | 'cancelled' | 'noop'`), so re-evaluating at every decision point does not churn session events — rely on `'noop'`. A manual `/plan` toggle by the user is simply overridden at the next evaluation point; document that instead of special-casing it. The planMode service absent → boot unaffected + ONE debug log, never a crash.
- **Both surfaces are agent-scoped, and evaluate only ROOT-like agents.** `session.header.parentSession === undefined` ⇒ root-like for the session-start payload; the `subagent/start` payload walks `parentSession` to the delegating root (in-process children stamp it at creation). Conversation forks also carry `parentSession` (seed lineage) and are conservatively excluded — an accepted boundary. Decision points: the `agent/session-start` listener plus the existing `subagent/start` walk, so a mid-session Prepare flip re-evaluates the root's flag without extra seams.
- **Bound every lineage walk with a seen-set.** A 1-cycle-only guard (`parent === current`) hangs the synchronous decision-point listener on any 2+ hop cycle (A→B→A); the walk must abandon on ANY revisited session id (and on a non-string `parentSession`, a missing header, or a registry gap). Lock it with a 2-cycle fixture.
- **The shared helpers live in `gates/steering.ts`**: `isRootLikeAgent(agent)` and `rootAgentOf(agent, agents)` — the lineage classifiers the planMode bridge and the dispatch caller derivation both use. `steeringCompass(harnessDir)` (the first `active|locked` compass scan) survives as a helper with NO production consumer: the planMode bridge now reads the SELECTED snapshot's own `compass_ref` and requires that compass's frontmatter `iteration_id` to equal the snapshot id, so the first-active-compass scan — and a session borrowing another lifecycle's gate — is gone. The module keeps its helper-private `AgentView` / `AgentsView`, and consumers import by explicit relative path — no barrel and no re-export shim. The goal advisory imports nothing from `steering.ts`, which is what lets the goal-write removal leave planMode's behavior — and its spec assertions — untouched.
- **Never drive an iteration with a goal round loop on dsh.** Progress = workflow snapshot phases + dispatch gates + subagent settle notifications. Phase 2 continuous execution is a PM-local loop (dispatch → wait for the settle notification → next dispatch), and a dispatched child owning the critical path means WAIT, not a duplicate work unit against the same worktree. The four upstream-only semantics that would make goal rounds safe (critical-path-aware readiness, durable human pause, per-round cost/work-unit accounting, no-new-information skip) are deferred rows with owner + trigger + completion definition in `{PROJECT_DIR}/dsh-integration/roadmap.md` — no upstream issue is open.

## Why This Matters

These bridges are the first mstar surfaces where host session state outlives a single mstar decision, so their write posture is a correctness property, not a style choice: an automatic goal writer can silently defeat an explicit human `pause` and re-run work the harness is already scheduling. The advisory-only posture keeps the observation surface (blocked goals are visible, with a residual pointer) while removing mstar from the goal lifecycle entirely. In the other direction, the planMode mirror is safe precisely because its target is a pure predicate over harness state and its set operation is idempotent — the same discipline does not transfer to goals, whose state is not a function of harness state.

## When to Apply

- Any future `ctx.goals` / `ctx.planMode` consumer in `packages/dsh` — check the write posture first.
- Reviewing a proposal to "mirror", "sync", or "arm" a goal from a plugin: the upstream semantics above are why the answer is no.
- Registering decision-point listeners that walk agent lineage (root classification, cycle bounds).
- Reviewing the Prepare-window flag behavior (Todo registration, `noop` churn-freedom, manual `/plan` overrides).

## Examples

- Source of record: `packages/dsh/src/gates/goal-bridge.ts` (advisory), `packages/dsh/src/gates/plan-mode-bridge.ts` (mirror), `packages/dsh/src/gates/steering.ts` (shared helpers); entry wiring in `packages/dsh/src/index.ts`.
- Iteration contracts: `.mstar/plans/20260911-dsh-goal-discipline.md` (zero-write removal inventory, helper relocation, three reading sites, four deferred upstream rows) and `.mstar/iterations/iter-20260911-dsh-ledger-goal-discipline/specs/dsh-progress-driver.md` (the driving discipline); the earlier mirror design and its QC findings: `.mstar/sdd/20260816-dsh-nb2-goal-bridge/review/qc2.md` (W-1/W-2), `qc3.md` (F-001/F-003).
- Upstream semantics: `deepseek-harness` `goal/src/index.ts` (`create` / `resume` arm, `edit` preserves activation and `roundsStarted`, `pause`/`complete`/`block` disarm), `goal-round-driver/src/index.ts` (active + armed + idle readiness).
