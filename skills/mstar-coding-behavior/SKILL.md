---
name: mstar-coding-behavior
description: Morning Star 跨角色通用编码行为准则 —— 任何实现、调试、重构、审查任务动手前必读。约束 Think Before Coding（先读懂再改、显式假设、不静默猜测）、Simplicity First（YAGNI、The Ladder、`simplify:` 标记、最小耐久切片）、Surgical Changes（改动可追溯、Bug 修根因定向检查直接调用点、不 piggyback）、Debugging（先复现、一步一测、修前写复现测试）、Review Feedback Handling（先核实再改、证据反驳）、Goal-Driven Execution（非平凡逻辑留可运行检查、Step→verify）。`@fullstack-dev*` / `@frontend-dev` / `@architect` / `@qa-engineer` / `@ops-engineer` / `@prompt-engineer` 必读；QC 核对手术范围时必读。不覆盖分支门禁、QC/QA 路由、Assignment 权限。
---

## Load order（必读顺序）

**在同一会话或任务中首次 Read 本 skill 时：必须先 Read `mstar-harness-core` skill（SKILL.md）。** 本 skill 只约束 **编码与改动风格**（Think / Simplicity / Surgical / Debugging / Goal-Driven）；**Done 所有权、状态机** 仍以 **`mstar-harness-core`** 为准；**分支 / worktree / QC-QA 检出字段** → **`mstar-branch-worktree`**；**调度防串扰** → **`mstar-dispatch-gates`**。冲突时 **以 `mstar-harness-core` 为准**。

**摘要**：`mstar-harness-core` — 不变量与门禁；本 skill — 实现与审查时的工程习惯，不替代 harness。

Priority remains（同 `mstar-harness-core`「信息源优先级」）：① 当轮用户显式指令 ② 项目 `AGENTS.md` / `CLAUDE.md` ③ `mstar-harness-core` ④ 其它 `mstar-*`（含本 skill）⑤ `mstar-roles` 角色正文。

**Scope**：适用于非平凡编码/调试/重构/审查任务；trivial one-liner 用判断、保持低开销。定义执行行为，不定义分支策略或门禁所有权。

# Morning Star Coding Behavior Guidelines

Lightweight, host-agnostic coding-behavior principles that reduce common agent mistakes. Complements other Morning Star skills; does not override stage gates or role routing.

## 1) Think Before Coding

Do not silently choose an interpretation when ambiguity exists. State assumptions explicitly when material; if multiple plausible interpretations exist, present options and ask. Surface tradeoffs affecting scope/risk/maintainability. If critical context is missing, pause and clarify instead of guessing.

**Understand the affected flow.** Read the brief, the code to be changed and its direct contracts before editing. Use supplied evidence and relevant knowledge; follow a changed symbol only far enough to resolve the concrete question. Do not restart repository-wide exploration during development or review. Scope and stopping rules → `mstar-harness-core` § 定向执行与验证边界.

**Read before you write.** Before generating code in an existing project: inspect imports (which libraries the project actually uses — do not introduce a different library for the same purpose); look at nearby tests (they document expected behavior more precisely than comments); follow existing patterns (API routes, file structure, error handling — match it, do not silently introduce a different one). If no precedent exists, say so and ask. If not 100% sure a signature/parameter exists, check source/docs before using it — confidently calling a non-existent API may compile then fail at runtime.

## 2) Simplicity First

**Upstream invariants**: the global engineering rules live in `mstar-harness-core`（核心研发守则）——no backward-compat layers, simplest implementation, layered growth, modularity, dependency discipline, long-term architecture; this section is their implementation-level playbook.

Implement the smallest durable slice that satisfies the request and acceptance criteria.

**The Ladder.** A reflex hierarchy for every decision — stop at the first rung that holds:

1. **Does this need code at all?** Speculative need → skip it (YAGNI).
2. **Already in this codebase?** A helper, util, type, or pattern that already lives here → reuse it. Look before you write.
3. **Stdlib / built-in covers it?** Use it.
4. **Native platform feature covers it?** CSS over JS, DB constraint over app code, OS primitive over a library.
5. **Already-installed dependency solves it?** Use it. Never add a new dependency for what a few lines can do. When a new dependency appears necessary, evaluate: (a) can this be done with what is already in the project? (b) can the standard library do it? (c) is the package maintained (check last commit date and issue tracker) and reasonably sized? If you add it, state why in one sentence — silently adding packages is not acceptable.
6. **Can it be one line?** One line.
7. **Only then:** the minimum durable code that works.

