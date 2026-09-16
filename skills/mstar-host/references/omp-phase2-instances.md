# OMP Phase 2 opportunity reminders and conditional plan instances

**Product-locked.** The OMP host's Phase-2 orchestration contract: a bounded opportunity reminder, native opt-in settings including a user-configurable plan-instance capacity, and conditional launch of extra plan-primary sessions over the available terminal transport. `phase2PlanInstances` gates extra primary launches only — shared scheduling and bounded reminders require no launch opt-in and no new reminder setting.

The shared scheduling policy this consumes is `mstar-iteration/references/phase-2-proactive-scheduling.md`; the iteration-side Phase 2 checklist stays in `mstar-iteration/references/phase-2-worktree-lease.md`.

## Background

The shared Phase-2 scheduling policy makes the coordinator reconsider independent work, but on the OMP host an overlooked opportunity can stay invisible until the next explicit user message, and plan-level parallelism beyond background tasks requires additional primary sessions. This plan adds: (1) a bounded, Phase-2-only OMP opportunity reminder; (2) native opt-in settings including a user-configurable plan-instance capacity; (3) conditional launch of extra plan-primary sessions through available Herdr/tmux transport. Native background tasks remain the default task transport in every mode.

## Target Users

OMP operators who run Morning Star iterations in a coordinator session inside a managed terminal environment (Herdr or tmux) and want plan-level parallelism without giving up central integration ownership.

## User Stories

1. As a coordinator, when a background result settles or capacity frees up during Phase 2, I get at most one bounded nudge to re-run the scheduling check — never a timer loop, never a duplicate of the native completion notice.
2. As an operator, I enable `phase2PlanInstances` once in native settings and set `maxPlanInstances` to what my environment tolerates; no extra primary starts until I opt in. Ordinary task concurrency and bounded scheduling reminders are independent of that setting.
3. As an operator, lowering `maxPlanInstances` stops new launches but never kills my running sessions.
4. As a coordinator, an authorized launch starts a separate scoped-plan PM session on its own prepared plan and worktree, without stealing my focus or leaking my credentials; it returns a durable handoff and I alone integrate and close the iteration.
5. As an operator without the needed skill, executable or managed environment, I get an explicit unavailable-transport result, no process start and no fake success; native scheduling and scoped reminders keep working.

## Locked user decisions

Do not re-ask:

| # | Decision | Product reading |
|---|---|---|
| 1 | Multi-instance enable is an explicit opt-in in native Morning Star plugin settings, disabled by default | Installing/updating does not start extra primary processes; model changes have their independent `modelHandoff` opt-in |
| 2 | `maxPlanInstances` is configurable in the same native settings surface; default 2 | Counts concurrently active plan-scoped primary sessions, excluding the iteration coordinator; a task subagent is not a plan primary |
| 3 | Configurability, not a fixed ceiling | The schema accepts supported positive integers and reports invalid values; never silently turn 2 into a hard maximum |
| 4 | Use extra primary instances only when the corresponding Herdr/tmux skill, CLI and current managed environment are available | All three prerequisites plus the opt-in are required for any launch |
| 5 | Native background tasks remain the default for task-level parallelism | Multi-instance off or transport missing never disables native task concurrency |
| 6 | Count owned pending launches as well as active plan sessions when enforcing capacity | Two asynchronous starts cannot both consume the same last slot; a failed/uncertain submission is never blindly retried |
| 7 | Extra instances run plan-scoped PM flows and return durable handoff; only the original coordinator integrates and closes | Never `task(agent=project-manager)`; never sibling/lifecycle scope for the child |

## Settings surface

### Navigation and identity

- Path: native OMP `/settings` → Plugins tab → npm plugin **`@mstar-harness/omp`** — the same surface as `modelHandoff` / `handoffTarget`.
- The host plugin-level **Enabled** toggle stays host-owned. **Opt-in for extra primary launches is `phase2PlanInstances`**, not plugin installation. It does not disable the shared rescheduling policy or bounded reminder.

### Native controls (keys are the labels)

The host renders each schema key as the row label. Product accepts that host constraint; a custom settings screen would be a forbidden second UI.

| Key / label | Type | Default | Values | Description (schema `description`) |
|---|---|---|---|---|
| `phase2PlanInstances` | boolean | `false` | `true`, `false` | Allow Phase-2 coordinators to launch additional plan-scoped primary sessions up to maxPlanInstances. Off by default; native background tasks and bounded scheduling reminders are independent. |
| `maxPlanInstances` | number | `2` | positive integers, minimum 1 | Maximum concurrently active plan-scoped primary sessions (owned pending launches included; iteration coordinator and task subagents excluded). Lowering it stops new launches without killing active work. |

