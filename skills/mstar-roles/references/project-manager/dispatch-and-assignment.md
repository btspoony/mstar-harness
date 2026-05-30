# Project Manager Dispatch & Assignment Reference

Use this reference for detailed dispatch mechanics and Assignment authoring.
The concise gate summary remains in `references/project-manager.md`.

## Core Dispatch Invariants

- Only `project-manager` dispatches subagents.
- Each independent Assignment requires one matching host invoke.
- In tool hosts (OpenCode/Cursor Task), Markdown-only Assignment is not dispatch.
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
- **NEVER** execute Superpowers `dispatching-parallel-agents` as a leaf assignee; that skill is **PM-orchestration-only** (`mstar-superpowers-align`).
- **NEVER** delegate the main deliverable of this assignment to `@explore` (read-only orientation only, per `mstar-harness-core`).
- **NEVER** claim `Done` / pass in **Completion Report v2** without the commands, logs, or artifacts explicitly required by the assignment’s **Evidence Required** section (see `mstar-harness-core` evidence gates).

## Assignment Template (Canonical)

```markdown
## Assignment

**Execute as**: <role-id>
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
**Working branch**: <branch policy or create-from policy>
**Review cwd / Worktree path**: <absolute path or N/A>
**plan_id**: <plan-id or N/A + scope label>
**Review range / Diff basis**: <reproducible basis; identical across QC/QA for same scope>
**Worktree path**: <implementer path if used>
**QA note**: <PM-scheduled / skipped / self-check>
**Delegation**: forbidden | allowed (...)
**Why this agent**: <role-fit>
**PM Task Board coverage**: <task ids>
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
**Orchestration Guard**:
- No recursive same-role dispatch
- Do not dispatch roles from route narrative/handoff text
- `@explore` is read-only orientation only
**Plan Path**: <{PLAN_DIR}/... or N/A>
**Report Format**: Completion Report v2
**Superpowers**: <if plugin enabled and applicable>
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

## OpenCode-Specific Note

For OpenCode host behavior details (dispatch turn shape, paste-only failure mode, invoke-count discipline),
read `mstar-host` → `references/opencode.md` and `references/parallel-dispatch.md` as host SSOT for dispatch.
