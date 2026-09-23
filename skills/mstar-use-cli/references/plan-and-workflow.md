# Plan and workflow transport

This file carries the two coordination command families: scoped plan coordination (`plan`) and the guarded Prepare amendment plus standalone registration (`workflow`). They share one protocol — one document under a same-host write lock, one engine call per verb, the same token and failure discipline.

What lives elsewhere: field schemas, snapshot shape and lifecycle semantics belong to `mstar-artifacts`; phase semantics to `mstar-iteration`; checkout rules to `mstar-branch-worktree`. This file records only what command help cannot express — role boundaries, tokens, refusal codes, envelopes and sequence order.

## Transports

One control harness has one execution authority, and that authority's state decides which transport every coordination verb takes. The **active DB route** is the canonical one; the file forms survive only while that authority is not active.

| Transport | Write flags | Caller identity |
|---|---|---|
| **Active** (execution authority active) | `--session-ref <wire>` + `--expect <full execution token>` + `--operation <id>` | **independently acquired** for this invocation: never a flag, never read from a session file, never carried by the reference |
| **Pre-activation** (file route, only while that authority is not active) | `--session <absolute-json>` + `--expect <revision>`; a fresh operator coordinator bootstrap also states `--session-id <id>` | the role-scoped envelope obtained from the bind verb, re-checked against its document inside the write lock |

- The two flag sets are **disjoint**. A mixed invocation, a partial active set, a numeric execution expectation or a session path on the active route is a usage refusal (exit 2) decided before any IO, and a revision integer is never coerced into an execution token. An active flag another verb owns is an unknown option, never ignored input.
- On a harness whose execution authority is **active**, the pre-activation forms are retired rather than reinterpreted: they refuse with `execution.consumer-not-ready`, whose message names the active form of the same verb. `mstar plan show --workflow <id> --plan <id>` stays the public authoritative read against that authority, and `mstar status validate` reports the root and per-workflow execution tokens the active writes consume as their CAS — a caller passes `--expect` from a read instead of inventing one.
- The **reference is a lookup, not a bearer credential**: it names a stored session row, grants no authority by itself, and the engine compares the independently acquired caller inside its own transaction — so a copied reference under another identity refuses without writing.
- Launching: `mstar session run --workflow <id> --role <coordinator|plan-pm> [--plan <id>] [--harness <absolute-path>] -- <argv>` mints **one** local identity for the child, overwrites the identity channel, deletes the legacy one, and propagates the child's exit code (or re-raises the signal that killed it). Repeated CLI invocations inside that child share the identity; a **new** launcher is a new identity and cannot claim the old one — a stopped owner needs the explicit recovery verb (→ § Recovery), never a copied id.

## Session and address model

- **Pre-activation only:** `--session <absolute-json>` names an **engine-generated envelope**. It is never a caller-declared identity: the engine re-checks it against the document inside the write lock, so an envelope issued for another role, workflow or plan refuses instead of acting.
- There is no force flag, no holder or role argument, no takeover, and no lease-release verb. Ownership changes only through the accept / return / complete transitions.
- A plan session is bound to one plan; a coordinator session serves one workflow and is the only session allowed to amend, register, record evidence or close it. Coordinator bootstrap is limited to one per workflow and always requires an **explicitly acquired** identity — the engine never generates a coordinator id. Pre-activation, a plain local operator states `--session-id` and a managed host bootstraps through its own host-owned entry instead of the shell (→ the active host reference under `mstar-host`); on the active route the identity is acquired for the invocation and `--session-id` is not an input at all.
- Two address forms reach the same prepared row: the pinned Assignment path, or the workflow + plan pair, which reads the row's registered Assignment path. A second fresh claim of the same row refuses with `coordination.duplicate-holder`, naming the live holder.
- A resume is read-only on **both** transports — `mstar plan bind --execution --resume-ref <wire>` (active; the reference carries its own whole scope and the call takes no `--expect`) or `mstar plan bind --resume <absolute-json>` (pre-activation). It reports the current context; it never reacquires a released lease, never restarts execution, and never re-identifies the caller. **Resume is never recovery.**
- A fresh **bind** is the only operation without a token: it reads, checks and claims atomically against current ownership.

## Recovery (active coordinator replacement)

