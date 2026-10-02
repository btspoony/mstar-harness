# Plan and workflow transport

This file carries the two coordination command families: scoped plan coordination (`plan`) and the guarded Prepare amendment plus standalone registration (`workflow`). They share one protocol — one document under a same-host write lock, one engine call per verb, the same token and failure discipline.

What lives elsewhere: field schemas, snapshot shape and lifecycle semantics belong to `mstar-artifacts`; phase semantics to `mstar-iteration`; checkout rules to `mstar-branch-worktree`. This file records only what command help cannot express — role boundaries, tokens, refusal codes, envelopes and sequence order.

<<<<<<< HEAD
Normal route: select the intended active DB verb from current help, invoke it with required inputs, and inspect its receipt. Do not interpose a mandatory top-down `persist`/rebind/repair ladder merely to replay normal progress. Active writes use the session reference, full execution token for the addressed scope, and operation id. Acquire the required current token from the authoritative read. `applied` and `replayed` are receipt outcomes; preserve components already applied only where the verb documents action-local partial semantics.
=======
Normal route: choose the intended public verb from current help and invoke it with its required inputs; inspect the receipt before deciding what remains. Do not interpose a mandatory top-down `persist`/rebind/repair ladder merely to replay normal progress. A refusal names the missing non-derivable input or conflict: active plan writes take the session reference, the caller's independently acquired `--session-id`/`sessionId` and the caller-owned operation id — the execution token is supplied only as an explicit constraint, and on plan operations an omitted one is derived by the engine from the plan's own read (verified for plan operations); workflow-level active writes (recovery, registration, evidence) still state the scope's full execution token as `--expect`; pre-activation writes take the session envelope and row revision; a fresh plan-PM bind takes explicit operator `--session-id`, and a fresh active bind additionally states the full execution token and the operation id (the pre-activation bind is the token-free form). An explicitly held token is never guessed — it is forwarded unchanged as the CAS comparison value. `applied` and `replayed` are receipt outcomes; preserve components already applied only where the verb documents action-local partial semantics (for example, an integration-start retry no-op). Foreign ownership or stop authorization remains an operator decision; never forward credentials to a leaf.
>>>>>>> origin/main

Payload discovery: `mstar-harness schema PlanProgress` describes `plan progress` JSON and `mstar-harness schema HandoffEvidence` describes `plan handoff` JSON, including nested QC/QA fields. Build a complete JSON object from the schema before invoking `--file`; the CLI accepts an absolute JSON file, not a one-field-at-a-time trial. Actor identity and the intended operation/target remain operator inputs; a public action does not supply the caller's session reference, token or operation id. Historical `submit` is not a plan verb: bounded non-authoritative advice is `mstar-harness judgment review-advice` with its own help and review-pack input, not a lifecycle submission.

## Transports

The execution route is selected by `execution_meta.authority_state`, not by `store_meta.authority_state`: `store_meta` governs issue/catalog authority, while `execution_meta` governs coordinated workflow operations. Use `mstar status validate` as the discriminating read. Its `state` is `active`, `legacy`, or `unreadable`: `active` is the supported operating route; `legacy` is unsupported and resolves `upgrade.entry` per observed files—an existing store uses `mstar store safe-upgrade`; legacy files without a store use `mstar store init` → `mstar store safe-upgrade`, which keeps the files authoritative until the upgrade confirmation and imports them during the authority switch; a truly empty workspace uses `mstar harness scaffold`. `unreadable` reports what could not be read and the recovery needed to make it readable.

<<<<<<< HEAD
| State | Supported action |
|---|---|
| `active` | Use the active DB route below. |
| `legacy` | Do not use file-form operation flags; follow this read's `upgrade.entry`. A storeless legacy workflow uses the init-then-safe-upgrade sequence; files remain authoritative until upgrade confirms and activates. |
| `unreadable` | Follow the reported self-check recovery, then rerun `mstar status validate`. |

## Active transport

The active DB route is the sole supported route for normal coordinated operations:

| Write flags | Caller identity |
|---|---|
| `--session-ref <wire>` + `--expect <full execution token>` + `--operation <id>` | Independently acquired for this invocation: never a flag, never read from a session file, never carried by the reference |

