---
category: Harness
packages: root, cli, commands, engine
---

- Added the public `mstar plan release` operation for an acquired holder's own execution claim, with explicit same-holder bind reacquisition.
- Allowed sparse active workflow mutations and workflow close to derive current tokens and generate one operation id when omitted; explicit session references and tokens remain constraints.
- Engine execution authority: a held claim is released only by its own holder and keeps released provenance for same-holder reacquisition; ACTIVE cleanup answers from the authoritative store; a launched minted identity takes precedence over the ambient session and never authorizes a scope it does not declare.
- Updated CLI and artifact guidance for release and sparse own-binding operations.

<!-- CN -->
- 新增公开命令 `mstar plan release`，供已获取身份的持有者释放自己的执行声明，并通过普通显式 bind 由同一持有者重新获取。
- 活跃 workflow 修改与关闭允许稀疏调用：省略时从当前作用域派生令牌并生成一次操作 ID；显式会话引用和令牌仍作为约束校验。
- 引擎执行权威：持有的声明仅由其自身持有者释放，并保留 released 溯源供同一持有者重新获取；ACTIVE 清理从权威存储读取；启动时铸就的身份优先于环境会话，且绝不授权其未声明的作用域。
- 更新 CLI 与产物文档中的释放及稀疏 own-binding 操作说明。
