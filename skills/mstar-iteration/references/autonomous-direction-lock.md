# Autonomous direction lock

Capability detail for Phase 1 when direction lock mode is **`autonomous`**.

**Opt-in only.** Default Phase 1 mode remains **`interactive`** (user-converged). Do **not** apply this reference unless the caller / Assignment explicitly declares `Direction lock mode: autonomous` (or equivalent written opt-in). Reading this file alone is not opt-in.

## Preconditions

- Research (§1.1) and candidate exploration already done — **read repo artifacts before ranking**.
- Do not invent roadmap items that have no file or status evidence.
- Scale budget (`S`/`M`/`L`/`XL`) applies in this mode (or when the caller supplies one); do not retrofit a scale cap onto an interactive start that never asked for one.

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
| Scale budget | `S` \| `M` \| `L` \| `XL` and resulting plan-count cap |

## Scale budget

| Budget | **Business** plan count |
|--------|-------------------------|
| `S` | 1 |
| `M` | 2–3 |
| `L` | 3–4（cap 4） |
| `XL` | **>4**（5+） |

### What counts toward the budget（HARD）

Count only **business delivery plans** registered in compass / `status.json` whose primary outcome is product, feature, bugfix, user-facing docs, API/contract, or architecture work for the locked direction.

**Do not count** harness / process work as plans (and do not invent plans whose sole job is process):

| Exclude from scale count | Examples |
|--------------------------|----------|
| Phase 1 process | Research, direction lock, Review & Edit chain, compass/index/`status.json` bootstrap |
| Phase 2 process | Per-task SDD briefs/reviews, plan QC tri, QA gate, branch merge-back |
| Phase 3–5 process | Compound / package promotion, iteration-close, Create PR, merge-ready / CI babysit |
| Meta “plans” | “run QC”, “do compound”, “open PR”, “setup harness”, “write compass only” |

Harness steps remain **mandatory gates** outside the budget — they do not consume S/M/L/XL slots and must not be padded into the plan list to “fill” the budget.

If evidence suggests more **business** work than the budget allows, keep overflow in compass `## Roadmap Position` → next iteration — do not silently expand past the budget, and do not replace business plans with process plans to stay under the cap.

## Direction constraint（optional input）

When a free-text direction / feedback constraint is supplied by the caller:

- Filter or re-rank candidates to fit that intent
- Still require code/roadmap evidence; do not lock a direction that contradicts the repo without documenting the conflict
- If constraint and evidence conflict irreconcilably → **Blocked**（escalate）

## Autonomous branch resolve

**Only in `autonomous` mode.** Do not use this order to skip user confirmation under `interactive`.

Resolve `iteration_base_branch` and `target_branch` in order（first hit wins per field）:

1. `{HARNESS_DIR}/status.json` root `metadata`
2. Existing / prior iteration compass frontmatter
3. Current git branch **only if** it is already a documented delivery, integration, or project-policy branch（not merely “whatever HEAD is”）
4. Still missing → **STOP** — escalate; **never** substitute `main` / `master` because those names exist

`spec_integration_branch` defaults to `iteration/<iteration-id>` once base/target are known.

## Anti-patterns

- Applying this reference without explicit autonomous opt-in
- Asking the user “do you agree with this direction?” as a routine gate in autonomous mode
- Locking without reading roadmap / status / STRATEGY when those files exist
- Silent default to `main` / `master` for base or PR target
- Skipping written rationale because “it was obvious”
- Forcing S/M/L plan caps on interactive starts that did not request a scale budget
- Counting harness process (Review chain / QC / QA / compound / close / PR) toward the scale budget
- Creating process-only plans to fill or absorb S/M/L slots