Persistence:

- Preferences are stored through the host plugin-settings path and **survive sessions**. No second config file, no competing settings UI, no activation command.
- Present-but-invalid values (non-integer, below 1, unparsable) **fail visibly** and authorize no launch; missing keys use schema defaults. Invalid values are never silently coerced to the default or to an unbounded mode.
- `maxPlanInstances` has effect only while `phase2PlanInstances` is enabled.

### Persisted preference vs runtime decision state

These are different stores; mixing them is a product defect.

| Store | What it holds | Lifetime |
|---|---|---|
| **Native saved preference** | `phase2PlanInstances`, `maxPlanInstances` | Host plugin settings; survives new sessions |
| **Runtime decision state** | Per-changed-state reminder latch; owned pending launch intents; active owned plan primaries; submission/ready/uncertain/refused observations | Current coordinator workflow only; never a second lifecycle/status register |

Re-read settings before launch admission and immediately before process/prompt submission. Reminder eligibility is independent of `phase2PlanInstances`; when launches are enabled, its observation may include real capacity changes without making opt-in a reminder gate. No reminder preference is added.

## Bounded opportunity reminder

- **Scope:** Phase 2 only; only the coordinator session bound to the active iteration; never cross-workflow, never leaf sessions.
- **Trigger:** supported lifecycle boundaries where opportunity state may have changed (for example a background job settling or a turn ending with unconsumed results). The public extension event list exposes no dedicated job-settled callback; consume snapshots at supported lifecycle boundaries — never pretend to subscribe to an unavailable event, never poll on a timer.
- **Bound:** at most one reminder per **changed** opportunity state (once-per-state latch, following the existing once-per-run pending-notice precedent). The host's session-stop continuation cap is not sufficient deduplication for a plugin; the plugin's own latch is the dedup policy. Identical unchanged readiness never re-fires. Explicit user messages and real blockers take priority.
- **Content:** points the coordinator at the shared rescheduling checkpoint (`mstar-iteration/references/phase-2-proactive-scheduling.md`). It never auto-dispatches, never duplicates the native completion delivery (which already resumes or informs the owning session), and never infers dependency graphs.
- **Launch opt-in off:** reminders remain available only within their bound owner/Phase-2 scope; no extra primary may start.

## Capacity and launch authorization

- Capacity is the union by plan ID of owned pending intents and active plan primaries, capped by latest `maxPlanInstances`; never double-count an intent that has bound. Coordinator/task leaves are excluded.
- Each launch requires: the opt-in enabled, Phase-2 coordinator scope, a prepared independent plan with its own PM-approved distinct worktree, capacity available, and transport prerequisites present.
- An authorized launch starts a separate **scoped-plan PM session** (the existing plan-scoped route) bound to its own prepared plan: never `task(agent=project-manager)`; no coordinator credentials (session JSON, `--expect` revisions) passed to the child; no sibling/lifecycle scope granted.
- Launches preserve focus and clean up only panes they created or own.
- **Uncertain launches are terminal observations:** an uncertain or failed submission is reported, never blindly retried; opaque IDs are never fabricated; duplicate requests cannot duplicate a plan owner.
- Lowering `maxPlanInstances` blocks new launches only; active user work is never killed.

## Transport prerequisites

All required, checked per launch: the corresponding optional skill present in the catalog (the Herdr skill today; a tmux skill only if one actually exists — binary existence is not skill availability), the CLI executable available, and the session actually inside the matching managed environment (for example `HERDR_ENV=1`; `TMUX` set for tmux).

- Optional skill discovery must never become a mandatory load-order dependency of the standalone `mstar-*` skill set.
- Missing prerequisites cause a visible no-op with native background scheduling intact — never a fake successful launch, never silently substituting a different prepared plan.
- Multiplexer state is transport capability only: pane idle/done, age, PID or terminal labels never grant ownership, release leases, infer completion or recover an abandoned owner. Engine scope/lease/revision/worktree/merge verbs and the scoped durable handoff are the only ownership and completion evidence.

## Completion and closure ownership

A child primary completes by returning its scoped durable handoff (existing plan verbs). Only the original coordinator performs integration merges (serial, under the integration lease) and Phase 3–6 iteration closure. No child ever integrates, closes, or mutates another workflow.

