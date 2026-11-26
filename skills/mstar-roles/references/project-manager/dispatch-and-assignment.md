# Project Manager Dispatch & Assignment Reference

Use this reference for detailed dispatch mechanics and Assignment authoring.
The concise gate summary remains in `references/project-manager.md`.

## Core Dispatch Invariants

- Only `project-manager` dispatches subagents.
- Each independent Assignment needs one matching host invoke: counting, dispatch-turn ordering, batch-readiness and the paste-only failure → **`mstar-host`** → `mstar-host/references/parallel-dispatch.md` § Mandatory order / § Hard rules.
- **Same-repo writable parallel tracks**: tool concurrency and worktree isolation are **separate gates**. Before implement invokes, complete **`mstar-branch-worktree`** → **`mstar-branch-worktree/references/parallel-writable-pre-dispatch.md`**.
- **Scope and stopping are explicit**: apply `mstar-harness-core` § 定向执行与验证边界. Give each leaf one result, owned paths/symbols, relevant inputs, named checks/selectors, and an evidence-based stopping condition. Reuse unaffected evidence; do not inject a suite merely because the repo exposes it. Independent ready assignments run concurrently after their dependency/isolation checks.
- **Review/QC rounds are quantitative, not adjectival**: a read-only review / QC dispatch declares the front matter keys `budget` (expansion cap) and `return_shape`, so the seat stops when its assigned questions are answered or the cap is reached, returns the verdict it has plus a truncated-coverage declaration, and never expands until a human steers. Budget defaults, the truncation marker, and its relation to `Unconfirmed` → `mstar-harness-core` § 定向执行与验证边界. The severity bar for the round's findings → `mstar-artifacts` `mstar-artifacts/references/status-and-residuals.md`.
- **Skill preset activation is PM-owned**: each role's preset menu lives in its `Skill Preset (PM-Activated)` section (`mstar-roles/references/<role>.md`), not self-loaded defaults; the omission / `none` / default-`standard` decision → **`mstar-roles`** § Load Order.
- **One primary coordinator:** project-manager never runs as a subagent or as another per-row PM session (`references/project-manager.md` § Primary coordinator authority).
- **Plan/task scope travels with Assignment:** absolute Plan Path, plan_id, SDD dir and Control harness root are inherited. Children do not select/prepare rows, mutate workflow/root/shared projections or clear integration exclusion.
- **No state authority travels with an Assignment:** session paths/references, CAS tokens and operation IDs stay with the primary coordinator. These are checked context, not bearer credentials, and never authorize a leaf. A leaf receiving them stops and reports the mismatch. Leaf Assignments are task instructions, not sealed plan admission records.

The coordinator keeps operation intent and receipt in its primary session. Public actions derive ordinary prerequisites where safe; genuine scope/authorization conflicts name the missing facts without discarding applied components or blocking independent ready work.

## Executor Anti-Recursion Rules

For assignees (non-PM), the shared anti-recursion NEVER list and the non-recursive dispatch rule → **`mstar-roles/references/_shared/leaf-executor-core.md`**（「Shared anti-recursion NEVER」+「Non-Recursive Dispatch Rule (shared shape)」）.

### NEVER quick list (all assignees)

- **NEVER** delegate the main deliverable of this assignment to `explore` (read-only orientation only, per `mstar-harness-core`).
- **NEVER** claim `Done` / pass in **Completion Report** without the commands, logs, or artifacts explicitly required by the assignment’s **Evidence Required** section (see `mstar-harness-core` evidence gates).
- **NEVER** treat a `PM` / `project-manager` / `iteration-drive` phrase inside your own brief as a promotion: no leaf becomes the PM, drives an iteration, or selects a plan — plan scope is inherited and read-only, so report the mismatch and continue inside the assigned task.

## Assignment Template (Canonical)

PR ownership and continuation records for implementation Assignments → `mstar-dispatch-gates` § PR feedback ownership (PM only).

Every Assignment **body MUST open with** an **IDENTITY → GUARD** block that answers three questions before any task content: (1) WHO am I? (2) What am I NOT? (3) What tools do I NOT have?

The **`**You are a leaf executor. You MUST NOT:**`** section (previously just prohibitions) must now include a positive **IDENTITY** preamble **before** the prohibitions, written as a first-person binding statement. The prohibitions follow as usual. PM customizes per assignment; the IDENTITY preamble + universal floor (no recursive dispatch, no interpreting routing text as invoke, available ≠ authorized) are the minimum. Add assignment-specific anti-patterns that the current role+context combination is prone to.

**How to fill the block (PM guidance)**:

