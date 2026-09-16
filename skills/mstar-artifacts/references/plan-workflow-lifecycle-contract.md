# Plan workflow lifecycle contract

The authoritative semantics for plan-level workflow delivery: what a `type: plan` workflow declares at registration, the stages it walks, the evidence each stage owes, and the engine seams that enforce them (§6). Corpus surfaces cite this file pointer-level instead of restating it; where a skill's prose and this contract disagree on lifecycle semantics, this contract is the wording authority until it is formally amended.

This file owns semantics only. The `packages/engine/src/*` line ranges below are orientation, not stable anchors — re-read the module before relying on a range.

## Foundational distinctions

Three meanings that must remain separate:

- **Standalone plan workflow:** an independently owned `type: plan` lifecycle, with its own delivery obligation and terminal close.
- **Plan row inside an iteration:** a work unit inside the iteration's existing lifecycle. Its completion does not independently create a second delivery PR obligation.
- **Plan-scoped primary PM session:** bounded execution authority that ends in handoff to its coordinator. It does not gain lifecycle authority because its role name includes PM. See `skills/mstar-iteration/references/plan-scoped-pm.md:21,62–68,95–109,145`.

Four facts that are not interchangeable: plan-row `Done`, workflow `completed`, PR opened, and PR merged are distinct facts. A workflow with completed implementation but an outstanding delivery PR must remain active and resumable.

## 1. Delivery-kind declaration

Every workflow declares its delivery kind at registration, as part of the registration evidence (§4a). Declared kinds:

- **`development`** — the full lifecycle of §3 applies: PR submission, merge-ready milestone, verified merge, and evidence-backed terminal close. The PR obligation is the declared delivery path, not an optional extra.
- **`verification/report-only`** — an explicit alternative completion policy is recorded at registration and names what evidence completes the workflow (for example the acceptance artifacts or report location). Terminal close still runs through the same evidence-backed close ordering (§4g); only the PR/merge stages are replaced by the recorded policy.

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

**Iteration application.** An iteration uses the same outer lifecycle around its multiple plan rows, adding only iteration-specific scope planning, dependency scheduling, integration and package/compass projections. Child plan handoffs do not trigger per-child delivery PRs or premature parent closure; only the iteration workflow itself walks submit PR → verify merge → terminal close.

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
- `closeWorkflow` preserves an existing valid terminal snapshot unchanged, including `failed`/`stopped` — idempotence this contract keeps.
- Close never releases leases. Another owner's lease is not released to force closure; strict terminal validation refuses leases without deleting them.
- Scoped and plan-scoped sessions cannot mutate lifecycle anchors or close sibling workflows (foundational distinctions, third meaning).

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