## Acceptance Criteria (observable)

Plan OA1–OA8 is binding; product phrasing:

| ID | Observable result |
|---|---|
| OA1 | Native settings persist `phase2PlanInstances` (default false) and user-configurable `maxPlanInstances` (positive integer, default 2, minimum 1); malformed values fail visibly and cannot authorize any launch |
| OA2 | A bounded Phase-2-only advisory prompts an overlooked scheduling check at most once per changed opportunity state; identical state never re-fires; native completion delivery stays authoritative and is never duplicated |
| OA3 | Disabled mode, absent skill/binary, wrong environment, wrong session/workflow, absent prepared plan or failed safety gates cause no process-start side effect |
| OA4 | An authorized launch starts a separate primary at prepared cwd/scope without focus or credential leakage |
| OA5 | Pending + active plan-primary capacity respects the latest configured maximum including owned pending launches; duplicate/uncertain submissions never duplicate a plan owner |
| OA6 | Completion is the scoped durable handoff, not pane terminal state; the coordinator retains serial integration and Phase 3–6 closure ownership |
| OA7 | Native background task operation stays usable without Herdr/tmux; missing transport never silently replaces a prepared plan with a different one |
| OA8 | Package discovery, native settings, host guidance and scoped checks describe only supported behavior, with one bilingual logical-change fragment |

## Target State

Bounded owner/Phase-2-scoped reminders plus independently opt-in primary starts: honest about unavailable transport, capacity-safe, ownership-safe, and subordinate to shared scheduling and engine coordination.

## Roadmap / Release Slices

- **Scope:** one complete slice — native settings and the bounded reminder, the transport-intent journal and capacity admission, the native tool/events/package surface, and the optional skill-driven launch guidance with bounded action traces. Not settings-only, and not a pretend compiled multiplexer bridge.
- **Next iteration:** none required. Conditional tmux support uses an actually available matching skill; creating a tmux skill or adding further transports is outside this slice.

## Deferred Scope and Tracking

No confirmed product requirement is deferred. If no available backend can meet skill/environment gating or reliable scoped submission with public APIs, the STOP condition reports the exact unsupported seam instead of faking success.

## Non-Goals

- Generic scheduler/DAG inference, second status register, timers/periodic polling, hidden auto-dispatch, cross-workflow reminders.
- Phase 1 or Phase 3–6 activation; automatic PR merge; killing active work on cap reduction.
- PM-task recursion; coordinator-credential distribution; terminal-derived ownership or completion.
- OMP core edits, user credential/config mutation, a general multiplexer framework, mandatory external skill dependencies.
- Development-time probes: no current-session settings edits, no automatic terminal creation as verification (real-environment E2E only via a separately requested `mstar-e2e` workflow, never a development-plan task).

## Priority

P1 within the expanded iteration; consumes the scheduling contract and shares the `packages/omp` integration boundary with the model-handoff plan under PM-serialized ownership.

## Effort (agent-oriented)

Each work item above closes in one focused round. No human calendar estimates are used.

## Prepare Package (Product)

### Specify

- **Problem:** Phase-2 opportunities stay invisible between explicit user messages on OMP, and plan-level parallelism needs extra primary sessions that nothing orchestrates safely today.
- **User value:** one bounded nudge per real opportunity; opt-in plan-level parallelism with an explicit, safe capacity; central integration preserved.
- **Scope:** `packages/omp/` settings + reminder/capacity/transport runtime + packaging/OMP guidance + bilingual fragment.
- **Non-goals:** listed above.
- **Target state:** listed above.
- **Roadmap if split:** settings/reminder work and the transport work may land separately; no partial product release.
- **Draft DoD:** OA1–OA8 observable with scoped runtime/package evidence.

### Clarify

- **Open questions:** none requiring the user; the locked decisions above stand.
- **Decisions:** setting names/defaults/capacity semantics, reminder bounds, ownership and transport rules above.
- **Architecture decision:** frozen below, including native observation, launch reservations and the optional skill-driven transport boundary.

## Architecture contract

### A. Native observation, not a scheduler

Source/publication baseline and loading requirements: published OMP **18.2.1**, Bun **>=1.3.14**, canonical external host imports and inline engine. `ExtensionContext.getAsyncJobSnapshot()` returns `{ running, recent, delivery } | null`; rows expose only `id/type/status/label/startTime/agentId`, and delivery exposes `queued/delivering/nextRetryAt`. Upstream `agent-session.ts:2251-2272` filters to the session owner; recent defaults to five rows and is not a complete durable history. There is no public job-settled event or review-result API. Null means unavailable, never “no jobs.” A disappeared recent job is not a new opportunity.

