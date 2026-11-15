# dsh Agent Teams reference

Load when the dsh profile mounts the Agent Teams layer — it is then the DEFAULT
delegation channel: teammates are `subagent` / `subagent_fork` children (legacy:
`spawn_teammate`) tracked through the four `team_task_*` tools. Channel selection
→ `dsh.md` § Delegation channels.

## Channel shape

- **Team surface: the four `team_task_*` tools plus the shared control
  tools.** On an rc.3 factory surface members are created with `subagent` /
  `subagent_fork`, listed with `list_agents` and steered with `send_message`;
  `tool-agent-team` owns only the four task tools, while `list_agents` /
  `send_message` / `wait_agent` come from `tool-subagent-control`. The domain
  service enforces Lead-only creation. `spawn_teammate` is NOT an rc.3 factory
  tool — it came from the removed
  `@deepseek-ai/dsh-experimental-agent-team-profile`, so only a legacy profile
  has it. `interrupt_agent` is the same control row, shipped OFF in every
  factory profile since 0.2.2-rc.3, so treat it as unavailable without a patch.
- **A teammate IS a continuable subagent child.** It is created by `subagent` /
  `subagent_fork` (a legacy profile creates it with `spawn_teammate`) and
  addressed by `list_agents` / `send_message` / `wait_agent`. A one-off,
  non-continuable child takes no board participation: it cannot own a task, and
  a task-board call against it refuses with `TEAM_MEMBER_NOT_FOUND`. Channel
  choice → `dsh.md` § Pick the delegation channel before you delegate.
- **Any root session is the implicit Lead**; a teammate is a continuable
  subagent child of that Lead. The creation call (`subagent`, `subagent_fork`
  or a legacy `spawn_teammate`) sends the initial task unchanged, and
  `send_message` steers a running member at its nearest step boundary.
- **Availability is profile-composed.** The team tools resolve availability at
  step preparation, so they are absent while Team mode is OFF for the root — the
  rc.3 factory default (**Enable agent teamwork** in the root conversation's
  model & reasoning menu, or `agent-team.config.defaultEnabled: true` in a
  profile patch). While they are absent use `subagent` and never attempt the
  protocol below; when they are available the shipped `dsh-web-app` surface has
  the host-plane direct rows disabled while its presets mount them per Session
  again. `workflow` stays mounted either way.
- **One Team per root session.** Roster entries and the task board are durable in
  the Lead session log; a fresh root starts an empty Team.

## Roster naming

A name is the member's model-facing **`target`** everywhere — messaging,
interruption, task owners — and it is immutable for the Team's lifetime.

| Situation | Name | Rule |
|---|---|---|
| One seat for a role | `architect` | the role slug alone |
| Additional seat for one role | `architect-2`, `architect-3` | role slug + seat ordinal |
| Reserved | `lead` | the implicit Lead is always addressable as `lead`; a teammate named `lead` is refused (`TEAM_INVALID_MEMBER_NAME`) |

- Names must be **lower-kebab-case** and **at most 64 characters**: lowercase
  letters and digits in hyphen-separated segments. `Architect`, `architect_2`,
  `architect/qc`, a name longer than 64 characters, and `lead` are all refused
  by the name grammar (`TEAM_INVALID_MEMBER_NAME`).
- Names are **unique for the Team's lifetime** — a name used by a creation that
  later failed is still taken (`TEAM_MEMBER_NAME_TAKEN`), so retries use the
  next free seat ordinal.
- The roster shows `role: lead` or `role: teammate`; use the name (target) in
  `send_message` (and `interrupt_agent` where the profile enables it), and task
  `owner` / `reassign` fields.

## Plan-row ⇄ team-task mirroring

Every writable plan row dispatched to a teammate is mirrored by exactly one
shared task, created **before** the spawn so the initial prompt can cite its
task id.