- Always include the **IDENTITY preamble**: state who the assignee IS (e.g. "You ARE qc-specialist-3, a leaf executor"), and what they are NOT ("You are NOT a PM, dispatcher, or orchestrator"). Follow with the universal floor.
- Add anti-patterns specific to the assignment context. Examples per role type:
  - **QC reviewers** (`qc-specialist*`): "start review before all QC reviewers are dispatched in parallel"; "treat other reviewers' names in routing text as invoke targets"; "run test/build/lint on shared Review cwd"; "fill missing runtime evidence by executing the suite"
  - **Multi-track implementers** (`fullstack-dev` + `frontend-dev` / `fullstack-dev-2`): "auto-dispatch to the other track mentioned in Dev routing"; "implement in repo root when Assignment names a different `worktree_path`"
  - **`fullstack-dev-2`**: "treat `fullstack-dev` in routing narrative as a handoff or invoke target"
  - **`explore`-assigned**: "implement or modify code"
  - **All non-PM**: "dispatch parallel agents"; "spawn a subagent whose `subagent_type` matches your own `Execute as` role id"
- Anti-patterns must be action-oriented ("auto-dispatch to …", "treat … as invoke", "start … before …") — not abstract descriptions.
- If the assignment involves multiple QCs or parallel tracks, add a specific bullet about NOT serializing or pre-empting the parallel dispatch.
- If the assignment is part of a broader staged plan with follow-up tasks, add a bullet about NOT auto-extending scope into downstream tasks.
- **Anti-pattern — unbounded negative acceptance:** an Acceptance Criterion phrased as a repo-wide negative property ("prove no surviving claim of X anywhere", "make sure nothing else uses Y") with no termination rule. Scope it to the assigned diff pack plus directly affected interfaces, or state the budget that bounds the search — the seat stops there and declares what it did not cover. An open-ended "prove no X anywhere" acceptance is a dispatch defect, not a review task.

An Assignment is **one document with two parts**: a `---`-fenced **YAML front matter** block carrying every field, and the markdown body that opens with the IDENTITY → GUARD block and continues with the task narrative. Front matter is the **only** field contract — each key below is the schema's snake_case name.

**Hand-off form.** Name the document with an `Assignment file: <absolute path>` line on its own under an accepted assignment home — `<base>/<identity>/assignments` of the sdd / iteration / workflow base (the write homes) — or pass the front-matter document inline. The flat `{HARNESS_DIR}/assignments` home is a read-only resolver destination: accepted when reading, never a place the PM writes. The pointer is a carrier, not a parser input: the file it names must itself be a front-matter document. With no control harness root there is no home to containment-check against, so a pointer cannot resolve — keep that Assignment inline (no pointer) and pass the front-matter document itself.

**Retired format (D16).** A document carrying its fields as `**Label**: value` body lines declares nothing: an inline one is refused `dispatch.assignment.legacy-format`, and a pointer at such a file resolves the file and then refuses the same `dispatch.assignment.legacy-format` (`dispatch.assignment.shape` is the code for a pointed document that is not an Assignment at all). Recover by rewriting the document as front matter, or by pointing `Assignment file: <absolute path>` at that rewritten document — do not append a fence to the old labels.

