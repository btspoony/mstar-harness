# Plan workflow lifecycle contract

The authoritative semantics for plan-level workflow delivery: what a `type: plan` workflow declares at registration, the stages it walks, the evidence each stage owes, and the engine seams that enforce them (§6). Corpus surfaces cite this file pointer-level instead of restating it; where a skill's prose and this contract disagree on lifecycle semantics, this contract is the wording authority until it is formally amended.

This file owns semantics only. The `packages/engine/src/*` line ranges below are orientation, not stable anchors — re-read the module before relying on a range.

## Foundational distinctions

Two distinct units:

- **Standalone plan workflow:** a single registered plan lifecycle with its own declared delivery obligation and terminal close.
- **Plan row inside an iteration:** a work unit coordinated directly by the iteration's primary PM. Row completion creates no child PR obligation or secondary PM seat.

Four facts that are not interchangeable: plan-row `Done`, workflow `completed`, PR opened, and PR merged are distinct facts. A workflow with completed implementation but an outstanding delivery PR must remain active and resumable.

## 1. Delivery-kind declaration

Every workflow declares its delivery kind at registration, as part of the registration evidence (§4a). Declared kinds:

- **`development`** — the full lifecycle of §3 applies: PR submission, merge-ready milestone, verified merge, and evidence-backed terminal close. The PR obligation is the declared delivery path, not an optional extra.
- **`verification/report-only`** — an explicit alternative completion policy is recorded at registration. Fulfilment matching that policy is recorded before row Done, consumed by direct completion and consulted again by evidence-backed terminal close. QC/QA remain required; no Git/integration, compound-before-PR, PR or merge obligation is invented.

Binding rules:

- The declared kind is recorded at registration. It is never inferred retroactively from runtime behavior, from the presence or absence of fields, or from convenience.
- Absence of `branch.target` (or of any other registration field) is not an implicit exemption. Missing fields never select a kind and never waive the declared obligation; a `development` workflow with missing branch fields is incomplete registration, not an exempt workflow.
- Verification/report-only workflows follow their recorded explicit completion policy, not an accidental PR exemption inferred from missing fields.
- An iteration uses the same outer lifecycle around its multiple plan rows (§3). Its child plan rows are not standalone workflows and gain no independent delivery PR obligation.

## 2. Cardinality stance

- The new normal route is **one independently owned development plan per `type: plan` workflow**. A `type: plan` label alone does not establish cardinality; this contract fixes it for the new normal route only.
- **Producers.** The known multi-row `type: plan` producer is audit promotion (`promoteAuditPlans`), which constructs one plan row per selected plan file (`packages/engine/src/audit.ts:1250-1272`). Existing specialized producers are `audit promote` and `migrate`; the generic normal-entry register producer is seam S1 (§6).
- **Decision:** audit promotion is explicitly **grandfathered** as a multi-row specialized producer. No schema-level one-row invariant is imposed on the grandfathered producer; it keeps working and is not silently broken. Any future schema tightening must migrate audit promotion off the multi-row shape first, and must re-inventory producers before enforcement. Until such a migration lands, the one-plan norm governs the new normal route and new registrations, not the grandfathered producer.

## 3. Lifecycle stages

The common delivery lifecycle:

```
register → recall → prepare/lock → execute + review/acceptance → compound disposition → submit PR → merge-ready (milestone) → verify merge → terminal close/unregister/reconcile
```

