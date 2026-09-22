# Plan-scoped primary PM (scoped `iteration-drive` route)

**Single home for the scoped route.** This file owns: accepted addressing forms, scoped boot, the plan-local driving loop, the scoped stop, and the coordinator command sequence. It does **not** own field/schema tables, executable flag syntax, or Assignment header templates.

- Command frontmatter/argument surface → **`commands/iteration-drive.md`**
- Executable flags, exit codes, JSON envelopes → **`mstar-use-cli`**（CLI owner）
- `coordination` / session / handoff / revision fields and row/issue ownership → **`mstar-artifacts/references/status-and-residuals.md`**（sole runtime schema home）
- Portable primary Assignment header → **`mstar-roles/references/project-manager/dispatch-and-assignment.md`**
- Dispatch mechanics, isolation gates → **`mstar-dispatch-gates`**, **`mstar-sdd`**, **`mstar-branch-worktree`**

No command aliases and no second vocabulary for the operations below.

## 0. Route selection (before any whole-iteration boot)

| Invocation | Route |
|---|---|
| `/iteration-drive`（**no args**） | unchanged whole-iteration boot and Phase 2 → 3 → 4 → 5 → 6 route（`commands/iteration-drive.md`） |
| `/iteration-drive --assignment <abs.md>` \| `--workflow <id> --plan <id>` \| `--resume <abs-session.json>` | **this file** — scoped primary route |
| any other nonempty argument shape | **fail closed before boot and before claim**; never broaden to the whole-iteration route |

Scoped boot does **not** load `mstar-compound` or the Phase 3–6 detail files merely because whole-iteration boot does. A leaf executor that finds this command in its own Assignment is refused by the role boundary (`mstar-dispatch-gates`), never promoted to PM.

## 1. Addressing forms (strict parse)

```text
/iteration-drive --assignment <absolute-md-path>
/iteration-drive --workflow <id> --plan <id>
/iteration-drive --resume <absolute-session-json-path>
```

- The first two are **fresh** addressing forms; the third explicitly **resumes** an already bound session through the **pre-activation** file route, so it is lawful only while the harness's execution authority is not active — on an ACTIVE harness it refuses (`execution.consumer-not-ready`) rather than being reinterpreted, and the session's own read-only resume is `mstar plan bind --execution --resume-ref <wire>` (§2).
- Fail **before any bind** on: duplicate flags, unknown flags, positional arguments, missing/blank values, mixed forms, partial `--workflow`/`--plan` pairs, and any path that is not absolute.
- Rejection is terminal for the turn: report the malformed form and the accepted forms. There is no fallback plan, no "first unfinished row", and no whole-iteration fallback.
- Both fresh forms resolve the **same** registered Assignment: `--workflow/--plan` reads `row.coordination.prepared.assignment_path`; it never selects the first unfinished row.

## 2. Scoped boot

1. **Load PM identity in the current primary session**: `mstar-harness-core` → `mstar-roles` → `references/project-manager.md`. No PM subagent is spawned or dispatched for any address form — PM runs in the **primary session** on every host（rule home → `mstar-roles/references/project-manager.md` § Plan-scoped authority；dispatch surface → the active host reference（`mstar-host`）§ C5）.
2. **Bind once**, matching the form exactly. On a harness whose execution authority is **active**（the canonical transport; → `mstar-use-cli` `references/plan-and-workflow.md` § Transports）the caller identity is independently acquired for this invocation and no session file is written or read:

   ```bash
   mstar plan bind --execution --workflow <id> --plan <id> --expect <plan-execution-token> --operation <id> [--harness <absolute-path>] [--json]
   mstar plan bind --execution --workflow <id> --coordinator --expect <workflow-execution-token> --operation <id> [--harness <absolute-path>] [--json]   # coordinator seat only
   mstar plan bind --execution --resume-ref <wire> [--json]                                        # read-only resume of that session
   ```

   Pre-activation（only while that authority is not active）the matching forms are:

   ```bash
   mstar plan bind --assignment <absolute-md-path> [--json]
   mstar plan bind --workflow <id> --plan <id> [--harness <absolute-path>] [--json]
   mstar plan bind --resume <absolute-session-json-path> [--json]
   mstar plan bind --coordinator --workflow <id> [--harness <absolute-path>] [--json]   # coordinator seat only
   ```

   `bind` is the only operation without an external `--expect`: it reads, checks and claims atomically against current ownership. Fresh coordinator bind initializes the workflow's coordinator only when absent; a second fresh coordinator fails exactly like a duplicate plan holder. Plan fresh bind requires a row that was **prepared** by the coordinator. A **resume is read-only** — it never reacquires ownership, never re-identifies the caller and is **never** the recovery path for a stopped owner.