```markdown
---
# ---- identity and authorization ------------------------------------------
execute_as: <role-id>
# exactly one: forbidden, or allowed (<callees> — and what they may do)
delegation: forbidden
# sdd | inline | N/A
execution_mode: sdd
# fresh | sticky | N/A — default fresh; sticky reuses the same implementer subagent across tasks,
# reviewers stay fresh → mstar-sdd/references/sticky-implementer-session.md
sdd_implementer_session: fresh
# absolute <main-repo-root>/{HARNESS_DIR}/sdd/<plan-id>/ (control harness root) when the L1 lease gate is
# active | {HARNESS_DIR}/sdd/<plan-id>/ when waived / single checkout | N/A
sdd_dir: <abs>/<HARNESS_DIR>/sdd/<plan-id>/
# absolute <SDD dir>/context.json when execution_mode: sdd | N/A — the destination contract consumed by
# mstar sdd exec --context / --context producers (mstar-sdd/references/file-handoffs.md)
sdd_context_file: <abs>/<HARNESS_DIR>/sdd/<plan-id>/context.json
# standard | <explicit skill list> | none — activates the execute_as role's preset; default standard for
# substantive implementation / QC rounds unless the route is trivial
skill_presets: standard
# full tri-review | single | N/A — default full tri-review when execution_mode: sdd; single only for
# inline / override
qc_mode: full tri-review
review_package_path: <branch-review diff file>
# the concrete report file the seat itself writes (e.g. {SDD_DIR}/review/qc.md) for ALL QC seats whatever
# the execution_mode; N/A only when the Assignment explicitly declares conversation-only review with no
# plan row — a seat never returns its report in conversation for later coordinator transcription
qc_report_path: N/A
# executor lock: only the execute_as role acts on this message
who_runs_this_turn: <role-id>

# ---- routing --------------------------------------------------------------
primary: <route type>
# visual | deep | quick | logic | ops | docs
task_category: docs
dev_routing: <parallel / single-stream / round-robin detail as needed>
# serial | parallel — N tracks
parallelism: serial
additional_gates: N/A
phase_gate_checklist: |
  - Prepare: specify [done|n/a], clarify [done|n/a], plan [done|n/a]
  - Execute: plan locked [done|n/a], tasks [done|n/a], implement [this assignment|done]
  - Gate decision: go | blocked (<reason>)

# ---- checkout and write ownership -----------------------------------------
# EXACTLY ONE branch form — working_branch OR branch_policy, never both. working_branch also accepts a
# flat string list for parallel tracks. Formal iteration: from metadata.spec_integration_branch;
# integration cut from metadata.iteration_base_branch (mstar-iteration §2.3).
working_branch: <branch policy or create-from policy>
# branch_policy: <direct on <branch> — <reason>>    <- the alternative form; drop working_branch to use it
# control | work (absent = work) — control writes only the control root's gitignored process targets, and
# is exempt from default-branch protection; every checkout and write constraint → § L1 path fields below.
write_domain: work
# required on write_domain: control — the actual process targets, each Git-ignored inside the control root
control_write_paths:
  - <absolute or worktree-relative process target>/

# both → § L1 path fields below (isolation, control root, per-shape ignore probing)
worktree_path: <absolute feature checkout>
control_harness_root: <abs>/<HARNESS_DIR>
review_cwd: <absolute review checkout or N/A>
# plan_id, review_range and diff_basis are the QC/QA alignment fields: byte-identical across every seat of
# one tri / QA set (merge-base = metadata.target_branch or the PM-specified ref — never origin/main).
review_range: <reproducible review range>
diff_basis: <diff basis>
main_worktree_branch: <residency branch of the primary checkout>

# ---- plan scope -----------------------------------------------------------
plan_id: <plan-id>
# as applicable to the selected row; otherwise N/A
iteration_id: N/A
workflow_id: N/A
plan_path: N/A
# inherited from the dispatching PM (plan_id + absolute plan path) — read-only for the leaf (no plan
# selection/preparation, workflow or root writes, lease release, session path or operation id)
plan_scope: inherited; read-only for the leaf

# ---- acceptance and closure -----------------------------------------------
acceptance_gate: pm-acceptance
# scope/evidence rationale, not a risk-tier selector; procedure → references/project-manager/acceptance.md
acceptance_gate_reason: <scope/evidence rationale>
# zero-residual | allow-residual — mirror the effective revisable coordinator configuration; default
# allow-residual, zero-residual explicit opt-in. No Assignment seal or second mode authority.
findings_cleanup: allow-residual
why_this_agent: <role-fit>
pm_task_board_coverage: <task ids>
# required when the round is staged, partial or temporary; otherwise N/A
roadmap_deferred_scope: N/A

# ---- task contract --------------------------------------------------------
task: <one concrete deliverable and stopping result aligned with coverage>
checkpoint_comment_rule: commit -> Completion Report -> PM Status Update -> next batch
# required when batching >= 3 ids
why_batching_is_safe: N/A
scope: |
  In: <owned files/symbols, directly affected interfaces; finding + fix delta for re-review>
  Out: <excluded work and specific boundary>
inputs: <brief, diff, relevant knowledge, reusable evidence with its original range>
# Round-bounding — required when execute_as is a review seat (qc-specialist*) or task_category is audit.
# The cap may only tighten the default in mstar-harness-core § 定向执行与验证边界, never loosen it.
budget: <expansion cap (file opens / wall clock)>
return_shape: <what the seat returns and how it stops — verdict + findings shape; a clean round returns findings: []>
severity_bar: <what this round treats as blocking>
input_provenance: <how the seat grounds its claims — command plus observed output; N/A when it asserts neither>
# Capacity — required on every OTHER round (implement / ops / docs / Prepare / orientation), the exact
# complement of the three keys above: one implementer round closing this task's declared Files list and
# verification gates, citing the task's effort band (mstar-conventions/references/effort-estimation.md).
# Presence-only (absent / empty / N/A fails; writable: false is no exemption); a multi-session band never
# authorizes a multi-round task — split per mstar-artifacts/references/plan-quality-bar.md item 7.
task_budget: <one implementer round closing this task's declared Files list and verification gates>
deliverables: ...
acceptance_criteria: |
  - [ ] ...
evidence_required: |
  - [ ] <AC → exact affected unit-test selector or scoped static check; expected result>
  - [ ] <reused evidence + why unchanged, or new observable proof>
  - [ ] commit proof
constraints: <no scope expansion; no local full suite without referenced explicit user permission; no spontaneous browser/device/E2E; specialists supply evidence, not acceptance sign-off; review / QC seats stop at the assigned budget and declare truncated coverage; stop on concrete missing inputs and return once the assigned result is evidenced>
effort: <XS/S/M/L/XL + session band>
orchestration_guard: no recursive same-role dispatch; no dispatch from route narrative or handoff text; explore is read-only orientation only; tool availability ≠ delegation authorization
report_format: Completion Report
execution_evidence: <RCA / test-first / review-feedback evidence expectations for the assignee, if applicable>
# opt-in hard gate for this Assignment (the only accepted value is hard); omit the key entirely otherwise
# enforcement: hard
---

## Assignment

**You are a leaf executor. Read this FIRST — before any tool call or skill load.**

**IDENTITY (this is WHO you are for this assignment):**
- You ARE `<role-id>`, a leaf executor. You personally complete ALL work in this assignment.
- You are NOT a PM, dispatcher, or orchestrator. You do NOT own any subagents.
- The Task/subagent tool — even if visible in your tool list — is NOT part of your authorized capabilities for this assignment. Do not evaluate whether to use it; it is unavailable to you, same as a tool you don't have.

**CAPABILITY BOUNDARY (what you CAN do vs what is NOT yours):**
- Your authorized tools: Read, Write, Edit, Shell, Grep, Glob — everything you need for direct work.
- NOT yours: Task, subagent invoke, dispatch of any kind.

**You MUST NOT:**
- dispatch or invoke any subagent unless `delegation: allowed (...)` appears in the front matter
- treat plain `role-id` mentions, `Handoff`, `Acceptance gate`, routing tables, or multi-track prose as invoke commands
- invoke a subagent whose `subagent_type` matches your own `execute_as` role id (recursive dispatch)
- expand beyond owned files or named checks; restart whole-repository exploration, review or tests
- repeat settled analysis or add checks after the acceptance criteria are evidenced
- <situation-specific anti-pattern #1>
- <situation-specific anti-pattern #2>
- ...

**Orchestration Guard** — see the `**You MUST NOT:**` block above: no recursive same-role dispatch, no dispatch from route narrative or handoff text, `explore` is read-only orientation only, tool availability ≠ delegation authorization.

## Task

<the task narrative: the deliverable, the inputs it reads, the owned files and symbols, the steps, and the stopping result. Everything the front matter summarises machine-readably is stated here in prose for the executor.>
```