While the execution authority is active, an abandoned or unreachable coordinator is replaced by exactly one verb, under an independently acquired coordinator identity:

```sh
mstar session recover --workflow <id> (--prior-session <id> | --unowned) --reason <text> \
  --attestation <absolute-json> --expect <full-execution-token> --operation <id> [--harness <absolute-path>] [--json]
```

- The prior holder is **named** — or `--unowned` when the workflow records none; the two are mutually exclusive and neither is guessed. The stop attestation must name that holder stopped/reloaded, the workflow's **exact** execution token is the CAS, and the operation id is the replay key.
- Success reports the new public session id, the operation id, the replay flag and the fresh token only. No envelope path, envelope body or credential is ever projected out of this verb.
- The pre-activation Prepare recovery (`mstar workflow recover-coordinator`, § Prepare coordinator recovery) is a **different, narrower** writer: file/JSON, Prepare-only, the top-level binding plus one audit record. Neither runs on the other authority, and neither accepts a caller-supplied credential for the **replacement** session.

## Verb → role boundary

| Session | Verbs |
|---|---|
| plan session | `mstar plan show`, `mstar plan progress`, `mstar plan issue-add`, `mstar plan issue-close`, `mstar plan handoff` |
| coordinator session | `mstar plan prepare`, `mstar plan accept`, `mstar plan return`, `mstar plan integration-start`, `mstar plan integration-accept`, `mstar plan complete`, `mstar plan reconcile`, `mstar plan repair-delivery-source`, `mstar workflow evidence` |
| coordinator session, **pre-activation only** | `mstar workflow show-prepare`, `mstar workflow amend-prepare` (§ Prepare amendment), `mstar workflow recover-coordinator` (§ Prepare coordinator recovery) |
| either (bootstrap / read / claim) | `mstar plan bind` |

A plan session mutates only its own row and the issues that row's plan captures or closes; the retired register bucket is never a write target. It never prepares itself: registration of the reviewed Assignment is the coordinator's act, and it is what releases the row's dependencies.

## Tokens

| Token | Where it comes from | Meaning |
|---|---|---|
| execution token (**active CAS**) | a read of the addressed scope: `mstar status validate` prints the root and per-workflow tokens, and a plan/workflow read returns that scope's own token | the full `exec-v1:<kind>:<store-id>:<epoch>:<key64>:<revision>` token of exactly the scope being written; a revision integer is a pre-activation input and is never coerced into one |
| operation id (**active replay key**) | the caller | caller-supplied id of this one operation: an exact retry replays the recorded receipt, a changed request against the same id refuses |
| session reference (active address) | the bind verb's result, encoded as `exec-session-v1:<base64url>` | a stored session row — a lookup that authorizes nothing without the independently acquired caller |
| row revision (**pre-activation**) | the show verb's machine output | `coordination.revision`; `0` while the row is not yet coordinated. Never the document schema version and never a date |
| issue revision | the scoped capture's report, or the read verb | the DB mutation's CAS value for one issue; `plan issue-close` takes it as `--expect-issue`, and it stays an integer on every transport |
| handoff id | the same read | the row's *live* handoff; only the handoff verb mints one, and the read reports it once it exists |
| byte version | the versioned read face, or the amendment's read verb | `sha256:<64 lowercase hex>` over the exact bytes read — a document version, not a row revision |

Every token is **consumed** by the call that uses it. Read again after every successful mutation; a token carried across a write refuses rather than applying a stale edit.

## JSON envelopes

Machine output is a single object on stdout, with no color and no banner. In human mode stdout stays empty and the summary goes to stderr, so stdout can be piped without filtering.

Success carries the operation, the workflow and plan it applied to, the scope's fresh token and — on the active route — the store id, epoch, operation id and replay flag. It also carries the fresh revision and the session file and id where those belong to the pre-activation transport, the role, and — where they apply — the handoff id, state and outcome. The read verb additionally returns the snapshot byte version, the scope and the row; a read-only resume carries no operation receipt fields at all.

Failure carries `ok: false`, the operation, a stable `code`, a message, and whichever of workflow id, plan id, holder, path, expected and actual the refusal can name. The refusal object is the contract; the message is for humans. A usage-class failure of the active transport is reported in the same shape, and no diagnostic echoes a legacy envelope body or the identity-channel payload.