| Stage | Producer | Evidence (recorded) | Failure behavior |
|---|---|---|---|
| register | PM via an authorized domain operation (seam S1) | Create-only snapshot + root `workflows[]` entry under one lock; records snapshot type, delivery kind, owned plan, project, source/target branches and coordinator. Registration does not authorize implementation; advisory research and unselected candidates are not silently promoted. | Missing or failed registration blocks execution (admission refusal, seam S2). A failed register write is never treated as partial activation success. |
| recall | PM, during Prepare before plan lock | Recall receipt: relevant knowledge/research inputs recorded, reused and rejected decisions noted, or a truthful empty result when none apply. No full-corpus scan; no invented knowledge. | Plan lock is not reached without the receipt. Existing implement-time re-alignment still applies when source inputs change. |
| prepare/lock | PM per `mstar-phase-gates` | Locked plan under the existing Prepare/clarify gates; their ownership and risk rules are unchanged. Workflow unification removes no gates. | Clarify/Prepare gate failure keeps the workflow active in Prepare; nothing advances silently. |
| execute + review/acceptance | Dev implementers, plan QC tri, QA per existing ownership | The existing per-plan gate evidence (implementation checks, QC tri, QA gate). | Gate failure leaves rows and workflow blocked/active — never silently completed. Row `Done` is not workflow completion (foundational facts). |
| compound disposition | PM/implementer on the delivery branch/worktree, before the PR head is finalized | Outcome ∈ {`created`, `updated`, reasoned `skipped`} recorded on the workflow. No mandatory new document; high overlap updates an existing document rather than generating a duplicate. | Missing disposition blocks PR head finalization. A reasoned `skipped` is a valid recorded outcome, not an omission. |
| submit PR | PM/owner | Real PR identity recorded at submission: repo, head, target (§4d). | Missing credentials, remote, or submission failure leaves the workflow blocked/active, not completed. A local commit or a pre-existing unrelated PR does not satisfy this stage. |
| merge-ready (milestone) | PM declares after submission | Milestone marker only. The workflow stays registered and resumable while the PR is open. | Not a completion state: an outstanding delivery PR keeps the workflow active (foundational facts). |
| verify merge | PM check — never the close verb | Provider merge evidence. PR opened, mergeable, and merged are different facts; missing or unavailable provider evidence is not accepted as merged. | Unverified merge keeps the workflow registered/resumable. Local close validation is never described as proof of a remote merge. |
| terminal close/unregister/reconcile | Authorized close path (seam S3): `closeWorkflow` semantics + phase-6 ordering | Terminal snapshot write → root unregister → projection reconcile, ordered and retryable; every row `Done`; delivery-kind evidence consulted (§6 S3). | Refusal when evidence or row state is insufficient. Root-removal failure is explicit partial closure; retry must not rewrite the terminal timestamp. |

**Iteration application.** One primary coordinator drives its multiple rows through ordinary operations, with dependency scheduling, isolated leaf tasks, serial real integration and package/compass projections. Child completion never triggers a child delivery PR or premature parent closure; only the parent walks compound → submit PR → verify merge → terminal close.

**Route application.** The engine selects the row's completion route from the workflow's own `type` and declared delivery kind — never from anchors that happen to be absent — and there are three:

| Route | Selected when | Direct completion proof | Outer obligation |
|---|---|---|---|
| iteration | Non-standalone workflow | QC/QA/source-review proof plus actual already-performed serial merge `integration: {base_sha,result_sha}` verified against the recorded integration checkout/target and ancestry | Row Done only; parent compound/PR/merge/close |
| standalone development | `type: plan`, `delivery_kind: development`, exactly one row | QC/QA plus clean registered source checkout/ref and commit; integration input refuses | Row Done precedes own compound/PR/verified-merge/close; workflow stays running |
| standalone report-only | `type: plan`, `delivery_kind: verification/report-only`, exactly one row | QC/QA plus already-recorded matching completion-policy fulfilment; no invented Git, integration input refuses | Row Done precedes evidence-backed terminal close; no PR/merge |

All routes use coordinator `complete`, not an ownership-transfer protocol. Missing anchors never select another route. Effective QA/cleanup configuration defaults to mandatory/allow-residual and is revisable through ordinary prepare; recorded source metadata/defaults do not require a ceremonial prepare record. Direct complete re-witnesses relevant Git at commit, retains source metadata, releases applicable exclusion and preserves replay timestamps. Evidence hashes record provenance, not byte-level plan or Assignment admission.

## 4. Evidence contracts

**(a) Registration is an authorized domain operation.** It writes the create-only snapshot and the root entry under one lock. The primitive reference is the audit-promotion sequence `packages/engine/src/audit.ts:1250-1324`: plan-row/snapshot construction, entry validation, then the atomic root-lock section — create-only `writeWorkflowSnapshot` → `registerWorkflowEntryLocked`, with rollback that removes only the exact snapshot version that call created. The generic producer (seam S1) reuses these primitives; it does not invent a second registration mechanism.