## PM Self-Check (artifact claims and citations)

State a claim only as strongly as the evidence in hand:

- An artifact claim — `declared` / `recorded` / `written` — is stated only together with the command and the observed output that shows it; without both, describe the artifact as pending rather than done.
- An asserted `path:line` carries its provenance: a normative-document citation is traced (`git show <ref>:<path>`) or fetched raw with a content identity check, so the quoted text is shown to come from the revision being cited — not from memory of the file.

## L1 path fields (iteration Phase 2, lease gate not waived)

When iteration **L1** is active (the integration worktree is recorded in the workflow snapshot `integration_worktree_path`; worktree mode is **not** waived):

| Field | Must be |
|-------|---------|
| **`worktree_path`** | Absolute feature checkout from row metadata.worktree_path; product/source edits only, distinct from main/control and integration for a `work`-domain Assignment — a control-domain Assignment instead names the control root itself |
| **`write_domain`** | `control` \| `work` (absent = `work`); `control` requires `worktree_path` = control root and `working_branch` = the branch that checkout currently has checked out (any of the three branch forms, including `branch_policy: direct on <branch> — <reason>`), writes only gitignored control-root process targets, and skips default-branch protection; the host dispatch gate runs the same validation, so an unverifiable control root refuses instead of passing |
| **`control_write_paths`** | Required on `write_domain: control`: the actual process targets written (absolute, or resolved against `worktree_path`); each must be Git-ignored and inside the control root — a tracked target such as `.agents/specs/…` is refused; a trailing `/` declares a directory, otherwise the entry must be Git-ignored under BOTH file and directory rules (`.mstar/notes` is refused where only the file path is re-included) |
| **`main_worktree_branch`** | The recorded residency branch from the main plan header, passed unchanged — the main worktree's attached branch must equal it (never a lifecycle-owned branch; never invented at check time) |
| **`control_harness_root`** | Absolute `<main-repo-root>/{HARNESS_DIR}` — the control root is the primary checkout (main worktree), derived from Git (`readMainWorktree`) |
| **`plan_path`** | Absolute under control harness (not relative from feature cwd) |
| **`sdd_dir`** | Absolute under control harness; run `mstar sdd workspace <plan-id>` with `MSTAR_CONTROL_ROOT=<main-repo-root>` (the derived main worktree root, verified before the fail-closed guard) when cwd is the feature tree |
| **`sdd_context_file`** | Absolute `<SDD dir>/context.json` — the bound destination contract (`controlHarnessRoot`/`featureCwd`/`workingBranch`/`planFile`/`sddDir`, all absolute) |

