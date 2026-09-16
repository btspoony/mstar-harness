# Plan-scoped primary PM contract

Status: architecture interfaces frozen 2026-09-15; PM Prepare lock still required. Source baseline: `1918b46cea58b4b53a65f800802611b465439b89`. This file is the implementation contract; names below are final, not existing-runtime claims.

## Outcome

A user opens an independent terminal session and invokes `/iteration-drive --assignment /absolute/control/assignment.md` or `/iteration-drive --workflow <workflow-id> --plan <plan-id>`. The command boots the existing primary `project-manager`, claims exactly one prepared plan through the CLI, and drives its SDD tasks, fresh L2 reviewers, plan QC tri and QA gate. It never dispatches a PM subagent. Herdr/tmux are optional ways to open a terminal, not prerequisites, dependencies or ownership signals.

The scoped finish line is a durable integration handoff. Handoff leaves the plan `InReview`; the iteration coordinator alone accepts it, serially integrates its pinned source, verifies Git, and records `Done` atomically with lease release. The coordinator retains dependency release, compass/index/root projections, iteration PR and Phase 3–6. A duplicate fresh entry for the same plan, by either address, fails with the active holder and scope. Only explicit resume of the original session is allowed; no automatic attach, fallback plan, TTL, idle or pane-state theft.

## Invariants

- One workflow snapshot remains the process authority; no per-plan workflow clone, database, daemon or second status copy.
- All supported coordination writes use the existing same-host `withStatusWriteLock`, the single ArtifactStore kind-to-path table, fresh in-lock reads and validation before atomic replacement. Scope, identity, transition or version rejection leaves authoritative document bytes unchanged.
- Process paths derive from the Git main worktree, never the feature checkout's `.mstar`. Honor explicit harness overrides and `.mstarc` subdirectory declarations, then enforce identity/path agreement.
- Assignment identity is not session identity. Fresh claims allocate new session UUIDs, never derive a holder from plan, assignment path, PID or terminal label.
- Scoped actors write only their row and its registered project residual bucket; they cannot write sibling rows, lifecycle anchors, root register, compass, shared indexes, iteration PR or Phase 3–6.
- Feature ownership and L2 isolation remain mandatory. Handoff pins reviewed Git and evidence; merge failure retains recoverable `InReview` ownership. Completion retains cleanup ownership metadata and deletes both leases in one snapshot write.
- Git merge and snapshot persistence are separate transactions. Explicit reconciliation observes Git ancestry/head and never trusts a caller's success flag or performs a second merge.
- No-argument `/iteration-drive` keeps the existing whole-iteration route. Any nonempty invalid scoped invocation fails closed before boot/claim; it never broadens scope.
- Cross-primary references are readable absolute control-root filesystem paths. `local://` is not a portable handoff address. Session envelopes below are credentials/pointers, not a second process-SSOT copy.
- Supported writers are cooperative same-machine interfaces, not a filesystem sandbox. Arbitrary shell/file edits or copied session credentials cannot be prevented by this contract and are not claimed to be prevented.

## A. Command and argument contract

### A1. Primary command versus CLI

`/iteration-drive` is a host prompt command, not an executable `mstar iteration drive` verb. Its only accepted nonempty forms are:

```text
/iteration-drive --assignment <absolute-md-path>
/iteration-drive --workflow <id> --plan <id>
/iteration-drive --resume <absolute-session-json-path>
```

The first two are fresh addressing forms; the third explicitly resumes an already bound session. Duplicate/unknown flags, positional arguments, missing/blank values, mixed forms and partial workflow/plan pairs fail before any claim. The command loads PM identity in the current primary session and calls the matching `mstar plan bind` form once. A leaf invoking this command is refused by the role boundary, not promoted to PM. No flags means the existing iteration-wide boot and Phase 2–6 route, unchanged. Scoped boot must not load compound/Phase 3–6 merely because whole-iteration boot does.

### A2. Executable CLI

All verbs below are thin calls to §B. Each accepts `--json`; JSON success is `{ok:true, operation, workflow_id, plan_id?, revision?, snapshot_version, session_file?, handoff_id?, state?, outcome?}`; failure is `{ok:false, code, message, workflow_id?, plan_id?, holder?, path?, expected?, actual?}`. JSON goes to stdout with no color/banner; human diagnostics go to stderr otherwise. Exit 0 = successful/no-op operation; 2 = syntax/unknown flags/invalid input shape; 1 = scope, ownership, stale revision, invalid state, Git, path, lock or store rejection. Do not add aliases or a generic JSON-patch escape hatch.

