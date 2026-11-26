# dsh Agent Teams reference

Load when the dsh profile mounts the Agent Teams layer — the shared task board is
then the DEFAULT coordination surface: teammates are continuable `subagent` /
`subagent_fork` children named through the subagent catalog, and their shared work
is tracked through the four `team_task_*` tools. Channel selection → `dsh.md`
§ Delegation channels.

## Channel shape

- **Team surface: the four `team_task_*` tools plus the shared control tools.** The
  Team service (`ctx.agentTeams`) owns only the task board — `isEnabled`,
  `setEnabled`, `createTask`, `getTask`, `listTasks`, `updateTask` — and has no member
  or seat read. A teammate is created by `subagent` / `subagent_fork`, discovered
  with `list_agents` and steered with `send_message`; those three come from
  `tool-subagent-control`, as does `interrupt_agent`, which exists only when
  `tool-subagent-control.interrupt` is on (the factory profiles ship it OFF). Any
  team-tree agent may create a board task.
- **A teammate IS a continuable subagent child.** The creation call returns
  `{ kind: 'activation', name }` at start — an activation, never a completion — and
  the child settles through its own `subagent/end` lifecycle event. A one-shot child
  takes no board participation: it never appears in `list_agents`, and a board
  `reassign` to it refuses with `TEAM_MEMBER_NOT_FOUND` (`agent "<name>" is not a
  continuable descendant of this task board's root`). Channel choice → `dsh.md`
  § Pick the delegation channel before you delegate.
- **Any root session is the implicit Lead** (`lead`). The creation call's `prompt`
  carries that teammate's first task unchanged; `send_message` reaches a running
  member at its nearest step boundary and starts an idle one.
- **Availability is profile-composed.** The Team tools resolve availability at step
  preparation, so they are absent while Team mode is OFF for the root — the rc.3
  factory default (**Enable agent teamwork** in the root conversation's model &
  reasoning menu, or `agent-team.config.defaultEnabled: true` in a profile patch).
  While they are absent use `subagent` and never attempt the protocol below. There is
  **one Team per root session**: the board lives in the Lead session log, so a fresh
  root starts an empty board.

## Member naming

A member's model-facing name is its subagent-catalog name: a child name is one path
segment, and the **full name is the slash path from the root** (`reviewer/checker`);
the root's own name is `lead`.

| Situation | Name | Rule |
|---|---|---|
| One seat for a role | `architect` | the role slug alone |
| Additional seat for one role | `architect-2`, `architect-3` | role slug + seat ordinal |
| Reserved | `lead` | the implicit Lead is always addressable as `lead`; no child may take it |

- A segment is **1–32 lower-case letters, digits or hyphens, starting with a
  letter**. `Architect`, `architect_2`, a segment longer than 32 characters, and
  `lead` are refused with `INVALID_AGENT_NAME`; an omitted `name` defaults to
  `agent-1`, `agent-2`, …
- Uniqueness is **per creator, among the children that creator started**: a name
  already used by one of your children is refused (`DUPLICATE_AGENT_NAME`), while two
  branches may each hold a `reviewer` (`reviewer`, `architect/reviewer`) — address the
  full path. A creation that errors releases its reserved name, and a child keeps its
  name while its creator's catalog records it, so a retry takes the free ordinal.
- Names are how messaging, interruption and task ownership address a member: the
  `agent` argument of `send_message` and the `owner` field a board task records (a name
  path, else a session id); a path naming no member of your tree refuses with `AGENT_NAME_NOT_FOUND`.

## Plan-row ⇄ team-task mirroring

Every writable plan row dispatched to a teammate is mirrored by exactly one shared
task, created **before** the creation call so the first prompt can cite its task id.

| Team task field | Plan-row content | Constraint |
|---|---|---|
| `subject` | `<planId> / Task <n> — <role>` | concise title, 200 characters |
| `description` | a coordination summary — task id, plan row, files in scope, acceptance criteria | complete details, 16384 characters. **Never the Assignment document itself** (see below) |
| `blockedBy` | task ids mirroring the plan rows this row depends on | ids must exist and not be deleted; a blocked task cannot be claimed or reassigned |
| `writeScopes` | the repository-relative prefixes this row may modify (never the checkout path) | workspace-relative only; absolute paths, `..` segments and empty segments are refused (`TEAM_INVALID_WRITE_SCOPE`). A checkout inside the workspace records its prefixes; a checkout entirely outside it (a sibling `…/{repo}.worktrees/<track>`) omits the field — the prompt is the whole address (§ Worktree hand-off and write isolation) |
| `owner` | the teammate executing the row (name path, else its session id) | set by `claim` (self-only) or Lead-only `reassign` |

