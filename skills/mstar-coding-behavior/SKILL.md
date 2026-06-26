---
name: mstar-coding-behavior
description: Morning Star (启明星) 跨角色通用编码行为准则 —— Think Before Coding（先读懂再改、显式假设、不静默猜测）、Simplicity First（YAGNI 优先不写代码、The Ladder 决策层级、删除优于添加、简洁优于聪明、`simplify:` 标记天花板与升级路径、最小耐久切片）、Surgical Changes（改动可追溯、Bug 修根因先 grep 所有调用点、不顺手重构、不 piggyback）、Goal-Driven Execution（非平凡逻辑必留一个可运行检查、模糊请求转可验证结果、Step → verify 微模板、分批留 roadmap）。任何实现、调试、重构、审查任务都应优先 Read 本 skill；`@fullstack-dev` / `@frontend-dev` / `@fullstack-dev-2` / `@architect` / `@qa-engineer` / `@ops-engineer` / `@prompt-engineer` 动手前必读；QC 审查员核对变更是否只做了该做的手术时必读。本 skill 不覆盖分支门禁、QC/QA 路由、Assignment 权限、Done 所有权等不变量（那些以 `mstar-harness-core` 为准）。
---

## Load order（必读顺序）

**在同一会话或任务中首次 Read 本 skill 时：必须先 Read `mstar-harness-core` skill（SKILL.md）。** 本 skill 只约束 **编码与改动风格**（Think / Simplicity / Surgical / Goal-Driven）；**Done 所有权、状态机** 仍以 **`mstar-harness-core`** 为准；**分支 / worktree / QC-QA 检出字段** → **`mstar-branch-worktree`**；**调度防串扰** → **`mstar-dispatch-gates`**。冲突时 **以 `mstar-harness-core` 为准**。

**摘要**：`mstar-harness-core` — 不变量与门禁；本 skill — 实现与审查时的工程习惯，不替代 harness。

# Morning Star Coding Behavior Guidelines

This skill captures lightweight, host-agnostic coding behavior principles that reduce common agent mistakes. It complements the other Morning Star skills and does not override stage gates or role routing.

Priority remains (同 `mstar-harness-core` SKILL.md「信息源优先级」):

1. User explicit instruction
2. Project `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` skill（global entry & SSOT）
4. Other `mstar-*` skills（含本 skill）
5. Role prompts in `mstar-roles` skill

## Scope

- Applies to non-trivial coding, debugging, refactoring, and review tasks.
- For trivial one-liners, use judgment and keep overhead minimal.
- This skill defines execution behavior, not branch policy or gate ownership.

## 1) Think Before Coding

Core idea: do not silently choose an interpretation when ambiguity exists.

- State assumptions explicitly before implementation when uncertainty is material.
- If there are multiple plausible interpretations, present options and ask for confirmation.
- Surface key tradeoffs when they affect scope, risk, or maintainability.
- If critical context is missing, pause and clarify instead of guessing.

Quick check:

- Can another reviewer see what assumptions were made?
- If assumptions are wrong, will the user detect it before large edits happen?

**Never lazy about understanding.** Shorten the solution, never the reading. Read the task and every file the change touches fully first; trace the actual flow end to end. A small diff in the wrong place is not efficiency — it is a second bug shipped with confidence.

## 2) Simplicity First

Core idea: implement the smallest durable slice that satisfies the request and acceptance criteria.

**Question the need (YAGNI).** Before writing code, ask: does this task need code at all? Can the goal be achieved by deletion, reusing existing logic, or a configuration change? If a path requires no code, take it and explain in one line.

**The Ladder.** A reflex hierarchy for every decision — stop at the first rung that holds:

1. **Does this need code at all?** Speculative need → skip it (YAGNI).
2. **Already in this codebase?** A helper, util, type, or pattern that already lives here → reuse it. Look before you write.
3. **Stdlib / built-in covers it?** Use it.
4. **Native platform feature covers it?** CSS over JS, DB constraint over app code, OS primitive over a library.
5. **Already-installed dependency solves it?** Use it. Never add a new dependency for what a few lines can do.
6. **Can it be one line?** One line.
7. **Only then:** the minimum durable code that works.