```text
mstar plan bind --coordinator --workflow <id> [--harness <absolute-path>] [--json]
mstar plan bind --assignment <absolute-md-path> [--json]
mstar plan bind --workflow <id> --plan <id> [--harness <absolute-path>] [--json]
mstar plan bind --resume <absolute-session-json-path> [--json]
mstar plan show --session <absolute-session-json-path> [--plan <id>] [--json]
mstar plan prepare --session <coordinator-session> --plan <id> --assignment <absolute-md-path> --expect <revision> [--json]
mstar plan progress --session <plan-session> --file <absolute-json-path> --expect <revision> [--json]
mstar plan residual-add --session <plan-session> --file <absolute-json-path> --expect <revision> --expect-register <version> [--json]
mstar plan residual-close --session <plan-session> --entry <id> --note <text> --expect <revision> --expect-register <version> [--json]
mstar plan handoff --session <plan-session> --file <absolute-json-path> --expect <revision> [--json]
mstar plan accept --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan return --session <coordinator-session> --plan <id> --handoff <id> --reason <text> --expect <revision> [--json]
mstar plan integration-start --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan integration-accept --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan complete --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan reconcile --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
```

`--expect` is the nonnegative row `coordination.revision` from `show` (absent coordination = 0), not snapshot schema_version or date. Every mutating row verb requires it. A sibling mutation does not change this row revision; same-row stale input fails `coordination.version-conflict`. `show` on a plan session accepts no `--plan`; on a coordinator session `--plan` is required. It returns the selected row, scoped paths, allowed operations, snapshot byte version and project-register byte version, not an editable sibling snapshot. After any successful changed row mutation, increment its revision once. No-op replay does not increment it; the revision precondition is checked even for replay, so stale retries first refresh with `show`.

`bind` is the only exception to the external revision flag: it reads/checks/claims atomically against current ownership, without accepting a caller snapshot. Fresh coordinator bind initializes the workflow's coordinator only if absent; a second fresh coordinator fails exactly like a duplicate plan holder. Resume returns current context without changing ownership or revision. Coordinator creation requires cwd in the verified main or recorded integration worktree, a registered running iteration, and no existing coordinated actor; it is the trusted local bootstrap, not an OS-authentication mechanism. Plan fresh bind requires a prepared row. There is no `--force`, arbitrary holder input, takeover, lease-release verb or automatic credential discovery.

Coordinator `prepare` registers the reviewed Assignment and releases this plan's dependencies for execution after checking they are actually ready. It is preparation, not another business plan. Dependencies and task readiness are PM judgment; the engine records the prepared authorization and checks exact path, branch, status and lock inputs, not prose intent.

## B. Engine boundaries and final exports

Implement `packages/engine/src/coordination.ts` and export its public API from `packages/engine/src/index.ts`. CLI implementation belongs in `packages/cli/src/plan-coordination.ts`, registered from `index.ts`. No second store path table, lock service or host session service.

```ts
type PlanScopeInput =
  | { assignmentPath: string }
  | { workflowId: string; planId: string; harnessDir?: string };
type CoordinationSession = {
  schema_version: 1;
  role: "plan-pm" | "coordinator";
  session_id: string;
  workflow_id: string;
  plan_id?: string;
  harness_root: string;
};
type BindPlanSessionInput =
  | { scope: PlanScopeInput; cwd: string }
  | { coordinator: true; workflowId: string; harnessDir?: string; cwd: string }
  | { resumePath: string; cwd: string };
type CoordinationRequest = {
  sessionPath: string;
  planId?: string;
  expectedRevision: number;
  operation: PlanCoordinationOperation;
};
type PlanCoordinationOperation =
  | { kind: "prepare"; assignmentPath: string }
  | { kind: "progress"; progress: PlanProgress }
  | { kind: "residual-add"; entries: ResidualEntry[]; expectedRegisterVersion: string }
  | { kind: "residual-close"; entryId: string; note: string; expectedRegisterVersion: string }
  | { kind: "handoff"; evidence: HandoffEvidence }
  | { kind: "accept"; handoffId: string }
  | { kind: "return"; handoffId: string; reason: string }
  | { kind: "integration-start"; handoffId: string }
  | { kind: "integration-accept"; handoffId: string }
  | { kind: "complete"; handoffId: string }
  | { kind: "reconcile"; handoffId: string };
```

Final function signatures (export named types shown here and in §D):

