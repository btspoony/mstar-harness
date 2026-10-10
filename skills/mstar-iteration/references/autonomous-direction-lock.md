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

Persistence has three ordered steps; none invents human approval:

1. **Lock rationale**: create the iteration package and retain the five fields below in its root **`direction-lock.md`**. This is the on-disk direction record; the host action itself cannot run yet because it requires a registered running workflow and this session's coordinator seat.
2. **Prototype**: follow `phase-1-prepare.md` §1.2.5. Retain an appropriate **HTML, Markdown or JSON** design prototype under `prototypes/`, with format rationale, choices, assumptions and a truthful autonomous disposition. Do not require HTML or routine human confirmation. Revise this disposition when the design materially changes; if the direction changes, reopen ranking/decisions and semantically re-lock. Reuse the same iteration's eventual hook/current binding; §1.2.5 distinguishes this from a new host start and owns the supported lifecycle/recovery boundary.
3. **Compass/plans and registration**: incorporate the direction-lock record's five fields into their existing sections (`## Scope`, `## Decisions`, `## Acceptance Criteria`, `## Non-Goals`, scale cap) without re-deriving the lock. Link the retained prototype path/revision and autonomous rationale as the design baseline. Translate it into formal criteria/constraints/interfaces; then register the ready iteration and acquire this session's coordinator seat. Execute `direction-lock` after those prerequisites and before Review & Edit. Role selection and mandatory writer closure still apply (§1.6).

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

Count only **business delivery plans** registered in compass / the workflow registration (ACTIVE: store execution authority) whose primary outcome is product, feature, bugfix, user-facing docs, API/contract, or architecture work for the locked direction.

**Do not count** harness / process work as plans (and do not invent plans whose sole job is process):

| Exclude from scale count | Examples |
|--------------------------|----------|
| Phase 1 process | Research, direction lock, retained prototype, Review & Edit, compass/catalog/execution registration |
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

1. Workflow `branch.base` / `branch.target` from the ACTIVE execution authority (`mstar status validate`); absent registration goes through `mstar iteration register` against that authority, never handwritten root / snapshot writes
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
- Skipping the retained prototype, calling its autonomous disposition user approval, or using it as a Prepare-gate substitute
- Forcing S/M/L plan caps on interactive starts that did not request a scale budget
- Counting harness process (Review chain / QC / QA / compound / close / PR) toward the scale budget
- Creating process-only plans to fill or absorb S/M/L slots
