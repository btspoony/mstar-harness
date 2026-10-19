---
category: Changed
packages: dsh
---

- The bundled mstar slash-command registration fails loud when the packaged `harness-commands/` mirror is missing: the plugin boot now logs an ERROR naming the expected mirror path and the recovery (`bun run dsh:bundle-assets`) instead of silently registering nothing.

<!-- CN -->
- 打包 `harness-commands/` 镜像缺失时，mstar 内置斜杠命令注册改为响亮失败：插件启动现在以 ERROR 级日志给出期望的镜像路径与恢复方式（`bun run dsh:bundle-assets`），不再静默跳过注册。