- The reference is a lookup, not a bearer credential: it names a stored session row and grants no authority without the independently acquired caller.
- `mstar status validate` reports the root and per-workflow tokens when state is active; `mstar plan show` reports the addressed plan token. Use the token matching the mutation scope.
- Legacy file-form operation routes are retired; their flags are not a supported alternative to the active route.
=======
| Transport | Write flags | Caller identity |
|---|---|---|
| **Active** (execution authority active) | `--session-ref <wire>` + `--operation <id>` + the caller's independently acquired `--session-id`/`sessionId`; `--expect <full execution token>` on workflow-level writes and on a fresh active bind — plan mutations may omit it (the engine derives the current token from the plan's own read) | **independently acquired** for this invocation — never read from a session file, never carried by or derived from the reference; the CLI/MCP transports carry no ambient identity, so it is supplied per call as the verbs' own `--session-id`/`sessionId` |
| **Pre-activation** (file route, only while that authority is not active) | `--session <absolute-json>` + `--expect <revision>`; a fresh operator coordinator bootstrap also states `--session-id <id>` | the role-scoped envelope obtained from the bind verb, re-checked against its document inside the write lock |

- The two flag sets are **disjoint**. A mixed invocation, a missing active address/operation input or a session path on the active route is a usage refusal (exit 2) decided before any IO. A numeric `--expect` is never coerced into an execution token: on the active plan route it reaches the engine's token check and refuses there as a genuine CAS fact; pre-activation, it is the row revision. An active flag another verb owns is an unknown option, never ignored input.
- On a harness whose execution authority is **active**, the pre-activation forms are retired rather than reinterpreted: they refuse with `execution.consumer-not-ready`, whose message names the active form of the same verb. `mstar plan show --workflow <id> --plan <id>` stays the public authoritative read against that authority, and `mstar status validate` reports the root and per-workflow execution tokens the active writes consume as their CAS — on plan mutations a caller states `--expect` only when holding the token as an explicit constraint — otherwise the engine reads it itself; workflow-level active writes state the scope's full token, and an invented token is never valid.
>>>>>>> origin/main
- The **reference is a lookup, not a bearer credential**: it names a stored session row, grants no authority by itself, and the engine compares the independently acquired caller inside its own transaction — so a copied reference under another identity refuses without writing.
- Launching: `mstar session run --workflow <id> --role <coordinator|plan-pm> [--plan <id>] [--harness <absolute-path>] -- <argv>` mints **one** local identity for the child, overwrites the identity channel, deletes the legacy one, and propagates the child's exit code (or re-raises the signal that killed it). Repeated CLI invocations inside that child share the identity; a **new** launcher is a new identity and cannot claim the old one — a stopped owner needs the explicit recovery verb (→ § Recovery), never a copied id.

## Session and address model

