---
category: Harness
packages: dsh
---

- **dsh plugin**: zero-config role personas — `subagent/start` decoration now falls back to the bundled `harness-agents/` mirror for role shells without a configured `rolePersonas` entry (shell file stem = role id; frontmatter `description` block scalar; `mode: primary` shells like project-manager excluded; interpolation-hazard defaults warned + skipped). Mirror shipped in the published tarball (`files` += `harness-agents`), cached per (path, mtime) with decision-point reads. Interop-log version assertion re-anchored version-agnostic (was hardcoded `0.1.0-alpha.4`).

<!-- CN -->
- **dsh 插件**：零配置角色 persona —— `subagent/start` 装饰在无 `rolePersonas` 配置时回退到打包的 `harness-agents/` 镜像（文件名主干 = role id；frontmatter `description` 块标量；`mode: primary`（如 project-manager）排除；含插值风险的默认值告警并跳过）。镜像随发布 tarball 携带（`files` 增加 `harness-agents`），按 (path, mtime) 缓存、决策点读取。互操作日志版本断言改为版本无关（原硬编码 `0.1.0-alpha.4`）。
