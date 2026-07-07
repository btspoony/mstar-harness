# Sticky implementer session (SDD token optimization)

Reuse the **same implementer subagent** across multiple tasks in one plan when tasks are tightly coupled, same `Execute as` role, and same `Working branch`. **L2 task reviewers stay fresh per task** — do not sticky reviewers.

SSOT for mode selection and host resume → this file. Per-task artifacts → **`file-handoffs.md`**.

## When to use

| `SDD implementer session` | Use |
|---------------------------|-----|
| **`fresh`** (default) | Independent tasks, module boundaries, different dev tracks, or first task on a plan |
| **`sticky`** | Same `fullstack-dev` (or same role id), sequential tasks on one branch, strong file/context continuity (e.g. T3+T4 daemon stderr + DB reset) |

**Prefer `sticky`** on iteration Phase 2 Autonomous Execute when PM will dispatch many tasks to the same dev on one plan feature branch.

## Assignment fields (implement dispatch)

```markdown
**Execution mode**: sdd
**SDD implementer session**: sticky | fresh
**SDD dir**: `{HARNESS_DIR}/sdd/<plan-id>/`
**Model tier**: standard
**Execute as**: fullstack-dev
**Working branch**: <branch>
**Covers task**: N | N–M   # single task id for this dispatch turn
```

- **Task 1** (or first task after `fresh` reset): `SDD implementer session: fresh` or `sticky` (starts sticky ledger).
- **Task 2+** with sticky: `SDD implementer session: sticky` + host **resume** (Cursor) or continuation prompt (fallback).

## Session ledger: `implementer-session.json`

PM writes/updates at `{SDD_DIR}/implementer-session.json` when starting or continuing sticky mode:

```json
{
  "plan_id": "<plan-id>",
  "execute_as": "fullstack-dev",
  "session_mode": "sticky",
  "host": "cursor",
  "host_agent_id": "<agent-id from first Task return — required for resume>",
  "working_branch": "feature/...",
  "started_task": 1,
  "last_task": 1,
  "started_at": "2026-07-07T00:00:00Z"
}
```

After each completed task review, PM sets `last_task` to N. **Do not** resume if `host_agent_id` is missing — fall back to `fresh` for that task.

## Per-task loop (sticky implementer)

Same as default SDD for artifacts and L2 review; only implementer dispatch differs:

1. `task-brief` → `{SDD_DIR}/task-N-brief.md`
2. Record `BASE_SHA`
3. **Implementer dispatch**
   - **First task** (`fresh` or sticky start): normal Task/subagent invoke → save `host_agent_id` to ledger
   - **Next tasks** (`sticky`): host **resume** with same `host_agent_id` + continuation prompt (`implementer-prompt.md` § Continuation)
4. On `DONE` → `review-package` → **fresh** task reviewer (never resume reviewer)
5. Append `progress.md`; update ledger `last_task`
6. Next task

**Still required per task:** commit, `task-N-report.md`, task-level diff, task reviewer, `progress.md` line.

## When to reset to `fresh`

Start a **new** implementer session (`session_mode: fresh` or new ledger) when any:

- `BLOCKED` / `NEEDS_CONTEXT` not resolved in one continuation turn
- `Execute as` role changes (`fullstack-dev` → `fullstack-dev-2`)
- `Working branch` changes
- Host does not support resume (OpenCode without resume → use **micro-batch** or `fresh`)
- Context clearly degraded (implementer confuses prior tasks) — PM judgment
- Switching from another dev track mid-plan

Delete or archive `implementer-session.json` when resetting.

## Micro-batch fallback (no host resume)

When resume is unavailable, PM may dispatch **one** implementer for **2–3** tightly coupled tasks:

- Prompt lists `task-N-brief.md` … `task-M-brief.md` and matching report paths only
- Implementer completes tasks **in order** in one session
- PM still runs **per-task** `review-package` + **fresh** task reviewer after each task (or after batch if PM documents per-task SHAs in Assignment)

Max **3** tasks per micro-batch without user override. See `project-manager.md` batch sizing.

## Host mapping

| Host | Sticky implementer |
|------|-------------------|
| **Cursor** | `Task` with `resume: <host_agent_id>` — **`mstar-host/references/cursor.md`** § SDD sticky |
| **OpenCode** | Resume only if task tool supports it; else micro-batch or `fresh` per task |
| **Codex** | Thread resume only when callable multi-agent tool documents agent id; else micro-batch or `fresh` |

## PM NEVER (sticky)

- Resume task **reviewer** sessions — reviewers stay fresh per task
- Parallel sticky implementers on the same branch
- Resume without updating `implementer-session.json` / `progress.md`
- Skip per-task review because implementer "remembers" prior tasks
- Paste full plan into continuation prompt — only new brief path + report path
