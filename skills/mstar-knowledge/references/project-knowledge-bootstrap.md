# Bootstrap Project Knowledge

Distill a coherent knowledge baseline from the current project — useful when the project has no `STRATEGY.md` / `CONCEPTS.md` / `{KNOWLEDGE_DIR}`, has partial or outdated ones, or has accumulated documentation debt.

**Goal**: produce a minimal, accurate, opinionated knowledge foundation that future iteration-start and plan-work can ground in.

## Load order (bootstrap)

Standalone, this bootstrap needs **`mstar-knowledge`** (this skill) plus **`mstar-doc-corpus`** for document shape; `mstar-harness-core` and `mstar-conventions` apply only when the project already runs the harness.

1. `mstar-knowledge` — this skill: `## Workflow — Maintain` 步骤与 `## Decision Rules` 基线
2. **`mstar-doc-corpus`** — 知识文档形状 SSOT（frontmatter 字段、两轨骨架、`problem_type` → 目录）
3. This skill's **references/strategy-document.md**（STRATEGY.md 形状、六节校验、访谈、维护触发）
4. This skill's **references/concepts-vocabulary.md**（CONCEPTS.md 规则）
5. Only when the harness already runs: `mstar-harness-core`（生命周期/授权权威）与 `mstar-conventions`（路径符号与发现链）

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
| `{KNOWLEDGE_DIR}/README.md` | Exists as prose navigation? Check registration completeness through `mstar catalog list` only when an active store exists, not README rows; with no store the document set is its own registry, so judge it from the files alone. | `absent` / `empty` / `partial` / `current` |
| `{KNOWLEDGE_DIR}/**/*.md` | Any knowledge docs? Are they still accurate? | `none` / `few` / `some` / `many` |
| `{ITERATION_DIR}/README.md` | Exists? Any past iteration artifacts? | `absent` / `present` |
| `{SPECS_DIR}/` or `designs/` | Any specs or ADRs? | `absent` / `present` |
| `docs/` | Any architecture docs, design notes? | Count and note relevance |
| Store-backed execution authority (only when the harness exists) | Query `mstar status validate` / `mstar plan show` for workflow/plan history (retained `status.json` / snapshots are migration sources only, never an execution probe). | `absent` / `present` |

Report findings to the user: what exists, what's missing, what's stale.

### 1.3 Deep read — extract knowledge from code

For each primary module / package identified in 1.1:

1. Read the module's exported interface (public classes, functions, APIs)
2. Read key configuration files (database schema, routes, middlewares)
3. Identify recurring patterns: error handling style, dependency injection, ORM usage, auth flow
4. Note any README or docstrings that describe domain concepts

**Output**: a mental model of the project's domain, architecture patterns, conventions, and tech choices.

## Phase 2: Distill STRATEGY.md

Produce `<repo-root>/STRATEGY.md`; this phase owns the flow, `references/strategy-document.md` owns the artifact contract.

### STRATEGY.md shape

Six required sections — Vision / What we build / What we don't build / Guiding Principles / Technology Direction / Decision Log — plus three optional ones; opinionated, one screen, 1–3 sentences each → `references/strategy-document.md` § Shape.

### Six-section validation

The six required headings must all be present before this phase reports done; `mstar lint <STRATEGY.md>` (`lintStrategySections`, optional validator) checks them for you → `references/strategy-document.md` § Validation.

### Creation interview

Ask the five questions one at a time — one-sentence vision, primary users and what they need, permanent non-goals, 2–3 decision principles, technology bets and why → `references/strategy-document.md` § Interview.

### Maintenance triggers

Re-review after a major architectural decision, when a plan introduces a new technology stack, or quarterly (PM-scheduled); replace a superseded direction, never keep both → `references/strategy-document.md` § Maintenance.

Handle the observed state: **absent** → gather from the Phase 1 survey, run the interview, draft and review (1–3 sentences per section); **stale/partial** → present the specific finding ("Section X contradicts current code / is outdated because Y changed"), ask in-place vs rewrite, apply while keeping the Decision Log for historical context; **current** → skip, note in report.

## Phase 3: Seed CONCEPTS.md

Use `references/concepts-vocabulary.md` (same skill) rules to produce `<repo-root>/CONCEPTS.md`.

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

Each doc follows the Knowledge track skeleton (`mstar-doc-corpus` `assets/knowledge-skeleton.md`).

### What NOT to generate

- Do not guess implementation details you haven't verified from code
- Do not document general framework knowledge (e.g., "how to use React")
- Do not create docs for areas the user explicitly excludes

### If knowledge docs already exist

Apply `## Workflow — Maintain` logic: keep accurate docs, update stale references, consolidate overlapping docs, delete docs for code that no longer exists, add new docs only for genuinely undocumented patterns.

## Phase 5: Indexing & discoverability

1. With an active store, discover and register knowledge through reviewed `mstar catalog discover` + `mstar catalog import` (or `register`); with no store the document set is its own registry and this step is a no-op. README is prose, with no registration-row obligation
2. Create or update `{ITERATION_DIR}/README.md` index table (if iteration artifacts exist)
3. Check AGENTS.md references all knowledge artifacts:
   - If missing `{KNOWLEDGE_DIR}/` → propose adding
   - If missing `STRATEGY.md` → propose adding
   - If missing `CONCEPTS.md` → propose adding
4. Ask for consent before editing AGENTS.md

## Phase 6: Initialize harness — opt-in only

Opt in only when the project wants lifecycle tracking (plans, iterations, a store-backed catalog, issue capture); the default standalone outcome needs none of it, the Phase 2–5 artifacts being a complete bootstrap committed with no `{HARNESS_DIR}` and no store.

With **no active store**, scaffold per **`mstar-conventions`**（`.mstar/` + subdirectories via `mstar harness scaffold`）then create the authority with `mstar store init`（scaffold writes no `status.json`；without an ACTIVE store there is no execution authority and work uses conversation tracking）. With an **active store already present**, initialize nothing — `mstar store init` refuses against an existing store.

Either way, before Phase 7, register every bootstrap artifact the catalog does not have yet: reviewed `mstar catalog discover`（dry-run proposal）then `mstar catalog import`，scoped to `STRATEGY.md`, `CONCEPTS.md` and the Phase 4 knowledge docs, so catalog searches and the completeness check see them instead of failing while bootstrap reports success.

## Phase 7: Commit

All bootstrap artifacts must be committed; add `{HARNESS_DIR}/` only when Phase 6 scaffolded it (the standalone default commits no harness root).
Bootstrap commits use the configured identity; missing/failing identity is Blocked, never fabricate or use `-c` identity overrides → `mstar-roles/references/_shared/leaf-executor-core.md` § Git NEVER (repo writes).

```bash
git add STRATEGY.md CONCEPTS.md AGENTS.md {KNOWLEDGE_DIR}/
git commit -m "chore: bootstrap project knowledge — STRATEGY.md, CONCEPTS.md, baseline knowledge docs"
```

Report a summary:
- STRATEGY.md: created / updated / skipped
- CONCEPTS.md: created / updated（<N> entries）/ skipped
- Knowledge docs: <N> created, <N> updated, <N> deleted, <N> kept
- Harness: initialized / already existed / not initialized (standalone default)
- AGENTS.md: updated / not modified
