# Autonomous direction lock

Capability detail for Phase 1 when direction lock mode is **`autonomous`**. Interactive (user-converged) lock remains the default for human-led starts; this reference covers code-first auto-lock only.

## Preconditions

- Research (§1.1) and candidate exploration already done — **read repo artifacts before ranking**.
- Do not invent roadmap items that have no file or status evidence.

## Ranking heuristics（highest first）

1. **Deferred / roadmap next** — prior compass `## Roadmap Position` next iteration, deferred-features, residuals marked for follow-up
2. **STRATEGY alignment** — `STRATEGY.md` vision / decision principles when present
3. **Product completeness** — closes a user-visible gap or unfinished capability
4. **Risk / blast radius** — prefer smaller, shippable slices when candidates are otherwise equal

Document trade-offs for **each** shortlisted candidate (2–4), then lock **one**.

## Lock outputs（must land on disk）

Write into compass (and plan Scope as needed):

| Field | Content |
|-------|---------|
| Locked direction | Single sentence |
| Rationale | Why this candidate won（cite paths / roadmap lines） |
| Acceptance criteria | Iteration-level Done |
| Non-goals | Explicit exclusions |
| Scale budget | `S` \| `M` \| `L` and resulting plan-count cap |

## Scale budget

| Budget | Plan count |
|--------|------------|
| `S` | 1 |
| `M` | 2–3 |
| `L` | 3–4（default cap 4 unless a written constraint requires more） |

If evidence suggests more work than the budget allows, keep overflow in compass `## Roadmap Position` → next iteration — do not silently expand past the budget.

## Direction constraint（optional input）

When a free-text direction / feedback constraint is supplied by the caller:

- Filter or re-rank candidates to fit that intent
- Still require code/roadmap evidence; do not lock a direction that contradicts the repo without documenting the conflict
- If constraint and evidence conflict irreconcilably → **Blocked**（escalate）

## Autonomous branch resolve

Resolve `iteration_base_branch` and `target_branch` in order（first hit wins per field）:

1. `{HARNESS_DIR}/status.json` root `metadata`
2. Existing / prior iteration compass frontmatter
3. Current git branch **only if** it is already a documented delivery, integration, or project-policy branch（not merely “whatever HEAD is”）
4. Still missing → **STOP** — escalate; **never** substitute `main` / `master` because those names exist

`spec_integration_branch` defaults to `iteration/<iteration-id>` once base/target are known.

## Anti-patterns

- Asking the user “do you agree with this direction?” as a routine gate in autonomous mode
- Locking without reading roadmap / status / STRATEGY when those files exist
- Silent default to `main` / `master` for base or PR target
- Skipping written rationale because “it was obvious”
