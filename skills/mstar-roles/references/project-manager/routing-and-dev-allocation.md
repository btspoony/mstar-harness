# Project Manager Routing & Dev Allocation Reference

This reference is an extension of `references/project-manager.md`.
Use it when PM needs detailed routing/developer allocation decisions beyond the minimal gate checks.

## Route Conflict Priority (Primary Route)

When multiple routes apply, set one `Primary` route in Assignment and treat others as additional gates.

1. User explicit instruction in this turn
2. Hotfix
3. High-risk production/shared-environment ops
4. QA report-only
5. High-ambiguity / intermittent bug
6. Bug fix
7. Refactor
8. Feature size bucket (large/medium/small)
9. User-visible UI/critical-flow evidence requirement (additional gate, usually not primary)

## Size Heuristics

- Large: touches >=3 modules or introduces independent subsystem
- Medium: 1-2 modules, adds API/page/major workflow
- Small: limited file set, micro UI/config update
- Hotfix: urgent production issue requiring fastest safe path

## Dev Allocation Rules

| Scenario | Default allocation |
| --- | --- |
| UI/components/a11y/styling | `frontend-dev` |
| API/DB/business logic | `fullstack-dev` |
| Fullstack (UI + backend) | `fullstack-dev` + `frontend-dev` |
| Parallelizable multi-module backend/fullstack | `fullstack-dev` + `fullstack-dev-2` |
| Prompt/rules/agents/skills changes | `prompt-engineer` |
| No special expertise needed | `general` |

## Dev Triangle Balance (`fullstack-dev` / `fullstack-dev-2` / `frontend-dev`)

### Default: spread backend/fullstack work across both tracks

When **>=2 independent** backend/fullstack units exist (on the task board or across sequential batches):

- **Parallel (preferred)** when units are parallelizable: dispatch **`fullstack-dev` + `fullstack-dev-2`** with explicit module boundaries and branch/worktree isolation.
- **Sequential rotation** when work is not concurrent: alternate `Execute as` between `fullstack-dev` and `fullstack-dev-2` by task/batch order (round-robin).

**Independence gate:** do **not** split genuinely dependent or sequential work across two dev IDs just to use both tracks.

**Single-id path needs justification:** collapsing >=2 independent units onto one backend-capable dev id requires `Dev owner tie-break: single id — <reason>` and Pre-Implement `single_stream_justified: yes` with that reason.

### When `frontend-dev` is required

- Task category is `visual`, or acceptance depends on page/component/interaction/a11y/frontend performance.
- UI-bearing fullstack work defaults to split ownership (`frontend-dev` for UI, `fullstack-dev` for API/domain).

### When `fullstack-dev-2` is required (concurrent dual-track)

Use a second implementation track when **any** applies:

- Task board has >=2 independently parallelizable implementation units.
- Medium+ fullstack scope and PM/user expects wall-clock acceleration.
- One fullstack track is overloaded while another independent module exists.

### `single-stream` clarification

`Dev routing: single-stream` means no concurrent multi-write dev tracks **in this round**.
It does **not** force all future batches to one fixed developer ID.

### Allowed override to single backend-capable dev id

- User explicitly locks owner
- Module ownership / continuity on one track
- Hotfix stop-bleeding
- Only one active write track in this round (true dependency, not preference)

Document override as `Dev owner tie-break: single id — <reason>`.

## Parallel Execution Rules

- `frontend-dev` + `fullstack-dev` can run in parallel once interface contract is clear.
- `fullstack-dev` + `fullstack-dev-2` can run in parallel when module boundaries are explicit.
- Same-repo multi-writer concurrency requires branch + worktree isolation.
- **SDD implement** (`Execution mode: sdd`, default multi-task): per-task **task reviewer** (L2) + plan **QC tri-review** (L3, N=3).
- **Inline / hotfix**: single-seat QC or skip per routing table.

## Routing / allocation NEVER (PM)

- **NEVER** assign multiple task-board rows to the same backend-capable dev id without `Dev owner tie-break: single id — <reason>` when round-robin or dual-track fairness rules expect spread (see round-robin section above).
- **NEVER** treat full-stack UI **plus** backend acceptance as a lone “single dev small task” without `frontend-dev` (or an explicit waiver + risk note) when the UI is user-visible.
- **NEVER** pick route priority from informal chat alone when it conflicts with the routing ladder in `references/project-manager.md`—this turn’s explicit user instruction wins, then hotfix, then the published priority table.

## Quick Checklist Before Dev Dispatch

- `Primary` route chosen and written
- `Task category` matches route
- `Dev routing` matches task board ownership
- Parallel intent and branch/worktree policy align
- If UI-visible changes: QA observable evidence gate present