```ts
resolvePlanScope(input: PlanScopeInput, cwd: string): Promise<ResolvedPlanScope>
bindPlanSession(input: BindPlanSessionInput): Promise<CoordinationResult>
readPlanCoordination(sessionPath: string, planId?: string): Promise<PlanCoordinationView>
mutatePlanCoordination(request: CoordinationRequest): Promise<CoordinationResult>
readCoordinatedArtifact(harnessRoot: string, ref: ArtifactRef): Promise<VersionedArtifact>
replaceCoordinatedArtifact(input: CoordinatedReplacement): Promise<VersionedArtifact>
```

`ResolvedPlanScope` is `{harnessRoot,workflowId,planId,snapshotPath,planPath,assignmentPath,worktreePath,workingBranch,projectId,sddDir}` (all paths canonical absolute). `VersionedArtifact` is `{payload:unknown|undefined,version:string}`. `PlanCoordinationView` is `{session:CoordinationSession,scope:ResolvedPlanScope|null,row:PlanRow,revision:number,snapshot_version:string,register_version:string,allowed_operations:string[]}`. Coordinator show on an unprepared row returns `scope:null`, revision 0 and `prepare` allowed, so first preparation is reachable; plan-session views always have a resolved scope. `CoordinationResult` has the CLI success shape in A2 plus `view?:PlanCoordinationView`. `CoordinatedReplacement` is `{harnessRoot:string,ref:ArtifactRef,payload:unknown,expectedVersion:string,sessionPath?:string}`. Stable exceptions use exported `CoordinationError extends Error` with `code` and `details: Record<string,unknown>`; error codes in this spec are consumer contracts, wording is not.

`resolvePlanScope` only resolves and validates; it never claims. Exported `mutatePlanCoordination` takes a discriminated operation, never a row/snapshot callback or arbitrary fields. Unknown JSON keys anywhere in operation/session/evidence/preparation are rejected before mutation. Internal helpers may share locked implementation, but no exported raw write bypass or generic patch operation is added.

## C. Binding, preparation, scope and versions

### C1. Address and Assignment agreement

Reuse `readMainWorktree`, existing `resolveProcessHarnessDir` policy (move the reusable resolver into engine coordination, then have the CLI helper consume it), `resolveWorkflowDir`, `resolveProjectDir`, `resolvePlanDir`, `resolveSddDir` and `resolveArtifactPath`. Explicit harness paths remain valid even outside main when intentionally configured, but assignment/session/active FsStore must resolve to that same chosen root. Record the chosen root in the session, not as a new main-root field on the snapshot. Git must identify one real main worktree and the same repository for main/integration/feature; a broken linked checkout must not fall back to its local artifacts. Canonicalize existing parents and symlinks before equality; reject `..`, nonabsolute handoff/session/assignment/evidence paths, traversal IDs, ambiguous plan `id`/`plan_id`, and mismatched keys. Use existing plan-row ID convention; when both IDs exist they must agree.

The portable Assignment is Markdown using existing English header fields (outside examples/fences): `Execution scope: plan`, `Execute as: project-manager`, `Delegation: allowed (plan-local implementation/review/qa only)`, `Workflow id`, `Plan id`, `Control harness root`, `Plan Path`, `Worktree path`, `Working branch`, `SDD dir`, `QA gate: mandatory|pm-acceptance`, `Findings cleanup: zero-residual|allow-residual`, `Main worktree branch`, and `Prepare gate: go`. Reject duplicate conflicting headers. Its body contains the prepared plan and review instructions, never a leaf IDENTITY block. Both direct addresses resolve the same registered Assignment; `--workflow/--plan` reads `row.coordination.prepared.assignment_path`, never selects the first unfinished row. `prepare` requires exact `row.file`/plan-path identity, an existing feature worktree on its assigned branch, distinct main/integration/feature paths, aligned snapshot integration anchors, valid main residency, and row `Todo` or `Blocked` without a lease/session/handoff. Plan project = string `metadata.project_id` or `_default`; no caller override.

Preparation stores `{assignment_path,assignment_sha256,plan_sha256,qa_gate,findings_cleanup,prepared_by,prepared_at}` under the row. Hashes are SHA-256 of exact UTF-8 file bytes. Fresh bind rechecks both hashes; stale preparation fails `coordination.assignment-stale` and requires coordinator re-prepare. After claim, Assignment is immutable: every show/resume/mutation rechecks its hash; content change fails without changing state. Plan Markdown can receive task/gate updates after claim, so its claim-time hash is provenance, not a perpetual lock. To amend an active Assignment, stop its writable work and restore the pinned file; this slice does not silently rebind to edited authorization. No assignment contents or mutable plan-state copies are added to session envelopes.

