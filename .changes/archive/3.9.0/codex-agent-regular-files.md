---
packages: root, cli
---

- Install Codex custom agent TOMLs as regular files so discovered roles can load. Re-running init replaces expected legacy links and backs up differing regular files before refresh; doctor detects links and source drift. Update installation and dispatch guidance to require successful named-role invocation.

<!-- CN -->
- 将 Codex 自定义角色 TOML 安装为普通文件，使已发现的角色能够加载。再次运行 init 会替换指向预期来源的旧链接，并在刷新不同内容的普通文件前备份；doctor 检测链接与来源内容漂移。同步安装及派发指导，以具名角色实际启动成功作为验证依据。