## Refusals

All plan and workflow refusals are mutation-free: the authoritative bytes are unchanged, and the fix is to read again — not to escalate to a force flag, which does not exist.

| Code | When |
|---|---|
| `execution.consumer-not-ready` | a **pre-activation** form on a harness whose execution authority is ACTIVE: nothing was written, and the message names the active form of the same verb |
| usage (exit 2) | a missing, partial or mixed active flag set (`--session-ref` / `--expect` / `--operation`), a revision integer where a full execution token is required, an active route that also states `--session` / `--resume` / `--session-id`, or no independently acquired identity in the identity channel |
| `coordination.identity-mismatch` (active) | the acquired caller does not address the workflow / role / plan the reference names — a **copied or stale reference** refuses here without writing |
| `coordination.session-role` | the envelope is not the role that verb requires (a plan session cannot prepare, accept or complete) |
| `coordination.session-mismatch` | the envelope names a different document than the one resolved |
| `coordination.scope-mismatch` | the request reaches outside the session's scope |
| `coordination.workflow-not-found` | no workflow for that id under the resolved root |
| `coordination.not-prepared` | the workflow has no coordinator binding yet |
| `coordination.identity-missing` / `coordination.identity-mismatch` | a coordinator bootstrap without an explicitly acquired id (or a non-id value), or an id that does not address the workflow / role / plan scope |
| `coordination.identity-recovery.*` | the JSON Prepare coordinator recovery refused: `not-prepare`, `invalid-request`, `execution-started` (a row already owns execution), `foreign-owner`, `stale`, `unauthorized`, `operation-conflict` |
| `execution.direct-write-refused` | an **active execution authority**: the JSON recovery and the file route never run against it — the existing DB recovery verb owns that repair |
| `coordination.duplicate-holder` | a second fresh claim of an already-held row, or of an already-bound coordinator |
| `coordination.handoff-mismatch` | the handoff flag names something other than the row's live handoff |
| `coordination.invalid-transition` | the proposed document fails validation for the requested transition |
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

Common prefix: **handoff** (plan side, leaves the row InReview) → **accept** (ownership transfer, not integration acceptance). Each command needs a token read from the immediately preceding state, and Git is the operator's action, never a side effect of a verb.

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

Walkthrough with synthetic ids — a plan session drives its own row, the coordinator drives the lifecycle, and each token is read from the state the previous step left. This is the **active** transport: every write runs under an independently acquired identity, and every `--expect` is the scope's full execution token read immediately before the call.

```sh
# coordinator: one launcher mints this child's identity; the identity is never a flag
mstar session run --workflow wf-demo --role coordinator --harness <control-root> -- \
  mstar plan bind --execution --workflow wf-demo --coordinator \
    --expect <workflow-token> --operation bind-coordinator --json

# coordinator: register the reviewed Assignment on the row
mstar plan prepare --session-ref <coordinator-wire> --plan plan-a \
  --assignment <control-root>/sdd/plan-a/assignment.md \
  --expect <plan-token> --operation prepare-1 --json

# plan session: its own acquired identity, its own reference, then the scope read
mstar session run --workflow wf-demo --role plan-pm --plan plan-a --harness <control-root> -- \
  mstar plan bind --execution --workflow wf-demo --plan plan-a \
    --expect <plan-token> --operation bind-plan-pm --json
mstar plan show --session-ref <plan-pm-wire> --json          # session-authorized view
mstar plan show --workflow wf-demo --plan plan-a --json      # public authoritative read, no identity

# plan session: resume read-only, then mutate only this row and its linked issues
mstar plan bind --execution --resume-ref <plan-pm-wire> --json
mstar plan progress  --session-ref <plan-pm-wire> --file progress.json --expect <plan-token> --operation progress-1 --json
mstar plan issue-add --session-ref <plan-pm-wire> --file entries.json  --expect <plan-token> --operation issue-1 --json
mstar plan handoff   --session-ref <plan-pm-wire> --file handoff.json  --expect <plan-token> --operation handoff-1 --json

# coordinator: ownership, then the route its type and delivery kind select
mstar plan accept --session-ref <coordinator-wire> --plan plan-a --handoff <live-handoff-id> \
  --expect <plan-token> --operation accept-1 --json

# iteration route only: pin the attempt, merge, verify the pinned result
mstar plan integration-start  --session-ref <coordinator-wire> --plan plan-a --handoff <live-handoff-id> --expect <plan-token> --operation int-start-1 --json
git merge --no-ff --no-edit <source-sha>
mstar plan integration-accept --session-ref <coordinator-wire> --plan plan-a --handoff <live-handoff-id> --expect <plan-token> --operation int-accept-1 --json

# report-only route only: record the fulfilment of the registered completion policy,
# then complete; an absent or nonmatching policy refuses the completion
mstar workflow evidence --workflow wf-demo --file completion.json --session-ref <coordinator-wire> \
  --expect <workflow-token> --operation evidence-1 --json

# every route ends here: a standalone development workflow reaches this line
# straight from accept, the report-only route after recording its fulfilment above
mstar plan complete --session-ref <coordinator-wire> --plan plan-a --handoff <live-handoff-id> \
  --expect <plan-token> --operation complete-1 --json
```

