# QC fix report — F-001 round 3

**plan_id**: `20260722-iter-wt-lease`  
**Coverage**: F-001 — `Worktree mode: waived` must not bypass cross-plan parallel lock/serial gate  
**Date**: 2026-07-22

## Problem (QC2 revalidation)

`Worktree mode: waived` was documented as a full control-worktree + lease gate waiver. Parallel rules scoped to "§2.0 #5 未 waive" could be read as: when waived, lockless cross-host parallel is permitted. That contradicted the invariant that only `Cross-host lease race: accepted` + audit re-enables cooperative multi-host parallel.

## Fix summary

1. **Split gates explicitly** in `mstar-iteration` §2.0 #5:
   - **Waivable**: control worktree, feature worktree defaults, `execution_lease` / `integration_merge_lease`.
   - **Not waivable**: cross-plan parallel safety gate (same-host lock, default serial, or race-accepted override).

2. **§2.4 / §2.6**: Removed "§2.0 #5 未 waive" qualifier from cross-plan parallel rules; gate applies **whether or not** waived. Prefer **`Plan parallelism: serial`** when waived.

3. **`status-and-residuals.md`**: Qualified "Feature implementation may run in parallel across plan IDs"; hard gate now states it applies when waived; coordination path = primary checkout when waived.

4. **`phase-2-worktree-lease.md`**: Waiver section lists what is / is not waived; Multi-plan parallelism and cross-plan hard gate updated.

5. **ADR** (`.harness/docs/2026-07-22-iteration-worktree-plan-lease.md`): Waiver + Consequences aligned.

6. **`mstar-dispatch-gates`**, **`project-manager.md`**: One-liners that waived does not authorize lockless cross-plan parallel.

7. **routing-eval** (v24): New case `iteration-phase2-waived-not-parallel-override`; `hard_fail_if` added to iteration Phase 2 cases for waived-as-parallel-override.

## Verification

```bash
python3 -m json.tool .cursor/skills/mstar-routing-eval/assets/routing-evals.json > /dev/null
# → JSON valid
```

## Files changed

| File | Change |
|------|--------|
| `skills/mstar-iteration/SKILL.md` | §2.0 #5, §2.4, §2.6 |
| `skills/mstar-iteration/references/phase-2-worktree-lease.md` | Waiver, Multi-plan parallelism, hard gate |
| `skills/mstar-plan-artifacts/references/status-and-residuals.md` | When fields apply, hard gate, Integration merge intro |
| `skills/mstar-dispatch-gates/SKILL.md` | Cross-plan + anti-pattern |
| `skills/mstar-roles/references/project-manager.md` | NEVER line |
| `.cursor/skills/mstar-routing-eval/assets/routing-evals.json` | v24 + new case |
| `.cursor/skills/mstar-routing-eval/SKILL.md` | hard_fail bullets |
| `.harness/docs/2026-07-22-iteration-worktree-plan-lease.md` | Waiver + Consequences |

## Residual

None for F-001 round 3 scope.
