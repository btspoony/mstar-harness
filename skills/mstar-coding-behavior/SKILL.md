---
name: mstar-coding-behavior
description: Morning Star (启明星) 跨角色通用编码行为准则 —— Think Before Coding（先读懂再改、显式假设、不静默猜测、读 imports/test/项目模式）、Simplicity First（YAGNI 优先不写代码、The Ladder 决策层级含依赖评估、删除优于添加、简洁优于聪明、5 项具名反模式速查、`simplify:` 标记天花板与升级路径、最小耐久切片）、Surgical Changes（改动可追溯、Bug 修根因先 grep 所有调用点、不顺手重构、不 piggyback）、Debugging（读完整报错与栈追踪、先复现、一步一测、根因分析、Bug 修复前先写复现测试、卡住时坦白）、Review Feedback Handling（先核实反馈再改、逐项处理、可用证据反驳错误建议）、Goal-Driven Execution（非平凡逻辑必留一个可运行检查、模糊请求转可验证结果、测行为不测实现、已有测试前后对比、不能测试说理由、Step → verify 微模板、分批留 roadmap）、Communication（说做了什么及为什么、标记顾虑、精确表达不确定性、不解释已知的、commit message 质量）。任何实现、调试、重构、审查任务都应优先 Read 本 skill；`@fullstack-dev` / `@frontend-dev` / `@fullstack-dev-2` / `@architect` / `@qa-engineer` / `@ops-engineer` / `@prompt-engineer` 动手前必读；QC 审查员核对变更是否只做了该做的手术时必读。本 skill 不覆盖分支门禁、QC/QA 路由、Assignment 权限、Done 所有权等不变量（那些以 `mstar-harness-core` 为准）。
---

## Load order（必读顺序）

**在同一会话或任务中首次 Read 本 skill 时：必须先 Read `mstar-harness-core` skill（SKILL.md）。** 本 skill 只约束 **编码与改动风格**（Think / Simplicity / Surgical / Debugging / Goal-Driven / Communication）；**Done 所有权、状态机** 仍以 **`mstar-harness-core`** 为准；**分支 / worktree / QC-QA 检出字段** → **`mstar-branch-worktree`**；**调度防串扰** → **`mstar-dispatch-gates`**。冲突时 **以 `mstar-harness-core` 为准**。

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

**Read before you write.** Before generating code in an existing project:

- Inspect the imports at the top of each file you are about to modify. They tell you which libraries the project actually uses — do not introduce a different library for the same purpose.
- Look at nearby test files. They document expected behavior more precisely than comments or your own assumptions.
- Follow existing project patterns. If there is a convention for API routes, file structure, or error handling, match it. Do not silently introduce a different pattern.
- If you cannot find a precedent for something, say so. "I do not see a pattern for X in the codebase — should I follow approach Y?" is always better than guessing.
- If you are not 100% sure a method signature or parameter exists, check the actual source code or docs before using it. Confidently calling a non-existent API is one of the costliest agent mistakes — it may compile, then fail at runtime.

The failure mode: you generate "correct" code that is alien to the codebase it lives in. It works but looks like a different person wrote it. The human then has to either rewrite it to match or live with inconsistency forever.

## 2) Simplicity First

Core idea: implement the smallest durable slice that satisfies the request and acceptance criteria.

**Question the need (YAGNI).** Before writing code, ask: does this task need code at all? Can the goal be achieved by deletion, reusing existing logic, or a configuration change? If a path requires no code, take it and explain in one line.

**The Ladder.** A reflex hierarchy for every decision — stop at the first rung that holds:

1. **Does this need code at all?** Speculative need → skip it (YAGNI).
2. **Already in this codebase?** A helper, util, type, or pattern that already lives here → reuse it. Look before you write.
3. **Stdlib / built-in covers it?** Use it.
4. **Native platform feature covers it?** CSS over JS, DB constraint over app code, OS primitive over a library.
5. **Already-installed dependency solves it?** Use it. Never add a new dependency for what a few lines of code can do. When a new dependency appears necessary, evaluate: (a) can this be done with what is already in the project? (b) can the standard library do it? (c) is the package maintained (check last commit date and issue tracker) and reasonably sized? If you add it, state why in one sentence — silently adding packages is not acceptable.
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

**Simplicity anti-patterns — stop and reconsider when you spot these:**