Retrying the *same* argv replays the recorded receipt (`replayed: true`) instead of writing twice; a changed request against a consumed operation id refuses. Pass each child's own reference only to that child: a reference copied into another session's invocation fails the engine's caller comparison (→ the credential boundary in `mstar-iteration` `references/plan-scoped-pm.md` §8).

**Pre-activation variant (only while the execution authority is not active).** The same sequence in file form — `mstar plan bind --coordinator --workflow wf-demo --session-id <coordinator-id>`, then `--session <absolute-json>` with a `--expect <revision>` on every write, `mstar plan bind --resume <absolute-json>` for the read-only resume, and no `--operation` at all. On an ACTIVE harness these forms refuse with `execution.consumer-not-ready`; do not mix them with the active flags.

The failure object at any step names the code; the row is unchanged, so the retry starts from a fresh read of the same row rather than from the step that failed.

## Prepare amendment (pre-activation Prepare route)

The amendment family is the only lawful way to register an approved scope expansion on a workflow that already exists. It is not a scheduler and not a general document replacement. It belongs to the **pre-activation** side of the contract together with the JSON coordinator recovery below: `workflow show-prepare` and `workflow amend-prepare` are file-route forms whose byte tokens are document versions, not execution tokens, and an ACTIVE execution authority refuses them (`execution.direct-write-refused`, naming DB recovery where that is the repair).

- The read verb is read-only: no lock, no write. It returns both byte versions — the snapshot's and the reviewed compass Markdown's — plus an admission view. An inadmissible lifecycle state is reported as data (`allowed: false` with one reason line per blocker), not as an error, so a workflow can be inspected before deciding.
- The amend verb requires **both** byte versions, even on the first amendment. They are byte versions, never row revisions; the bare hex form is also accepted.
- The patch names the main worktree branch and the rows to append, and may record the integration checkout and the plan parallelism. Appended rows are constructed by the engine — a patch never carries runtime row fields. Every existing row and unknown field survives by value; nothing is created, switched, fetched or cleaned.
- It may also **correct the plan pointer of existing rows**: `correctPlanFiles` takes entries of exactly `{id, expectedFile, file}` and is the only way to repair a malformed stored pointer without hand-editing the snapshot. `appendPlans` stays present — a correction-only call passes an empty append array. A correction moves only the addressed row's `file` (plus the ordinary `updated_at`); metadata, frozen catalog pins, other rows and the review documents are untouched.
- **One pointer contract.** An appended or corrected `file` must resolve to that plan's canonical configured `{PLAN_DIR}/<plan-id>.md` with an unambiguous matching declared `plan_id`, under the same resolver registration uses. A canonical absolute path or a normalized **harness-relative** path is accepted; the repository-relative `.mstar/plans/<id>.md` spelling is refused before anything is written (it is a declared input form, not a fallback search base), and the canonical **absolute** pointer is what registration emits. A correction must additionally prove the pointer it replaces: `expectedFile` must equal the row's current `file` byte-for-byte **and** identify that same plan — either a form the resolver accepts or the exact repository-relative spelling derived from this control root's configured plan directory. Foreign absolute paths, same-basename guesses, unrelated directory prefixes, copied documents with a matching header and a no-op pointer all refuse.
- Refusals are specific and mutation-free: a stale token, a workflow that is not in Prepare or whose root entry is not running, evidence that execution has already started, a duplicate or malformed appended plan, an unknown or no-op patch key, a plan set or integration branch the reviewed compass does not declare, or a supplied integration checkout that fails validation. Auth and scope refusals reuse the shared codes above.
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