New local tool **`mstar_phase2`** is registered by `src/extensions/phase2-orchestration.ts`; it never spawns, merges, rewrites workflow state or releases leases. Its strict discriminated operations are:

```ts
export type CheckpointReason =
  | "before-wait" | "result-settled" | "dependency-changed"
  | "ownership-changed" | "capacity-changed";
export type Phase2Request =
  | { operation: "bind"; workflowId: string; coordinatorSessionPath: string }
  | { operation: "checkpoint"; reason: CheckpointReason;
      decision: "dispatched" | "wait" | "blocked"; note: string }
  | { operation: "reserve-launch"; planId: string; transport: "herdr" | "tmux";
      skill: { name: string; source: string };
      capability: { executable: string; version: string; target: string } }
  | { operation: "record-launch"; intentId: string;
      observation: "starting" | "created" | "submitting" | "submitted" | "refused" | "uncertain";
      target?: string; evidencePath: string };
```

`bind` is the coordinator's first Phase-2 host action, independently of model handoff/settings and on no-argument `/iteration-drive` resumes. It validates the explicit workflow, main/control root and real coordinator envelope against the named snapshot; obtains host session ID itself; rejects `session_init` task sessions and scoped plan PMs. Bind is **plugin observation binding**, not engine `plan bind` and never writes an engine credential. Persist only its identity pointer in `pi.appendEntry("mstar:phase2", ...)`, exact-session filtered on replay. Engine remains authoritative; every tool/event rereads named snapshot ownership and phase, and disables itself on drift/terminal state. Exact accepted phase string is `phase-2-execute`; unknown/missing phases are inert with a one-time diagnostic. Phase-2 entry guidance must write the existing phase projection through its lawful engine writer, not add a phase heuristic.

`checkpoint` acknowledges PM's execution of the scheduling spec against the **currently sampled** observation; it carries a decision/note, not a ready list. Runtime attaches the sampled key; caller cannot choose/reset it. `blocked` suppresses advisory continuation until a new explicit user turn or a subsequent PM checkpoint clears the block; a timer or incidental snapshot churn cannot override a known blocker.

### B. Reminder event and latch contract

Export from `packages/omp/src/phase2-orchestration.ts`:

```ts
export type Phase2Observation = Readonly<{
  key: string;             // computed from the facts below
  hasRunningJobs: boolean;
  nativeDeliveryPending: boolean;
  recentTerminalIds: readonly string[];
}>;
export type ReminderState = Readonly<{
  acknowledgedKey: string | null;
  remindedKeys: readonly string[];
  blocked: boolean;
}>;
export function decidePhase2Reminder(
  state: ReminderState, observation: Phase2Observation,
  context: Readonly<{ boundPhase2: boolean; pendingMessages: boolean;
    userTurn: boolean; snapshotAvailable: boolean }>
): "silent" | "remind";
```

The observation key hashes a canonical sorted projection of workflow ID, host session ID, current running job IDs/types/statuses, and relevant engine plan facts (`id/status`, coordination revision/prepared hash/session holder/handoff state, execution holder). Include the transport-journal byte version and latest **valid** capacity preference only when launch mode is enabled. Exclude labels, time, last-read time, `updated_at`, result text and recent-job eviction. The projection is an opportunity **observation**, not proof of a ready task. Job-to-plan inference from labels is forbidden.

Use `before_agent_start` and `tool_result` only to sample/update native-result coverage; `agent_end` is the sole emission point. `input` marks explicit steering; session start/switch/branch/tree reconstruct with exact host session identity; shutdown invalidates the callback generation. No polling/timers, no stop-hook continuation and no fabricated `job_settled`. `session_stop` is not selected: the host already defers it for background completions (`agent-session.ts:2305-2315`), so it cannot be the sole before-wait opportunity mechanism.

At `agent_end`, a valid bound Phase-2 coordinator with an available snapshot may get one `pi.sendMessage` custom advisory using `{ triggerTurn: true, deliverAs: "followUp" }` **only if** its observation is neither acknowledged nor already reminded, there is running work or a changed engine/transport observation, no block/user steering/queued message, and no native delivery queued/in flight. New terminal IDs seen in `recent` are covered by native delivery: suppress the plugin notice for that observation, do not reproduce completion text. `tool_result`/next `before_agent_start` lets PM consume native delivery and run the shared checkpoint instead.

