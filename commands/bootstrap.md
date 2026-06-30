---
name: bootstrap
description: Bootstrap or refresh a project's knowledge scaffolding — distill STRATEGY.md, CONCEPTS.md, and baseline knowledge docs from the existing codebase and any docs. Use when a project has no knowledge infrastructure, stale/partial docs, or needs a fresh distillation.
agent: project-manager
---

# Bootstrap Project Knowledge

Distill a coherent knowledge baseline from the current project — useful when the project has no `STRATEGY.md` / `CONCEPTS.md` / `{KNOWLEDGE_DIR}`, has partial or outdated ones, or has accumulated documentation debt.

**Goal**: produce a minimal, accurate, opinionated knowledge foundation that future iteration-start and plan-work can ground in.

## Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `skills/pm/SKILL.md` → **§ Host entry** + **§ Boot**
4. `mstar-plan-conventions`（路径符号）
5. `mstar-strategy` → **§ STRATEGY.md structure** + **§ Creating STRATEGY.md**
6. `mstar-compound` → **references/concepts-vocabulary.md**（CONCEPTS.md 规则）
7. `mstar-compound-refresh` → **§ Core rules**（知识维护基线）

## Phase 1: Survey — understand what exists

### 1.1 Codebase scan

- Read `README.md` (if exists) to understand project purpose
- Read `AGENTS.md` / `CLAUDE.md` (if exists) for conventions and maintenance rules
- Glob for `**/package.json`, `**/pyproject.toml`, `**/go.mod`, `**/Cargo.toml` to identify tech stack
- Glob for `**/src/`, `**/lib/`, `**/app/` to identify module structure
- Scan top-level directory layout

### 1.2 Existing knowledge inventory

Check what already exists and note its condition:

| Artifact | Check | Condition |
|----------|-------|-----------|
| `STRATEGY.md` | Exists? Is it current/accurate? | `absent` / `stale` / `partial` / `current` |
| `CONCEPTS.md` | Exists? Covers core domain nouns? | `absent` / `stale` / `partial` / `current` |
| `{KNOWLEDGE_DIR}/README.md` | Exists? Index populated? | `absent` / `empty` / `partial` / `current` |
| `{KNOWLEDGE_DIR}/**/*.md` | Any knowledge docs? Are they still accurate? | `none` / `few` / `some` / `many` |
| `{ITERATION_DIR}/README.md` | Exists? Any past iteration artifacts? | `absent` / `present` |
| `{SPECS_DIR}/` or `designs/` | Any specs or ADRs? | `absent` / `present` |
| `docs/` | Any architecture docs, design notes? | Count and note relevance |
| `{HARNESS_DIR}/status.json` | Exists? Any historical plans? | `absent` / `present` |

Report findings to the user: what exists, what's missing, what's stale.

### 1.3 Deep read — extract knowledge from code

For each primary module / package identified in 1.1:

1. Read the module's exported interface (public classes, functions, APIs)
2. Read key configuration files (database schema, routes, middlewares)
3. Identify recurring patterns: error handling style, dependency injection, ORM usage, auth flow
4. Note any README or docstrings that describe domain concepts

**Output**: a mental model of the project's domain, architecture patterns, conventions, and tech choices.

## Phase 2: Distill STRATEGY.md

Use `mstar-strategy` skill to produce `<repo-root>/STRATEGY.md`.

### If STRATEGY.md is absent

1. Gather context from Phase 1 survey
2. Ask the user the 5 interview questions（`mstar-strategy` § Phase 2）
3. Draft and review: keep each section 1-3 sentences

### If STRATEGY.md exists but is stale/partial

1. Present specific findings: "Section X contradicts current code / is outdated because Y changed"
2. Ask whether to update in-place or rewrite
3. Apply edits, keeping the Decision Log for historical context

### If STRATEGY.md is current

Skip, note in report.

## Phase 3: Seed CONCEPTS.md

Use `mstar-compound/references/concepts-vocabulary.md` rules to produce `<repo-root>/CONCEPTS.md`.

### Identify core domain nouns

From the codebase survey and STRATEGY.md, extract terms that meet the qualifying bar:
- Its meaning in this project is precise enough that a new engineer would need it defined
- It is not general programming vocabulary

**Source areas** to scan:
- Database schema (table/column names that encode domain concepts)
- Core model/type definitions
- API endpoint naming patterns
- Entity relationship structure
- README / architecture docs
- STRATEGY.md domain terms

### Write entries

Each entry: one-sentence definition + optional paragraph for behavioral rules.
- Cluster by domain relationship
- Add `*Avoid:*` aliases for retired synonyms
- No implementation specifics (file paths, class names)
- Add `## Flagged ambiguities` tail section if needed

### If CONCEPTS.md already exists

Reconcile: keep valid entries, add newly discovered terms, update stale definitions. Do not duplicate.

## Phase 4: Generate baseline knowledge docs

From the Phase 1 survey, identify patterns and conventions worth documenting as knowledge docs in `{KNOWLEDGE_DIR}/`.

### Minimum docs to produce (if absent)

| Knowledge doc | Content source | Category |
|---------------|---------------|----------|
| **Architecture overview** | Module structure, tech stack, component interactions | `architecture-patterns/` |
| **Development conventions** | Linting, testing, commit format, code style from AGENTS.md / configs | `conventions/` |
| **Project setup** | Dependencies, environment setup, build/run commands | `developer-experience/` |
| **Key domain patterns** | ORM patterns, auth flow, error handling, API design | `best-practices/` |

Each doc follows the Knowledge track template (`mstar-compound/assets/resolution-template.md`).

### What NOT to generate

- Do not guess implementation details you haven't verified from code
- Do not document general framework knowledge (e.g., "how to use React")
- Do not create docs for areas the user explicitly excludes

### If knowledge docs already exist

Apply `mstar-compound-refresh` logic:
- Keep accurate docs
- Update stale references
- Consolidate overlapping docs
- Delete docs for code that no longer exists
- Add new docs only for genuinely undocumented patterns

## Phase 5: Indexing & discoverability

1. Create or update `{KNOWLEDGE_DIR}/README.md` index table
2. Create or update `{ITERATION_DIR}/README.md` index table (if iteration artifacts exist)
3. Check AGENTS.md references all knowledge artifacts:
   - If missing `{HARNESS_DIR}/knowledge/` → propose adding
   - If missing `STRATEGY.md` → propose adding
   - If missing `CONCEPTS.md` → propose adding
4. Ask for consent before editing AGENTS.md

## Phase 6: Initialize harness (if absent)

If `{HARNESS_DIR}/` does not exist:
1. Initialize per `mstar-plan-conventions`（`.mstar/` + subdirectories）
2. Create empty `status.json` from template (`mstar-plan-artifacts/templates/status.empty.json`)

## Phase 7: Commit

All bootstrap artifacts must be committed:

```bash
git add STRATEGY.md CONCEPTS.md AGENTS.md {HARNESS_DIR}/ {KNOWLEDGE_DIR}/
git commit -m "chore: bootstrap project knowledge — STRATEGY.md, CONCEPTS.md, baseline knowledge docs"
```

Report a summary:
- STRATEGY.md: created / updated / skipped
- CONCEPTS.md: created / updated（<N> entries）/ skipped
- Knowledge docs: <N> created, <N> updated, <N> deleted, <N> kept
- Harness: initialized / already existed
- AGENTS.md: updated / not modified