Every implementer/reviewer handoff cites these absolute destinations; native hosted subagents observe pwd/branch first and write only to the declared destinations (`mstar-sdd` prompt templates). CLI-launchable children start via `mstar sdd exec --context <context.json> -- <argv>`. State the boundary, never overclaim: the context/launcher binds starting cwd and validated destinations — it does NOT block a later deliberate `chdir`, absolute-path write, or host-native edit tool (`apply_patch`).

Do **not** waive worktree because default-gitignored `plans/` are missing under the feature checkout — see `mstar-branch-worktree` 「Harness path SSOT under default gitignore」.
## Completion Report Template

```markdown
## Completion Report

**Agent**: <role-id>
**Task**: ...
**Status**: Done | Blocked | Partial
**Scope Delivered**: ...
**Artifacts**: ...
**Validation**: ...
**Issues/Risks**: ...
**Residuals disclosure**: <open R# list — id + severity + tracking location; `N/A — none open` when none>
**Plan Update**: ...
**Handoff**: narrative to `project-manager` (not auto-dispatch)
**Git**: <real `git log -1 --format='%h %an <%ae>'` showing the configured author, or N/A for read-only; missing/failing identity is Blocked, never fabricate or use per-commit identity overrides — `mstar-roles/references/_shared/leaf-executor-core.md` § Git NEVER (repo writes)>
**Worktree path**: <absolute path or N/A>
```

## Status Update Template

```markdown
## Status Update

**Task**: ...
**Phase**: ...
**Phase Gates**: ...
**PM Task Board**: ...
**Subagent invokes issued**: <N>
**Context Loaded**: ...
**Progress**: ...
**Completed / Next**: ...
**Blockers**: ...
**Decisions needed**: ...
**Evidence Snapshot**: ...
**Residuals disclosure**: <open R# list — id + severity + tracking location; `N/A — none open` when none>
**PM Acceptance**: <required before Done: report pointer, per-AC evidence/results/applicability, coverage/gaps and issue dispositions — see acceptance.md>
**Effort note (agent-oriented)**: ...
```

## Host-Specific Note

For host behavior details (dispatch turn shape, paste-only failure mode, invoke-count discipline),
read `mstar-host` → the active host reference and `mstar-host/references/parallel-dispatch.md` as host SSOT for dispatch.

An Assignment targeting project-manager is a dispatch defect: PM is the sole primary-session coordinator, never a subagent or secondary per-row primary.

## SDD vs inline implement Assignment（PM）

| Mode | Who loads `mstar-sdd` | Assignment shape |
|------|----------------------|------------------|
| **`Execution mode: sdd`**（多 task 默认；iteration Phase 2 默认） | **PM** before first implement dispatch | **Per task**：one implementer dispatch + one **fresh** task reviewer；prompt 只含 `{SDD_DIR}/task-N-brief.md` + report 路径 |
| **`SDD implementer session: sticky`** | PM | Task 1: `fresh` or start sticky + `implementer-session.json`; Task 2+: host **resume** + continuation prompt — **still** per-task review |
| **`Execution mode: inline`**（hotfix / 单 task） | PM optional | One leaf Assignment；可含完整 scope，但仍须 canonical 字段 |

**NEVER（SDD）**：

- 把整份 plan 或 T1–Tn 全文贴进 **一个** `fullstack-dev` leaf Assignment。
- 省略 `Execution mode` / `SDD dir` 却期望 SDD 产物（`progress.md`、per-task review）。
- 期望 leaf `fullstack-dev` 载入 `mstar-sdd` 并自编排 per-task 循环 — **编排仅 PM**（`mstar-iteration` §2.4–2.5）。
