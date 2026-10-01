# Plan and workflow transport

This file carries the two coordination command families: scoped plan coordination (`plan`) and the guarded Prepare amendment plus standalone registration (`workflow`). They share one protocol — one document under a same-host write lock, one engine call per verb, the same token and failure discipline.

What lives elsewhere: field schemas, snapshot shape and lifecycle semantics belong to `mstar-artifacts`; phase semantics to `mstar-iteration`; checkout rules to `mstar-branch-worktree`. This file records only what command help cannot express — role boundaries, tokens, refusal codes, envelopes and sequence order.

Normal route: select the intended active DB verb from current help, invoke it with required inputs, and inspect its receipt. Do not interpose a mandatory top-down `persist`/rebind/repair ladder merely to replay normal progress. Active writes use the session reference, full execution token for the addressed scope, and operation id. Acquire the required current token from the authoritative read. `applied` and `replayed` are receipt outcomes; preserve components already applied only where the verb documents action-local partial semantics.

Payload discovery: `mstar-harness schema PlanProgress` describes `plan progress` JSON and `mstar-harness schema HandoffEvidence` describes `plan handoff` JSON, including nested QC/QA fields. Build a complete JSON object from the schema before invoking `--file`; the CLI accepts an absolute JSON file, not a one-field-at-a-time trial. Actor identity and the intended operation/target remain operator inputs; a public action does not supply the caller's session reference, token or operation id. Historical `submit` is not a plan verb: bounded non-authoritative advice is `mstar-harness judgment review-advice` with its own help and review-pack input, not a lifecycle submission.

## Transports

The execution route is selected by `execution_meta.authority_state`, not by `store_meta.authority_state`: `store_meta` governs issue/catalog authority, while `execution_meta` governs coordinated workflow operations. Use `mstar status validate` as the discriminating read. Its `state` is `active`, `legacy`, or `unreadable`: `active` is the supported operating route; `legacy` is unsupported and provides only `upgrade.entry: "mstar store safe-upgrade"`; `unreadable` reports what could not be read and the recovery needed to make it readable.

| State | Supported action |
|---|---|
| `active` | Use the active DB route below. |
| `legacy` | Do not use file-form operation flags; run the single upgrade entry `mstar store safe-upgrade`. |
| `unreadable` | Follow the reported self-check recovery, then rerun `mstar status validate`. |

## Active transport

The active DB route is the sole supported route for normal coordinated operations:

| Write flags | Caller identity |
|---|---|
| `--session-ref <wire>` + `--expect <full execution token>` + `--operation <id>` | Independently acquired for this invocation: never a flag, never read from a session file, never carried by the reference |

- The reference is a lookup, not a bearer credential: it names a stored session row and grants no authority without the independently acquired caller.
- `mstar status validate` reports the root and per-workflow tokens when state is active; `mstar plan show` reports the addressed plan token. Use the token matching the mutation scope.
- Legacy file-form operation routes are retired; their flags are not a supported alternative to the active route.
- The **reference is a lookup, not a bearer credential**: it names a stored session row, grants no authority by itself, and the engine compares the independently acquired caller inside its own transaction — so a copied reference under another identity refuses without writing.
- Launching: `mstar session run --workflow <id> --role <coordinator|plan-pm> [--plan <id>] [--harness <absolute-path>] -- <argv>` mints **one** local identity for the child, overwrites the identity channel, deletes the legacy one, and propagates the child's exit code (or re-raises the signal that killed it). Repeated CLI invocations inside that child share the identity; a **new** launcher is a new identity and cannot claim the old one — a stopped owner needs the explicit recovery verb (→ § Recovery), never a copied id.

## Session and address model

- A plan session is bound to one plan; a coordinator session serves one workflow and is the only session allowed to amend, register, record evidence or close it. Coordinator identity is independently acquired and limited to one coordinator per workflow.
- Two address forms reach the same prepared row: the pinned Assignment path, or workflow + plan, which reads the row's registered Assignment path. A second fresh claim refuses with `coordination.duplicate-holder`.
- Active resume is read-only: `mstar plan bind --execution --resume-ref <wire>` reports current context; it never reacquires a released lease, restarts execution, or re-identifies the caller. Resume is never recovery.
- A fresh active bind requires `--expect <full execution token>`, `--operation <id>`, and independently acquired runtime session identity: coordinator binds use the workflow token; plan-PM binds use the plan token. It checks and claims atomically against current ownership. Active resume is read-only and token-free.

## Recovery (active coordinator replacement)

While the execution authority is active, an abandoned or unreachable coordinator is replaced by exactly one verb, under an independently acquired coordinator identity:

```sh
mstar session recover --workflow <id> (--prior-session <id> | --unowned) --reason <text> \
  --attestation <absolute-json> --expect <full-execution-token> --operation <id> [--harness <absolute-path>] [--json]
```