Record the reminder key with `appendEntry` **before** sending; replay full session entries into the seen-key set so A→B→A or reload does not re-nudge A. Only real changed facts create another eligible key. Missing/ambiguous ownership or failed snapshot reads are silent for continuation and produce a bounded diagnostic, never a guessed key. Native persistence has the same non-flush caveat as model handoff; do not promise power-loss exactly-once delivery.

Reminder text says only to run the shared rescheduling checkpoint and honor blockers. It never asserts a particular plan is ready. `isIdle()` alone cannot authorize emission, decide no background work, or free capacity.

### C. Capacity, reservation and recovery

Native schema: `phase2PlanInstances` boolean default false; `maxPlanInstances` number default 2/min 1/step 1/**no max of 2**. Require `Number.isSafeInteger(value) && value >= 1`; absent keys default, malformed present values visibly refuse starts. The settings decoder exports `Phase2Settings = Readonly<{phase2PlanInstances:boolean;maxPlanInstances:number}>`, `Phase2SettingsResult = {ok:true;value:Phase2Settings}|{ok:false;reason:"settings-read-failed"|"invalid-settings";message:string}`, `decodePhase2Settings(raw:Record<string,unknown>):Phase2SettingsResult`, and `readPhase2Settings(cwd:string):Promise<Phase2SettingsResult>`. Use the same public uncached reader, not the model decoder.

Use a small **transport-intent journal**, not a lifecycle register, at `<resolved workflow dir>/omp-launches.json`. It records only `version:1`, workflow/coordinator identity and intent entries:

```ts
export type LaunchIntent = Readonly<{
  id: string; workflowId: string; coordinatorSessionId: string;
  planId: string; preparedHash: string; assignmentPath: string;
  worktreePath: string; transport: "herdr" | "tmux";
  state: "reserved" | "starting" | "created" | "submitting" | "submitted" | "refused" | "uncertain";
  target?: string; evidencePaths: readonly string[];
}>;
export function reservePlanLaunch(
  request: Extract<Phase2Request, {operation:"reserve-launch"}>,
  authority: Readonly<{ coordinatorSessionPath: string; cwd: string }>
): Promise<{ ok:true; intent:LaunchIntent; applied:boolean } | { ok:false; code:string; message:string }>;
export function recordPlanLaunch(
  request: Extract<Phase2Request, {operation:"record-launch"}>,
  authority: Readonly<{ coordinatorSessionPath: string; cwd: string }>
): Promise<{ ok:true; intent:LaunchIntent; applied:boolean } | { ok:false; code:string; message:string }>;
```

Both functions belong to `phase2-launches.ts`; the shared request/settings types live in the settings module. Derive journal path from validated session/root. Lock in order **canonical snapshot → canonical journal** with existing `withStatusWriteLock`; reread snapshot/settings/journal and admit under both, then atomic exported `writeJson` for the plugin-owned journal only. Never enter a private protected-write context or mutate engine rows. Release locks before CLI interaction. Revalidate ownership/prepared hash at every transition; no automatic retry on drift. Parallel calls can serialize their launch reservations, but this does not claim to govern independent operator-started primaries that bypass the plugin.

Occupancy is the union by plan ID of outstanding non-refused intents and active engine plan-primary bindings. Count each once. Active means real `coordination.session` plus execution authority, including returned-for-fix work. A matching durable handoff in `submitted`, `accepted`, `integrating`, `merged` or `completed` proves the child reached its scoped stop and removes that plan from launch occupancy, even with a retained coordinator lease; `returned` reactivates occupancy. Coordinator/task leaves are excluded. Uncertain or pre-bind submitted intents stay occupied until durable handoff or explicit human recovery, never TTL/process/pane exit. Only current matching prepared/session/handoff identity can discharge an intent.

`reserve-launch` requires enabled/valid settings, current coordinator/Phase 2, an existing coordinator-prepared Todo/Blocked row with no plan binding/lease/handoff, identical prepared Assignment hash, existing canonical same-repository distinct feature worktree on its assigned branch, PM's recorded dependency readiness and the skill/executable/environment checks below. Duplicate `(workflow,plan,preparedHash)` returns the existing intent without another authorization; any different live intent/binding for that plan refuses. Under the journal lock the last slot has one winner. Lower caps prohibit further reservations/submissions but do not kill, revoke leases or edit active intents. Re-read preference and capacity immediately before the first process start and before prompt submission; these checks bound authorization at command invocation, not an atomic transaction with later user settings edits.

Transitions are strict: `reserved → starting → created → submitting → submitted`. The starting/created/submitting transitions perform fresh setting/cap/engine checks and persist before their respective pane-create/OMP-start/prompt side effect. Admission counts the current intent once; occupancy must be within latest cap. Every result says `applied`: only a newly persisted transition returns true. Duplicate requests return the recorded intent with false and authorize no side effect. PM acts only on true: starting permits pane creation; created permits OMP start in the returned pane; submitting permits the single scoped prompt. Uncertain is terminal; refused requires proof no process/prompt exists. A lower cap pauses future side effects without deleting existing work; no auto-loop.

Recovery replays journal plus current engine facts. Before any side-effecting CLI call persist its intent/transition; a crash after reservation or submission without known outcome becomes `uncertain` and never auto-retries. `refused` is allowed only for an observed failure known to precede any process/prompt side effect; malformed output, timeout, vanished response or a stalled prompt is uncertainty. The journal records transport observations only; child `plan bind`, `handoff`, coordinator accept/integrate/complete remain the sole ownership/state writers. Lost credentials/ambiguous old coordinator journal require explicit recovery, not a new credential or takeover.

### D. Optional transport selection (skill-driven, no compiled multiplexer bridge)

**Selected:** after `reserve-launch`, PM executes the optional skill under the recorded transition protocol; before creating the pane record `starting`, before submitting scoped input record `submitting`. Compiled code admits/records, never spawns or parses screens. This preserves skill-owned command semantics instead of a general bridge. No `phase2-transport.ts` or mandatory external skill.

Capability is a cooperative PM assertion backed by current skill catalog/read, executable/help/version output and matching managed environment; it is not an invented ExtensionAPI skill catalog. Record those read-only evidence files with the intent. A binary alone, skill alone or a managed environment alone is insufficient. If both qualify, use the current caller's matching environment; ambiguity is a visible refusal, not focus-based selection.

- **Herdr:** current available contract is skill `herdr`, `HERDR_ENV=1`, CLI 0.9.0. At actual authorized use, read the skill and current group help/status. Use the caller's explicit pane/current target; create a sibling with `herdr pane split --current --direction <chosen> --cwd <prepared-worktree> --no-focus`. Parse `.result.pane.pane_id` from the real response. Record `created`, then `herdr agent start <unique-name> --kind omp --pane <returned-id>`. Readiness means only prompt transport is ready. Record `submitting`, then `herdr agent prompt <unique-name> "/iteration-drive --assignment <absolute-prepared-assignment>"` without waiting for plan completion. Preserve CLI argument boundaries; do not send credentials, `--resume` of the coordinator, or a process-global PM role. Prompt submission alone does not prove the child bound or executed.
- **tmux:** conditional only when an actual matching tmux skill is available **and read**, the CLI supports that skill's command forms, `TMUX` identifies this caller and its explicit target is resolved. The current catalog has no matching tmux skill and no `TMUX` identifies the caller, so tmux is **unavailable here**, not a failed implementation requirement. At a supported site use the skill's detached/nonfocus creation with explicit cwd and returned pane ID, launch OMP and submit the same absolute scoped route; inspect help rather than guessing flags or shell-typing into the user's focused pane. If the skill cannot provide those operations, refuse that backend. No silent Herdr substitution.

In both cases, PM uses only returned opaque targets, records actual command output before proceeding and treats `agent_not_ready`, blocked UI, timeout/stalled submission or missing ID according to observed side effects. No blind prompt resend. Created empty panes may be removed only with proven ownership and no potentially active primary; never kill uncertain/user work to free capacity. Pane ready/idle/done is never plan completion. The child obtains its own engine session by fresh `plan bind`, runs only the prepared scope and stops at durable handoff; coordinator continues native tasks and later serial integration.

### E. Proof and rollout

Unit/adapter cases exercise actual journal files, concurrent calls, real temporary engine snapshots/credentials and runtime tool/event entry, with transport **not executed** against user terminals. The skill-driven path gets bounded before/after PM action traces with scripted capability/CLI responses (documented as simulated transport, not native E2E): nonfocus cwd, opaque-ID reuse, checkpoint before submission, missing skill/environment, duplicate intent and stalled prompt. No fake compiled transport tests claiming actual Herdr/tmux execution.

Rollback disables extra starts through native preference or unloads the extension; never delete engine ownership or the uncertainty journal to “reset” capacity.
