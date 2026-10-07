---
category: Harness
packages: root, cli, commands, engine
---

- Allowed sparse active workflow mutations and workflow close to derive current tokens and generate one operation id when omitted; explicit session references and tokens remain constraints.
- ACTIVE cleanup reads the authoritative store; a launched minted coordinator identity takes precedence over ambient identity without granting unrelated workflow authority.

<!-- CN -->
- 活跃 workflow 修改与关闭允许稀疏调用：省略时从当前作用域派生令牌并生成一次操作 ID；显式会话引用和令牌仍作为约束校验。
- ACTIVE 清理读取权威 store；启动时铸造的 coordinator 身份优先于环境身份，不因此授予其他 workflow 权限。