- The prior holder is **named** — or `--unowned` when the workflow records none; the two are mutually exclusive and neither is guessed. The stop attestation must name that holder stopped/reloaded, the workflow's **exact** execution token is the CAS, and the operation id is the replay key.
- Recovery is active DB only. Pre-activation Prepare recovery is retired; do not use file/JSON snapshot forms.

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

All plan and workflow refusals are mutation-free: the authoritative bytes are unchanged, and the fix is to read again — not to escalate to a force flag, which does not exist.

| Code | When |
|---|---|
| `execution.consumer-not-ready` | the retired file-form writer was attempted against the active authority; nothing was written, the message identifies active state and says no upgrade is required |
| `execution.not-active` | the execution authority is not active; the refusal names the observed state and the sole supported upgrade entry |
| usage (exit 2) | a missing or mixed active flag set, a token kind that does not match the operation, an unsupported file-form flag, or no independently acquired identity in the identity channel |
| `coordination.identity-mismatch` | the acquired caller does not address the workflow / role / plan named by the session reference — a copied or stale reference refuses without writing |
| `coordination.session-role` | the session is not the role required by the verb |
| `coordination.session-mismatch` | the session reference addresses a different document than the request |
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

Common prefix: **handoff** (plan side, leaves the row InReview) → **accept** (ownership transfer, not integration acceptance). Invoke the intended public action under the correct actor with its required session address, current expectation and operation id, then inspect its receipt; use a refusal to identify a missing input or conflict rather than running a mandatory preflight ladder. Explicit pinned Git merge is the operator's action, never a verb side effect.

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

The plan PM submits final handoff evidence (`mstar-harness schema HandoffEvidence`); the coordinator accepts it and follows the registered delivery kind. On the iteration route, start a pinned integration attempt, perform and verify the recorded Git merge, accept integration and complete. On standalone development, complete after accept; on report-only, record fulfilment of its registered policy before complete without inventing a Git step. Every supported write uses the active DB route, the scope-matched token, and an independently acquired identity; inspect the `applied` or `replayed` receipt. Do not turn those explicit inputs into a ceremonial top-down preflight ladder.

The failure object at any step names the code; the row is unchanged, so the retry starts from a fresh read of the same row rather than from the step that failed.

## Retired file-route operations

Prepare amendments and coordinator recovery that use file snapshots, byte-version tokens, or session envelopes are not supported operating procedures in this release. When `mstar status validate` reports `state: legacy`, use only `mstar store safe-upgrade`; do not invoke pre-activation file forms. The migration entry is the forward-upgrade path and retains its reviewed safety barriers.

## Standalone plan registration and delivery evidence

- Registration is create-only: it writes the workflow snapshot and root register under one lock, recording the owned plan row, project, delivery kind and branch anchors. The delivery kind is declared, never inferred. Supply `--plan-file plans/<id>.md` using a normalized harness-relative path; absolute paths and `.mstar/plans/<id>.md` are refused. The active creation call uses the root token from `mstar status validate` plus an operation id under an independently acquired identity; it takes no session reference because no session row exists before the workflow.
- Delivery evidence uses the active DB route and workflow-scope token. Legacy file-route forms are unsupported; on `state: legacy`, use only `mstar store safe-upgrade`.
- **Completion ordering per kind.** Development records compound disposition, PR identity and verified merge after every row is `Done`; report-only records fulfilment of its registered completion policy before `Done`. No merge or integration branch is synthesized for report-only.
- A registered `branch.source` is not amended by ordinary evidence; the legacy repair verb is not a general anchor editor. The close consults evidence before writing terminal state. See `references/status-and-registers.md` for close order and refusal conditions.

## Iteration workflow registration

An iteration does not go through `mstar workflow register`. It registers through `mstar iteration register` — the same create-only, one-lock contract and the same crash recovery (existing snapshot bytes kept, only the missing root entry written on re-run), and the same active root-token creation (`--expect <the store's root execution token>` + `--operation <id>`, no `--session-ref`) — with a compass ref, the three branch anchors and Todo plan rows in place of a delivery kind; no delivery kind or evidence declaration applies to it, and plan-row metadata is derived by the producer rather than supplied. Each row's plan pointer goes through the one registered-plan resolver and what gets stored is the **canonical absolute** `{PLAN_DIR}/<plan-id>.md`, never a copy of the caller's spelling: a canonical absolute or normalized harness-relative input is accepted, and the repository-relative `.mstar/plans/<id>.md` spelling is refused — before the first journal row, the snapshot or any root write. Lifecycle semantics: `mstar-artifacts`; flag set: the command help.

## Exit codes

| Code | When |
|---|---|
| `0` | the operation succeeded, including an idempotent no-op, a replayed operation id and a read-only resume |
| `1` | engine refusal — every code above, always with no change to authoritative bytes |
| `2` | usage: missing or mixed active flags, unknown flag, an unsupported retired file-form argument, a token of the wrong kind, a relative path where an absolute path is required, or an unreadable or unparseable payload |