3. **Re-read with `show` and constrain the session to the returned scope**:

   ```bash
   mstar plan show --session-ref <wire> [--plan <id>] [--json]        # active: a plan-pm reference carries its own plan; a coordinator reference requires --plan
   mstar plan show --workflow <id> --plan <id> [--json]               # public authoritative read
   mstar plan show --session <plan-session.json> [--json]             # pre-activation
   mstar plan show --session <coordinator-session.json> --plan <id> [--json]
   ```

   `show` returns the selected row, resolved scoped paths, `allowed_operations`, the snapshot byte version, and `revision`. It never returns an editable sibling snapshot. A plan session passes no `--plan`; a coordinator session requires it. On the active route the reference carries the workflow it authorizes — `--session-ref` accepts no `--workflow` — and the token to spend comes from the scope read, not from a remembered value.
4. **Constrain everything that follows to that scope**: loaded skills, dispatched child inputs, session backlog, goal text, session todos, STOP conditions, and every writable path.
5. **Stale input stops.** If a later `show` reports the Assignment hash changed, the session/scope/holder no longer matches, or the token is behind, stop and report — do not re-bind silently and do not fall back to generic iteration drive.

## 3. Scope boundary (writable surface)

A scoped actor writes **only its own row and the issues linked to it that it captures or closes**. Concretely:

| Permitted | Forbidden |
|---|---|
| row `coordination.*`（`prepared` / `progress` / `handoff`）, row `status`, row `revision`, retained `metadata.working_branch` / `metadata.worktree_path` / `metadata.track_branches` | sibling rows, lifecycle anchors, snapshot `branch` / `integration_worktree_path` / `execution_policy`, `compass_ref` |
| issues in `{HARNESS_DIR}/store.db` linked to this plan, via `issue-add` / `issue-close` | any other plan's issues, the retired `projects/<project-id>/residuals.json` register bucket, the v2 root `status.json` register, shared indexes (`{KNOWLEDGE_DIR}` / `{ITERATION_DIR}`), iteration PR, Phase 3–6 |
| `progress` / `issue-add` / `issue-close` / `handoff`（plan session） | any raw `writeWorkflowSnapshot` / direct snapshot or register edit, `--force`, arbitrary holder input, takeover, a lease-release verb |

Field semantics, ownership and lock rules → **`mstar-artifacts/references/status-and-residuals.md`**（「Plan coordination」）.

## 4. Plan-local driving

Drive the bound plan with the **existing** SDD / gate machinery; scope is inherited by every child input.

1. **Prepare gate**: the coordinator prepared this row (`mstar plan prepare`, §6). A plan session never prepares itself.
2. **Implement**: `mstar sdd workspace` → `mstar sdd task-brief` → dispatch implementers → fresh L2 task reviewer（`mstar-sdd` § Per-task loop）. `Execution mode: sdd` stays the default for multi-task plans.
3. **Plan QC tri**: after all tasks, branch `review-package` → **N=3** tri-review（`mstar-review-qc`, `mstar-dispatch-gates`）; then the `QA gate` from the Assignment (`mandatory` → `qa-engineer`; `pm-acceptance` → PM acceptance artifact).
4. **Progress**（row status + summary + evidence paths）:

   ```bash
   # active (canonical): own reference, the plan's full execution token, own operation id
   mstar plan progress --session-ref <plan-wire> --file <absolute-json-path> \
     --expect <plan-execution-token> --operation <id> [--harness <absolute-path>] [--json]

   # pre-activation only
   mstar plan progress --session <plan-session> --file <absolute-json-path> --expect <revision> [--json]
   ```

   Allowed transitions: `InProgress` → `InProgress|InReview|Blocked`; `Blocked` → `Blocked|InProgress`; `InReview` → `InReview|InProgress|Blocked` **before handoff**. Never `Todo`/`Done`, never lease removal.