| Team task field | Plan-row content | Constraint |
|---|---|---|
| `subject` | `<planId> / Task <n> — <role>` | concise title, 200 characters |
| `description` | a coordination summary — task id, plan row, files in scope, acceptance criteria | complete details, 16384 characters. **Never the `## Assignment` header region** (see below) |
| `blocked_by` | task ids mirroring the plan rows this row depends on | ids must exist; a blocked task cannot be claimed or reassigned |
| `write_scopes` | the repository-relative prefixes this row may modify (never the checkout path) | workspace-relative only; absolute paths and `..` segments are refused. A checkout inside the workspace records its prefixes; a checkout entirely outside it (a sibling `…/{repo}.worktrees/<track>`) omits the field — the prompt is the whole address (§ Worktree hand-off and write isolation) |
| owner | the teammate target executing the row | assigned by `claim` or Lead-only `reassign` |

### Exactly one gated carrier per Assignment — every time

`TEAM_DISPATCH_TOOLS` makes four calls dispatch carriers — the creation call's
`prompt` (`subagent` on rc.3; legacy `spawn_teammate.prompt`),
`team_task_create.description`, `team_task_update.description` and
`send_message.message` — and every Assignment-shaped call is recorded as its own
dispatch. Both failure directions are real:

- **Two carriers** for one piece of work: the board `description` repeats the
  Assignment header, so the spawn settles with its member while the board row
  never settles, leaving a permanently unresolved duplicate that inflates
  dispatch counts and the panel graph.
- **No carrier** for a later task: a teammate reused on a track is steered with a
  header-free message, no new spawn happens, and the task's Assignment never
  reaches a carrier at all — so `gateAssignmentText` never runs its field, lease
  and worktree checks, and the ledger records nothing. A silently ungated
  writable dispatch is worse than a duplicate.

**So each task gets exactly one carrier, chosen by its position on the track:**

| Task on the reused track | Carrier |
|---|---|
| the track's FIRST task | the creation call's `prompt` — `subagent` on rc.3; legacy `spawn_teammate.prompt` (the creation IS the dispatch) |
| every LATER task on that track | `send_message.message` (the steer IS the dispatch) |
| never | `team_task_create.description` / `team_task_update.description` — the board row is the coordination record, always non-Assignment text (ids, scope, acceptance) |

A track's later task therefore carries its full `## Assignment` header in the
`send_message` that starts it. That is the only way its gates run; a short
"continue with task 3" message is not a delegation and must not be used to
dispatch writable work.

- **Task ids are Team-local generated values.** The plan id and task number
  live in `subject`, never in the opaque id.
- **Every mutation of an existing task is a compare-and-set.**
  `team_task_create` takes no revision — it creates the row; every later action
  reads the task with `team_task_get` (or `team_task_list`) and passes its
  current `revision` as `expected_revision`, so an outdated edit is rejected
  instead of overwriting newer work.
- **Cover the transitions the plan row needs:** `claim` → `in_progress` +
  owner, `complete` (keeps the owner), `release` / `reopen` (clears the owner
  and returns the task to pending), `set_dependencies`, `edit`, `reassign`,
  `delete`. A task that still blocks another cannot be deleted
  (`TEAM_TASK_HAS_DEPENDENTS`).
- **Keep the two records in step.** The plan row is the delivery authority; the
  task board is the coordination projection. A completion recorded only on the
  board — or only in the plan — is not a completed row.

## Wake discipline

Readiness never starts the owner. A task becomes `ready` when every blocker is
completed, but that is a derived filter, not a wake signal; an idle teammate
stays idle until someone messages it.

| Member state | Meaning | Lead action |
|---|---|---|
| `running` | a turn is executing | `send_message` reaches it at the next step boundary; otherwise `wait_agent` |
| `inactive` | **no turn is executing — not done, not failed** | `send_message` to start/resume it before waiting |
| `provisioning` | creation is in flight | `wait_agent`; do not spawn the same name again |
| `failed` | **member creation failed** | creation failure ≠ work failure: record it, then retry with a new name if capacity allows |

