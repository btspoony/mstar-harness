# Plan and workflow transport

This file carries the two coordination command families: scoped plan coordination (`plan`) and the guarded Prepare amendment plus standalone registration (`workflow`). They share one protocol — one document under a same-host write lock, one engine call per verb, the same token and failure discipline.

What lives elsewhere: field schemas, snapshot shape and lifecycle semantics belong to `mstar-artifacts`; phase semantics to `mstar-iteration`; checkout rules to `mstar-branch-worktree`. This file records only what command help cannot express — role boundaries, tokens, refusal codes, envelopes and sequence order.

## Session and address model

- `--session <absolute-json>` names an **engine-generated envelope**. It is never a caller-declared identity: the engine re-checks it against the document inside the write lock, so an envelope issued for another role, workflow or plan refuses instead of acting.
- There is no force flag, no holder or role argument, no takeover, and no lease-release verb. Ownership changes only through the accept / return / complete transitions.
- A plan session is bound to one plan; a coordinator session serves one workflow and is the only session allowed to amend, register, record evidence or close it. Coordinator bootstrap is trusted-local and limited to one per workflow.
- Two address forms reach the same prepared row: the pinned Assignment path, or the workflow + plan pair, which reads the row's registered Assignment path. A second fresh claim of the same row refuses with `coordination.duplicate-holder`, naming the live holder.
- A resume is read-only. It reports the current context; it never reacquires a released lease and never restarts execution.
- The bind verb is the only verb without a token: it reads, checks and claims atomically against current ownership.

## Verb → role boundary

| Session | Verbs |
|---|---|
| plan session | `mstar plan show`, `mstar plan progress`, `mstar plan residual-add`, `mstar plan residual-close`, `mstar plan handoff` |
| coordinator session | `mstar plan prepare`, `mstar plan accept`, `mstar plan return`, `mstar plan integration-start`, `mstar plan integration-accept`, `mstar plan complete`, `mstar plan reconcile`, `mstar plan repair-delivery-source`, `mstar workflow show-prepare`, `mstar workflow amend-prepare`, `mstar workflow evidence` |
| either (bootstrap / read / claim) | `mstar plan bind` |

A plan session mutates only its own row and its own register bucket. It never prepares itself: registration of the reviewed Assignment is the coordinator's act, and it is what releases the row's dependencies.

## Tokens

| Token | Where it comes from | Meaning |
|---|---|---|
| row revision | the show verb's machine output | `coordination.revision`; `0` while the row is not yet coordinated. Never the document schema version and never a date |
| register version | the same read | `absent` when that project register does not exist yet, otherwise the exact digest token of its bytes |
| handoff id | the same read | the row's *live* handoff; only the handoff verb mints one, and the read reports it once it exists |
| byte version | the versioned read face, or the amendment's read verb | `sha256:<64 lowercase hex>` over the exact bytes read — a document version, not a row revision |

Both the revision and the register version are **consumed** by the call that uses them. Read again after every successful mutation; a token carried across a write refuses rather than applying a stale edit.

## JSON envelopes

Machine output is a single object on stdout, with no color and no banner. In human mode stdout stays empty and the summary goes to stderr, so stdout can be piped without filtering.

Success carries the operation, the workflow and plan it applied to, the fresh revision, the document version, the session file and id, the role, and — where they apply — the handoff id, state and outcome. The read verb additionally returns the register version, the scope and the row.

Failure carries `ok: false`, the operation, a stable `code`, a message, and whichever of workflow id, plan id, holder, path, expected and actual the refusal can name. The refusal object is the contract; the message is for humans.

## Refusals

All plan and workflow refusals are mutation-free: the authoritative bytes are unchanged, and the fix is to read again — not to escalate to a force flag, which does not exist.

| Code | When |
|---|---|
| `coordination.session-role` | the envelope is not the role that verb requires (a plan session cannot prepare, accept or complete) |
| `coordination.session-mismatch` | the envelope names a different document than the one resolved |
| `coordination.scope-mismatch` | the request reaches outside the session's scope |
| `coordination.workflow-not-found` | no snapshot for that workflow id under the resolved root |
| `coordination.not-prepared` | the workflow has no coordinator binding yet |
| `coordination.duplicate-holder` | a second fresh claim of an already-held row, or of an already-bound coordinator |
| `coordination.handoff-mismatch` | the handoff flag names something other than the row's live handoff |
| `coordination.invalid-transition` | the proposed document fails validation for the requested transition |
| `coordination.git-unavailable` | a Git-derived fact the verb needs cannot be established |
| `coordination.expected-version-required` / `coordination.version-conflict` | a coordinate write without a token, or with one that no longer matches the bytes |
| shared lock failure | another writer holds the same-host lock |