### C2. Persisted ownership

The snapshot gains optional `coordination: {coordinator: {session_id,session_file,bound_at}}`. A row gains optional `coordination: {revision,prepared?,session?,progress?,handoff?}`. Coordinator is unique per workflow; each row session is `{session_id,session_file,bound_at}`. A new session UUID is generated by the engine, and its JSON envelope is stored at `<resolved-workflow-dir>/<workflow-id>/sessions/<session-id>.json` using exclusive creation. Files are private (mode 0600); they contain no copied snapshot. Stage/write the envelope inside the validated binding critical section before the snapshot commit, remove only the just-created uncommitted envelope on failure; a crash-orphan envelope grants no ownership because all calls match the snapshot. Fresh duplicate attempts do not allocate a committed session. All later calls read the named envelope and match every identity field and canonical session-file path to the snapshot. A copied/edited assignment never becomes a resume credential. Possession of the original session envelope permits explicit resume; copied credentials/arbitrary filesystem writes are outside the security guarantee.

Fresh plan bind uses `claimLease(row, session_id, fields)` and atomically writes the row session, retained `metadata.working_branch`/`metadata.worktree_path`, status `InProgress`, and revision. Existing foreign lease, orphan `InProgress`, Done row or already handed-off row fails. No implicit same-holder resume from assignment. Explicit `--resume` validates the current session and lease; it may report handed-off/accepted/completed read-only context but does not reacquire released leases or restart execution. A scoped session must never receive the coordinator session path in its Assignment or child dispatch.

### C3. Lock and conflict protocol

- Lock pathname stays `<document-dir>/.status-write.lockdir` via `withStatusWriteLock`; existing timeout, PID diagnosis, nonreentrancy and `(dev,ino)` ownership checks remain. Never automatically delete a stale lock or steal an execution lease. A leaked lock requires the operator to verify no writer is alive and remove that specific lock before `reconcile`; PID age/pane status alone is not proof.
- Snapshot operation: canonicalize root/store/path, acquire snapshot lock, read latest bytes and parse/validate, authenticate session and Assignment, check row revision and transition/allowlist, read required Git/evidence facts, build only the allowed delta, validate resulting snapshot, then atomically store it. Never compute a full replacement before acquiring the lock. Whole-document serialization under the lock is acceptable; sibling objects/unknown unrelated fields must be preserved semantically.
- `revision` changes only with row changes, so independent plan mutations with the same starting snapshot preserve both. Global coordinator binding uses snapshot lock but does not increment arbitrary row revisions. It changes only top coordination and `updated_at`.
- Artifact version is `sha256:<64 lowercase hex>` of exact on-disk bytes; missing = `absent`. `readCoordinatedArtifact` reads bytes once, derives payload/version from that same read and validates the corresponding kind. No use of mtime/date/schema version as CAS. `replaceCoordinatedArtifact` requires `expectedVersion`, re-reads and compares inside the document lock, validates then writes. No automatic retry/rebase of caller replacements. Missing version = `coordination.expected-version-required`; mismatch = `coordination.version-conflict` with expected/actual/path and reload guidance.
- Residual operations acquire snapshot lock then project-register lock; authenticate under snapshot lock and mutate the fixed `entries[planId]` bucket inside register lock. Check expected row revision plus register byte version; duplicate IDs fail. Do not use the existing backlog next-free-key behavior for plan residuals. Write only the register (no snapshot/revision bump), so there is no two-document commit pretending to be atomic. Snapshot lock prevents ownership transfer during the write. Handoff/complete use the same lock order when checking findings cleanup. Global multi-document writers use root → snapshot(s ordered by canonical path) → register(s ordered by canonical path). No inverse nested acquisition; single-document operations do not acquire root.

For generic root/register replacements and legacy register helpers, protection discovery must hold root then the relevant workflow snapshot locks before the destination lock, and recheck the protected-plan set there. Merely scanning a snapshot before locking a register would race a new prepare/bind and is forbidden. Root register writers that validate a coordinated snapshot follow the same root→snapshot order. The pure domain path never acquires root while holding snapshot. Missing register is `absent`/empty-bucket for show, cleanup checks and first residual-add; malformed existing register fails, never normalizes to empty.

### C4. Whole-writer cutover (required, not optional hardening)

