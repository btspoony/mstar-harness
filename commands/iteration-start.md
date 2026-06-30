---
name: iteration-start
description: Start a new harness iteration — research backlog, lock direction with grill-me, produce compass/plans, run edit chain (product-manager → architect → writing-specialist each review-and-edit, then PM final review and lock), submit to integration branch
agent: project-manager
---

# Start Iteration

Start a new Morning Star harness iteration. Detailed workflow → **`mstar-iteration` § Phase 1: iteration-start**；per-plan Prepare gates → **`mstar-phase-gates`**（specify → clarify → plan）。

## 0. Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `skills/pm/SKILL.md` → **§ Host entry** + **§ Boot**
4. `mstar-iteration` → **§ Phase 1: iteration-start**（迭代范围、compass 模板、状态初始化）
5. `mstar-phase-gates` → Prepare（specify → clarify → plan）
6. `mstar-plan-conventions`, `mstar-plan-artifacts`

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

## 4. Write Compass & Plans

Produce harness artifacts per **`mstar-iteration` § 1.3 创建迭代 compass**（template: `mstar-iteration/references/iteration-compass-template.md`）：

- `{ITERATION_DIR}/<iteration-id>-delivery-compass.md` — iteration scope, plans table, milestones, acceptance criteria, non-goals, roadmap position
- `{PLAN_DIR}/<plan-id>-<name>.md` for each plan in this iteration
- Register all plans in `{HARNESS_DIR}/status.json`（per `mstar-plan-artifacts`）
- Update `{ITERATION_DIR}/README.md` index（per `mstar-iteration` § 1.4）

## 5. Review & Edit Chain

Each role below **reviews and directly edits** the documents. Do not just flag issues — apply the fixes yourself. PM only steps in for the final lock.

1. **@product-manager** — review and edit the compass; adjust scope, priorities, and user-facing details; write or update specs in `{SPECS_DIR}/`
2. **@architect** — review and edit the compass and specs; adjust technical architecture, interface contracts, module boundaries, and trade-off reasoning
3. **@writing-specialist** — review and edit all documents for clarity, consistency, completeness, and bilingual parity; tighten prose, unify terminology, and remove ambiguity
4. **PM** — final review; lock all documents; confirm Prepare phase gates pass

## 6. Integration Branch

- Create `iteration/<iteration-id>` from `main`
- Register `spec_integration_branch` in `{HARNESS_DIR}/status.json`
- Commit all documents to the integration branch and push to remote