## Completion sequence

The plan session hands off; the coordinator drives the rest. The engine selects **one of two routes** from the workflow's own type and delivery kind — never inferred from anchors that happen to be absent.

| Route | When | After `accept` | What `complete` does |
|---|---|---|---|
| **Iteration** | `type: iteration`, or any non-standalone workflow | `integration-start` → the operator's pinned `git merge --no-ff` in the recorded integration checkout → `integration-accept` → `complete` | Done, the handoff completed, and **both** leases released — the row's execution lease and the workflow's integration-merge lease |
| **Standalone development** | `type: plan` with `delivery_kind: development` owning exactly one row | `complete` straight from the accepted handoff — no integration verb, no merge record | Done and the handoff completed with no integration record; only the row's execution lease is released, and the workflow stays running until its delivery evidence and the close |

Common prefix: **handoff** (plan side, leaves the row InReview) → **accept** (ownership transfer, not integration acceptance). Each command needs a token read from the immediately preceding state, and Git is the operator's action, never a side effect of a verb.

| Step | Session | What it records | Notes |
|---|---|---|---|
| handoff | plan | the immutable pinned handoff; the row stays InReview | the plan's finish line; execution ownership has not moved yet |
| accept | coordinator | execution ownership transfers to the coordinator | no merge happens here; this is ownership, not integration acceptance |
| integration-start | coordinator | the integration attempt and its pinned base, before any Git runs | **iteration route only**; reads the clean recorded integration checkout and refuses a foreign merge lease — the attempt is pinned *before* Git so a crash mid-merge stays reconcilable |
| merge | operator | the merge itself | **iteration route only**; an explicit pinned merge in the recorded integration worktree |
| integration-accept | coordinator | verified evidence of the pinned Git result | **iteration route only**; never runs a merge and never completes the row |
| complete | coordinator | Done, atomically | the last step of **either** route: it releases only the row's execution lease on the standalone route, and both leases on the iteration route |
| return / reconcile | coordinator | a failed attempt / crash recovery | `return` restores the plan owner; `reconcile` observes Git and finishes the iteration attempt without a second merge — on the standalone route it only replays an already-completed row |
| repair-delivery-source | coordinator | a corrected `branch.source` only | **not a normal step**: a pre-fix-snapshot exception for a registered source that wrongly equals the target, derived from the sealed accepted handoff, never replayable |

A retried start never moves the recorded base; that is what makes the pinned attempt, not the retry, the unit of recovery.

Walkthrough with synthetic ids — a plan session drives its own row, the coordinator drives the lifecycle, and each token is read from the state the previous step left:

```sh
# coordinator: bootstrap once per workflow, in the main worktree
mstar plan bind --coordinator --workflow wf-demo --json

# coordinator: register the reviewed Assignment (revision 0 = not yet coordinated)
mstar plan prepare --session <coordinator-session.json> --plan plan-a \
  --assignment <control-root>/sdd/plan-a/assignment.md --expect 0 --json

# plan session: read scope, revision and the operations allowed right now
mstar plan bind --workflow wf-demo --plan plan-a --json
mstar plan show --session <plan-session.json> --json

# plan session: mutate only this row, then hand off
mstar plan progress --session <plan-session.json> --file progress.json --expect <revision> --json
mstar plan residual-add --session <plan-session.json> --file entries.json --expect <revision> --expect-register absent --json
mstar plan handoff --session <plan-session.json> --file handoff.json --expect <revision> --json

# coordinator: ownership
mstar plan accept --session <coordinator-session.json> --plan plan-a --handoff <live-handoff-id> --expect <revision> --json

# iteration route only: pin the attempt, merge, verify the pinned result
mstar plan integration-start --session <coordinator-session.json> --plan plan-a --handoff <live-handoff-id> --expect <revision> --json
git merge --no-ff --no-edit <source-sha>
mstar plan integration-accept --session <coordinator-session.json> --plan plan-a --handoff <live-handoff-id> --expect <revision> --json

# both routes end here; a standalone development plan reaches this line straight from accept
mstar plan complete --session <coordinator-session.json> --plan plan-a --handoff <live-handoff-id> --expect <revision> --json
```