`ArtifactStore.put/get/delete/list` public port stays async with its current signatures. Add a private engine authorization context for protected filesystem writes, created only by the locked coordination/writer implementation; it records canonical target and operation permission, not a caller-supplied boolean. `FsStore.put/delete` reject protected targets outside that context with `coordination.direct-write-refused`. No reentrant lock acquisition in the store: caller owns the lock. `review`/unrelated `json` retain current behavior. Classify `json` aliases by canonical target path against resolved protected roots; an absolute/symlink alias to status/snapshot/residuals cannot bypass classification. Direct low-level arbitrary `writeJson` is outside the public promise, but all supported callers below must migrate.

- `writeWorkflowSnapshot(snapshot, dir, {expectedVersion,sessionPath?})`: change signature; no missing-version compatibility fallback. Existing snapshots without coordination may use locked CAS; initial creation requires `absent`. For a coordinated snapshot require the matching coordinator session and exact preservation of `plans`, `coordination`, both lease kinds, id/type/started_at, branch anchors, integration path and all unknown fields; the only replacement delta allowed is `phase` plus `updated_at`. Lifecycle terminal changes use `closeWorkflow`, not replacement. Reject adding/removing coordination through replacement. Thus the existing coordinator can persist its phase projection without gaining a backdoor to overwrite row owners. Update every direct caller and affected tests.
- `closeWorkflow`: preserve fresh locked read and terminal-before-unregister ordering; accept optional `sessionPath` in `CloseWorkflowOptions`, required/matched coordinator for coordinated workflows. Never infer plan actor is coordinator or remove leases. A coordinated workflow can close only after all rows Done and no leases; Phase 6 remains coordinator-owned.
- `registerWorkflow` / `unregisterWorkflow` / `registerWorkflowEntryLocked`: keep root locked in-place semantics, route put through private write context, and enforce current snapshot identity/terminal state. Unregister a running coordinated workflow is refused; register cannot replace identity/dir of an existing coordinated workflow. These root operations are not in a plan actor's allowlist.
- `appendProjectRegisterEntries` / `closeProjectRegisterEntry`: keep legacy backlog semantics for uncoordinated keys and use locked private writes; reject an existing coordinated plan key (`coordination.scoped-writer-required`) before the next-free-key loop or close, directing the caller to `residual-add`/`residual-close`. Identify coordinated ownership from validated registered workflow snapshots under root → relevant snapshot → register locks, not a cached plan list. Never bump a coordinated plan key to escape ownership.
- `persist <kind>`: status/snapshot/residuals require `--expect-version <version>` and call `replaceCoordinatedArtifact`; `persist get ... --versioned` returns `{payload,version}`. Coordinated snapshot replacement additionally requires `--session <coordinator-session>` and the phase-only delta above; reject plan sessions. Refuse replacement of any root that registers a coordinated workflow (current or proposed), or a register containing a coordinated plan bucket (current or proposed). Refuse `persist delete` for all protected kinds/aliases; lifecycle close is not deletion. `persist get/list` stay read-only. Unrelated review/json retains existing behavior. Invalid/unknown/mixed flags fail closed. Add `--session <coordinator-session>` to `status workflow-close` for the coordinated close requirement; the legacy uncoordinated invocation is unchanged.
- `promoteAuditPlans` (`audit.ts`): replace direct snapshot `writeJson` with locked create-only (`absent`) storage under root → snapshot order. On registration failure, remove only the exact snapshot version this call created under snapshot lock; never delete a snapshot another writer changed. Existing re-promote refusal remains.
- `applyMigratePlan` (`migrate.ts`): stop snapshot/register/root raw overwrite paths. Under root lock, recheck the source byte version before additive writes; create missing snapshots/registers with `absent`, accept existing target only if byte-equivalent to the planned payload, otherwise refuse. A v2 root is still a no-op before any writes. Refuse coordinated target state; keep archive-first/root-last semantics. No new layout migration or schema bump.
- `scaffoldHarness` (`path.ts:471-490`): change to `scaffoldHarness(root: string): Promise<string>` and migrate all callers to await it. Initial protected state writes use locked `absent` semantics; concurrent existing state is never replaced (an existing empty/malformed document now fails validation rather than being silently reinitialized). It never creates scoped sessions or coordination records. Retain unrelated directory/roadmap bootstrap behavior.
- Injected/custom stores without the canonical local FsStore identity are rejected by the new coordination and protected replacement APIs with `coordination.local-store-required`; do not claim same-host CAS on an arbitrary remote module. Existing noncoordinated ArtifactStore operations outside this capability keep their prior contract. No distributed store capability protocol is added.

