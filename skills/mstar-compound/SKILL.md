---
name: mstar-compound
description: Morning Star 知识结晶 —— 将已解决问题的经验沉淀为结构化知识文档，存入 `{KNOWLEDGE_DIR}`。支持 Bug track（症状/失败尝试/解决方案）与 Knowledge track（上下文/指南/适用场景）双轨。含重叠检测（更新已有文档）、可发现性检查（AGENTS.md 索引）、CONCEPTS.md 领域词汇协同。触发：PM 在 Done 后调用、Debug 修复后、或任何非平凡问题解决后。产出：`{KNOWLEDGE_DIR}/<category>/<slug>.md` + 可选 AGENTS.md 更新。
---

# mstar-compound（知识结晶）

## Load order

**Read `mstar-harness-core` first.** Path symbols (`{KNOWLEDGE_DIR}`, `{HARNESS_DIR}`) → **`mstar-plan-conventions`**. On conflict, **`mstar-harness-core` wins**.

## Purpose

After solving a non-trivial problem, `mstar-compound` captures the learning as a structured document in `{KNOWLEDGE_DIR}`, so future plan research, debugging, and implementation can find and reuse it. This is the **closing loop** of the mstar delivery cycle: `Done → compound → knowledge feeds back to future specify/plan`.

Knowledge that isn't captured evaporates when the session ends. Knowledge that is captured but not discoverable is equally lost. This skill addresses both.

## 产物存储位置

**SSOT**: `mstar-plan-conventions/references/artifact-storage-paths.md`。本 skill 不重定义路径；知识文档 → `{HARNESS_DIR}/knowledge/<category>/<slug>.md`，CONCEPTS.md → `<repo-root>/CONCEPTS.md`。`<category>` 取值见 `references/category-mapping.md`。

## When to use

## When to use

- PM declares a plan `Done` and the work yielded reusable insight
- A non-trivial bug was fixed and the diagnosis is worth preserving
- A pattern, convention, or tooling decision was established that others should follow
- Any problem took meaningful investigation (not a typo or one-liner)

**Skip when:** the fix is trivial (typo, formatting, dep bump), the solution is already well-documented, or the problem is still in-progress.

## Integration with mstar lifecycle

```
specify → clarify → plan → plan(locked) → tasks → implement → QC → QA → Done
                                                                          │
                                                                    ┌─────┘
                                                                    ▼
                                                              mstar-compound
                                                                    │
                                                                    ▼
                                                              {KNOWLEDGE_DIR}
                                                                    │
                                                    feeds back into future specify / plan
```

Compound can also be invoked standalone at any point where a meaningful learning occurred outside a formal plan.

## Usage

```
/pm compound                    # PM invokes after Done (from conversation context)
/pm compound "the N+1 query in brief generation"
/pm compound plan_id:<id>       # Link knowledge to a specific plan
/pm compound mode:lightweight   # Single-pass mode for simple captures
```

## Two tracks

The skill classifies work into one of two tracks based on problem type:

| Track | What it captures | Section structure |
|-------|-----------------|-------------------|
| **Bug** | Incident-level fix — "X broke, here's why and how we fixed it" | Problem, Symptoms, What Didn't Work, Solution, Why This Works, Prevention |
| **Knowledge** | Durable guidance — "this is how we do X, and why" | Context, Guidance, Why This Matters, When to Apply, Examples |

Track is determined by `problem_type`. See `references/category-mapping.md` for the full mapping.

## Execution modes

| Mode | When | Behavior |
|------|------|----------|
| **Full** (default) | Most cases | Dispatches research subagents for context analysis, solution extraction, and overlap detection |
| **Lightweight** | Simple fixes, context-tight sessions | Single-pass documentation, no subagents, faster |

In Cursor, Full mode dispatches subagents via Task tool. PM selects mode.

## Phase 1: Gather context

Read the conversation history to understand:
- What problem was solved (the concrete issue)
- What was tried and didn't work
- What the working solution was
- Why the solution works (root cause)
- Which files/modules were involved
- The plan_id if applicable (link to `status.json`)

If `{KNOWLEDGE_DIR}/README.md` exists, scan its index for related existing documents.

Classify the problem into a track (bug vs knowledge) and category using `references/category-mapping.md`.

## Phase 2: Overlap detection

Before creating a new doc, check if an existing doc covers the same ground:

1. Extract keywords from the problem (module names, error messages, technical terms)
2. Search `{KNOWLEDGE_DIR}/**/*.md` using frontmatter fields (`module:`, `tags:`, `problem_type:`)
3. Score overlap across dimensions: problem statement, root cause, solution approach, referenced files, prevention