<<<<<<< HEAD
- A plan session is bound to one plan; a coordinator session serves one workflow and is the only session allowed to amend, register, record evidence or close it. Coordinator identity is independently acquired and limited to one coordinator per workflow.
- Two address forms reach the same prepared row: the pinned Assignment path, or workflow + plan, which reads the row's registered Assignment path. A second fresh claim refuses with `coordination.duplicate-holder`.
- Active resume is read-only: `mstar plan bind --execution --resume-ref <wire>` reports current context; it never reacquires a released lease, restarts execution, or re-identifies the caller. Resume is never recovery.
- A fresh active bind requires `--expect <full execution token>`, `--operation <id>`, and independently acquired runtime session identity: coordinator binds use the workflow token; plan-PM binds use the plan token. It checks and claims atomically against current ownership. Active resume is read-only and token-free.
=======
- **Pre-activation only:** `--session <absolute-json>` names an **engine-generated envelope**. It is never a caller-declared identity: the engine re-checks it against the document inside the write lock, so an envelope issued for another role, workflow or plan refuses instead of acting.
- There is no force flag, no holder or role argument, no takeover, and no lease-release verb. Ownership changes only through the accept / return / complete transitions.
- A plan session is bound to one plan; a coordinator session serves one workflow and is the only session allowed to amend, register, record evidence or close it. Coordinator bootstrap is limited to one per workflow and always requires an **explicitly acquired** identity — the engine never generates a coordinator id. Pre-activation, a plain local operator states `--session-id` and a managed host bootstraps through its own host-owned entry instead of the shell (→ the active host reference under `mstar-host`); on the active route the identity is acquired for the invocation and, because the CLI/MCP transports carry no ambient identity, it is supplied per call as the verbs' own `--session-id`/`sessionId` — never derived from the session reference.
- Two address forms reach the same prepared row: the pinned Assignment path, or the workflow + plan pair, which reads the row's registered Assignment path. A second fresh claim of the same row refuses with `coordination.duplicate-holder`, naming the live holder.
- A resume is read-only on **both** transports — `mstar plan bind --execution --resume-ref <wire>` (active; the reference carries its own whole scope and the call takes no `--expect`) or `mstar plan bind --resume <absolute-json>` (pre-activation). It reports the current context; it never reacquires a released lease, never restarts execution, and never re-identifies the caller. **Resume is never recovery.**
- A fresh **bind** reads, checks and claims atomically against current ownership. A fresh **active** bind states the full execution token together with the independently acquired session identity and the caller-owned operation id (`plan bind --execution` refuses without them); the **pre-activation** bind is the token-free form. Plan **mutations** may equally omit the execution token — the engine derives it from the plan's own read (verified for plan operations) — while workflow-level writes state it as `--expect`.
>>>>>>> origin/main

## Recovery (active coordinator replacement)

While the execution authority is active, an abandoned or unreachable coordinator is replaced by exactly one verb, under an independently acquired coordinator identity:

```sh
mstar session recover --workflow <id> (--prior-session <id> | --unowned) --reason <text> \
  --attestation <absolute-json> --expect <full-execution-token> --operation <id> [--harness <absolute-path>] [--json]
```

- The prior holder is **named** — or `--unowned` when the workflow records none; the two are mutually exclusive and neither is guessed. The stop attestation must name that holder stopped/reloaded, the workflow's **exact** execution token is the CAS, and the operation id is the replay key.
- Recovery is active DB only. Pre-activation Prepare recovery is retired; do not use file/JSON snapshot forms.
- `authorizationRef` is an audit reference, not an authorization source: it MUST identify a real external authorization event (explicit user/operator instruction or confirmation). An agent MUST NOT synthesize it from its own task or assignment.

## Verb → role boundary

| Session | Verbs |
|---|---|
| plan session | `mstar plan show`, `mstar plan progress`, `mstar plan issue-add`, `mstar plan issue-close`, `mstar plan handoff` |
| coordinator session | `mstar plan prepare`, `mstar plan accept`, `mstar plan return`, `mstar plan integration-start`, `mstar plan integration-accept`, `mstar plan complete`, `mstar plan reconcile`, `mstar plan repair-delivery-source`, `mstar workflow evidence` |
| either (active bootstrap / read / claim) | `mstar plan bind` |

A plan session mutates only its own row and the issues that row's plan captures or closes; the retired register bucket is never a write target. It never prepares itself: registration of the reviewed Assignment is the coordinator's act, and it is what releases the row's dependencies.

## Tokens

| Token | Where it comes from | Meaning |
|---|---|---|
| Root execution token | `mstar status validate` → `.token` | `root` token; used only for new workflow registration |
| Workflow execution token | `mstar status validate` → matching `.workflows[]` entry, or an authoritative workflow read | `workflow` token; used only for that workflow |
| Plan execution token | `mstar plan show` → addressed plan | `plan` token; used only for that plan |
| operation id (**active replay key**) | the caller | caller-supplied id of this one operation: an exact retry replays the recorded receipt, a changed request against the same id refuses |
| session reference (active address) | the active bind or recovery result: `exec-session-v1:` + base64url of canonical JSON `{storeId, epoch, workflowId, role, sessionId, planId}` | stored session-row address; not a bearer credential |
| issue revision | the scoped capture's report, or the read verb | the DB mutation's CAS value for one issue; `plan issue-close` takes it as `--expect-issue` |
| handoff id | the same read | the row's live handoff; only the handoff verb mints one |
| byte version | retired file-route comparison value; not an execution token or a supported mutation credential |

