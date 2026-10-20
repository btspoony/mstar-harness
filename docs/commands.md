# Command reference

The slash commands this repository ships live in [`commands/`](../commands). This page indexes all seven: what each one does, the argument form it accepts, which sibling to reach for, and the skill that owns its semantics.

Two boundaries hold across the page. All seven are **user entry points** — a command boots `project-manager` in your current session, and none of them is a subagent target: a leaf executor that receives one refuses it on role grounds. And this page is a **router, not a second protocol home** — every behavioural rule stays with its owning skill, while the `mstar-harness` binary reference — the `plan` verbs, flags and exit codes — stays with the **`mstar-use-cli`** skill, and install / `init` / `doctor` with [`INSTALL.md`](../INSTALL.md).

For project roadmap content, use the CLI `mstar roadmap` family (not a slash command): show, reviewed import, revision-guarded replace and transport export. The authoring/read/write rules live only in `mstar-project-governance`; `mstar-use-cli` indexes the family and the built command's `--help` owns its options.

A registered legacy leaf that is not a regular file (a FIFO, socket or device) refuses by type and names its recovery instead of blocking the command. The imported source also participates in the operation identity: repeating one `--operation-id` over changed legacy bytes refuses as a conflict rather than replaying a receipt that describes bytes this run never read, while an unchanged repeat still returns its retained receipt. The v1 route converts from the same descriptor-verified register bytes it classified, and each source hash is taken where the bytes were read, so the receipt describes the input the run consumed. A refused workflow source is always addressable by `--ack-skip-workflow <id>`: an unconvertible plan row refuses as that workflow's source rather than aborting the upgrade, a converted v1 lifecycle whose converted plan rows cannot be imported refuses under its own original id, and a `workflows/` entry that sources nothing behaves like an absent tree. A v1 canonical compass is not a workflow source, so the acknowledgement cannot address it: it is read through the same bounded probe, and a non-regular or swapped-in link refuses by name with both supported repairs (replace it with a regular file to keep the grouping, or remove it to convert those plans as standalone rows) plus the route that starts without importing any legacy source (`store init --harness <new-empty-control-root>`, existing data untouched). Root `status.json` `residual_findings` are not imported by `store upgrade`: the receipt states their count and the supported route (a project register document or the issue verbs) instead of dropping them silently. When a DSH refusal follows a committed execution import, its message and the command's recovery field both name the execution acknowledgement the retry also needs. Both source digests are ordered by code unit, never by the process locale, so the same bytes keep the same identity across machines.

## Store CLI upgrade and recovery

`mstar store upgrade --operator <name> [--harness <path>]` is the single default path for importing recognized v1/v2 workflow state directly into the local store. It creates or opens the store, activates execution authority, and reports unrecognized or unresolvable inputs while preserving original source bytes and paths. The standalone `mstar migrate` file-staging entry is retired; use `store upgrade` without a staging step. Stop older installed writers and align consumers before an authority upgrade; documentation changes do not perform that operational cutover.
If `execution.delivery-declaration-required` or `execution.workflow-skip-unmatched` refuses, its cause appears first, followed by the committed schema version and current issue/catalog and execution authority states. The failed import transaction committed no rows and existing execution rows remain unchanged. Resolve the cause through its source owner, correct the declarations or acknowledgements, then retry with `mstar store upgrade --operator <name>`. Store initialization or normalization may already have committed even though no execution rows were imported.

Active standalone v1 plan lifts require one addressed JSON object per original workflow ID via variadic `--delivery <json...>`. Take IDs from the refusal, not a directory basename. For example, if it lists `v1-build` and `v1-check`, retry the same source with both intents:

```sh
mstar-harness store upgrade --harness .mstar --operator maintenance \
  --delivery '{"workflow":"v1-build","deliveryKind":"development","branchSource":"feature/build","branchTarget":"main"}' \
  '{"workflow":"v1-check","deliveryKind":"verification/report-only","completionPolicy":"report at reports/check.md"}'
```

Each object requires `workflow` and `deliveryKind`; `development` also requires `branchSource`/`branchTarget`, while `verification/report-only` requires `completionPolicy`. Kind is never inferred. Missing, duplicate, unmatched or incoherent declarations refuse before execution-row registration; store initialization/activation may already have committed. Retry the same entry with the corrected declarations, preserving source bytes, IDs, statuses and progress. Completed v1 rows, v2 snapshots, iterations and empty roots need none: inapplicable declarations refuse, so omit them on retry rather than backfilling an immutable kind. Current help owns the exact flags and schema; MCP accepts the same objects in its `delivery` array.