5. **Findings**（cleanup mode from the Assignment）: capture each finding as an issue **linked to this plan**, and close one with its disposition:

   ```bash
   # active
   mstar plan issue-add   --session-ref <plan-wire> --file <absolute-json-path> \
     --expect <plan-execution-token> --operation <id> [--harness <absolute-path>] [--json]
   mstar plan issue-close --session-ref <plan-wire> --issue <id> --disposition <resolved|waived|duplicate|superseded> \
     --file <absolute-json-path> --expect-issue <issue-revision> \
     --expect <plan-execution-token> --operation <id> [--harness <absolute-path>] [--json]

   # pre-activation only
   mstar plan issue-add   --session <plan-session> --file <absolute-json-path> --expect <revision> [--json]
   mstar plan issue-close --session <plan-session> --issue <id> --disposition <resolved|waived|duplicate|superseded> \
     --file <absolute-json-path> --expect-issue <issue-revision> --expect <revision> [--json]
   ```

   The capture contract — who captures, the idempotence by source identity, and the migration mapping for the retired register — is **`mstar-project-governance`「Issue capture」**; each report names the DB-assigned issue ids and revisions. The retired `residual-add` / `residual-close` verbs refuse and write nothing.

**Backlog / goals / todos / STOP are plan-local**: the session backlog is this plan's tasks; goal text covers **this plan's** flow only（`mstar-host` § `/goal` directive）; todos are the plan's task list, and no global phase entry（Phase 3/PR/compound）is seeded; the STOP is the handoff in §5, not plan `Done`.

## 5. Finish = durable handoff（not `Done`）

When QC/QA evidence is complete and no child writer is active:

```bash
# active
mstar plan handoff --session-ref <plan-wire> --file <absolute-json-path> \
  --expect <plan-execution-token> --operation <id> [--harness <absolute-path>] [--json]

# pre-activation only
mstar plan handoff --session <plan-session> --file <absolute-json-path> --expect <revision> [--json]
```

- Requires row `InReview`, no active child writes, a clean feature worktree, `review_head === source_sha === feature branch HEAD === feature worktree HEAD`, and the QC/QA evidence pins.
- The handoff record is immutable; the plan keeps its `execution_lease` and stays **`InReview`**.
- **Then STOP the scoped session.** Handoff is the scoped finish line. Do **not** set `Done`, do **not** delete `execution_lease`, do **not** open Phase 3 / PR, do **not** run compound, and do **not** treat "last unfinished plan" as an exception that advances the iteration.
- A user asking to mark `Done` before integration is rejected: `Done` + lease release is the coordinator's atomic completion after a verified merge（§6）.
- After handoff, further `progress` / `issue-add` / `issue-close` mutations are rejected by the engine until a coordinator `return`; the session reports the handoff id and waits.

## 6. Coordinator sequence（one coordinator seat per workflow）

```bash
# active (canonical): the coordinator's own reference + the plan scope's full execution token + an operation id
mstar plan prepare            --session-ref <coordinator-wire> --plan <id> --assignment <absolute-md-path> --expect <plan-execution-token> --operation <id> [--harness <absolute-path>] [--json]
mstar plan accept             --session-ref <coordinator-wire> --plan <id> --handoff <id> --expect <plan-execution-token> --operation <id> [--harness <absolute-path>] [--json]
mstar plan return             --session-ref <coordinator-wire> --plan <id> --handoff <id> --reason <text> --expect <plan-execution-token> --operation <id> [--json]
mstar plan integration-start  --session-ref <coordinator-wire> --plan <id> --handoff <id> --expect <plan-execution-token> --operation <id> [--json]
mstar plan integration-accept --session-ref <coordinator-wire> --plan <id> --handoff <id> --expect <plan-execution-token> --operation <id> [--json]
mstar plan complete           --session-ref <coordinator-wire> --plan <id> --handoff <id> --expect <plan-execution-token> --operation <id> [--json]
mstar plan reconcile          --session-ref <coordinator-wire> --plan <id> --handoff <id> --expect <plan-execution-token> --operation <id> [--json]

# pre-activation only (same verbs, file route)
mstar plan prepare --session <coordinator-session> --plan <id> --assignment <absolute-md-path> --expect <revision> [--json]
# … and every other verb above with `--session <coordinator-session> --expect <revision>` instead of
#   `--session-ref/--expect/--operation`.
```