Every token is **consumed** by the call that uses it. Read again after every successful mutation; a token carried across a write refuses rather than applying a stale edit.

## JSON envelopes

Machine output is a single object on stdout, with no color and no banner. In human mode stdout stays empty and the summary goes to stderr, so stdout can be piped without filtering.

Success carries operation/workflow/plan scope, the fresh token, store id, epoch, operation id, replay flag, role and applicable handoff/state/outcome. Read verbs return their applicable scope and row; active resume carries no mutation receipt.

Failure carries `ok: false`, the operation, a stable `code`, a message, and whichever of workflow id, plan id, holder, path, expected and actual the refusal can name. The refusal object is the contract; the message is for humans. A usage-class failure of the active transport is reported in the same shape, and no diagnostic echoes a legacy envelope body or the identity-channel payload.

## Refusals

Refusal commit-state is action-local: read the receipt instead of assuming. On the coordinated plan route a refused operation is transactional — no row, receipt or counter change (verified there) — so its recovery is a fresh read, never an undo; where a verb documents action-local partial application, committed components stay committed and only the documented remaining action is replayed. There is no force flag to escalate to.

| Code | When |
|---|---|
<<<<<<< HEAD
| `execution.consumer-not-ready` | the retired file-form writer was attempted against the active authority; nothing was written, the message identifies active state and says no upgrade is required |
| `execution.not-active` | the execution authority is not active; the refusal names the observed state and the sole supported upgrade entry |
| usage (exit 2) | a missing or mixed active flag set, a token kind that does not match the operation, an unsupported file-form flag, or no independently acquired identity in the identity channel |
| `coordination.identity-mismatch` | the acquired caller does not address the workflow / role / plan named by the session reference — a copied or stale reference refuses without writing |
| `coordination.session-role` | the session is not the role required by the verb |
| `coordination.session-mismatch` | the session reference addresses a different document than the request |
=======
| `execution.consumer-not-ready` | a **pre-activation** form on a harness whose execution authority is ACTIVE: nothing was written, and the message names the active form of the same verb |
| usage (exit 2) | a missing or mixed active address/operation set (`--session-ref` / `--operation`), a missing independently acquired identity (`--session-id`/`sessionId` on the CLI/MCP transports), a pre-activation route without a nonnegative row revision, or an active route that also states `--session` / `--resume` |
| `coordination.identity-mismatch` (active) | the acquired caller does not address the workflow / role / plan the reference names — a **copied or stale reference** refuses here without writing |
| `coordination.session-role` | the envelope is not the role that verb requires (a plan session cannot prepare, accept or complete) |
| `coordination.session-mismatch` | the envelope names a different document than the one resolved |
>>>>>>> origin/main
| `coordination.scope-mismatch` | the request reaches outside the session's scope |
| `coordination.workflow-not-found` | no workflow for that id under the resolved root |
| `coordination.not-prepared` | the workflow has no coordinator binding yet |
| `coordination.identity-missing` / `coordination.identity-mismatch` | a coordinator bootstrap lacks an explicitly acquired identity, or the identity does not address the requested workflow / role / plan scope |
| `coordination.duplicate-holder` | a second fresh claim of an already-held row, or of an already-bound coordinator |
| `coordination.handoff-pin` | the handoff flag names something other than the row's live handoff |
| `coordination.invalid-transition` | the proposed document fails validation for the requested transition |
| `coordination.handoff-state` | a plan session attempts a transition while a non-returned handoff owns the plan |
| `coordination.handoff-missing` | a handoff transition is requested when no handoff exists |
| `coordination.execution-lease-required` | an operation requires a valid active execution lease, but lease validation fails |
| `coordination.prepare-already-prepared` | prepare is attempted on an already-prepared row |
| `coordination.prepare-session-bound` | prepare is attempted after another session is bound (non-claimant) |
| `coordination.prepare-handoff-active` | prepare is attempted after a handoff exists |
| `coordination.prepare-status` | prepare is attempted when the row is not Todo or Blocked |
| `coordination.progress-phase` | progress is attempted from a status with no progress transitions (including absent status) |
| `coordination.progress-transition` | the requested progress status edge is not allowed from the current status |
| `coordination.plan-status` | a transition requires a particular current row status, but the row differs |
| `coordination.workflow-not-running` | a plan operation is attempted when the lifecycle is not running |
| `coordination.merge-lease-foreign` | a merge lease claims another plan/source attempt and must not be reused or released |
| `coordination.merge-lease-stopped-owner` | a merge lease belongs to an inactive/stopped session; only reconcile may act |
| `coordination.findings-open` | completion or transition is blocked because findings remain open |
| `coordination.completion-frozen` | completion delivery fulfilment is frozen after an owned plan reaches Done |
| `coordination.git-unavailable` | a Git-derived fact the verb needs cannot be established |
| `coordination.expected-version-required` / `coordination.version-conflict` | a coordinate write without a token, or with one that no longer matches the bytes |
| shared lock failure | another writer holds the same-host lock |