**(b) Admission consumes registration.** `packages/engine/src/sdd.ts:1185-1194` falls back to branch-alignment-only when no active workflow row applies, or a non-InProgress row has no lease — so the SDD seam does not enforce the registration obligation by itself. On the normal plan route that fallback closes with a precise refusal code, and the refusal documents the registration command and the recovery path (seam S2). Registration/recovery semantics: a crash between snapshot creation and root registration leaves no partial activation; recovery re-runs the authorized producer without duplicating identity.

**(c) Compound disposition.** The outcome ∈ {`created`, `updated`, reasoned `skipped`} is recorded on the workflow before PR head finalization. Engine checks can validate the disposition and referenced artifacts; that is not semantic-quality proof. Existing compound document/index validation is reused as-is.

**(d) PR identity.** Repo, head, and target are recorded at submission. Neither a local commit nor a pre-existing unrelated PR satisfies the obligation; a failed submission leaves the workflow blocked/active, not completed.

**(e) Merge-ready.** Leaves the workflow registered and resumable. A requirement to submit a PR implies no authorization to merge it.

**(f) Verified merge.** A PM check, never the close verb. It distinguishes opened, mergeable, and merged; missing or unavailable provider evidence is not accepted as merged.

**(g) Terminal close.** Existing `closeWorkflow` semantics (`packages/engine/src/workflow.ts:665-725`): close-timestamp validation, snapshot identity check, coordinated-writer authority, every row `Done`, strict terminal validation that refuses leases without deleting them, and idempotent preservation of an existing valid terminal snapshot (including `failed`/`stopped`); it never releases leases. Ordering per phase-6 (`packages/engine/src/iteration.ts:514-616` reuse): snapshot terminal → unregister → reconcile. The local gate deliberately does not verify remote merge — that verification is the PM's separate check in (f). `closeWorkflow` does not inspect PR or compound evidence; seam S3 adds exactly that delivery-kind evidence consultation while reusing every existing guard.

## 5. Failure and abandonment

- Failure and abandonment close through explicit `failed`/`stopped` statuses with a recorded reason. They are never rewritten as successfully completed.
- **Current exposure.** The DB lifecycle already carries the terminal `failed`/`stopped` branch (the active form `mstar workflow lifecycle --status failed|stopped --reason`, under `--session-ref`/`--expect`/`--operation`), and this contract does **not** reimplement it. What stays deferred is the **installed JSON/CLI `failed`/`stopped` exposure** — no expanded exposure and no cancellation subsystem is claimed or added here. A workflow that must become terminal on that deferred path is a named blocker for its owner: reported as such, rather than closed as `completed` or edited by hand.
- `closeWorkflow` preserves an existing valid terminal snapshot unchanged, including `failed`/`stopped` — idempotence this contract keeps.
- Close never releases leases. Another owner's lease is not released to force closure; strict terminal validation refuses leases without deleting them.
- Leaf assignments cannot mutate lifecycle anchors or close workflows. The primary coordinator retains those workflow-wide operations.

## 6. Engine seam inventory

Three named seams. Per-seam acceptance checks state the observable behavior each seam owes. This section specifies seams; it implements none of them.

**S1 — Generic register producer.** A general authorized registration path for normal plan workflows, reusing the §4a primitives (create-only snapshot + root entry under one lock, rollback of only the created version).
Acceptance checks: a standalone development plan registers before execution; a missing registration, failed register write, or ambiguous owner blocks execution without partial activation being treated as success; crash/retry between snapshot creation and registration preserves identity, timestamps, ownership and resumability; existing producers (audit promotion) use the same primitives.

**S2 — Admission consumption.** The SDD admission fallback (`packages/engine/src/sdd.ts:1185-1194`) closes on the normal plan route: execution without a registered running workflow row is refused with a precise refusal code, and the refusal documents the registration command and recovery path.
Acceptance checks: an unregistered plan's execution is refused, not silently continued on branch alignment alone; the refusal names registration and recovery; no partial activation is treated as success.