### Exactly one gated carrier per Assignment — every time

Three calls are Team dispatch carriers — `team_task_create.description`,
`team_task_update.description` and `send_message.message`. The creation call's
`prompt` (`subagent` / `subagent_fork`) is the fourth carrier, gated by the ordinary
delegation branch. Both failure directions are real:

- **Two carriers** for one piece of work: the board `description` repeats the Assignment, so the creation settles with its child while the board row never settles — a permanently unresolved duplicate that inflates dispatch counts and the panel graph.
- **No carrier** for a later task: a teammate reused on a track is steered with a field-free message, no new creation happens, and the task's Assignment reaches no carrier — so `gateAssignmentText` never runs its field, lease and worktree checks, and the ledger records nothing. A silently ungated writable dispatch is worse than a duplicate.

**Each task gets exactly one carrier, chosen by its position on the track:**

| Task on the reused track | Carrier |
|---|---|
| the track's FIRST task | the creation call's `prompt` — `subagent` / `subagent_fork` (the creation IS the dispatch) |
| every LATER task on that track | `send_message.message` (the steer IS the dispatch) |
| never | `team_task_create.description` / `team_task_update.description` — the board row is the coordination record, always non-Assignment text (ids, scope, acceptance) |

A later task on a track carries its full Assignment document in the `send_message` that starts it; that is the only way its gates run, and a short "continue with task 3" message is not a delegation.

- **Task ids are Team-local generated values** (`task-1`, `task-2`, …). The plan id
  and task number live in `subject`, never in the opaque id.
- **Every mutation of an existing task is a compare-and-set.** `team_task_create`
  takes no revision — it creates the row; every later action reads the task with
  `team_task_get` (or `team_task_list`) and passes its current `revision` as
  `expected_revision`, so an outdated edit is refused (`TEAM_TASK_STALE_REVISION`)
  instead of overwriting newer work.
- **Cover the transitions the plan row needs:** `claim` is self-only and requires
  readiness (owned by another → `TEAM_TASK_ALREADY_CLAIMED`; not ready →
  `TEAM_TASK_BLOCKED`); `complete` requires `in_progress` and **keeps the owner**;
  `release` / `reopen` clear the owner and return the task to `pending`; `reassign`
  is **Lead-only** (`TEAM_LEAD_REQUIRED`), sets the owner and `in_progress`, and sends
  no message; `edit` and `set_dependencies` need the owner or the Lead; a task that
  still blocks another cannot be deleted (`TEAM_TASK_HAS_DEPENDENTS`); a tombstone
  refuses mutation (`TEAM_TASK_DELETED`).
- **Board refusals:** `TEAM_DISABLED`, `TEAM_TASK_NOT_FOUND`, `TEAM_TASK_STALE_REVISION`,
  `TEAM_TASK_LIMIT`, `TEAM_TASK_ALREADY_CLAIMED`, `TEAM_TASK_BLOCKED`,
  `TEAM_TASK_UNAUTHORIZED`, `TEAM_TASK_INVALID_TRANSITION`, `TEAM_TASK_DELETED`,
  `TEAM_TASK_HAS_DEPENDENTS`, `TEAM_TASK_DEPENDENCY_CYCLE`, `TEAM_LEAD_REQUIRED`,
  `TEAM_MEMBER_NOT_FOUND`, `TEAM_INVALID_WRITE_SCOPE`, `TEAM_INVALID_ARGUMENT`.
- **Keep the two records in step.** The plan row is the delivery authority; the task
  board is the coordination projection. A completion recorded only on the board — or
  only in the plan — is not a completed row.

## Wake discipline

Readiness never starts the owner: a task becomes `ready` when every blocker is
completed, but that is a derived filter, not a wake signal, and a task change never
ends a `wait_agent` call, adds an inbox message, or starts an idle agent.