## Completion sequence

The plan session hands off; the coordinator drives the rest. The engine selects **one of three routes** from the workflow's own type and delivery kind — never inferred from anchors that happen to be absent.

| Route | When | After `accept` | What `complete` does |
|---|---|---|---|
| **Iteration** | `type: iteration`, or any non-standalone workflow | `integration-start` → the operator's pinned `git merge --no-ff` in the recorded integration checkout → `integration-accept` → `complete` | Done, the handoff completed, and **both** leases released — the row's execution lease and the workflow's integration-merge lease |
| **Standalone development** | `type: plan` with `delivery_kind: development` owning exactly one row | `complete` straight from the accepted handoff — no integration verb, no merge record | Done and the handoff completed with no integration record; only the row's execution lease is released, and the workflow stays running until its delivery evidence and the close |
| **Standalone report-only** | `type: plan` with `delivery_kind: verification/report-only` owning exactly one row | record the fulfilment of the registered completion policy, then `complete` straight from the accepted handoff — no integration verb, no merge record | Done and the handoff completed with no integration record; only the row's execution lease is released, and the workflow stays running until the close |

Common prefix: **handoff** (plan side, leaves the row InReview) → **accept** (ownership transfer, not integration acceptance). Invoke the intended public action under the correct actor with its required session address and operation id — the current expectation only as an explicitly held constraint, since plan operations derive it — then inspect its receipt; use a refusal to identify a missing input or conflict rather than running a mandatory preflight ladder. Explicit pinned Git merge is the operator's action, never a verb side effect.

| Step | Session | What it records | Notes |
|---|---|---|---|
| handoff | plan | the immutable pinned handoff; the row stays InReview | the plan's finish line; execution ownership has not moved yet |
| accept | coordinator | execution ownership transfers to the coordinator | no merge happens here; this is ownership, not integration acceptance |
| integration-start | coordinator | the integration attempt and its pinned base, before any Git runs | **iteration route only**; reads the clean recorded integration checkout and refuses a foreign merge lease — the attempt is pinned *before* Git so a crash mid-merge stays reconcilable |
| merge | operator | the merge itself | **iteration route only**; an explicit pinned merge in the recorded integration worktree |
| integration-accept | coordinator | verified evidence of the pinned Git result | **iteration route only**; never runs a merge and never completes the row |
| completion evidence | coordinator | the fulfilment of the registered `completion_policy` (policy + evidence) | **report-only route only**, and it comes *before* Done: the completion step refuses an absent, empty or nonmatching fulfilment, so the row cannot be marked Done on a policy nothing fulfilled |
| complete | coordinator | Done, atomically | the last step of **every** route: it releases only the row's execution lease on both standalone routes, and both leases on the iteration route |
| return / reconcile | coordinator | a failed attempt / crash recovery | `return` restores the plan owner; `reconcile` observes Git and finishes the iteration attempt without a second merge — on either standalone route it only replays an already-completed row |
| repair-delivery-source | coordinator | a corrected `branch.source` only | **not a normal step**: a pre-fix-snapshot exception for a registered source that wrongly equals the target, derived from the sealed accepted handoff, never replayable |

A retried start never moves the recorded base; that is what makes the pinned attempt, not the retry, the unit of recovery.