**S3 — Standalone close path.** The close path consults the registered delivery kind's evidence before completing. The local post-merge gate is snapshot-type-generic; the delta is the delivery-kind evidence consultation, reusing `closeWorkflow` guards and phase-6 ordering unchanged.
Acceptance checks: a registered `development` workflow with missing or incomplete delivery evidence refuses the close and stays registered/resumable; `Done` rows without required PR/compound evidence cannot be used to declare the workflow delivered; close retry after the terminal write preserves the original timestamp; `failed`/`stopped` workflows are never rewritten as successfully completed; close never releases leases; crash/retry between terminal write and unregister preserves identity, timestamps, ownership and resumability.

**Explicit deferral.** Mid-lifecycle advancement-gate breadth is deferred: per-stage engine gates across recall, prepare/lock, execute, compound disposition and PR submission are not part of this contract. `evaluatePhaseGate` stays iteration-shaped. The process obligations for those stages are carried by corpus pointers to this contract; only registration admission (S2) and terminal evidence (S3) are wired into code, plus the S1 producer.

## 7. Scope decisions

The direction and reason columns record the reasoning behind each answer; the answers are binding. There are no open decisions in this table.

| Decision | Answer | Direction | Reason |
|---|---|---|---|
| Does every `type: plan` mean a development PR? | **No.** Delivery kind is declared at registration (§1). Development plans require PR; verification/report-only workflows follow the explicit alternative completion policy recorded at registration. | Declare the delivery obligation explicitly for the workflow's purpose. Development plans require PR; verification/report-only workflows need an explicit alternative completion contract. | `type: plan` is also used for independent verification. Do not force empty PRs or make absence of `branch.target` an implicit escape hatch. The strict universal alternative is possible but must be consciously selected. |
| Is `type: plan` exactly one plan row? | **One independently owned development plan per workflow for the new normal route; audit promotion grandfathered as an explicitly inventoried multi-row producer (§2).** | Prefer one independently owned development plan for the new normal route; inventory current multi-row producers before tightening schema. | A type label alone does not establish cardinality. Audit promotion must be considered before enforcing a one-row invariant. |
| Where does compound run for a standalone plan? | **On its delivery branch/worktree, before the PR head is finalized (§3, §4c).** | On its delivery branch/worktree before the PR head is finalized. | Do not invent an iteration compass or extra integration branch solely to reuse iteration-close. Preserve control-root process artifacts versus tracked-result write ownership. |
| What completes the workflow? | **Verified merge plus common close; PR submission and merge-ready remain resumable milestones (§3, §4e–g).** | Verified merge plus common close; PR submission and merge-ready remain resumable milestones. | Preserves the stronger existing post-merge-close semantics. A user request to submit a PR is not authorization to merge it. |
| How should failure/abandonment close? | **Explicit failed/stopped handling with reason, never successful completed-close; no lease release by close (§5).** | Explicit failed/stopped handling with reason, never successful completed-close. | Preserve the existing distinction and do not release another owner's lease to force closure. |

## Binding negatives

- No part of this contract authorizes auto-merge. Submitting a PR never implies merge authorization; merging is a separate authorized act, verified by the PM check in §4f.
- No forced PR for `verification/report-only` workflows. Their completion follows the policy recorded at registration (§1).
- No silent completion anywhere. Every stage transition records its evidence; failure renders the workflow blocked/active, never implicitly done.
- No cleanup authorization is implied by lifecycle completion: worktree/branch deletion stays explicit and ownership/merge-guarded, exactly as the existing post-merge-close contract requires.
- Close never releases leases, and terminal `failed`/`stopped` states are never rewritten as `completed` (§5).