The ladder runs after understanding, not instead of it. Two rungs work → take the higher one.

**Deletion over addition. Boring over clever.** Removing unnecessary code is a feature; cleverness is what someone decodes at 3am — prefer a boring, obvious solution a tired reviewer verifies in seconds. Do not add unrequested features/flags/configurability; avoid new abstractions for single-use logic; prefer straightforward local fixes over framework-level reshaping **only when they fit the target design**; reject speculative error handling for impossible paths unless required by project policy.

**Simplification markers.** When a deliberate shortcut has a known ceiling (global lock, O(n²) scan, naive heuristic), mark it with a `simplify:` comment naming the ceiling and the upgrade path:

```text
// simplify: global lock on cache misses. Replace with per-key lock if throughput matters.
```

This signals intent — the simplicity is deliberate, not an oversight — and gives the next person the upgrade path without research.

- Do not confuse "minimum" with "temporary." A small implementation must still align with the long-term target state, stable interfaces, and known follow-up plan.
- If a workaround is unavoidable, label it `simplify:` / `temporary`, explain why, and record the removal path in the plan/status artifact before claiming the task complete.

> **Engine check (when available):** run `mstar lint <target>` (or `import { findSimplifyMarkers, findTemporaryMarkers } from "@mstar-harness/engine"` in a host hook) to check the marker convention above — every `simplify:` / `temporary` comment is reported, and `temporary` markers without a recorded plan/status removal path are violations. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

**Simplicity anti-patterns — stop and reconsider when you spot these:**

| Anti-pattern | Signal |
|---|---|
| **Premature abstraction** | Writing a class/interface/strategy where a single function suffices. |
| **Speculative error handling** | Wrapping code in try/catch for errors that cannot happen. |
| **Unnecessary configurability** | Making a value configurable (env var, parameter) that will never change. Hardcode it until there is a real reason not to. |
| **Dead flexibility** | An interface with one implementation, or a generic type with one instantiation — cost with zero benefit until a second use exists. |
| **"In case we need to"** | Justification for abstraction includes a guess about future requirements. "In case we need to" is a guess, and guesses about the future are usually wrong. |

**Durability check**: can this slice be extended by the next batch without undoing its core shape? Are deferred items captured in an existing roadmap/task board/residual tracker (not just chat)? Would a reviewer understand whether this is the final approach, a staged slice, or a deliberate simplification?

## 3) Surgical Changes

Every changed line should be traceable to the task. Touch only files/regions needed for the requested outcome; do not opportunistically refactor adjacent code; match existing style unless a change is explicitly requested; remove only artifacts made unused by your own change; report unrelated issues separately instead of piggyback editing.

**Traceability test**: each hunk maps to a user requirement, acceptance criterion, or required fix-up.

**Bug fix = root cause, not symptom.** Inspect the failing path, changed symbol and directly affected callers. Fix at the narrowest responsible point and cover the demonstrated regression. An unresolved dependency outside the assigned scope is a concrete question for PM, not permission to survey every caller or module.

## 4) Debugging

When something does not work, investigate; do not guess.

- **Read the error message entirely**, including the full stack trace — a `TypeError` can mean a hundred things; the message and trace tell you which one.
- **Reproduce before fixing.** If you cannot reproduce, you cannot verify. "I think this should fix it" is gambling.
- **Change one thing at a time.** Changing three things and seeing the bug disappear tells you nothing about which change fixed it — or what new bugs the other two introduced.
- **Fix the root cause, not the symptom.** If a value is unexpectedly null, do not just add a null check — figure out why it is null (see Surgical Changes · bug=root-cause).
- **For executable bugs, write the minimal reproduction unit test before fixing.** Observe the relevant failure, apply the fix, then observe that case pass. For document/policy fixes, use the scoped evidence route below.
- **Run only affected unit tests.** Name the relevant file/case or selector; distinguish pre-existing failures from regressions. Reuse unaffected evidence and do not rerun a suite because HEAD changed. If an entry cannot select the required scope, report the gap instead of broadening it.
- **If stuck, say so.** "I tried X and Y; neither worked. I'm seeing Z. I think it might be W but am not sure" is infinitely more useful than silently trying random things for 20 iterations.