The handoff is a **byte-level pin**, not just a pointer: the digest of every report it names is taken at submission, so a cited report that changes afterwards — even by appending a section — refuses the completion step with a stale-evidence code. Finalize the QC and QA reports before handing off. When a report genuinely must change after a handoff, `return` the handoff, re-sign it against the new bytes, and let the coordinator `accept` again; there is no way to complete against the old pin.

### Intent-first walkthrough

<<<<<<< HEAD
The plan PM submits final handoff evidence (`mstar-harness schema HandoffEvidence`); the coordinator accepts it and follows the registered delivery kind. On the iteration route, start a pinned integration attempt, perform and verify the recorded Git merge, accept integration and complete. On standalone development, complete after accept; on report-only, record fulfilment of its registered policy before complete without inventing a Git step. Every supported write uses the active DB route, the scope-matched token, and an independently acquired identity; inspect the `applied` or `replayed` receipt. Do not turn those explicit inputs into a ceremonial top-down preflight ladder.
=======
The plan PM submits the final handoff evidence (`mstar-harness schema HandoffEvidence`); the coordinator accepts it and follows the registered delivery kind in the table above. On the iteration route, start a pinned integration attempt, perform and verify the recorded Git merge, accept integration and complete. On standalone development, complete after accept; on report-only, record fulfilment of its registered policy before complete without inventing a Git step. At each point consult current verb help and supply the required address for the active or pre-activation route — plan operations may omit `--expect` under the verified resolver (an explicitly held token stays a constraint), while workflow-level writes retain their documented expectation contract — and inspect the action's `applied`, `partial` or `replayed` receipt. Do not turn those explicit inputs into a ceremonial top-down preflight ladder. A foreign owner, missing independent actor identity or ambiguous target is still an action-local refusal; preserve completed independent components only where the verb documents partial-applied semantics.
>>>>>>> origin/main

The failure object at any step names the code; the row is unchanged, so the retry starts from a fresh read of the same row rather than from the step that failed.

## Retired file-route operations

<<<<<<< HEAD
Prepare amendments and coordinator recovery that use file snapshots, byte-version tokens, or session envelopes are not supported operating procedures in this release. When `mstar status validate` reports `state: legacy`, use only `mstar store safe-upgrade`; do not invoke pre-activation file forms. The migration entry is the forward-upgrade path and retains its reviewed safety barriers.
=======
The amendment family is the only lawful way to register an approved scope expansion on a workflow that already exists. It is not a scheduler and not a general document replacement. It belongs to the **pre-activation** side of the contract together with the JSON coordinator recovery below: `workflow show-prepare` and `workflow amend-prepare` are file-route forms whose byte tokens are document versions, not execution tokens, and an ACTIVE execution authority refuses them (`execution.direct-write-refused`, naming DB recovery where that is the repair).

- The read verb is read-only: no lock, no write. It returns both byte versions — the snapshot's and the reviewed compass Markdown's — plus an admission view. An inadmissible lifecycle state is reported as data (`allowed: false` with one reason line per blocker), not as an error, so a workflow can be inspected before deciding.
- The amend verb requires **both** byte versions, even on the first amendment. They are byte versions, never row revisions; the bare hex form is also accepted.
- The patch names the main worktree branch and the rows to append, and may record the integration checkout and the plan parallelism. Appended rows are constructed by the engine — a patch never carries runtime row fields. Every existing row and unknown field survives by value; nothing is created, switched, fetched or cleaned.
- It may also **correct the plan pointer of existing rows**: `correctPlanFiles` takes entries of exactly `{id, expectedFile, file}` and is the only way to repair a malformed stored pointer without hand-editing the snapshot. `appendPlans` stays present — a correction-only call passes an empty append array. A correction moves only the addressed row's `file` (plus the ordinary `updated_at`); metadata, frozen catalog pins, other rows and the review documents are untouched.
- **One pointer contract.** An appended or corrected `file` must resolve to that plan's canonical configured `{PLAN_DIR}/<plan-id>.md` with an unambiguous matching declared `plan_id`, under the same resolver registration uses. A canonical absolute path or a normalized **harness-relative** path is accepted; the repository-relative `.mstar/plans/<id>.md` spelling is refused before anything is written (it is a declared input form, not a fallback search base), and the canonical **absolute** pointer is what registration emits. A correction must additionally prove the pointer it replaces: `expectedFile` must equal the row's current `file` byte-for-byte **and** identify that same plan — either a form the resolver accepts or the exact repository-relative spelling derived from this control root's configured plan directory. Foreign absolute paths, same-basename guesses, unrelated directory prefixes, copied documents with a matching header and a no-op pointer all refuse.
- Refusals are specific and action-local to the amend: by the amend contract stated below, a refusal from the amend step leaves every document byte-identical — a stale token, a workflow that is not in Prepare or whose root entry is not running, evidence that execution has already started, a duplicate or malformed appended plan, an unknown or no-op patch key, a plan set or integration branch the reviewed compass does not declare, or a supplied integration checkout that fails validation. Auth and scope refusals reuse the shared codes above.
- Stop condition: a stale token is recovered by reading again and reviewing the new bytes, then amending with the fresh tokens. There is no force, replace, init or fallback flag, and no replacement-document path.