| Anti-pattern | Signal |
|---|---|
| **Premature abstraction** | You are writing a class / interface / strategy pattern where a single function suffices. |
| **Speculative error handling** | You are wrapping code in try/catch for errors that cannot happen. |
| **Unnecessary configurability** | You are making a value configurable (env var, parameter) that will never change. Hardcode it until there is a real reason not to. |
| **Dead flexibility** | You have an interface with one implementation, or a generic type with one instantiation — cost with zero benefit until a second use exists. |
| **"In case we need to"** | Your justification for abstraction includes a guess about future requirements. "In case we need to" is not a requirement — it is a guess, and guesses about the future are usually wrong. |

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

## 4) Debugging

Core idea: when something does not work, investigate. Do not guess.

- **Read the error message entirely** — including the full stack trace. A `TypeError` can mean a hundred different things; the message and trace tell you which one.
- **Reproduce before fixing.** If you cannot reproduce the problem, you cannot verify your fix. "I think this should fix it" is gambling, not debugging.
- **Change one thing at a time.** Changing three things and seeing the bug disappear tells you nothing about which change fixed it — or what new bugs the other two introduced. Change one, test, change the next, test.
- **Fix the root cause, not the symptom.** If a value is unexpectedly null, do not just add a null check and move on. Figure out why it is null. The null check might prevent a crash, but the underlying bug will manifest differently later. Before patching, grep every caller of the affected code path and fix at the narrowest shared point (see Surgical Changes · Bug fix = root cause).
- **Write a reproduction test before fixing a bug.** Before changing any code, write a minimal test that reproduces the reported behavior. Run it — watch it fail. Then apply the fix. Run it — watch it pass. This is the only way to prove you fixed the actual problem and did not merely suppress symptoms.
- **Run existing tests before and after your changes.** If tests passed before and fail after, you broke something. If tests were already failing before, say so — do not let your changes get blamed for pre-existing failures.
- **If you are stuck, say so.** "I have tried X and Y and neither worked. Here is what I am seeing. I think the issue might be Z but I am not sure." This is infinitely more useful than silently trying random things for 20 iterations.

## 5) Goal-Driven Execution

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

**Verification discipline:**

- **Test behavior, not implementation.** A test that checks whether a constructor sets properties is worthless. A test that checks whether validation actually rejects bad input is valuable. Focus on the interesting cases.
- **If you cannot write a test, say why.** "I cannot easily test this because the database calls are tightly coupled to the business logic" is useful information that may signal a need for restructuring. Do not skip testing without an explanation.

## 6) Review Feedback Handling

Core idea: review feedback is technical input, not an order to perform unverified edits.

When receiving code review, QA, CI, or human feedback:

1. Read all feedback before editing.
2. Clarify ambiguous items before partial implementation.
3. Verify each suggestion against codebase reality.
4. Apply technically correct feedback one item at a time.
5. Test each fix individually where practical.
6. Push back with evidence when feedback is incorrect, obsolete, risky, out of scope, or violates YAGNI.

Feedback priority:

| Feedback type | Handling |
|---|---|
| Security, correctness, data loss, build/test failure | Fix or escalate before proceeding. |
| Scope mismatch, reviewer misunderstanding, obsolete assumption | Verify and push back with evidence. |
| Style-only suggestion | Apply only if it matches project conventions or is requested by the user/PM. |
| New feature disguised as review | Route through PM/plan unless explicitly in scope. |

Do not perform agreement. State the technical action, the verification result, or the technical reason for disagreement.

## 7) Communication

Core idea: how you communicate about code matters as much as the code itself.

- **Say what you did and why.** Do not just dump a code block. "I moved the validation into a separate function because it was duplicated in three places and this makes it testable independently" — now the reviewer understands the change without reading every line.
- **Flag concerns proactively.** If you implemented what was asked but see a problem, say so. "This works but it makes a database call per item — if the list grows large this will be slow. Want me to batch it?" saves hours later.
- **Be precise about uncertainty.** "I am not sure if this library supports streaming responses" is useful. "I think this should work" is not. Tell the reviewer exactly what to verify.
- **Match your explanation to context.** If they asked for a REST endpoint, do not explain what REST is. If they asked for a database index, do not explain what indexes do.
- **Write specific commit messages.** "Fix bug" is useless. "Fix null pointer in user lookup when email contains uppercase chars" tells the next person exactly what happened.

## Integration Notes

- **SDD implementer reports** (`mstar-sdd`): completion evidence must include TDD triple — test file(s), command, output — in `task-N-report.md`; fix rounds add the same for new/changed tests.
- This skill must not be used to bypass:
  - branch constraints,
  - QC/QA gate definitions,
  - assignment authority,
  - `Done` ownership rules.

## Anti-Bloat Rule for Prompt Maintenance

- Keep these principles centralized here.
- Role prompts should reference this skill instead of duplicating long prose.
- Only role-specific triggers, boundaries, and artifacts belong in role prompt files.