The reusable process-root export is `resolveProcessHarnessDir(cwd: string, harnessDir?: string): string | null` from `coordination.ts`; CLI callers pass their real cwd and preserve current non-Git fallback behavior for existing unscoped commands. Scoped bind/operations add the stricter required-Git checks in C1. Stable refusal codes also include `coordination.duplicate-holder`, `coordination.scope-mismatch`, `coordination.path-mismatch`, `coordination.invalid-transition`, and `coordination.session-mismatch`. No `--session` accepts role/scope claims solely from its JSON; the persisted binding is checked inside the lock.

## D. Domain allowlist and handoff shape

All operations may change snapshot `updated_at` when they write it; all row operations except residual-only writes increment only that row's revision. No operation accepts row identity/file/title, global branch/base/target/integration, integration_worktree_path, execution_policy, lifecycle phase/status, compass_ref, sibling metadata or a caller-selected project. Extra fields are an error, not silently ignored. Root/global lifecycle operations stay in their existing coordinator route, never `mutatePlanCoordination`.

| Operation / actor | Permitted writes and transitions |
|---|---|
| coordinator bind / trusted local bootstrap | top `coordination.coordinator`, `updated_at`; existing coordinator requires explicit resume |
| prepare / coordinator | selected row `coordination.prepared`, revision; Todo/Blocked with no execution/session/handoff; no source status change |
| plan bind / fresh prepared session | `execution_lease`, row session/revision, `status=InProgress`, retained metadata.working_branch/worktree_path; no other metadata |
| progress / active plan session | `status`, `coordination.progress`, revision, `metadata.track_branches`; InProgress→InProgress/InReview/Blocked, Blocked→Blocked/InProgress, InReview→InReview/InProgress/Blocked before handoff; never Todo/Done or lease removal |
| residual-add / active plan session | only `entries[planId]` append; generate source_plan, lifecycle_id and registered_at; other buckets untouched; no next-free key |
| residual-close / active plan session | only selected entry lifecycle=`resolved`, closed_at, closure_note after nonblank evidence-bearing note; no ID/severity rewriting |
| handoff / plan session | require InReview, no active child writes, QC/QA gate and findings cleanup evidence; set immutable submitted handoff record, revision; keep execution lease |
| accept / coordinator | submitted→accepted, record accepted_by/at; transfer `execution_lease.holder` to coordinator session while retaining worktree/branch and original row session; no merge or Done |
| return / coordinator | submitted/accepted→returned with reason/returned_at, restore execution holder to original plan session, status InProgress; cannot return an un-reconciled integrating/merged/completed record |
| integration-start / coordinator | accepted→integrating; atomically claim top integration_merge_lease and set attempt base/pin/time; preserve InReview/execution ownership |
| integration-accept / coordinator | integrating→merged only after §E Git proof; record observed result; keep both leases and InReview until complete |
| complete / coordinator | merged→completed; verified Git proof + evidence + findings gate, status Done, retain metadata.working_branch/worktree_path and existing track_branches, delete row execution_lease and own integration_merge_lease in ONE snapshot write |
| reconcile / coordinator | integrating/merged/completed only; follow §E table, never invoke merge; when proven complete, same atomic completion delta; unrelated rows and global anchors unchanged |

`PlanProgress = {status:"InProgress"|"InReview"|"Blocked",summary:string,evidence_paths:string[],track_branches?:string[]}`. Require nonblank summary; paths are existing canonical absolute artifacts within this plan's resolved plan/SDD area, and track branches must belong to its recorded L2 Assignments/worktrees, never another plan/main/integration. Replacing the current progress summary is intentional; task history remains the existing plan/SDD ledger. Reject progress/residual mutation while handoff is submitted, accepted, integrating, merged or completed. A returned record remains visible; a new handoff replaces it with `attempt = previous.attempt + 1`, preventing old-id replay.

```ts
type EvidenceRef = { path: string; sha256: string };
type HandoffEvidence = {
  source_sha: string;
  review_base: string;
  review_head: string;
  qc: { decision: "Approve" | "Approve with residuals"; reports: string[]; consolidated: string };
  qa: { gate: "mandatory" | "pm-acceptance"; decision: "pass"; report: string };
};
type PlanHandoff = {
  id: string;
  attempt: number;
  state: "submitted" | "accepted" | "returned" | "integrating" | "merged" | "completed";
  submitted_by: string;
  submitted_at: string;
  source_branch: string;
  source_sha: string;
  worktree_path: string;
  review_base: string;
  review_head: string;
  qc: { decision: "Approve" | "Approve with residuals"; reports: EvidenceRef[]; consolidated: EvidenceRef };
  qa: { gate: "mandatory" | "pm-acceptance"; decision: "pass"; report: EvidenceRef };
  accepted_by?: string;
  accepted_at?: string;
  returned_at?: string;
  return_reason?: string;
  integration?: { target_branch: string; worktree_path: string; base_sha: string; started_at: string; result_sha?: string; verified_at?: string };
  completed_at?: string;
};
```