The six `store` verbs administer project harnesses, including the main worktree's canonical control root. `--harness <path>` selects that project explicitly; omitting it uses normal discovery from the working directory. CLI and MCP use the same domain operations. Native SQLite transactions/CAS, authorization, verified-backup checks and migration/activation guards remain; application file/directory mutexes do not.

For an existing store, retain a verified recovery image before upgrading:

```text
mstar store backup --harness {HARNESS_DIR} --out <absolute-backup.db>
mstar store upgrade --harness {HARNESS_DIR} --operator <name>
```

If a retired held claim requires the operator's full stop attestation, construct the document using `mstar schema --command store.upgrade` and retry the same upgrade with `--attestation <absolute-json>`. Do not hand-edit the store or replace the project target with a fixture to evade a refusal.

The remaining `store` verbs are `init`, `migrate`, `backup`, `activate`, and `retire`. `migrate` / `activate` / `retire` remain the separate issue/catalog migration flow. The only remaining `store execution` verbs are `restore-preview`, `restore`, and `export`: restore previews and restores use a standalone `store backup` image; export reports the current execution state. Receipt retention is an expected source of backup-only `execution` operation rows: a terminal close or adoption prunes that workflow's operation receipts (each listed in a preview of an older point with `liveRevision: null`), the init-time purge beside the in-place epoch bump clears the superseded epoch's, and a restore preserves prior-epoch receipt rows as history under its frozen bytes-plus-one-epoch contract, outside the current epoch's replay scope, so restoring any of them is harmless and re-arms nothing. `result_json` payloads are write-time versioned: graph rows written before the slimming change keep their full form, later rows carry the slim envelope, so inventory digests compare write-time bytes per row and mixed forms never produce same-key content drift. Staged execution preview/apply/activate/retire/abort and the safe-upgrade verb are removed.

Backup captures a consistent native database image, including committed WAL state; it does not freeze ordinary documents, logs or `notes.jsonl`. Restore replaces the issue/catalog/execution/host authority domains in one native transaction on the same live database file, commits a new epoch and retains authorization, loss acknowledgement, stale-preview checks and a verified safety image. It neither rolls back ordinary file bodies nor renames the live database or removes its WAL/SHM files. Exact restore inputs and recovery belong to the current command help.

The native restore receipt is authoritative. Failure to write its optional filesystem copy does not turn an already-committed restore into a refusal: the successful result returns `recoveryReceiptPath: null`. A proven pre-commit failure reclaims only that attempt's newly owned safety image; a changed or unreadable store generation preserves the image rather than treating a missing operation row as proof that no commit occurred. Dsh skip acknowledgements can recover unregistered Dsh-only symlink sources without following them, including a symlinked whole `workflows/` root with `--ack-skip-dsh dsh-workflows`; the receipt discloses the dropped source while preserving the link and target bytes. This never authorizes reading or discarding registered execution sources through symlinks. A refused Dsh phase that runs *after* the execution phase already committed names its complete retry in one message and in the same command's structured recovery: the `--ack-skip-dsh <selector>` selectors it lists; `--ack-skip-workflow <id...>` for the union of the ids that invocation committed — which the retry's own retained receipt now proves were imported from these exact bytes, so repeating them is accepted and reported as unnecessary while omitting them needs no acknowledgement — and the original acknowledgements the unchanged root still requires (for example a duplicated v1 plan id or an unsafe registered source); plus, for a v1 root, the same `--delivery <json>` declarations and `--ack-skip-compass <iteration-id>` acknowledgements that invocation used, because the unchanged root still needs one delivery declaration per active standalone plan lift and still refuses that non-regular compass. A retry that omitted the still-required acknowledgements would refuse again before reaching the Dsh phase.