| `list_agents` state | Meaning | Lead action |
|---|---|---|
| `running` | a turn is executing | `send_message` reaches it at the next step boundary; otherwise `wait_agent` |
| `inactive` | **no turn is executing — not done, not a work result** | `send_message` to start/resume it before waiting |

`corrupt` / `unsupported` / `unavailable` is an unreadable-branch diagnostic — that
row's descendants could not be read. The row is still a member you can message, and
the status says nothing about its work.

- **`wait_agent` is an inbox wait on the caller's own queue, never progress
  sampling.** It returns `{ timedOut }`: `false` means new input is pending, `true`
  means nothing arrived within `timeout_ms` (10000–3600000, default 30000). Pending
  input reaches the model only after the running tool call finishes, so re-list with
  `list_agents` and `team_task_list` after a wakeup or timeout instead of polling.
- **A completed dependency does not wake the dependent owner.** After marking a
  blocker complete, `send_message` the dependent's owner; `reassign` also sets an
  owner and `in_progress` but sends **no** message, so follow it with one.
- **`send_message` returns `{ messageId }` and proves inbox acceptance only** (it
  renders `message delivered to agent <name>`); it does not confirm the recipient
  processed the message.
- **Completion is a plan-row verdict, not a status sample.** `inactive` after a turn
  means the member stopped executing; read the plan-row evidence and the
  settlement/close-out result before recording anything as done.

## Report budget

The Lead re-reads every reply it received on every later turn of its own session, so
reply volume is a per-turn cost paid for the rest of the run — measured: **110
agent-message replies / ~240k characters in one session**. Keep durable material in
files, not replies:

- **A teammate reply carries status + artifact path + at most a short summary.**
  Findings, transcripts, diffs and reasoning belong in the assigned file; the reply
  names that file (`path:line`) and states the verdict.
- **Bound: a report reply stays under ~15 lines / ~1,200 characters** unless the task
  asks for prose (a written deliverable, or a verdict the Lead explicitly asked to
  read inline). Over the bound is a defect in the reply, not in the reader: move the
  excess into the artifact and point at it.
- **A settlement notice is a signal, not a deliverable channel.** `send_message` / a
  settle event says that work finished (status + where); it never carries the work.