The failure object at any step names the code; the row is unchanged, so the retry starts from a fresh read of the same row rather than from the step that failed.

## Prepare amendment

The amendment family is the only lawful way to register an approved scope expansion on a workflow that already exists. It is not a scheduler and not a general document replacement.

- The read verb is read-only: no lock, no write. It returns both byte versions — the snapshot's and the reviewed compass Markdown's — plus an admission view. An inadmissible lifecycle state is reported as data (`allowed: false` with one reason line per blocker), not as an error, so a workflow can be inspected before deciding.
- The amend verb requires **both** byte versions, even on the first amendment. They are byte versions, never row revisions; the bare hex form is also accepted.
- The patch names the main worktree branch and the rows to append, and may record the integration checkout and the plan parallelism. Appended rows are constructed by the engine — a patch never carries runtime row fields. Every existing row and unknown field survives by value; nothing is created, switched, fetched or cleaned.
- Refusals are specific and mutation-free: a stale token, a workflow that is not in Prepare or whose root entry is not running, evidence that execution has already started, a duplicate or malformed appended plan, an unknown or no-op patch key, a plan set or integration branch the reviewed compass does not declare, or a supplied integration checkout that fails validation. Auth and scope refusals reuse the shared codes above.
- Stop condition: a stale token is recovered by reading again and reviewing the new bytes, then amending with the fresh tokens. There is no force, replace, init or fallback flag, and no replacement-document path.

Walkthrough with synthetic ids:

```sh
# coordinator: read the admission view and both byte versions (no lock, no write)
mstar workflow show-prepare --session <coordinator-session.json> --json
# -> {..., "snapshot_version": "sha256:<hex>", "compass_version": "sha256:<hex>",
#     "plan_ids": ["plan-a"], "allowed": true, "blockers": []}

# coordinator: apply the approved delta with exactly those tokens
mstar workflow amend-prepare --session <coordinator-session.json> \
  --expect-snapshot sha256:<hex> --expect-compass sha256:<hex> --input patch.json --json
```

A read that reports `allowed: false` is an answer, not a failure: fix the blocker (or abandon the amendment) before spending the tokens. A refusal from the amend step leaves every document byte-identical, so the next attempt starts from a new read.

## Standalone plan registration and delivery evidence

- Registration is create-only: it writes the workflow snapshot and the root register entry under one lock, recording the owned plan row, the project, the declared delivery kind and the branch anchors. The delivery kind is **declared, never inferred**, and each kind requires its own evidence declaration at registration. Re-running after a crash between the two writes recovers: existing snapshot bytes are kept and only the root entry is written.
- Delivery evidence is recorded stage by stage: a payload is merged into the snapshot's delivery block under the snapshot lock. The PR identity is recorded once and pinned to the registered branch anchors; a conflicting anchor is refused rather than overwritten. Declaring the kind of an older kind-less snapshot is a one-time act and refuses a terminal snapshot.
- Both verbs are authorized like the close: a coordinated workflow's document is written only for its own bound coordinator envelope; otherwise the call refuses without changing bytes.
- A registered `branch.source` cannot be amended by ordinary evidence: the evidence verb merges only the delivery block, and the one-time kind declaration refuses a value that conflicts with an already-registered anchor. The single exception is the legacy repair verb, which replaces **only** `branch.source` on a pre-fix snapshot whose registered source wrongly equals its target, derived from the sealed accepted handoff — it records no Done, no delivery success and no remote merge, and it is not a general anchor editor.
- The close consults this evidence *before* writing the terminal state, so a gate and the close can never disagree. Close order, refusal conditions and the root unregister: `references/status-and-registers.md`.

## Exit codes

| Code | When |
|---|---|
| `0` | the operation succeeded, including an idempotent no-op and a read-only resume |
| `1` | engine refusal — every code above, always with no change to authoritative bytes |
| `2` | usage: missing or mixed address forms, unknown flag, a token that is neither the absent literal nor a version token, a non-numeric revision, a relative path where an absolute one is required, an unreadable or unparseable payload file |