Walkthrough with synthetic ids:

```sh
# pre-activation (file route) only — an ACTIVE execution authority refuses these forms
# coordinator: read the admission view and both byte versions (no lock, no write)
mstar workflow show-prepare --session <coordinator-session.json> --json
# -> {..., "snapshot_version": "sha256:<hex>", "compass_version": "sha256:<hex>",
#     "plan_ids": ["plan-a"], "allowed": true, "blockers": []}

# coordinator: apply the approved delta with exactly those tokens
mstar workflow amend-prepare --session <coordinator-session.json> \
  --expect-snapshot sha256:<hex> --expect-compass sha256:<hex> --input patch.json --json
```

A read that reports `allowed: false` is an answer, not a failure: fix the blocker (or abandon the amendment) before spending the tokens. A refusal from the amend step leaves every document byte-identical, so the next attempt starts from a new read.

## Prepare coordinator recovery (pre-activation, JSON only)

`mstar workflow recover-coordinator` replaces the recorded coordinator binding of one Prepare workflow with an explicitly acquired session — the state a cancelled or unreachable owner leaves behind. It is **not** an alias for the active recovery (§ Recovery): that one runs against the execution authority under a full execution token and a stop attestation, while this one is file/JSON, Prepare-only, and narrows the effect to the top-level binding plus one audit record — no prepared-plan takeover, no lease transfer, no raw session rewrite and no force flag. Each authority keeps its own recovery; **resume is never recovery** on either.

- Flags: `--prior-session <absolute-json>` — **an input flag, never a projection**: the operator names the envelope the workflow records now, and it is also what supplies the workflow address. The host route resolves that stored envelope itself instead of taking a path; neither route ever accepts a credential path for the **replacement** session from the caller. Then `--session-id <id>` (the replacement, never generated) · `--expect-snapshot` / `--expect-compass` (both byte versions from `workflow show-prepare`) · `--operation-id` (the replay key) · `--reason` · `--authorization-ref` · `--stopped <session-id…>` (must name the recorded coordinator). A relative `--prior-session`, a malformed version token, a missing field or an empty stop assertion is a usage error (exit `2`) before any engine I/O.
- Guards, all inside the snapshot write lock: the prior envelope must still authenticate the **exact** recorded coordinator; the new identity must address this workflow's coordinator seat; the workflow must be a named, registered, running Prepare with a committed registration; every row must pass the original whole-workflow no-execution admission; both byte versions must be current; the stop assertion must name that holder. An **active execution authority** refuses and names the existing DB recovery instead of running this writer.
- Effect: the binding replaced, one immutable `coordination.identity_recoveries` audit record appended, `updated_at` refreshed. Rows, branch anchors, evidence and sibling workflows stay byte-identical; the prior envelope's bytes remain as history and stop authorizing because the binding moved.
- Replay: the same operation id with the same request against the current binding returns the recorded receipt (`replay: true`) without version churn; a changed request, a stale token or a superseded binding refuses. A failure between the envelope write and the snapshot commit is reported as a failure — never a success receipt — and reclaims only the exact envelope that operation created.
- **Output projection** — a different thing from the input flag above: the success JSON carries the workflow id, the old/new **public** session ids, the operation id, the replay flag and both byte versions only. It echoes **no** envelope path, envelope bytes or credential — an envelope path is coordinator-owned transport, never a public diagnostic. Naming the recorded envelope on the way *in* is required; reading one *out* of this verb is not part of its contract.