The ladder runs after understanding, not instead of it. Two rungs work → take the higher one and move on.

**Deletion over addition. Boring over clever.** Removing unnecessary code is a feature. Cleverness is what someone decodes at 3am — prefer a boring, obvious solution that a tired reviewer can verify in seconds.

- Do not add features, flags, or configurability that were not requested.
- Avoid introducing new abstractions for single-use logic.
- Prefer straightforward local fixes over framework-level reshaping **only when they fit the target design**.
- Reject speculative error handling for impossible paths unless required by project policy.

**Simplification markers.** When a deliberate shortcut has a known ceiling (global lock, O(n²) scan, naive heuristic), mark it with a `simplify:` comment that names the ceiling and the upgrade path:

```text
// simplify: global lock on cache misses. Replace with per-key lock if throughput matters.
```

This signals intent — the simplicity is deliberate, not an oversight — and gives the next person the upgrade path without research.

- Do not confuse "minimum" with "temporary." A small implementation must still align with the long-term target state, stable interfaces, and known follow-up plan.
- If a workaround is unavoidable, label it as `simplify:` / `temporary`, explain why, and record the removal path in the plan/status artifact before claiming the task is complete.

Default rule:

- If 200 lines can be 50 with the same behavior, clarity, and durable architecture, prefer the smaller solution.

Durability check:

- Can this slice be extended by the next batch without undoing its core shape?
- Are deferred items captured in an existing roadmap / task board / residual tracker, not just mentioned in chat?
- Would a reviewer understand whether this is the final approach, a staged slice, or a deliberate simplification?

## 3) Surgical Changes

Core idea: every changed line should be traceable to the task.

- Touch only files and regions needed for the requested outcome.
- Do not opportunistically refactor adjacent code.
- Match existing style and patterns unless a change is explicitly requested.
- Remove only artifacts made unused by your own change.
- If unrelated issues are found, report them separately instead of piggyback editing.

Traceability test:

- Each hunk should map to a user requirement, acceptance criterion, or required fix-up.

**Bug fix = root cause, not symptom.** A bug report names a symptom, not the cause. Before editing, grep every caller of the function or code path you are about to touch. The fix belongs where all callers route through — one guard in the shared function is smaller than a guard in every caller. Patching only the path the ticket names leaves every sibling caller still broken. Fix it once, at the narrowest shared point.

## 4) Goal-Driven Execution

Core idea: convert vague requests into verifiable outcomes and iterate until verified.

- Define concrete success criteria before major edits.
- For multi-step tasks, use brief `Step -> verify` checkpoints.
- For split delivery, maintain a durable roadmap: current slice, later slices, dependencies, owner/trigger, and completion condition.
- Prefer evidence-backed completion claims (tests, command output, reproducible checks).
- If verification fails, loop on diagnosis and fix before declaring completion.
- Do not finish with "next plan / later / follow-up" only in prose. If the work is not fully complete, the remaining work must be written to the plan/status artifact or the task must report `Partial` / `Blocked`.

**Minimal check for non-trivial logic.** Any non-trivial change (a branch, a loop, a parser, a data transformation, a money or security path) must leave behind ONE runnable check — the smallest thing that fails if the logic breaks. An inline self-check, a quick `assert`-based demo, or one minimal test. No frameworks, no fixtures, no per-function suites unless asked. Trivial one-liners need none — YAGNI applies to tests too.

Micro template:

```text
1. [Step]
   Verify: [specific check]
2. [Step]
   Verify: [specific check]
3. [Step]
   Verify: [specific check]
```

## Integration Notes

- This skill is additive to `verification-before-completion` (见 `mstar-superpowers-align`) and other Morning Star controls.
- It must not be used to bypass:
  - branch constraints,
  - QC/QA gate definitions,
  - assignment authority,
  - `Done` ownership rules.

## Anti-Bloat Rule for Prompt Maintenance

- Keep these principles centralized here.
- Role prompts should reference this skill instead of duplicating long prose.
- Only role-specific triggers, boundaries, and artifacts belong in role prompt files.
