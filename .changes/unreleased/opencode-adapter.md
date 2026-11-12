---
category: Fixed
packages: cli
---

- **`mstar init --target opencode` verifies the generation it actually wrote.** A dual-key config (both `plugin` and `plugins` present) made the post-write check re-derive the generation from config markers, get `null`, and silently validate nothing. The adapter now records the generation it resolved on the same options object the caller validates with, so a dual-key write is checked against the surface it selected.
- **The seeded `mcp.servers["morning-star"]` command is a copy, not an alias.** The V2 MCP seed spread the module-level server entry, which copied the object but shared its `command` array; a consumer mutating one written entry mutated the constant every later write reads from.

<!-- CN -->
- **`mstar init --target opencode` 现在校验它真正写入的那个 generation。** 双键配置（`plugin` 与 `plugins` 同时存在）会让写入后校验从配置标记重新推导 generation，得到 `null` 并静默跳过校验。适配器现在把已解析的 generation 记录到调用方用于校验的同一个 options 对象上，双键写入因此按它选定的层面接受检查。
- **种入的 `mcp.servers["morning-star"]` command 是副本，不再是别名。** V2 MCP 种子原本展开模块级 server 条目，复制了对象却共享其 `command` 数组；消费者改动某次写入的条目即会改动后续每次写入所读的常量。
