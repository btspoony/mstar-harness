---
category: Harness
packages: dsh
---

- **dsh plugin**: `/codebase-audit` now advertises the `simplify` input hint — the command frontmatter `input:` is `[simplify]` (was `[no args]`), so the dsh web client's claim UX invites the follow-up arg as ghost text instead of executing bare; docs/cli.md documents the variant (usage line + keyword table + examples).
- **dsh plugin**: the skill-lint gate now flags ephemeral citations — `lintSkillDoc` runs the engine `findEphemeralCitations` and reports each hit as a `skill.ephemeral.task-artifact` / `skill.ephemeral.sdd-deeplink` violation (severity `medium`) with the existing warn/hard gate semantics (advisory under warn, veto under hard); placeholder forms pass and the current `skills/` corpus stays zero-hit.

<!-- CN -->
- **dsh 插件**：`/codebase-audit` 现公布 `simplify` input hint——命令 frontmatter `input:` 为 `[simplify]`（原为 `[no args]`），dsh web 客户端 claim UX 以 ghost text 邀请后续参数而非裸执行；`simplify` 变体已在 docs/cli.md 完整记录（用法行 + 关键词表 + 示例）。
- **dsh 插件**：skill-lint 门禁现可标记短命引用——`lintSkillDoc` 运行 engine `findEphemeralCitations`，每条命中报为 `skill.ephemeral.task-artifact` / `skill.ephemeral.sdd-deeplink` 违规（severity `medium`），沿用既有 warn/hard 门禁语义（warn 模式 advisory、hard 模式 veto）；占位符形式通过，当前 `skills/` corpus 保持零命中。