All SHA inputs are full Git object IDs resolved/verified in the same repository, accepting its object format (40 or 64 lowercase hex); hashes for file evidence are SHA-256 without the artifact-version prefix. Engine generates handoff UUID, attempt and timestamps; input cannot set state, holder or target. `review_head === source_sha === feature branch HEAD === feature worktree HEAD`; review_base must be an ancestor, worktree clean, no merge/rebase/cherry-pick in progress. Existing review contracts determine QC seat count (sdd tri, explicit inline/single exception) and valid decisions; mandatory QA requires QA report, pm-acceptance requires the PM acceptance artifact. Engine validates report existence/digests, named decision/shape and Git pins, not the quality of human/model judgment. `findingsCleanupGate` is invoked on the plan's exact register bucket at handoff and completion; Approve with residuals is allowed only when that gate and prepared policy allow it. Revalidate evidence digests on accept, integration-start, integration-accept and complete; edited evidence requires return/review, never relabeling the old pin.

The “no active child writes” handoff prerequisite is the scoped PM's verified SDD/host preflight, not an engine claim to introspect every host job. Once handed off, the engine rejects all further scoped progress/residual mutations until return. Feature HEAD/cleanliness equality is required at handoff, accept and integration-start. After integration has started, proof uses the pinned Git objects; complete/reconcile must not require a feature branch/worktree that authorized same-round cleanup may later remove. Completed replay checks durable Git proof without requiring retained process reports to be rewritten or resurrecting ownership.

## E. Serial integration and explicit crash reconciliation

`accept` is ownership transfer, not integration acceptance. `integration-start` reads clean recorded integration checkout on snapshot.branch.integration, verifies source/evidence pins still match, refuses any foreign merge lease, and records current integration HEAD as `base_sha` plus the immutable source pin before Git is run. Retrying the same started attempt is a no-op after revision refresh; it never moves base_sha. The coordinator then performs exactly `git -C <integration-path> merge --no-ff --no-edit <pinned-source-sha>` (argument-array invocation, not shell interpolation). No squash/rebase or moving branch-name merge. CLI state verbs do not execute this Git mutation; it remains the authorized coordinator's explicit Git action.

`integration-accept`/`complete`/`reconcile` verify recorded integration branch/worktree/repository, source/evidence pins, no unfinished Git operation and these facts: result is the recorded base when source was already its ancestor (already-integrated no-op), OR result is a two-parent merge commit with first parent exactly base_sha and second parent exactly source_sha. The recorded result must be reachable from the current integration HEAD. For initial recovery after a crash, find the unique such merge on the first-parent path from base_sha to current HEAD; zero/multiple candidates cannot be guessed. Later unrelated commits are acceptable only when the proven result remains an ancestor; no false success from merely finding source on an unrelated branch. Complete rechecks the proof rather than trusting state=`merged`.

| Observed recovery state | `reconcile` result |
|---|---|
| integrating; HEAD==base; clean; source not already ancestor | Return attempt to accepted, remove integration attempt and only this holder's merge lease, retain coordinator execution lease/InReview; outcome `retry-ready`; no merge performed |
| integrating; source already ancestor of base, or unique exact merge proof exists and is ancestor of HEAD | Record proof then apply atomic completion; outcome `completed`; no duplicate merge |
| integrating; MERGE_HEAD/conflicts or dirty checkout | Refuse `coordination.integration-unresolved`, preserve all state/leases; operator resolves or explicitly aborts Git, then reruns reconcile |
| integrating/merged; moved/missing branch, unexpected parent graph, multiple matching results, unavailable objects or changed evidence | Refuse `coordination.integration-diverged` (or `coordination.evidence-stale`); no Done or lease release |
| merged; proof still valid | Apply normal complete atomically; outcome `completed` |
| completed; same handoff and valid recorded proof | Read-only no-op `already-completed`; no lease reacquisition or revised timestamps |

If return is needed after merge failed: abort the Git merge explicitly, run reconcile to retry-ready, then `return`. Never discard a merge lease while Git may still be in flight. A crash after complete but before CLI output is handled by show+reconcile with the current revision. A crash before session snapshot binding leaves only an inert envelope. Lost credentials or an abandoned active owner need explicit human recovery outside normal commands; no automatic takeover flag is introduced.

