---
name: iteration-start
description: Start a new harness iteration — research backlog, lock direction with grill-me, produce compass/plans, run review chain (product-manager → architect → writing-specialist → PM lock), submit to integration branch
agent: project-manager
---

# Start Iteration

Start a new Morning Star harness iteration. Follow Prepare gates from `mstar-phase-gates` (specify → clarify → plan).

## 0. Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `skills/pm/SKILL.md` → **§ Host entry** (PM role identity) + **§ Boot** (load order)
4. `mstar-phase-gates` → Prepare (specify → clarify → plan)
5. `mstar-plan-conventions`, `mstar-plan-artifacts`

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

Produce harness artifacts:

- `{ITERATION_DIR}/<iteration-id>-compass.md` — iteration vision, scope, roadmap batches, deferred items
- `{PLAN_DIR}/<plan-id>-<name>.md` for each plan in this iteration
- Register all plans in `{HARNESS_DIR}/status.json`

## 5. Review Chain

1. **@product-manager** — review compass; adjust scope and user-facing details; write or update specs in `{SPECS_DIR}/`
2. **@architect** — review compass and specs; adjust technical architecture, interface contracts, and module boundaries
3. **@writing-specialist** — full review of all documents for clarity, consistency, and completeness
4. **PM** — final review; lock all documents; confirm Prepare phase gates pass

## 6. Integration Branch

- Create `iteration/<iteration-id>` from `main`
- Register `spec_integration_branch` in `{HARNESS_DIR}/status.json`
- Commit all documents to the integration branch and push to remote