## 5) Goal-Driven Execution

Convert vague requests into verifiable outcomes and iterate until verified. Define concrete success criteria before major edits; use brief `Step -> verify` checkpoints for multi-step tasks; for split delivery, maintain a durable roadmap (current slice, later slices, dependencies, owner/trigger, completion condition); prefer evidence-backed completion (tests, command output, reproducible checks). If verification fails, loop on diagnosis and fix before declaring completion. Do not finish with "next plan / later / follow-up" only in prose — remaining work must be written to the plan/status artifact or the task reports `Partial` / `Blocked`.

**Minimal check for non-trivial logic.** Any non-trivial change (a branch, a loop, a parser, a data transformation, a money or security path) must leave behind ONE runnable check — the smallest thing that fails if the logic breaks. An inline self-check, a quick `assert`-based demo, or one minimal test. No frameworks, no fixtures, no per-function suites unless asked. Trivial one-liners need none — YAGNI applies to tests too.

Micro template:

```text
1. [Step]
   Verify: [specific check]
2. [Step]
   Verify: [specific check]
```

**Verification discipline**: test behavior, not implementation (a test checking whether a constructor sets properties is worthless; one checking whether validation rejects bad input is valuable — focus on interesting cases). If you cannot write a test, say why ("I cannot easily test this because the database calls are tightly coupled to the business logic" may signal a need for restructuring — do not skip testing without an explanation).

## 6) Review Feedback Handling

Review feedback is technical input, not an order to perform unverified edits. When receiving code review, QA, CI, or human feedback: read all feedback before editing; clarify ambiguous items before partial implementation; verify each suggestion against codebase reality; apply technically correct feedback one item at a time; test each fix individually where practical; push back with evidence when feedback is incorrect, obsolete, risky, out of scope, or violates YAGNI.

Feedback priority:

| Feedback type | Handling |
|---|---|
| Security, correctness, data loss, build/test failure | Fix or escalate before proceeding. |
| Scope mismatch, reviewer misunderstanding, obsolete assumption | Verify and push back with evidence. |
| Style-only suggestion | Apply only if it matches project conventions or is requested by the user/PM. |
| New feature disguised as review | Route through PM/plan unless explicitly in scope. |

Do not perform agreement. State the technical action, the verification result, or the technical reason for disagreement.

## Integration Notes

- **SDD implementer reports**: executable changes retain the affected test file(s), command and actual output in `task-N-report.md`. Non-executable docs and prompt/skill policy changes use `Verification mode: scoped-check` with real changed files, reason, check command and result; complete format and applicability → `mstar-sdd/references/file-handoffs.md` § Verification evidence. Never use this mode to skip tests for executable logic. Fix reports update only the affected evidence.

> **Engine check (when available):** run `mstar lint <task-N-report.md>` (or `import { assertSddTddTriple } from "@mstar-harness/engine"` in a host hook) to validate the selected report evidence: executable test triple or explicit `scoped-check` fields. This is structural validation; PM/QC still verify applicability against the actual diff and evidence. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- This skill must not be used to bypass branch constraints, QC/QA gate definitions, assignment authority, or `Done` ownership rules.

## Anti-Bloat Rule for Prompt Maintenance

- Keep these principles centralized here.
- Role prompts should reference this skill instead of duplicating long prose.
- Only role-specific triggers, boundaries, and artifacts belong in role prompt files.

## Workflow

Apply the six sections in reading order: **1) Think Before Coding**（读懂再改）→ **2) Simplicity First**（最小耐久切片）→ **3) Surgical Changes**（可追溯改动 / 根因修复）→ **4) Debugging**（先复现、一步一测）→ **5) Goal-Driven Execution**（Step → verify）→ **6) Review Feedback Handling**（先核实再改、证据反驳）。

## Evidence

正确结果 = 相关检查及真实输出：可执行逻辑留下一个**最小可失败检查**（§5），bug 单测红转绿（§4）；文档/策略改动用 `scoped-check` 的定向静态或 before/after 可观察证据（Integration Notes）。不因模板制造测试，也不把静态校验声称为模型服从度或运行时实测。

## References

- 角色正文与加载矩阵 → **`mstar-roles`**
- 阶段门禁 / 意图门禁 / 可验证编辑 → **`mstar-phase-gates`**