## F. Runtime rule homes and replacement inventory

These are the exact ownership boundaries for the command/skill plan; implementations link rather than duplicate tables.

| Authoritative home | Required change |
|---|---|
| `commands/iteration-drive.md` | accepted argument forms and branch-to-scoped-boot; keep no-arg Phase 2–6 route |
| `skills/mstar-iteration/references/plan-scoped-pm.md` (new) | primary scoped boot, prepare/bind/show calls, plan-only backlog/goals/todos/STOP, plan-local SDD/QC/QA finish at handoff, coordinator accept/return/integration command sequence |
| `skills/mstar-roles/references/project-manager.md` + `project-manager/dispatch-and-assignment.md` | primary role with bounded plan authority; portable primary Assignment header, no leaf promotion/PM subagent shell; inherited child scope |
| `skills/mstar-iteration/SKILL.md`, `references/command-shared-invariants.md`, `references/phase-2-worktree-lease.md` | select scoped route before global todo/last-plan logic; replace manual claim/status/transfer/merge-completion protocol with A2 calls; coordinator-only global projections/Phase 3–6 |
| `skills/mstar-artifacts/references/status-and-residuals.md` | sole runtime field/schema home for coordination/session/handoff/revision and row/register ownership; replace manual snapshot/residual mutation examples with domain calls; link actual CLI reference |
| `skills/mstar-branch-worktree/SKILL.md` | retained ownership after complete and unchanged L1/L2/cleanup gates; replace manual Done+lease-delete instruction with complete/reconcile pointer |
| `skills/mstar-dispatch-gates/SKILL.md`, `skills/mstar-sdd/SKILL.md`, `skills/mstar-sdd/references/file-handoffs.md` | enforce child plan/path scope at preflight and preserve existing task reviewer/QC/QA separation; no credential passed to leaves |
| `skills/mstar-host/SKILL.md` and its seven host refs | goal applies to active scope, not always iteration; dsh still does not arm `/goal`; host syntax/transport pointers only, no duplicated engine protocol |
| `skills/mstar-artifacts/SKILL.md`, `skills/pm/SKILL.md` | short entry/field pointers only if their current instructions would bypass the new scope route |
| `docs/cli.md` | executable `mstar plan` and persist flags (CLI owner only) |
| `docs/plan-scoped-pm.md`, README.md/README_CN.md | user session recipe, both entry forms, explicit resume, non-goals and optional Herdr/tmux transport; link command reference |

The engine-present manual clauses to replace are phase-2 §2.4 steps 1/3/5 (manual lease claim, snapshot update, Done/lease deletion), “Same-host exclusive write lock”'s claim that locking only `writeWorkflowSnapshot` protects an outside read, “lease release is manual owner action” cleanup wording, and status-and-residuals claim/release/status/register snippets. Read-only lease/worktree validators remain checks, not mutation substitutes. Do not load or edit the engine-absent legacy fallback as if it provides the new scoped feature: without this CLI the scoped route fails with install/upgrade guidance; no prompt-only or raw-write fallback. Existing unscoped engine-absent behavior is intentionally unchanged.

## G. Non-goals, validation and delivery

Non-goals: cross-machine/distributed coordination; arbitrary filesystem sandboxing; TTL/heartbeat/idle theft; new PM role/shell; agent fleet service; auto pane/session spawning; unrelated host configuration; real-browser/device/installed-deployment E2E gates; additional business plans. The persistent prepared Assignment is intentionally immutable during an execution; no hot authorization rebinding, distributed store protocol or automatic abandoned-owner recovery is part of this scope.

State safety is verified by deterministic targeted engine regressions: multiprocess updates to different rows, duplicate claims through both address forms, same-row revision conflicts, unchanged bytes on invalid scope/identity/transition, guarded whole-write aliases, residual preservation and Git crash reconciliation. CLI subprocess tests and a real temporary-repository smoke exercise executable operations without a multiplexer. Policy changes use concrete before/after pressure scenarios plus static links/name checks, not universal model-compliance claims. No-argument prompt drive is proven by scoped routing evidence, not mislabeled as a nonexistent CLI verb test. Tests and selectors are frozen per task in the two delivery plans; no full local suite.

One bilingual fragment per logical change; paired README usage must remain aligned. All tracked examples use synthetic IDs and placeholder control roots, never this preparation's actual plan IDs/SHAs/paths. Preparation edits here are document evidence only; no runtime test, build, lint, formatter or installed-agent claim is made.
