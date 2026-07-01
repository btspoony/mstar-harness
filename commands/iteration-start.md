---
name: iteration-start
description: Start a new harness iteration — research backlog, lock direction with grill-me, produce compass/plans, run mandatory Review & Edit chain via Task dispatch (product-manager → architect → writing-specialist each review-and-edit, then PM final lock), then create the integration branch from an explicit base. Not Done until review chain completes, compass is locked, and base/target branches are recorded.
agent: project-manager
---

# Start Iteration

Start a new Morning Star harness iteration. **Not Done until the Review & Edit chain runs via dispatched roles and PM lock — not when compass files are first written.**

Detailed workflow → **`mstar-iteration` § Phase 1: iteration-start**（含 §1.6 Review & Edit chain）；per-plan Prepare gates → **`mstar-phase-gates`**（specify → clarify → plan）。

## 0. Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `skills/pm/SKILL.md` → **§ Host entry** + **§ Boot**
4. `mstar-iteration` → **§ Phase 1: iteration-start**（迭代范围、compass 模板、§1.6 Review & Edit chain、状态初始化）
5. `mstar-dispatch-gates` → iteration-start review chain + implement dispatch
6. `mstar-phase-gates` → Prepare（specify → clarify → plan）
7. `mstar-plan-conventions`, `mstar-plan-artifacts`

## 1. Research

Load harness entry, then survey structured and unstructured sources:

**Structured harness dirs:**
- `{HARNESS_DIR}/status.json` → active plans, deferred features, residuals
- `{ITERATION_DIR}/` → previous iteration compasses, roadmap batches
- `{KNOWLEDGE_DIR}/` → design knowledge, architecture notes
- `{SPECS_DIR}/` → existing specs, gaps

**Unstructured discovery — search the repo for planning artifacts by name:**
- Glob for `**/roadmap*.md`, `**/ROADMAP*.md`, `**/*-roadmap.md`
- Glob for `**/deferred*.md`, `**/DEFERRED*.md`
- Glob for `**/features*.md`, `**/FEATURES*.md`
- Also search for `**/backlog*.md`, `**/TODO*.md`, `**/todo*.md`, `**/*.plan.md`
- Open and read any matches that carry iteration-level or deferred-scope information

Identify deferred or incomplete items from prior iterations as priority candidates for this iteration.

Also read `STRATEGY.md`（if exists）for strategic alignment.

## 2. Explore Directions

Explore candidate directions targeting **product completeness**:

- Default to completing deferred items from previous iterations
- Allow substantive refactoring where it accelerates product maturity
- Scope 2–4 candidates, each with clear product-completeness goals and trade-offs

## 3. Lock Direction — grill-me

Run the **grill-me skill** to stress-test candidate directions with the user:

- Walk through trade-offs for each candidate
- Converge on a **single iteration direction** with shared understanding
- Document: locked direction, success criteria, non-goals
- Confirm delivery branch policy:
  - `iteration_base_branch`: branch/ref used to create `spec_integration_branch`
  - `target_branch`: PR target after iteration-close
  - If either is not explicit, inspect the current branch and ask. **Do not default to `main` / `master` just because those names exist.**

## 4. Write Compass & Plans

Produce harness artifacts per **`mstar-iteration` § 1.3**（template: `mstar-iteration/references/iteration-compass-template.md`）：

- `{ITERATION_DIR}/<iteration-id>-delivery-compass.md` — YAML frontmatter **must** include `iteration_base_branch`, `target_branch`, `status: active`
- `{PLAN_DIR}/<plan-id>-<name>.md` for each plan in this iteration
- Register all plans in `{HARNESS_DIR}/status.json`（per `mstar-plan-artifacts` §1.5：root `metadata` + plan `spec_integration_branch`）
- Update `{ITERATION_DIR}/README.md` index（per `mstar-iteration` § 1.4）

## 5. Review & Edit Chain（HARD GATE — do not commit before this）

**STOP**: Do not run §6 Integration Branch until **all** rows below are true.

Each role below **reviews and directly edits** the documents. Do not just flag issues — apply the fixes yourself. PM only steps in for the final lock.

| # | Role | Required action |
|---|------|-----------------|
| 5.1 | **@product-manager** | Task subagent: **edit** compass, plans, `{SPECS_DIR}/`; scope, UX, priorities |
| 5.2 | **@architect** | Task subagent: **edit** compass, plans, specs; contracts, SQL, module boundaries |
| 5.3 | **@writing-specialist** | Task subagent: **edit** all iteration docs; terminology, structure, clarity |
| 5.4 | **@project-manager** | Merge subagent edits; resolve conflicts; **lock** compass (`status: locked`); confirm Prepare gates |

**Evidence of done** = edited compass / plans / specs on disk + compass `status: locked`. **No** separate iteration review reports under `reports/` — unlike per-plan QC, there is no downstream audit chain to preserve.

**Tool rule (Cursor / hosts with Task)**:
- Steps 5.1–5.3: **MUST** use `Task` (parallel when independent). See **`mstar-dispatch-gates`** · iteration-start review chain.
- PM thread **MUST NOT** substitute by performing all three specialist edits itself.
- Exception: user explicitly waives subagent dispatch ("PM-only review").

**Prepare gate (per plan in compass)**:
- [ ] specify / clarify / plan = done on each plan file
- [ ] `primary_spec` path exists (if declared)
- [ ] `blocked_by` / sequential deps documented

Only after 5.4 → proceed to §6.

### iteration-start pre-commit checklist

PM must print this block before §6; all `[ ]` must be `[x]`:

- [ ] grill-me decisions recorded in compass
- [ ] Draft compass + plans + `status.json` registered
- [ ] @product-manager Task completed — compass / plans / specs edited
- [ ] @architect Task completed — compass / specs edited
- [ ] @writing-specialist Task completed — iteration docs edited
- [ ] PM final lock: compass `status: locked`; Prepare gates pass (blocked plans documented)
- [ ] Branch policy locked: `iteration_base_branch`, `spec_integration_branch`, and `target_branch` recorded in compass / `status.json`
- [ ] **THEN**: git commit + push `iteration/<iteration-id>`

## 6. Integration Branch

**Precondition**: §5 complete — compass `status: locked`; specialist Tasks returned; Prepare gates confirmed.

- Create `spec_integration_branch` (e.g. `iteration/<iteration-id>`) **from** the locked `iteration_base_branch`:

```bash
git fetch origin   # if needed
git checkout -b <spec_integration_branch> <iteration_base_branch>
# or: git checkout <spec_integration_branch>  if it already exists
```

- Register `iteration_base_branch`, `spec_integration_branch`, and `target_branch` in compass frontmatter **and** `{HARNESS_DIR}/status.json` root `metadata`
- Commit all documents to the integration branch and push to remote

**STOP** if `iteration_base_branch` or `target_branch` is missing. Ask the user or derive only from an already documented project/iteration policy; never silently substitute `main`.