| Overlap | Action |
|---------|--------|
| **High** (4-5 dimensions match) | **Update** the existing doc with fresher context instead of creating a new one. Add `last_updated` field. |
| **Moderate** (2-3 dimensions match) | Create new doc; flag for consolidation review (potential `mstar-compound-refresh` trigger) |
| **Low/None** | Create new doc normally |

## Phase 3: Write the document

### 3.1 Determine path

Category → directory under `{KNOWLEDGE_DIR}/`. Examples:
- Bug track: `build-errors/`, `runtime-errors/`, `performance-issues/`, `database-issues/`, `security-issues/`, `integration-issues/`
- Knowledge track: `architecture-patterns/`, `design-patterns/`, `conventions/`, `workflow-patterns/`, `tooling-decisions/`, `best-practices/`

Filename: `<sanitized-slug>.md` (lowercase, hyphen-separated, no date prefix).

### 3.2 Frontmatter

Required fields for both tracks (SSOT: `references/schema.yaml`):

```yaml
---
module: <area>
date: YYYY-MM-DD
problem_type: <enum value>
category: <directory name>
severity: critical|high|medium|low
plan_id: <optional, link to status.json>
tags: [<keywords>]
---
```

Bug-track adds: `symptoms`, `root_cause`, `resolution_type`.
Knowledge-track adds: `applies_when` (optional).

### 3.3 Body

Follow the section structure from `assets/resolution-template.md` for the determined track.

### 3.4 Validate

After writing, validate the YAML frontmatter:
- `---` delimiters are correct
- All required fields present
- Enum values match allowed values
- `date` is YYYY-MM-DD format
- Array fields use `[item1, item2]` syntax

## Phase 4: Discoverability check

Check whether the project's `AGENTS.md` or `CLAUDE.md` would lead a future agent to discover `{KNOWLEDGE_DIR}`.

If `{KNOWLEDGE_DIR}` is not mentioned in the root instruction file, propose the smallest addition that surfaces the knowledge store. Example:

```markdown
- `{HARNESS_DIR}/knowledge/` — captured solutions and reusable patterns
```

Ask for user consent before applying (PM can approve). If the user declines, the doc is still written — only the discoverability edit is skipped.

## Phase 5: CONCEPTS.md synergy

If the captured learning introduces or clarifies a domain term whose meaning is project-specific and not obvious to a newcomer, propose adding it to `CONCEPTS.md` at the repo root.

Read `references/concepts-vocabulary.md` for inclusion rules. Only propose when the term meets the qualifying bar:
- Its meaning in this project is precise enough that a new engineer would need it defined
- It is not general programming vocabulary

If `CONCEPTS.md` doesn't exist yet, ask whether to seed it. A seed populates the core domain nouns of the area the learning touches; a full repo-wide bootstrap is the job of `mstar-compound-refresh`.

## Phase 6: Update indexes

1. Add a row to `{KNOWLEDGE_DIR}/README.md` index table (create if missing):
   - Document (link), Source Plan (`plan_id`), Description, Status (`Active`)

2. If `plan_id` was provided, optionally update `status.json` metadata to reference this doc under `knowledge_refs`.

## Phase 7: Refresh trigger

After capturing, check if the new learning suggests an older doc may now be stale (contradicted, superseded, or in a refactored domain). If so, recommend:

```
Consider: /pm compound-refresh <scope hint>
```

Do not automatically run refresh — only flag when there's a concrete reason.

## CONCEPTS.md bootstrap requests

If invoked specifically to create CONCEPTS.md from scratch (not to document a solved problem), redirect to `mstar-compound-refresh` (which handles full repo-wide vocabulary bootstrapping). `mstar-compound` only seeds vocabulary as a side effect of capturing a real learning.

## Support files

Read on demand at the step that needs them:

- `references/schema.yaml` — canonical frontmatter schema (Phase 3)
- `references/category-mapping.md` — problem_type → directory + track mapping (Phase 1)
- `references/concepts-vocabulary.md` — CONCEPTS.md rules (Phase 5)
- `assets/resolution-template.md` — section structure per track (Phase 3)

## Skill dependencies

This skill integrates with:
- **`mstar-plan-conventions`** — path symbols (`{KNOWLEDGE_DIR}`, `{HARNESS_DIR}`)
- **`mstar-plan-artifacts`** — `status.json` linking, index maintenance
- **`mstar-compound-refresh`** — for knowledge maintenance after capture

## NOT to do

- Do not create a doc for trivial fixes (typos, formatting, dep bumps)
- Do not write the doc before the solution is verified
- Do not skip the overlap check — creating duplicates degrades the knowledge store
- Do not edit AGENTS.md without user consent
- Do not create CONCEPTS.md entries for general programming vocabulary
- Do not modify product code — this skill writes documentation only
