# dsh Agent Teams reference

Load when the dsh profile mounts the Agent Teams layer — it is then the DEFAULT
delegation channel, and plan work runs through `spawn_teammate`, `team_task_*`,
`wait_agent`, and `send_message`. Channel selection → `dsh.md` § Delegation
channels.

## Channel shape

- **Nine tools, installed per member.** `spawn_teammate`, `send_message`,
  `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_create` /
  `team_task_list` / `team_task_get` / `team_task_update`. Every member — Lead
  and teammates — receives the same nine definitions; the domain service
  enforces Lead-only creation and interruption, so the toolset is not the
  authority boundary.
- **Any root session is the implicit Lead**; a teammate is a continuable
  subagent child of that Lead. `spawn_teammate` sends the initial task
  unchanged, `send_message` steers a running member at its nearest step
  boundary and starts or resumes an inactive one.
- **Availability is profile-composed.** When `spawn_teammate` is absent from
  the toolset the Team layer is not mounted — use the `subagent` channel and
  never attempt the protocol below. Mounted, the shipped Team profile layer
  disables the legacy direct-delegation rows; it does not disable `workflow`.
- **One Team per root session.** Roster entries and the task board are durable
  in the Lead session log; a fresh root starts an empty Team.

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
  `send_message`, `interrupt_agent`, and task `owner` / `reassign` fields.

## Plan-row ⇄ team-task mirroring

Every writable plan row dispatched to a teammate is mirrored by exactly one
shared task, created **before** the spawn so the initial prompt can cite its
task id.

| Team task field | Plan-row content | Constraint |
|---|---|---|
| `subject` | `<planId> / Task <n> — <role>` | concise title, 200 characters |
| `description` | a coordination summary — task id, plan row, files in scope, acceptance criteria | complete details, 16384 characters. **Never the `## Assignment` header region** (see below) |
| `blocked_by` | task ids mirroring the plan rows this row depends on | ids must exist; a blocked task cannot be claimed or reassigned |
| `write_scopes` | the repository-relative prefixes this row may modify (never the checkout path) | workspace-relative only; absolute paths and `..` segments are refused — a sibling worktree is named in the prompt instead |
| owner | the teammate target executing the row | assigned by `claim` or Lead-only `reassign` |

### Exactly one gated carrier per Assignment — every time

`TEAM_DISPATCH_TOOLS` makes four calls dispatch carriers — `spawn_teammate.prompt`,
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
| the track's FIRST task | `spawn_teammate.prompt` (the spawn is the dispatch) |
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

- **The Team layer caps the roster.** The shipped profile sets
  `maxMembers: 8`; that cap counts **created teammates**, while the Lead is
  implicit and addressable as `lead`. The 9th creation is refused with
  `Team member limit 8 reached` (`TEAM_MEMBER_LIMIT`).
- **The activation pool caps concurrency.** The subagent manager defaults to
  **8 concurrent children** (`maxActiveSubagents`); a spawn beyond the free
  pool is rejected (`subagent limit reached (active child limit: 8)`).
- **Failures are permanent.** A `failed` creation keeps its roster entry — its
  name and its roster slot — because the roster has no removal tool. Plan the
  team width against both caps; when the roster is full, do not invent a ninth
  member: keep the remaining work inside the existing seats and record the cap
  as the reason the remaining rows are not dispatched.

### Seat budget: one seat per track, never one per task

The roster is **finite and non-recyclable**, so a seat policy of "a fresh
teammate for every task" exhausts it and then cannot dispatch the remaining work
— on a Team profile the direct `subagent` rows are disabled, so there is no
cheap escape once the roster is full.

| Work | Seat | Why |
|---|---|---|
| Implementer | **one durable teammate per WRITABLE TRACK**, reused across that track's tasks via `send_message` | the track keeps its checkout, branch, and context; a new seat per task is what exhausts the roster |
| Task reviewer | **not a roster seat** — a `workflow` single-seat read-only run (or `subagent` when mounted) | review isolation wants a fresh context per task, and fresh-context children outside the roster do not consume the cap. The one-seat `workflow` route is a **supported** path when no direct delegation can carry the seat — template `dsh-workflow-scripts.md` § 4 `mstar-review-single`; rules `dsh.md` § Read-only fan-out |
| Plan QC tri | `workflow` fan-out | read-only, N≥3, one run |

- **Review isolation and roster economy are not in conflict.** A reviewer needs a
  fresh CONTEXT, not a durable identity: `workflow` children are fresh one-shot
  subagents that never join the Team, so each task review is isolated while the
  roster stays untouched.
- **Budget the width before the first spawn.** `tracks + reserved recovery ≤
  maxMembers`; leave at least one free slot so a genuinely failed track can be
  re-seated.
- **A wave does NOT free capacity — it moves an existing member.** Idle is not
  freed: `maxMembers` counts created teammates and the roster has no removal
  operation, so waiting for a wave to finish never yields a new seat. When a plan
  has more writable tracks than `maxMembers - reserved`, the supported move is to
  **reassign an idle member to the later track** and tell it the new address:
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
  and record the cap as the reason the remaining writable rows are not
  dispatched.
- **When the cap is reached, the recovery is documented, not manual.** Keep the
  remaining rows on their existing track owners, or run them as `workflow`
  read-only work, and record the cap as the reason in the plan row — never a
  ninth spawn attempt, and never a hand-edited roster.

## Worktree hand-off and write isolation

- **The spawn has no `cwd` field; the member does.** `spawn_teammate` gives every
  teammate the Lead's working directory as its STARTING directory — it is a full
  agent, not a sandboxed function, so it enters an assigned checkout through its
  own tools (absolute paths, or a directory change of its own). Parallel writable
  tracks therefore work: create one worktree per track first (repository
  procedure, L2 isolation), then state each member's absolute checkout path in
  its initial prompt.
- **The prompt carries the absolute address; the board carries a legal scope.**
  A teammate that is never told which checkout belongs to it will edit the shared
  cwd, so the initial prompt must name the absolute worktree path, the branch,
  and the files it owns. `write_scopes` is a DIFFERENT field: it is
  workspace-relative and refuses absolute paths and `..` segments, so never paste
  a checkout path into it. Record the repository-relative prefixes the track
  modifies (for example `packages/dsh/src/gates/`) — the same path means the same
  file inside every worktree of that repository — and omit the field when the
  track only reads or when its scope cannot be expressed (a checkout outside the
  workspace): the prompt is the authority, `write_scopes` is only the advisory
  echo.
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
| per-teammate model or preset selection | `spawn_teammate` takes name, description, prompt, and `context` (`fresh` / `fork`) only; the roster model inherits the Lead's, and `fork` means inherited conversation, not a different preset |