- **`wait_agent` observes, it never wakes.** It returns `noProgress` immediately
  when no other member is running or provisioning, and its own message says to
  wake the required member first. It sees only changes after the call starts —
  re-list with `list_agents` and `team_task_list` after a wakeup or timeout
  instead of polling.
- **A completed dependency does not wake the dependent owner.** After marking a
  blocker complete, `send_message` the dependent's owner; `reassign` also sets
  an owner and `in_progress` but sends **no** message, so follow it with one.
- **`send_message` success is inbox acceptance only** (`{ sent: true }`). It
  does not confirm the recipient processed the message.
- **Completion is a plan-row verdict, not a status sample.** `inactive` after a
  turn means the member stopped executing; read the plan-row evidence and the
  settlement/close-out result before recording anything as done.

## Report budget

The Lead re-reads every reply it has received on every later turn of its own
session, so reply volume is a per-turn cost paid for the rest of the run —
measured: **110 agent-message replies / ~240k characters in one session**. Keep
the durable material in files, not in replies:

- **A teammate reply carries status + artifact path + at most a short summary.**
  Findings, transcripts, diffs and reasoning belong in the assigned file; the
  reply names that file (`path:line`) and states the verdict.
- **Bound: a report reply stays under ~15 lines / ~1,200 characters** unless the
  task asks for prose (a written deliverable, or a verdict the Lead explicitly
  asked to read inline). Over the bound is a defect in the reply, not in the
  reader: move the excess into the artifact and point at it.
- **A settlement notice is a signal, not a deliverable channel.**
  `send_message` / a settle event says that work finished (status + where); it
  never carries the work, and a short notice is not a reason to restate the
  artifact inline.
- **The same bound governs the task board.** A task `description` carries the
  assignment (up to 16384 characters); an outcome written through
  `team_task_update` states the result and the artifact path, not the narrative.

## Capacity

- **The Team layer declares no roster cap of its own.** Since 0.2.2-rc.3
  `agent-team` config is only `maxTasks` (default 256) and `defaultEnabled`;
  `maxMembers` / `maxMessageBytes` / `disposalTimeoutMs` were REMOVED and a row
  that sets one does not activate (`TEAM_INVALID_CONFIG`). Teammates are
  ordinary subagent children, so width comes from `maxActiveSubagents` (default
  **8 concurrent children**) and `maxDepth` (default **1** — a teammate does not
  delegate further unless raised).
- **The activation pool caps concurrency.** A spawn past the free pool is
  rejected with `subagent limit reached (active child limit: N)`; there is no
  team-specific `TEAM_MEMBER_LIMIT`.
- **Failures are permanent.** A `failed` creation keeps its roster entry — its
  name stays taken — because the roster has no removal operation. Plan the width
  against the pool and the depth limit, and record the bound on the plan row.

### Seat budget: one seat per track, never one per task

The roster is **non-recyclable** (no removal operation, a name never returns)
while the activation pool is small — 8 concurrent children by default, so a
"fresh teammate per task" policy churns names, checkouts and context for no gain.

| Work | Seat | Why |
|---|---|---|
| Implementer | **one durable teammate per WRITABLE TRACK**, reused across that track's tasks via `send_message` | the track keeps its checkout, branch, and context; a new seat per task churns the pool and the name space for no gain |
| Task reviewer | **not a roster seat** — a `workflow` single-seat read-only run (or `subagent` when mounted) | review isolation wants a fresh context per task, and fresh-context children outside the roster take no durable seat. The one-seat `workflow` route is a **supported** path when no direct delegation can carry the seat — template `dsh-workflow-scripts.md` § 4 `mstar-review-single`; rules `dsh.md` § Read-only fan-out |
| Plan QC tri | `workflow` fan-out | read-only, N≥3, one run |

- **Review isolation and roster economy are not in conflict.** A reviewer needs a
  fresh CONTEXT, not a durable identity; `workflow` children never join the Team.
- **Budget the width before the first spawn.** `tracks + reserved recovery ≤
  maxActiveSubagents` (8 by default), leaving one free slot for a failed track.
