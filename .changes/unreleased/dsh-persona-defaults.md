---
category: Harness
packages: dsh
---

- **dsh plugin**: zero-config role personas — `subagent/start` decoration now falls back to the bundled `harness-agents/` mirror for role shells without a configured `rolePersonas` entry (shell file stem = role id; frontmatter `description` block scalar; `mode: primary` shells like project-manager excluded; interpolation-hazard defaults warned + skipped). Mirror shipped in the published tarball (`files` += `harness-agents`), cached per (path, mtime) with decision-point reads. Interop-log version assertion re-anchored version-agnostic (was hardcoded `0.1.0-alpha.4`).
- **dsh plugin**: warn-only fallbacks adoption advisory — when the optional `dsh-llm-fallbacks` capability is mounted, ONE bounded pass per apply reads the deployment's fallbacks row config (loader entry `options.config`, never the fallbacks plugin's module internals) and warns on taxonomy gaps: mstar roles missing from `roles.list` (id set mirror-derived, not hardcoded), declared roles with an empty persona, and legacy keys (`detectLegacyKeys` semantics via the applied service; skipped on the loader-fallback path). Unreadable row config → skip + one debug; never writes the fallbacks config; unmounted → not invoked. Logger `mstar/fallbacks-advisory`.

<!-- CN -->
- **dsh 插件**：零配置角色 persona —— `subagent/start` 装饰在无 `rolePersonas` 配置时回退到打包的 `harness-agents/` 镜像（文件名主干 = role id；frontmatter `description` 块标量；`mode: primary`（如 project-manager）排除；含插值风险的默认值告警并跳过）。镜像随发布 tarball 携带（`files` 增加 `harness-agents`），按 (path, mtime) 缓存、决策点读取。互操作日志版本断言改为版本无关（原硬编码 `0.1.0-alpha.4`）。
- **dsh 插件**：只告警的 fallbacks 采纳建议 —— 当可选的 `dsh-llm-fallbacks` 能力已挂载时，每次 apply 只执行一遍有界检查：结构化读取部署的 fallbacks 行配置（loader 条目 `options.config`，绝不读 fallbacks 插件模块内部），并对分类缺口告警：`roles.list` 缺少 mstar 角色（角色 id 集合派生自镜像、非硬编码）、已声明角色 persona 为空、以及遗留键（经已应用服务的 `detectLegacyKeys` 语义；loader 回退路径跳过）。行配置不可读 → 跳过 + 一条 debug；绝不写入 fallbacks 配置；未挂载 → 不调用。日志器 `mstar/fallbacks-advisory`。