For registered execution sources whose root/directory is not a real in-root directory, whose nested snapshot/source is a symlink or non-regular file, and for recognized v1/v2 source workflows whose IDs already exist in the native store, `--ack-skip-workflow <id...>` explicitly skips importing only the original IDs named by the refusal. A collision is not by itself proof of a previous import, but the store's **own retained import receipts are**: every committed import records a `store_operations` receipt carrying the consumed `sourceDigest`, the `inputDigest` of the caller's own conversion-shaping input, and the `importedIds` it committed, and that table is never pruned. An id a retained receipt for **these exact source bytes** already lists is a **proven replay** — it needs no acknowledgement, is reported in `dispositions` (naming the id and stating that the native authority already holds it from an import of these exact bytes), and never overwrites or deletes a native row. Source bytes alone cannot prove which `--delivery` declarations or `--ack-skip-compass` acknowledgements an earlier import consumed, because those shape the rows without touching the bytes: a run carrying **neither** still relies on the bytes alone (so a receipt retained by an older CLI, which recorded no `inputDigest`, still proves that repeat), while a run carrying **either** needs the receipt to record the same `inputDigest` — otherwise the id stays an unproven collision. Any other collision — an unrelated workflow that happens to share the id, a source whose bytes changed after the recorded import, or a same-bytes receipt that does not prove this run's conversion-shaping input was consumed — keeps refusing and still needs the acknowledgement; in the last case the refusal says so, because such a receipt cannot prove which input its committed rows came from, so this run treats the id as no proven replay and leaves the native rows unchanged. Current native workflow, plan, session and progress rows stay authoritative and are not replaced. Unsafe directory paths are skipped before child probing; unsafe nested source bytes and linked targets are never read. Sources are opened without following the final symlink and validated/read through that same descriptor. Source bytes remain preserved and receipts name each lost import without claiming automatic resumption. Dsh disposal still needs its independent acknowledgement. For a linked whole root naming `legacy-a` and `legacy-b`, retry the same source with:

```sh
mstar-harness store upgrade --harness .mstar --operator maintenance \
  --ack-skip-workflow legacy-a legacy-b --ack-skip-dsh dsh-workflows
```

Only acknowledge imports you intend to lose. Unknown IDs and IDs that are neither refused unsafe sources nor recognized native-ID collisions produce a usage error (exit 2) before registered unsafe-source refusals; remove those IDs and retry the same source, or omit `--ack-skip-workflow` entirely. A missing snapshot in a real registered directory remains a reported skip, not an acknowledgement target; this is not a missing-directory recovery. Per-directory Dsh selectors come from the separate Dsh refusal; use `store upgrade --help` for the CLI input or MCP `ackSkipWorkflow: ["legacy-a", "legacy-b"]`. Genuine same-operation replay uses its retained native receipt; a repeat under a new operation id is served by the same-source receipt above, so an **unchanged** re-run reports `verdict: "nothing-to-import"` with `imported: 0` and exit code 0 instead of refusing. Only a collision with **no** same-source provenance must still be acknowledged explicitly — and a run carrying `--delivery`/`--ack-skip-compass` needs that provenance to cover the same input, so changing a declaration without changing the source refuses rather than replaying.

A **duplicated v1 plan id is a refused source, not an abort**. When several root `plans[]` rows claim one id, the rows are ordered by plan id, then by the owning lifecycle id (the iteration compass that registers that id, empty for an unregistered row), then by row ordinal; the first row survives and each later duplicate is refused on its own, so one duplicated agent-authored row never blocks a healthy sibling source. `--ack-skip-workflow <that plan id>` acknowledges losing exactly those duplicate rows: the surviving row imports, every other source imports normally, and each skipped duplicate is reported with its `plans[]` ordinal and with the status, progress and notes that stay only in the legacy `status.json`. Without that acknowledgement the run refuses before the import transaction commits any execution row.

A **non-regular v1 iteration compass has its own acknowledgement**, `--ack-skip-compass <iteration-id...>`, which takes the iteration DIRECTORY name under `iterations/`. The acknowledged compass is never read: that iteration produces no lifecycle, and the plan rows it registered convert as standalone plan rows instead — each active one then needs its own `--delivery` declaration. The receipt names the skipped iteration and that grouping loss. The compass refusal itself names all three continuations (replace it with a regular file, acknowledge the skip, or remove it), and an id that names no compass the invocation refused is a usage error (exit 2), never a silent no-op.

The no-follow read is a **trust boundary, not a security boundary**. Both legacy importers assume the control root they read is trusted and defend against **accidental symlink traversal** — a legacy tree relocated by a symlink, or a leaf swapped for a link. A writer who can rename entries *inside* that root is outside the guard's model, and the two readers differ in what they then miss: the execution importer compares the leaf's device/inode against its own probe, so it rejects a leaf swap but is defeated by an ancestor directory replaced **before** that probe; the DSH importer checks only its parent directory's type before opening, so a parent or higher ancestor replaced after that check can still lead the open to a different regular file. Such a writer already controls the imported bytes and the operator's own hook/`.env` execution context. Where a supported flow imports a tree the operator does not trust (for example a `.mstar` copied from another checkout), the correct shape is a **staged, re-validated private copy**, never descriptor anchoring. The guard is also only as wide as the platform's constants, and each flag degrades independently: a runtime omitting `O_NOFOLLOW` loses only the final-symlink refusal, and one omitting `O_NONBLOCK` loses only the non-blocking open — the descriptor type checks remain in both cases (no Windows CI runs today). The guard is described, never implied.

