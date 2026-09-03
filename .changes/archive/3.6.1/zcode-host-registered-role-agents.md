---
packages: root, opencode
---
- Corrected the ZCode host contract (`mstar-host`): current ZCode **does** register Morning Star role agents (`agents/*.md`) as callable `subagent_type` values — dispatch now prefers the **bare role id** (e.g. `fullstack-dev`), keeps `general-purpose` as the universal fallback, keeps C5b prompt + skill-load binding required because the role shells are thin, and carries its own C5/C5b SSOT (the shared role-binding doc is re-scoped to Kimi-only; `zcode.md` no longer loads it). Documents the ZCode frontmatter constraint (single-line quoted English `description`; `|-` blocks and nested `tools`/`permission` are silently mangled/dropped) and that direct marketplace add works now that the repo ships `.claude-plugin/marketplace.json`.

<!-- CN -->
- 修正 `mstar-host` 的 ZCode 宿主契约:当前 ZCode **会**把 Morning Star 角色 agents(`agents/*.md`)注册为可调用的 `subagent_type`——派发改为优先**裸角色 id**(如 `fullstack-dev`),保留 `general-purpose` 作为通用回退,且因角色壳很薄仍强制 C5b prompt + skill-load 绑定;`zcode.md` 自带 C5/C5b SSOT(共享角色绑定文档收归 Kimi 专用,ZCode 不再加载)。同时记录 ZCode frontmatter 约束(单行带引号英文 `description`;`|-` 块与嵌套 `tools`/`permission` 会被静默破坏/丢弃),以及仓库内置 `.claude-plugin/marketplace.json` 后 marketplace 可直接添加。