- **A wave does NOT deliver a new seat — it moves an existing member.** Capacity
  is the activation pool plus a name space that never returns, so a finished
  wave is not a budget for the next track. When a plan has more writable tracks
  than the pool minus reserved recovery, the supported move is to **reassign an
  idle member to the later track** and tell it the new address:
  1. `list_agents` → pick a teammate that is `inactive` and whose track is
     genuinely finished (its board task is `complete`).
  2. `team_task_get` the later track's board task, then `team_task_update`
     `reassign` it to that member (that row's owner is the migration record).
  3. `send_message` that member with the later track's **absolute checkout
     path, branch and the full `## Assignment` header** — the steer is the later
     task's gated carrier (§ Exactly one gated carrier per Assignment), so a
     header-free wake-up would leave the task ungated.
  Record the migration on the plan row. If no member is free, the remaining
  tracks wait; if they cannot wait, run their read-only work as `workflow` seats
  and record the bound as the reason the remaining writable rows are not
  dispatched.
- **When the pool is exhausted, the recovery is documented, not manual.** Keep
  the remaining rows on their existing track owners, or run them as `workflow`
  read-only work, and record the bound as the reason in the plan row — never a
  spawn retry against a full pool, and never a hand-edited roster.

## Worktree hand-off and write isolation

- **The creation call's `cwd` is only a STARTING directory.** `subagent` /
  `subagent_fork` give every teammate the Lead's working directory unless the
  call names one (a legacy `spawn_teammate` has no `cwd` field at all) — it is a
  full agent, not a sandboxed function, so it enters an assigned checkout
  through its own tools (absolute paths, or a directory change of its own).
  Parallel writable tracks therefore work: create one worktree per track first
  (repository procedure, L2 isolation), then state each member's absolute
  checkout path in its initial prompt.
- **The prompt carries the absolute address; the board carries a legal scope.**
  A teammate that is never told which checkout belongs to it will edit the shared
  cwd, so the initial prompt must name the absolute worktree path, the branch,
  and the files it owns. `write_scopes` is a DIFFERENT field: it is
  workspace-relative and refuses absolute paths and `..` segments, so the
  checkout path never goes into it. Where the checkout sits decides the rest:
  a checkout **inside** the workspace records the track's repository-relative
  prefixes (for example `packages/dsh/src/gates/`); a checkout **entirely
  outside** the workspace (the normal `…/{repo}.worktrees/<track>` shape) omits
  the field, because no workspace-relative value can name it, and the prompt is
  the whole address; a track that only reads omits it too. The prompt is the
  authority; `write_scopes` is only the advisory echo.
- **`write_scopes` is advisory, not a lock.** Overlapping scopes on in-progress
  tasks surface as `writeScopeWarnings`; they never block a write. Bash,
  formatters, and code generators are not covered by the filesystem version
  guard either — coordinate them explicitly, and keep seats in disjoint
  directories so interleaving is harmless.
- **A stale write is a rebase signal.** On `FS_STALE_VERSION`, re-read the file,
  rebase the intended change onto the new content, and retry; do not overwrite
  a teammate's edit.
- **The Lead owns final integration.** Review the combined diff and run the
  verification after teammates settle; a member's own claim of success is not
  delivery evidence.

## What the channel does not provide

| Not provided | Consequence / where it lives instead |
|---|---|
| automatic worktree creation | the channel creates no checkout; create one per writable track through the repository's worktree procedure, then hand each member its absolute path |
| locks | `write_scopes` warns; concurrent writes can still interleave |
| merges, rebases, or review gates | the Lead integrates and verifies; no tool merges member work |
| automatic ownership release | `complete` keeps the owner; `release`, `reopen`, and `reassign` are explicit calls |
| per-teammate model or preset selection | the creation call fixes the member's name and prompt; `fresh` vs `fork` is the tool choice (`subagent` vs `subagent_fork`) on rc.3, a `context` field on a legacy `spawn_teammate`. The model inherits the Lead's, and `fork` means inherited conversation, not a different preset |