- **The same bound governs the task board.** A task `description` is coordination text (ids, scope, acceptance, result, artifact path — never the Assignment document, which rides the task's own carrier); an outcome states the path.

## Capacity

- **The Team layer declares no seat cap.** `agent-team` config is only `maxTasks`
  (default 256 — the number of non-deleted board tasks it keeps) and `defaultEnabled`;
  a row that still sets `maxMembers`, `maxMessageBytes` or `disposalTimeoutMs` does not
  activate (`TEAM_INVALID_CONFIG`). Teammates are ordinary subagent children, so width
  comes from the subagent activation pool `maxActiveSubagents` (default **8 concurrent
  children**) and `maxDepth` (default **1** — a teammate does not delegate further
  unless raised).
- **The activation pool caps concurrency.** A creation past the free pool is refused
  with `subagent limit reached (active child limit: N)`; there is no Team-specific
  member limit.
- **A creation that errors is not failure of the work.** It releases its name and
  takes no board state — the work simply has no seat yet. Record it, then retry
  within the pool bound.

### Seat budget: one seat per track, never one per task

A child's name is not recycled while its creator's catalog records it and the pool is
small — 8 concurrent children by default — so a "fresh teammate per task" policy churns
names, checkouts and context for no gain.

| Work | Seat | Why |
|---|---|---|
| Implementer | **one durable teammate per WRITABLE TRACK**, reused across that track's tasks via `send_message` | the track keeps its checkout, branch, and context; a new seat per task churns the pool and the name space for no gain |
| Task reviewer | **no durable teammate seat** — a `workflow` single-seat read-only run (or a one-shot `subagent`) | review isolation wants a fresh context per task, and a `workflow` child never occupies the activation pool's durable-team budget. The one-seat `workflow` route is a **supported** path when no direct delegation can carry the seat — template `dsh-workflow-scripts.md` § 4 `mstar-review-single`; rules `dsh.md` § Read-only fan-out |
| Plan QC tri | `workflow` fan-out | read-only, N≥3, one run |

- **Review isolation and seat economy are not in conflict.** A reviewer needs a fresh
  CONTEXT, not a durable identity; `workflow` children never join the board.
- **Budget the width before the first creation.** `tracks + reserved recovery ≤
  maxActiveSubagents` (8 by default), leaving one free slot for a track that must
  retry.
- **A wave does NOT deliver a new seat — it moves an existing member.** Capacity is
  the activation pool plus names that do not come back, so a finished wave is not a
  budget for the next track. When a plan has more writable tracks than the pool minus
  reserved recovery, the supported move is to **reassign an idle member to the later
  track** and tell it the new address:
  1. `list_agents` → pick a teammate that is `inactive` and whose track is genuinely
     finished (its board task is `completed`).
  2. `team_task_get` the later track's board task, then `team_task_update` `reassign`
     it to that member (that row's owner is the migration record).
  3. `send_message` that member with the later track's **absolute checkout path,
     branch and the full `## Assignment` header** — the steer is the later task's
     gated carrier (§ Exactly one gated carrier per Assignment), so a header-free
     wake-up would leave the task ungated.
  Record the migration on the plan row. If no member is free, the remaining tracks
  wait; if they cannot wait, run their read-only work as `workflow` seats and record
  the bound as the reason the remaining writable rows are not dispatched.
- **When the pool is exhausted, the recovery is documented, not manual.** Keep the
  remaining rows on their existing track owners, or run them as `workflow` read-only
  work, and record the bound as the reason in the plan row — never a creation retry
  against a full pool, and never a hand-edited board.

## Worktree hand-off and write isolation

- **The creation call's `cwd` is only a STARTING directory.** `subagent` /
  `subagent_fork` give every teammate the Lead's working directory unless the call names
  one — the child is a full agent, not a sandboxed function, so it enters an assigned
  checkout through its own tools (absolute paths, or a directory change of its own).
  Parallel writable tracks therefore work: create one worktree per track first
  (repository procedure, L2 isolation), then state each member's absolute checkout
  path in its initial prompt.
- **The prompt carries the absolute address; the board carries a legal scope.** A
  teammate never told which checkout belongs to it will edit the shared cwd, so the
  initial prompt must name the absolute worktree path, the branch, and the files it
  owns. `writeScopes` is a DIFFERENT field: it is workspace-relative and refuses
  absolute paths and `..` segments, so the checkout path never goes into it. Where the
  checkout sits decides the rest: a checkout **inside** the workspace records the
  track's repository-relative prefixes (for example `packages/dsh/src/gates/`); a
  checkout **entirely outside** the workspace (the normal
  `…/{repo}.worktrees/<track>` shape) omits the field, because no workspace-relative
  value can name it, and the prompt is the whole address; a track that only reads omits
  it too. The prompt is the authority; `writeScopes` is only the advisory echo.
- **`writeScopes` is advisory, not a lock.** Overlapping scopes on in-progress tasks
  surface as `writeScopeWarnings`; they never block a write. Bash, formatters, and code
  generators are not covered by the filesystem version guard either — coordinate them
  explicitly, and keep seats in disjoint directories so interleaving is harmless.
- **A stale write is a rebase signal.** On `FS_STALE_VERSION`, re-read the file, rebase
  the intended change onto the new content, and retry; do not overwrite a teammate's
  edit.
- **The Lead owns final integration.** Review the combined diff and run the verification
  after teammates settle; a member's own claim of success is not delivery evidence.

## What the channel does not provide

| Not provided | Consequence / where it lives instead |
|---|---|
| automatic worktree creation | the channel creates no checkout; create one per writable track through the repository's worktree procedure, then hand each member its absolute path |
| locks | `writeScopes` warns; concurrent writes can still interleave |
| merges, rebases, or review gates | the Lead integrates and verifies; no tool merges member work |
| automatic ownership release | `complete` keeps the owner; `release`, `reopen`, and `reassign` are explicit calls |
| per-teammate model or preset selection | the creation call fixes the member's name and prompt; the member's model inherits the Lead's, and `fresh` vs `fork` is the tool choice (`subagent` vs `subagent_fork`) — `fork` means inherited conversation, not a different preset |