```sh
# pre-activation (JSON) Prepare recovery only
# coordinator: read both byte versions, then replace a binding its prior owner cannot authenticate
mstar workflow show-prepare --session <coordinator-session.json> --json
mstar workflow recover-coordinator --prior-session <recorded-coordinator-session.json> \
  --session-id <explicitly-acquired-id> --operation-id op-2026-09-21-1 --reason "<why the prior owner cannot authenticate>" \
  --authorization-ref "<operator authorization>" --stopped <recorded-session-id> \
  --expect-snapshot sha256:<hex> --expect-compass sha256:<hex> --json
```
>>>>>>> origin/main

## Standalone plan registration and delivery evidence

- Registration is create-only: it writes the workflow snapshot and root register under one lock, recording the owned plan row, project, delivery kind and branch anchors. The delivery kind is declared, never inferred. Supply `--plan-file plans/<id>.md` using a normalized harness-relative path; absolute paths and `.mstar/plans/<id>.md` are refused. The active creation call uses the root token from `mstar status validate` plus an operation id under an independently acquired identity; it takes no session reference because no session row exists before the workflow.
  Known issue I-000295: the catalog entity currently stores the harness-relative path duplicated (`plans/plans/<id>.md`); the execution lifecycle is unaffected, and the fix is tracked.
- Delivery evidence uses the active DB route and workflow-scope token. Legacy file-route forms are unsupported; on `state: legacy`, use only `mstar store safe-upgrade`.
- **Completion ordering per kind.** Development records compound disposition, PR identity and verified merge after every row is `Done`; report-only records fulfilment of its registered completion policy before `Done`. No merge or integration branch is synthesized for report-only.
- A registered `branch.source` is not amended by ordinary evidence; the legacy repair verb is not a general anchor editor. The close consults evidence before writing terminal state. See `references/status-and-registers.md` for close order and refusal conditions.

## Iteration workflow registration

An iteration does not go through `mstar workflow register`. It registers through `mstar iteration register` — the same create-only, one-lock contract and the same crash recovery (existing snapshot bytes kept, only the missing root entry written on re-run), and the same active root-token creation (`--expect <the store's root execution token>` + `--operation <id>`, no `--session-ref`) — with a compass ref, the three branch anchors and Todo plan rows in place of a delivery kind; no delivery kind or evidence declaration applies to it, and plan-row metadata is derived by the producer rather than supplied. Each row's plan pointer goes through the one registered-plan resolver and what gets stored is the **canonical absolute** `{PLAN_DIR}/<plan-id>.md`, never a copy of the caller's spelling: a canonical absolute or normalized harness-relative input is accepted, and the repository-relative `.mstar/plans/<id>.md` spelling is refused — before the first journal row, the snapshot or any root write. Lifecycle semantics: `mstar-artifacts`; flag set: the command help.

## Exit codes

| Code | When |
|---|---|
| `0` | the operation succeeded, including an idempotent no-op, a replayed operation id and a read-only resume |
<<<<<<< HEAD
| `1` | engine refusal — every code above, always with no change to authoritative bytes |
| `2` | usage: missing or mixed active flags, unknown flag, an unsupported retired file-form argument, a token of the wrong kind, a relative path where an absolute path is required, or an unreadable or unparseable payload |
=======
| `1` | engine refusal — every code above, returned with a stable code; the refusal's commit state is action-local, stated by that verb's result (on the coordinated plan route a refused operation writes no row, no receipt and no counter change) |
| `2` | usage: missing or mixed address forms, missing or mixed active address/operation inputs, unknown flag, an active route carrying a pre-activation flag, a token that is neither the absent literal nor a version token, a relative path where an absolute one is required, an unreadable or unparseable payload file |
>>>>>>> origin/main
