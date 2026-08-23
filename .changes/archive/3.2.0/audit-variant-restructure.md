---
category: Harness
packages: root, opencode
---

- Restructured `mstar-audit` into a **variant carrier**: SKILL.md now holds the common core (hard rules, recon, attack-and-vet discipline, variant dispatch table, output-format contract), with full codebase-audit detail moved verbatim to `references/codebase-audit.md` (Phase 2 category fan-out + subagent-prompt requirements, effort table, scope variants, Phase 4 plan writing, audit index / plan-file output templates, `mstar audit scaffold` callout, handoff to execution). `pr-deep-review` no longer loads full-audit-only content; pointer surfaces (`references/pr-review.md`, both commands, `code-reviewer` role, `mstar-harness-core` index) cite the common core + the correct variant reference.

<!-- CN -->
- 将 `mstar-audit` 重构为**变体载体（variant carrier）**：SKILL.md 只保留公共核心（hard rules、recon、attack-and-vet 纪律、变体分发表、output 契约），完整 codebase-audit 细节逐字迁至 `references/codebase-audit.md`（Phase 2 九类别 fan-out 与 subagent prompt 要求、effort 表、scope variants、Phase 4 plan 撰写、audit index / plan 文件输出模板、`mstar audit scaffold` callout、handoff to execution）。`pr-deep-review` 不再加载仅 full-audit 相关的内容；各指针面（`references/pr-review.md`、两个 commands、`code-reviewer` 角色、`mstar-harness-core` 索引）改引公共核心 + 正确变体 reference。