> Amendment 2026-10-06 — ACTIVE store execution authority
>
> **Authority and registration.** When execution authority is ACTIVE, `{HARNESS_DIR}/store.db` owns workflow/plan execution rows and the root register (`execution_registry`). The active `mstar workflow register` route consumes the **root creation token** and an operation id; registration records the declared delivery kind and execution identity through the store-backed registration seam. It does not create or update a root `status.json` or workflow snapshot, and registration still does not authorize implementation.
>
> **Direct execution and completion.** Registration uses the root token; workflow writes use workflow tokens and plan writes use plan tokens. Session references select an independently acquired caller identity, not authority supplied by a leaf. The primary coordinator drives rows through ordinary `prepare`, `progress` and direct `complete` under its selected workflow — no per-row bind, sealed Assignment or handoff/accept transfer exists on any route, and completion evidence follows the §3 route table. Completion marks the row `Done`, releases the applicable workflow merge exclusion for its verified attempt, and leaves the workflow `running` for the declared delivery tail. The iteration and standalone routes keep their §3 proofs unchanged.
>
> **Close.** ACTIVE terminal close uses the store-backed lifecycle seam and unregisters the workflow from `execution_registry`; it does not use snapshot-terminal-write → root-file-removal as its authority. Delivery evidence, row completion and the absence of a dangling workflow integration exclusion remain prerequisites, and close never releases an exclusion to force success. A released exclusion remains an audit record, not permission to resume or take another owner's claim.
>
> **File-route boundary.** The create-only snapshot + root `workflows[]` registration and snapshot-terminal close/unregister ordering in §3, §4(a), §4(g) and the seam inventory describe **pre-activation / engine-absent only**. Under ACTIVE authority use the public store-backed verbs and their current CLI contracts; never dual-write those files. This amendment changes the authority and persistence seams, not delivery-kind declarations, semantic review/QA gates, verified-merge obligations, close authorization or the Binding negatives. Earlier frozen clauses remain byte-identical.

> Amendment 2026-10-10 — File-route retirement
>
> This closing amendment supersedes the file-route boundary in the 2026-10-06 amendment. It is append-only: earlier frozen clauses, including every ACTIVE clause of that amendment, remain byte-identical. It does not change delivery-kind declarations, the non-file evidence obligations of the §3 stages, the §3 route-table proofs, semantic review/QA gates, verified-merge obligations, close authorization, or the Binding negatives.
>
> **Historical file route.** The file execution route is retired. It is not a live route and not a second execution transport. These frozen descriptions are historical:
>
> - §3 lifecycle stages, where they record file evidence or file ordering: create-only snapshot plus root `workflows[]` entry under one lock, and terminal snapshot write → root unregister → projection reconcile.
> - §4(a) registration primitives: create-only `writeWorkflowSnapshot` → `registerWorkflowEntryLocked`, and the audit-promotion file sequence cited there as the live producer.
> - §4(g) terminal-close file ordering: snapshot-terminal `closeWorkflow`, then unregister, then reconcile.
> - §6 file-route seam members: S1's create-only snapshot + root-entry producer; S2's file-register admission probe; S3's snapshot close path and phase-6 file ordering.
>
> **Only route.** Execution authority is the ACTIVE DB route in `{HARNESS_DIR}/store.db` (`execution_registry`, `execution_workflows`, `execution_plans`, and the other execution tables). `mstar workflow register` and `mstar iteration register` record the declared delivery kind and execution identity through the store-backed registration seam (root creation token + operation id). They do not create or update a root `status.json` or workflow snapshot, and registration still does not authorize implementation. The primary coordinator drives rows through ordinary `prepare`, `progress`, and direct `complete`. ACTIVE terminal close is `mstar status workflow-close`: one store transaction writes the terminal workflow state and unregisters the workflow from `execution_registry`. It does not use snapshot-terminal-write → root-file-removal. Delivery evidence, row completion, and the absence of a dangling workflow integration exclusion remain prerequisites. Close never releases an exclusion to force success. A harness with no ACTIVE store has no execution authority (conversation tracking); it does not fall back to those files.
>
> **Migration sources.** Root `status.json` and `workflows/<id>/snapshot.json` are migration sources / retained history, not authority. The kept migration tooling writes them as staging and reads them as byte-witness sources: `mstar migrate` (v1 tree → v2 files), then `mstar store upgrade` (v2 files → `store.db`). `mstar harness scaffold` does not write `status.json`. Delete the staging files after a successful import. `validateStatusV2` and `validateWorkflowSnapshot` remain migration-tooling validators. Where the engine still keeps migration-scoped `status` / `snapshot` readers or writers, they serve that tooling only.
>
> **Persist surface.** The user-facing persist family accepts `review` and `json` only. `status` and `snapshot` files are migration staging written engine-internally by the kept migration tooling. The engine `ArtifactKind` type retains `status` and `snapshot` as migration-scoped internal kinds; this amendment does not claim that type is two-member.
