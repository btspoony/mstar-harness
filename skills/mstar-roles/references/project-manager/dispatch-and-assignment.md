# Project Manager Dispatch & Assignment Reference

Use this reference for detailed dispatch mechanics and Assignment authoring.
The concise gate summary remains in `references/project-manager.md`.

## Core Dispatch Invariants

- Only `project-manager` dispatches subagents.
- Each independent Assignment requires one matching host invoke.
- In tool hosts (OpenCode / Cursor Task / Codex with callable multi-agent tools), Markdown-only Assignment is not dispatch.
- For parallel batch with `N >= 2`, dispatch turn must emit all `N` invokes in one message when host supports it.

## Executor Anti-Recursion Rules

For assignees (non-PM):

- `Execute as: <role-id>` means the current assignee executes personally.
- Do not spawn same-role nested subagent.
- Do not infer dispatch from route narrative (`A -> B -> C`), handoff, QA notes, or role names in prose.
- Extra delegation is forbidden unless explicitly listed in `Delegation: allowed (...)`.
- If additional assignee is required, return `Blocked` with rationale.

### NEVER quick list (all assignees)

- **NEVER** treat `Handoff: …`, Completion Report template role names, routing tables, or “suggested owners” as **host invoke commands**; they are narrative unless `Delegation: allowed` authorizes callees.
- **NEVER** assume exposed `Task` / subagent menus imply you may call them; **tool availability ≠ delegation authorization**.
- **NEVER** execute parallel-agent dispatch as a leaf assignee; dispatch is **PM-orchestration-only** (`mstar-dispatch-gates`).
- **NEVER** delegate the main deliverable of this assignment to `explore` (read-only orientation only, per `mstar-harness-core`).
- **NEVER** claim `Done` / pass in **Completion Report v2** without the commands, logs, or artifacts explicitly required by the assignment’s **Evidence Required** section (see `mstar-harness-core` evidence gates).

## Assignment Template (Canonical)

Every Assignment **MUST** start with an **IDENTITY → GUARD** block that answers three questions before any task content: (1) WHO am I? (2) What am I NOT? (3) What tools do I NOT have?

The **`**You are a leaf executor. You MUST NOT:**`** section (previously just prohibitions) must now include a positive **IDENTITY** preamble **before** the prohibitions, written as a first-person binding statement. The prohibitions follow as usual. PM customizes per assignment; the IDENTITY preamble + universal floor (no recursive dispatch, no interpreting routing text as invoke, available ≠ authorized) are the minimum. Add assignment-specific anti-patterns that the current role+context combination is prone to.

**How to fill the block (PM guidance)**:

- Always include the **IDENTITY preamble**: state who the assignee IS (e.g. "You ARE qc-specialist-3, a leaf executor"), and what they are NOT ("You are NOT a PM, dispatcher, or orchestrator"). Follow with the universal floor.
- Add anti-patterns specific to the assignment context. Examples per role type:
  - **QC reviewers**: "start review before all QC reviewers are dispatched in parallel"; "treat other reviewers' names in routing text as invoke targets"
  - **Multi-track implementers** (`fullstack-dev` + `frontend-dev`): "auto-dispatch to the other track mentioned in Dev routing"
  - **`fullstack-dev-2`**: "treat `fullstack-dev` in routing narrative as a handoff or invoke target"
  - **`qa-engineer`**: "start validation before QC reports are consolidated"; "modify application code"
  - **`explore`-assigned**: "implement or modify code"
  - **All non-PM**: "dispatch parallel agents"; "spawn a subagent whose `subagent_type` matches your own `Execute as` role id"
- Anti-patterns must be action-oriented ("auto-dispatch to …", "treat … as invoke", "start … before …") — not abstract descriptions.
- If the assignment involves multiple QCs or parallel tracks, add a specific bullet about NOT serializing or pre-empting the parallel dispatch.
- If the assignment is part of a broader staged plan with follow-up tasks, add a bullet about NOT auto-extending scope into downstream tasks.