## Standalone plan registration and delivery evidence

- Registration is create-only: it writes the workflow snapshot and the root register entry under one lock, recording the owned plan row, the project, the declared delivery kind and the branch anchors. The delivery kind is **declared, never inferred**, and each kind requires its own evidence declaration at registration. Re-running after a crash between the two writes recovers: existing snapshot bytes are kept and only the root entry is written. On the active route it is a **root-token creation** — `--expect <the store's root execution token>` + `--operation <id>` under an independently acquired identity, and it takes no `--session-ref` at all (no session row exists before the workflow does).
- Delivery evidence is recorded stage by stage: a payload is merged into the snapshot's delivery block under the snapshot lock. The PR identity is recorded once and pinned to the registered branch anchors; a conflicting anchor is refused rather than overwritten. Declaring the kind of an older kind-less snapshot is a one-time act and refuses a terminal snapshot, and it exists only on the pre-activation route (the DB creation route declares its kind at registration, so there is no active operation for a declaration and it is never disguised as one).
- **Completion ordering per kind.** The declared kind decides which stage order applies, and the recording seam is the same one: a `development` workflow records the compound disposition, the PR identity and the verified-merge record **after** every row is `Done` (the tail runs post-Done); a `verification/report-only` workflow records the fulfilment of its registered `completion_policy` — `{completion: {policy, evidence}}`, the policy naming the registered one — **before** the row is `Done`, because the completion step and the close both consult it. An absent, empty or nonmatching fulfilment refuses the completion with no write, and no merge, integration branch or integration checkout is ever synthesized for this kind.
- Recording evidence is authorized like the close, and the two transports stay disjoint: the active form takes `--session-ref <wire> --expect <the workflow's full execution token> --operation <id>` under an independently acquired coordinator identity, while the pre-activation form takes the bound coordinator envelope (`--session`) and refuses on an ACTIVE harness. A verb with neither refuses without changing bytes.
- A registered `branch.source` cannot be amended by ordinary evidence: the evidence verb merges only the delivery block, and the one-time kind declaration refuses a value that conflicts with an already-registered anchor. The single exception is the legacy repair verb, which replaces **only** `branch.source` on a pre-fix snapshot whose registered source wrongly equals its target, derived from the sealed accepted handoff — it records no Done, no delivery success and no remote merge, and it is not a general anchor editor.
- The close consults this evidence *before* writing the terminal state, so a gate and the close can never disagree. Close order, refusal conditions and the root unregister: `references/status-and-registers.md`.

## Iteration workflow registration

An iteration does not go through `mstar workflow register`. It registers through `mstar iteration register` — the same create-only, one-lock contract and the same crash recovery (existing snapshot bytes kept, only the missing root entry written on re-run), and the same active root-token creation (`--expect <the store's root execution token>` + `--operation <id>`, no `--session-ref`) — with a compass ref, the three branch anchors and Todo plan rows in place of a delivery kind; no delivery kind or evidence declaration applies to it, and plan-row metadata is derived by the producer rather than supplied. Each row's plan pointer goes through the one registered-plan resolver and what gets stored is the **canonical absolute** `{PLAN_DIR}/<plan-id>.md`, never a copy of the caller's spelling: a canonical absolute or normalized harness-relative input is accepted, and the repository-relative `.mstar/plans/<id>.md` spelling is refused — before the first journal row, the snapshot or any root write. Lifecycle semantics: `mstar-artifacts`; flag set: the command help.

## Exit codes

| Code | When |
|---|---|
| `0` | the operation succeeded, including an idempotent no-op, a replayed operation id and a read-only resume |
| `1` | engine refusal — every code above, always with no change to authoritative bytes |
| `2` | usage: missing or mixed address forms, missing/partial/mixed active flags, unknown flag, an active route carrying a pre-activation flag, a token that is neither the absent literal nor a version token (or a revision integer where a full execution token is required), a relative path where an absolute one is required, an unreadable or unparseable payload file |