A stopped or unreachable coordinator is replaced **only** by `mstar session recover` under an independently acquired coordinator identity (named prior holder or explicit `--unowned`, stop attestation, the workflow's exact token, an operation id) — never by a copied reference, a restarted launcher or a hand edit.

1. **`prepare`** registers the reviewed Assignment on a `Todo`/`Blocked` row after checking path, branch, status and lock inputs and after dependency readiness. It is preparation, not a second business plan; dependency and task-readiness judgment stays PM's.
2. **`accept`** is ownership transfer, not integration acceptance: `submitted → accepted`, `execution_lease.holder` moves to the coordinator while worktree/branch stay. No merge, no `Done`.
3. **`return`** restores the original plan session as execution holder, sets `InProgress` and records the reason. It cannot return an un-reconciled integrating/merged/completed record: abort the Git merge, `reconcile` to `retry-ready`, then `return`.
4. **`integration-start`** reads the clean recorded integration checkout on `snapshot.branch.integration`, refuses any foreign merge lease, and pins the integration HEAD as `base_sha` plus the source pin — all **before** Git runs. Retrying a started attempt is a no-op after a revision refresh; `base_sha` never moves.
5. **Git merge is the coordinator's own explicit action**, the only Git mutation in this flow:

   ```bash
   git -C <integration-worktree-path> merge --no-ff --no-edit <pinned-source-sha>
   ```

   Argument-array invocation, never shell interpolation; no squash, no rebase, no moving branch-name merge. CLI state verbs never execute this merge.
6. **`integration-accept`** records the observed verified result（`integrating → merged`）and keeps both leases and `InReview`. Then **`complete`** performs the single atomic completion: verified Git proof + evidence + findings gate → `status: Done`, retain `metadata.working_branch` / `metadata.worktree_path` / existing track branches, and delete the row `execution_lease` **and** the coordinator's `integration_merge_lease` in **one** snapshot write.
7. **Crash recovery uses `reconcile` only** — never a caller-supplied success flag and never a second merge:

   | Observed state | `reconcile` result |
   |---|---|
   | `integrating`; HEAD == base; clean; source not yet an ancestor | back to `accepted`, drop the attempt + this holder's merge lease, keep coordinator execution lease and `InReview`; outcome `retry-ready` |
   | `integrating` or `merged`; source already ancestor, or unique exact merge proof is an ancestor of HEAD | record proof, apply the atomic completion; outcome `completed`; no duplicate merge |
   | `integrating`; `MERGE_HEAD` / conflicts / dirty checkout | refuse `coordination.integration-unresolved`; all state and leases preserved; resolve or explicitly abort Git, then re-run |
   | moved/missing branch, unexpected parent graph, multiple matching results, changed evidence | refuse `coordination.integration-diverged` / `coordination.evidence-stale`; no `Done`, no lease release |
   | `completed`; proof still valid | read-only no-op `already-completed` |

8. The coordinator — not the plan session — retains dependency release, compass / index / root projections, the iteration PR, and Phase 3–6.

## 7. Revision / token protocol（`--expect`）

- **Active:** `--expect` is the addressed scope's **full execution token**（`exec-v1:<kind>:<store-id>:<epoch>:<key64>:<revision>`）read immediately before the call — `mstar status validate` prints the root and per-workflow tokens and a scope read returns its own. A revision integer is a usage refusal on this route, never coerced.
- **Pre-activation:** `--expect` is the nonnegative row `coordination.revision` from `show`（absent coordination = 0）— **not** the snapshot `schema_version` or a date.
- Every mutating row verb requires its token on either transport. A sibling row's mutation does not change this row's token; same-row stale input fails `coordination.version-conflict`.
- After any successful changed row mutation the token advances **once**（active: a fresh token is printed on success）; a replayed operation id / no-op replay does not advance it. The precondition is still checked on replay, so a stale retry first refreshes with `show`.
- A fresh `bind` is the only exception（§2）. The snapshot byte version（`--expect-version`）and the issue revision（`--expect-issue`）are separate CAS values and never substitute for the row token.

## 8. Sessions and the credential boundary

- Fresh claims allocate a new session identity; a holder is never derived from a plan id, Assignment path, PID or terminal label. Assignment identity is not session identity.
- **The active reference is a lookup, not a bearer credential.** `exec-session-v1:<base64url>` names a stored session row and grants nothing by itself: the engine compares the independently acquired caller inside its own transaction, so a copied or stale reference refuses without writing. A token (`--expect`) and an operation id are CAS/replay values, not secrets that confer authority.
- **Nothing on this boundary travels into a child.** Never pass a session path, a session reference, a `--expect` value (revision or full execution token) or an operation id into a child Assignment or child invocation — coordinator or plan. Children receive the plan's `Worktree path`, `Working branch`, `Plan Path`, `SDD dir` and task-specific brief/report/diff paths only（`mstar-sdd/references/file-handoffs.md`）; a leaf that receives any of the above stops and reports it rather than using it.
- **Resume ≠ recovery.** A resume（active: `mstar plan bind --execution --resume-ref <wire>`; pre-activation: `--resume <absolute-json>`）validates the current session and lease and may report handed-off / accepted / completed context **read-only**. It never reacquires a released lease, never restarts execution, and never attaches to an active foreign holder automatically. Replacing a stopped owner is a separate, explicit act on the authority that owns it: `mstar session recover` (named prior holder or `--unowned`, stop attestation, exact token, operation id) on the active route, or the guarded Prepare recovery on the file route.
- A duplicate fresh entry for the same plan — by **either** address — fails with code `coordination.duplicate-holder` plus the active holder, workflow and plan. Only an explicit read-only resume of the original session continues；no automatic attach, fallback plan, TTL/idle/pane-state theft.
- Cross-primary references are readable **absolute control-root filesystem paths**；`local://` is not a portable handoff address.
- Lost credentials or an abandoned active owner need the explicit recovery verb above. No `--force`, takeover or automatic abandonment flag exists, and hand-editing a session file or a coordination document is never a path.

## 9. Evidence, STOP and failures

- Session todos and the final report stay **plan-scoped**: scoped checks / before-after pressure traces and the plan's own gates. Never claim whole-iteration evidence.
- STOP conditions: handoff submitted（§5）, invalid input（§1）, stale scope/token（§2/§7）, duplicate holder（§8）, un-reconciled Git（§6.7）, or a blocked dependency. Report the code, the holder, and the exact next command.
- Failures are reported from the CLI envelope（`ok:false` + `code`）, never invented: exit 2 = invalid input shape, exit 1 = scope / ownership / revision / state / Git / path / lock rejection.

## 10. Missing CLI = fail closed

The scoped route **requires** `mstar plan …`. Without it（engine/CLI absent or older than this contract）:

- **Fail closed with install/upgrade guidance**（name `mstar plan` and the required version or feature）.
- **Never** substitute raw snapshot/register edits, a prompt-only manual protocol, or the engine-absent legacy fallback for the scoped feature. `mstar-engine-legacy` does not provide it.
- Unscoped no-argument `iteration-drive` behavior is unchanged in that environment.

## 11. Transport（optional）

Herdr / tmux (or any multiplexer) is only a way to open a terminal. It is **not** a prerequisite, dependency, ownership signal or session identity. Nothing in this route reads pane state, TTL or terminal labels to decide ownership.

Where the active host reference declares an optional skill-driven extra-primary launch protocol (its native opt-in, its bind/checkpoint/reserve/record calls, non-focus pane creation at the prepared worktree, the absolute `--assignment` submission and terminal uncertainty handling), **`mstar-host`** → that reference's Phase-2 section is the only home for those calls; this file defines none of them. The protocol stays optional there too and adds no load-order dependency here.

Such a conditional extra-primary launch is available only for a plan row the coordinator has already registered **and** prepared, and whose feature worktree exists; a row that does not yet exist cannot be launched, because row admission closes with Phase 1. Registration and preparation are distinct row states — the launch precondition is a prepared row, never registration alone.