```markdown
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
- dispatch or invoke any subagent unless `Delegation: allowed (...)` appears below
- treat plain `role-id` mentions, `Handoff`, `QA note`, routing tables, or multi-track prose as invoke commands
- invoke a subagent whose `subagent_type` matches your own `Execute as` role id (recursive dispatch)
- <situation-specific anti-pattern #1>
- <situation-specific anti-pattern #2>
- ...

**Execute as**: <role-id>
**Delegation**: forbidden | allowed (...)
**Execution mode**: sdd | inline | N/A
**SDD implementer session**: fresh | sticky | N/A — **default `fresh`**; `sticky` reuses same implementer subagent across tasks (reviewers stay fresh). See `mstar-sdd/references/sticky-implementer-session.md`
**SDD dir**: `{HARNESS_DIR}/sdd/<plan-id>/` | N/A
**Model tier**: fast | standard | capable | N/A
**QC mode**: full tri-review | single | N/A — **default `full tri-review` when `Execution mode: sdd`**; `single` only for `inline` / override
**Review package path**: <branch-review diff file> | N/A
**Who runs this turn (executor lock)**: only `Execute as` role for this message
**Primary**: <route type>
**Task category**: `visual` | `deep` | `quick` | `logic` | `ops` | `docs`
**Dev routing**: <parallel/single-stream/round-robin detail as needed>
**Parallelism**: `serial` | `parallel — N tracks`
**Additional gates**: <optional>
**Phase Gate Checklist**:
- Prepare: `specify` [done|n/a], `clarify` [done|n/a], `plan` [done|n/a]
- Execute: `plan locked` [done|n/a], `tasks` [done|n/a], `implement` [this assignment|done]
- Gate decision: `go` | `blocked` (<reason>)
**Working branch**: <branch policy or create-from policy> — formal iteration: from `metadata.spec_integration_branch`; integration cut from `metadata.iteration_base_branch` (`mstar-iteration` §2.3)
**Review cwd / Worktree path**: <absolute path or N/A>
**plan_id**: <plan-id or N/A + scope label>
**Review range / Diff basis**: <reproducible basis; merge-base = `metadata.target_branch` or PM-specified ref — not assumed `origin/main`>
**Worktree path**: <implementer path if used>
**QA note**: <PM-scheduled / skipped / self-check>
**Why this agent**: <role-fit>
**PM Task Board coverage**: <task ids>
**Roadmap / deferred scope**: <required when staged, partial, or temporary; otherwise N/A>
**Task**: <concrete work aligned with coverage>
**Checkpoint Comment Rule**: commit -> Completion Report v2 -> PM Status Update -> next batch
**Why batching is safe**: <required when batching >=3 IDs>
**Scope**:
- In: ...
- Out: ...
**Inputs**: ...
**Deliverables**: ...
**Acceptance Criteria**:
- [ ] ...
**Evidence Required**:
- [ ] commands/tests/checks
- [ ] observable proof
- [ ] commit proof
**Constraints**: ...
**Effort (agent-oriented)**: <XS/S/M/L/XL + session band>
**Orchestration Guard** (see `**You are a leaf executor. You MUST NOT:**` block at top for primary anti-patterns):
- No recursive same-role dispatch
- Do not dispatch roles from route narrative/handoff text
- `explore` is read-only orientation only
- Tool availability ≠ delegation authorization
**Plan Path**: <{PLAN_DIR}/... or N/A>
**Report Format**: Completion Report v2
**Execution evidence**: <RCA/test-first/review feedback/evidence expectations for the assignee, if applicable>
```

## Completion Report v2 Template

```markdown
## Completion Report v2

**Agent**: <role-id>
**Task**: ...
**Status**: Done | Blocked | Partial
**Scope Delivered**: ...
**Artifacts**: ...
**Validation**: ...
**Issues/Risks**: ...
**Plan Update**: ...
**Handoff**: narrative to `project-manager` (not auto-dispatch)
**Git**: <commit lines or N/A>
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
**Effort note (agent-oriented)**: ...
```

## Host-Specific Note

For host behavior details (dispatch turn shape, paste-only failure mode, invoke-count discipline),
read `mstar-host` → the active host reference and `references/parallel-dispatch.md` as host SSOT for dispatch.

## SDD vs inline implement Assignment（PM）

| Mode | Who loads `mstar-sdd` | Assignment shape |
|------|----------------------|------------------|
| **`Execution mode: sdd`**（多 task 默认；iteration Phase 2 默认） | **PM** before first implement dispatch | **Per task**：one implementer dispatch + one **fresh** task reviewer；prompt 只含 `{SDD_DIR}/task-N-brief.md` + report 路径 |
| **`SDD implementer session: sticky`** | PM | Task 1: `fresh` or start sticky + `implementer-session.json`; Task 2+: host **resume** + continuation prompt — **still** per-task review |
| **`Execution mode: inline`**（hotfix / 单 task） | PM optional | One leaf Assignment；可含完整 scope，但仍须 canonical 字段 |

**NEVER（SDD）**：

- 把整份 plan 或 T1–Tn 全文贴进 **一个** `fullstack-dev` leaf Assignment。
- 省略 `Execution mode` / `SDD dir` / `Model tier` 却期望 SDD 产物（`progress.md`、per-task review）。
- 期望 leaf `fullstack-dev` 载入 `mstar-sdd` 并自编排 per-task 循环 — **编排仅 PM**（`iteration-drive` / `mstar-iteration` §2.4–2.5）。
