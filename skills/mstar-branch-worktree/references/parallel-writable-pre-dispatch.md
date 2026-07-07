# Parallel writable pre-dispatch gate (PM)

## Why this exists

Host dispatch can satisfy **「N Assignments ⇒ N invokes in one message」** while every writer still shares **one checkout directory**. That may satisfy `mstar-dispatch-gates` tool concurrency but **violates** same-repo write isolation.

**N parallel invokes ≠ parallel-safe.** Worktree isolation is a **separate, earlier** gate.

## Mode switch (do not carry single-track habits)

Serial single-plan waves (one feature branch, one checkout, PM on integration) do **not** authorize multi-writer parallel tracks without re-running this gate.

When the round adds a second **concurrent** writable implement track on the **same business repo**, treat it as a **mode switch** — even if earlier plans in the iteration were serial.

## Pre-dispatch checklist (HARD)

Before the **first** concurrent writable implement dispatch in a round:

1. **Re-read repo parallel rules** — root `AGENTS.md` and `{HARNESS_DIR}/AGENTS.md` for branch / worktree / merge-order constraints not duplicated in harness skills.
2. **Confirm PM checkout** — PM thread stays on **`spec_integration_branch`** (or the team integration line). **Do not** `checkout` topic / feature branches in the PM **primary cwd** to "help" implementers.
3. **Create isolation** — for each writable track: `git worktree add <worktree-path> <branch>` (or host-equivalent) **before** Task invoke. Each Assignment **must** include absolute **`Worktree path`**.
4. **Verify paths exist** — for each track: directory exists; `git -C <path> branch --show-current` matches Assignment **`Working branch`**.
5. **Assignment tags** — `Dispatch mode: parallel independent tracks` + `Worktree isolation: required` (`mstar-phase-gates`).
6. **Merge order** — when tracks may touch overlapping paths (shared packages, migrations, lockfiles), PM assigns **explicit sequential merge order** before dispatch.

## PM primary cwd invariants

| Allowed (PM thread) | Forbidden (PM thread) |
|---------------------|----------------------|
| `git checkout` integration branch | `checkout` writable topic branches while tracks are active |
| `git worktree add` / `list` / `remove` | `commit` product code |
| read-only inspection inside worktrees | switch primary cwd to an implementer feature branch |

## Leaf implementer invariants

- **Before first** repo `Write` / `commit`: `cd` to Assignment **`Worktree path`**.
- **Never** implement in PM's integration checkout when Assignment names a different **`Worktree path`**.
- Completion Report: **`Worktree path used`** (absolute) + **`Working branch used`**.

## Common anti-patterns

| Looks compliant | Actually wrong |
|----------------|----------------|
| Two Task invokes in one message | Both writers share default repo root checkout |
| Assignment lists `Working branch: feature/...` only | No `Worktree path`; subagent inherits PM cwd |
| `git checkout -b feature/...` on shared checkout | Branch exists but **no** directory isolation |
| Parent `.worktrees/` directory exists | Per-track subdirs missing — empty parent ≠ isolation |
| Prior serial plans succeeded | Assumes parallel needs no worktree setup |

## Emit-zero until ready

If worktrees are not created and verified, **`Subagent invokes issued: 0`** for that implement batch — same discipline as `mstar-dispatch-gates` emit-zero for incomplete parallel QC batches.

## After parallel dev (pointer)

Before plan QC tri: merge all tracks to one **`Working branch` `HEAD`** — parent skill §「单一待审 Git 快照」.
