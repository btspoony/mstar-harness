---
name: mstar-strategy
description: Morning Star 全局战略方向 —— 创建并维护 `STRATEGY.md`（项目级战略文档），作为 brainstorm/plan 的上游锚点。定义产品愿景、技术方向、不做事项、决策原则。触发：项目初始化、方向性决策变更、或 PM 要求战略对齐时。
---

# mstar-strategy（全局战略方向）

## Load order

**Read `mstar-harness-core` first.** Path symbols → **`mstar-plan-conventions`**. On conflict, **`mstar-harness-core` wins**.

## Purpose

`STRATEGY.md` is the project's **upstream anchor** — a concise declaration of what the project is, where it's going, and what principles guide decisions. It is read as grounding by brainstorm, plan, and ideation phases so strategic choices flow into every feature.

Without a strategy document, decisions are made in isolation — each plan misses the larger context.

## 产物存储位置

**SSOT**: `mstar-plan-conventions/references/artifact-storage-paths.md`。STRATEGY.md → `<repo-root>/STRATEGY.md`（与 `.git/`、`AGENTS.md` 同级）。**禁止**放入 `{HARNESS_DIR}`、`docs/` 或任何子目录。

## When to use

| Trigger | Example |
|---------|---------|
| Project initialization | "Create STRATEGY.md for this new project" |
| Directional change | "We're pivoting from monolith to microservices" |
| PM requests alignment | "Check if this plan aligns with our strategy" |
| Periodic review | "Review and update STRATEGY.md" |

## STRATEGY.md structure

A good strategy document is opinionated and concise. It should fit in one screen of reading.

### Required sections

```markdown
# Strategy

## Vision
<1-2 sentences: what the project aims to become>

## What we build
<Core product/users/use cases>

## What we don't build
<Explicit non-goals — as important as goals>

## Guiding Principles
- <Principle 1>
- <Principle 2>
- <Principle 3>

## Technology Direction
<Key tech choices and rationale>

## Decision Log
<Major past decisions with context — why, not just what>
```

> **Engine check (when available):** run `mstar lint <STRATEGY.md>` (or `import { lintStrategySections } from "@mstar-harness/engine"` in a host hook) to check the six required sections above (Vision, What we build, What we don't build, Guiding Principles, Technology Direction, Decision Log). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

### Optional sections

- **Current Focus** — what the team is working on now
- **Risks & Mitigations** — known strategic risks
- **Competitive Context** — what alternatives exist and how we differ

## Creating STRATEGY.md

### Phase 1: Gather context

1. Read existing project documentation (README, AGENTS.md, existing specs).
2. If `{KNOWLEDGE_DIR}` or `{ITERATION_DIR}` exist, scan for architectural decisions and patterns.
3. If `CONCEPTS.md` exists, use it to understand domain vocabulary.

### Phase 2: Interview

Ask PM these questions (one at a time):

1. "What is the one-sentence vision for this project?"
2. "Who are the primary users and what do they need most?"
3. "What are you explicitly NOT building? What's out of scope permanently?"
4. "What 2-3 principles should guide every technical decision?"
5. "What technology bets have you made, and why?"

### Phase 3: Draft

Write STRATEGY.md at the repo root. Keep it concise — each section should be 1-3 sentences or a short bullet list.

### Phase 4: Discoverability

Check if AGENTS.md references STRATEGY.md. If not, propose adding:

```markdown
- `STRATEGY.md` — project vision and guiding principles
```

Ask for consent before applying.

## Maintaining STRATEGY.md

### Review triggers

- After a major architectural decision
- When a plan introduces a new technology stack
- Quarterly review (scheduled by PM)

### Update rules

1. **Be decisive about direction changes.** Don't keep old strategy alongside new — replace it.
2. **Log decisions with context.** The Decision Log captures *why* a choice was made, not just what.
3. **Keep it current.** Stale strategy is worse than no strategy — it misdirects plans.

## STRATEGY.md vs other docs

| Document | Purpose | Audience |
|----------|---------|----------|
| `STRATEGY.md` | Product/technical direction, principles, decisions | PM, architect, all implementers |
| `AGENTS.md` | Repo maintenance policy, conventions | Contributors and agents |
| `CONCEPTS.md` | Domain vocabulary | Anyone reading/writing project docs |
| Plans in `{PLAN_DIR}/` | Feature-level implementation plan | Implementers, reviewers |

## NOT to do

- Do not write STRATEGY.md as a novel — it should be scannable
- Do not include implementation details or file paths
- Do not create without PM/architect input (ask the questions)
- Do not keep outdated strategy as "historical reference" — git preserves it
- Do not conflate strategy (direction) with conventions (how-to)

## Workflow

主链：**创建**（Phase 1 收集上下文 → Phase 2 访谈 PM → Phase 3 落盘 `<repo-root>/STRATEGY.md` → Phase 4 可发现性检查）→ **维护**（方向变更时果断替换旧策略、Decision Log 记决策理由、保持最新）→ **定期评审**（重大架构决策后 / 新技术栈引入时 / 季度评审）。作为 brainstorm / plan 的上游锚点被引用。

## Evidence

正确结果 = `<repo-root>/STRATEGY.md` 通过 `lintStrategySections` 六节检查（Vision / What we build / What we don't build / Guiding Principles / Technology Direction / Decision Log，`mstar lint <STRATEGY.md>`），一屏可读完，且 Decision Log 记录的是**理由**而非仅结论。

## References

- 迭代级战略对齐（iteration-start §1.1 读 STRATEGY.md）→ **`mstar-iteration`**
- 知识维护 / bootstrap（战略变更后的知识对账）→ **`mstar-compound-refresh`**
- 路径符号与产物存储 SSOT → **`mstar-plan-conventions`**