An unsafe root `status.json` cannot identify workflows to acknowledge. Existing native authority remains usable without legacy upgrade. If you deliberately want a fresh native authority with **no legacy imports**, choose a new empty control root and run `store init --harness <new-empty-control-root>`; never reuse an existing store with this create-only entry. Existing stores and legacy bytes remain untouched.

Workflow notes are ordinary admitted append facts, not execution authority. Current-session, provenance and trusted-target checks still govern admission, but an admitted append may finish after a later session revocation. There is no cancellation-after-admission guarantee or SQLite writer transaction spanning the filesystem append; repeated IDs may append again, and receipts return only the note ID.

| Command | Purpose | Owning skill |
|---------|---------|--------------|
| [`/iteration-start`](#iteration-start) | Start an iteration: interactive direction lock, then the full lifecycle | `mstar-iteration` |
| [`/iteration-drive`](#iteration-drive) | Drive/resume the selected locked iteration with one primary coordinator | `mstar-iteration` |
| [`/iteration-loop`](#iteration-loop) | The same lifecycle end to end, autonomous lock, minimal human intervention | `mstar-iteration` |
| [`/codebase-audit`](#codebase-audit) | Read-only survey of a codebase → a prioritized review report | `mstar-audit` |
| [`/amazing-test-audit`](#amazing-test-audit) | Read-only test-suite audit → findings to delete / repair / consolidate tests | `mstar-audit` (`tests` focus) |
| [`/amazing-pr-review`](#amazing-pr-review) | Read-only pre-merge review of a PR / branch / diff → one verdict | `mstar-audit` (`pr` variant) |
| [`/amazing-e2e-check`](#amazing-e2e-check) | Explicitly requested E2E / browser / device / deployment verification | `mstar-e2e` |

iteration-start locks interactively, iteration-drive resumes an already locked iteration, and iteration-loop runs Phase 1→6 autonomously. None launches a per-row PM.

## /iteration-start

```text
/iteration-start [direction] [pause]
```

**Purpose** — Phase 1 of an iteration: research, interactive direction lock with `grill-me`, compass and plans, the Review & Edit chain, PM lock, integration branch — then auto-continue into Phase 2→6.

**When** — you are starting a new iteration and want to converge on its direction with the PM. `pause` stops after Phase 1 (lock + integration worktree) so you can inspect the artifacts and continue later with `/iteration-drive`; `/iteration-loop` is the same lifecycle with an autonomous lock instead.

**Args** — `direction` is a free-text hint that narrows the candidate scope and seeds `grill-me`; it is not a lock, and the lock stays interactive. A token that is exactly `pause` (case-insensitive) is the flag; the remaining tokens join into `direction`, so `/iteration-start pause` is a pause with an empty hint.

**Hosts** — Cursor Plan mode takes the alternate Phase 1 path (empty CreatePlan scaffold → feedback loop → deferred grill) instead of the sections below; every other host runs the plain path. It is the only command that reads the bundled, non-`mstar-*` `skills/grill-me/` skill.

**Defined in** — [`commands/iteration-start.md`](../commands/iteration-start.md); semantics → `mstar-iteration` (`references/phase-1-prepare.md` for Phase 1 detail, `references/command-shared-invariants.md` for the Phase 2–5 shared invariants); host dispatch → `mstar-host`.

## /iteration-drive

```text
/iteration-drive
```

**Purpose** — drive the active iteration to completion: Phase 2 Autonomous Execute → Phase 3 iteration-close → Phase 4 Create PR → Phase 5 PR merge-ready → Phase 6 post-merge close. Done is Phase 6 §6.1–§6.4 complete; neither the close, nor an open PR, nor a merged PR is Done by itself.

**When/arguments** — resume or advance an already locked iteration, with no arguments. Reject every nonempty argument shape before boot; never reinterpret unsupported input as whole-iteration authorization. PM stays in the primary session; a leaf receiving this command refuses it.

**Defined in** — [`commands/iteration-drive.md`](../commands/iteration-drive.md); phase route and transition gates → `mstar-iteration` (`references/phase-2-worktree-lease.md`, `references/phase-3-iteration-close.md`, `references/phase-4-5-pr-delivery.md`, `references/phase-6-post-merge-close.md`); Phase 5 helper-skill discovery → `references/phase5-helper-discovery.md`.

### Direct row operations

The primary coordinator uses ordinary `show`, revisable `prepare`, `progress`, `issue-add`, `issue-close` and direct `complete`. Source facts live in row metadata. Defaults are mandatory QA and allow-residual cleanup; configuration remains revisable during active execution, and valid metadata/defaults need no ceremonial prepare record. Leaf Assignments retain task identity/scope/worktree/evidence, not sealed plan admission.

All rows use the same workflow coordinator, transaction/CAS/receipt discipline and declared-route completion:

| Route | Direct completion proof | Outer obligation |
|---|---|---|
| Iteration/non-standalone | Reviewed source/QC/QA and real already-performed serial two-parent integration merge in recorded target checkout, with actual base/result SHAs | Parent compound/PR/verified merge/terminal close; no child PR |
| Standalone development | Reviewed source/QC/QA and clean registered source checkout/ref, without iteration integration inputs | Own compound/PR/verified merge/terminal close |
| Standalone report-only | Explicit registered-policy fulfilment recorded before Done plus QC/QA, without invented Git/integration | Evidence-backed terminal close, no PR/merge |

Completion never performs Git merge or an ownership transfer. The coordinator explicitly merges once in the recorded integration checkout and then complete verifies the actual result. Lost output means retry complete against actual facts, not a second merge. Resolve/abort a real conflict in Git. Exact replay preserves completion timestamps. Recovery replaces only the explicitly stopped workflow coordinator; row-specific sessions/launches are removed.

Runtime sequence → `mstar-iteration/references/phase-2-worktree-lease.md`; fields/lifecycle → `mstar-artifacts`; exact flags/JSON/exit codes → `mstar-use-cli/references/plan-and-workflow.md`.


## /iteration-loop

```text
/iteration-loop [direction] [scale]
```

**Purpose** — the whole lifecycle Phase 1→6 with minimal human intervention: code-first research and an **autonomous** direction lock (no `grill-me`), then the same execute → close → PR → merge-ready → post-merge close chain. Done is Phase 6 §6.1–§6.4 complete.

**When** — unattended or cloud runs that should not wait on a direction dialogue. `/iteration-start` locks interactively and `/iteration-drive` resumes an already locked iteration.

**Args** — `direction` is free text that constrains the lock; it may be empty. A trailing token of exactly `S` / `M` / `L` / `XL` (case-insensitive) is `scale`, and the remaining text joins into `direction`, so a lone scale token means an empty direction.

**Scale** — budgets the iteration's **business** plans: `S` 1, `M` 2–3, `L` 3–4, `XL` more than 4. The budget rules — including what the budget does not count — live in `mstar-iteration`.

**Defined in** — [`commands/iteration-loop.md`](../commands/iteration-loop.md); semantics → `mstar-iteration` (`references/phase-1-prepare.md` and `references/autonomous-direction-lock.md` for Phase 1; Phase 2–6 are delegated to the `/iteration-drive` route) plus `references/command-shared-invariants.md`.

## /codebase-audit

```text
/codebase-audit [simplify]
```

**Purpose** — a read-only survey of a codebase as a senior advisor, producing a prioritized, evidence-backed review report under the review tree (`{REVIEW_DIR}/<date>-codebase-<level>-<round>/`). No source edits, no state machine, no commits: the audit is advisory and its output is a review report.

**When** — before `/iteration-start`, to discover what is worth doing; or standalone, to build a prioritized backlog. `/amazing-pr-review` reviews an existing change rather than surveying the codebase, `/amazing-test-audit` audits the test suite rather than the whole codebase, and `/amazing-e2e-check` verifies behaviour rather than reading code.

**Args** — an optional keyword narrows the pass (a category focus such as `bug`, `security`, `perf`, `tech-debt`); the `simplify` variant runs a debt-focused deep pass over dead, duplicated, speculative and over-built surfaces.

**Hosts** — on dsh, the large-repo fan-out runs through the native `workflow` tool rather than `subagent`; other hosts keep their own invoke tool.

**Defined in** — [`commands/codebase-audit.md`](../commands/codebase-audit.md); procedure → `mstar-audit` (common core in the skill, full-audit detail in `references/codebase-audit.md`); dsh fan-out script → `mstar-host` → `references/dsh-workflow-scripts.md`.

## /amazing-test-audit

```text
/amazing-test-audit [scope|subsystem] [quick|deep] [campaign]
```

**Purpose** — a read-only audit of the existing test surface: sweep for junk patterns (assertion-free probes, source restatements, mock-tested mocks, test-only production seams), grade every candidate against the value/retention bar, and report prioritized findings to delete, repair, consolidate, or relocate tests. No test edits, no source edits, no state machine, no commits: the audit is advisory and its output is a review report under `{REVIEW_DIR}`. A baseline test failure is reported as a suspected product bug, never silently deleted.

**When** — when the suite itself is the question: pruning or repairing test debt before an iteration, after a test-heavy change, or as a standalone backlog pass. `/codebase-audit` surveys the whole codebase rather than the test surface, and `/amazing-pr-review` reviews an existing change rather than the suite.

**Args** — a `scope|subsystem` token narrows the sweep to that area; `quick` / `deep` set the effort level (the audit effort table shared with `/codebase-audit`) and default to a whole-repo sweep; the `campaign` token switches to a whole-subsystem campaign that marks every test declaration in an `R` / `F` / `C` / `D` ledger before the report findings are written. `quick` and `campaign` are mutually exclusive — campaign breadth is always the whole subsystem, so the combination hard-stops and asks the user to drop one token.

**Hosts** — the lane fan-out follows `/codebase-audit`: read-only `scout` / `explore` seats per lane under the assignment's read-only delegation grant; each host keeps its own invoke tool (no native dsh `workflow` script ships for this entry).

**Defined in** — [`commands/amazing-test-audit.md`](../commands/amazing-test-audit.md); procedure → `mstar-audit` (common core in the skill, test-suite detail in `references/test-audit.md`); lane fan-out routing → `commands/amazing-test-audit.md` (Routing, mirrors `/codebase-audit`).

## /amazing-pr-review

```text
/amazing-pr-review [pr|branch|scope] [quick|default|deep]
```

**Purpose** — a read-only, evidence-first review of a PR / branch / diff that decides whether a change is safe to ship: one verdict — `ship it` / `needs fixes` / `blocked` computed from the finding tally for a **settled** run (completed without a stop, every required domain opened, the resolved diff basis readable and complete), never chosen, or the single derived override `incomplete` with its cause and unscanned scope on exactly three conditions — the run stopped before synthesis, a required domain seat never opened, or the resolved diff basis could not be read — with a display-only score band (`mergeable` / `good` / `pass` / `fail`) — plus the findings, and a posted GitHub review whenever a PR number is given (posting is mandatory then). Wall-clock overrun is not one of those conditions: a fully covered run past its tier budget publishes its tally-derived verdict and declares the overrun under `- notes:`. It never auto-approves, never requests changes and never merges.

**When** — assessing a change you did not author. Do not use it to self-check your own work.

**Tiers** — `quick` (single pass, one seat) / `default` (the no-flag landing tier, two seats) / `deep` (the full three-stage pipeline). An explicit token wins over size- and sensitivity-based inference; two tier tokens together hard-stop and ask the user. Tier contracts and their wall-clock budgets live in `mstar-audit` → `references/pr-review.md`.

**Hosts** — on dsh, the `deep` tier's seats run through the native `workflow` tool while `default` and `quick` keep `subagent`; other hosts keep their own invoke tool.

**Batch** — one session reviews one PR; remaining PRs from a multi-PR input are registered as audit todos, one session each.

**Defined in** — [`commands/amazing-pr-review.md`](../commands/amazing-pr-review.md); procedure → `mstar-audit` (`references/pr-review.md`, the `pr` variant: tier resolution, pipeline, worktree isolation, same-target re-review, posting, and the report archive under `{REVIEW_DIR}/<date>-pr<N>/`).

## /amazing-e2e-check

```text
/amazing-e2e-check [environment/device] [scenarios]
```

**Purpose** — run explicitly requested E2E, browser, device or installed-deployment scenarios as an independent verification workflow. The owning skill covers registration, evidence, scope boundaries and closure.

**When** — on an explicit user request only. It is never a routine iteration QA gate, and routine QA never triggers it.

**Execution** — the PM orchestrates and the assigned `ops-engineer` executes; the entry itself does not authorize E2E from routine QA and does not insert it into an iteration.

**Defined in** — [`commands/amazing-e2e-check.md`](../commands/amazing-e2e-check.md); semantics → `mstar-e2e`.
