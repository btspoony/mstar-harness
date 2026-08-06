---
packages: root, opencode
---

- **`mstar-skill-authoring`**: fold the skill-writer 6 principles into the runtime authoring skill — expert process first, compact 5-question body, 1–3 skill routing, per model+harness validation, encode only model gaps, every edit as paired experiment. Body stays the executable gate; full writer loop / output template / anti-patterns → `references/skillsbench-authoring.md` (progressive disclosure).
- Tightened `description` trigger contract (ZH) with exclusions; kept Morning Star layout (purpose test, frontmatter contract, skill-relative paths, review template) as SSOT rather than a parallel handbook.
- Restored `## Skill-relative script and asset paths` heading so `mstar-host` § cross-reference stays valid (Post-Skill-Change stale-ref checklist).
- Clarified release docs: during development write `.changes/unreleased/<slug>.md` only — do **not** hand-edit `CHANGELOG*.md` / `packages/*/CHANGELOG.md` (assembled by `release:prepare`).

<!-- CN -->
- **`mstar-skill-authoring`**：将 skill-writer 六原则并入运行时撰写技能——专家流程优先、紧凑 5 问 body、1–3 skill 路由、按 model+harness 实测、只补模型缺口、每次改动做 paired 实验。Body 保留可执行门控；完整 writer 流程 / 输出模板 / 反模式 → `references/skillsbench-authoring.md`（渐进披露）。
- 收紧 `description` 触发契约（中文，含排除条件）；保留 Morning Star 既有结构（purpose test、frontmatter 契约、技能相对路径、review 模板）作为 SSOT，不另起平行手册。
- 恢复 `## Skill-relative script and asset paths` 小节标题，使 `mstar-host` 的 § 交叉引用继续有效（Post-Skill-Change stale-ref 清单）。
- 澄清发布文档：开发期只写 `.changes/unreleased/<slug>.md` —— **禁止**手改 `CHANGELOG*.md` / `packages/*/CHANGELOG.md`（由 `release:prepare` 组装）。
