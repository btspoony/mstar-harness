---
category: Harness
packages: dsh
---

- **dsh plugin**: role-based subagent configuration via the optional `dsh-llm-fallbacks` plugin — two-command install contract (`dsh plugin --profile web add @mstar-harness/dsh` + `add dsh-llm-fallbacks`; fold-into-patch explicitly rejected — duplicate loader entry id boot failure / dual plugin instance). A role-matched `subagent/start` registers the configured `rolePersonas[executeAs]` persona as the child's agent-scoped `mstar:role-persona` system-prompt section; fallbacks unmounted degrades to the same Config-sourced injection with one debug log; `roleMap` is documented as a taxonomy bridge (logging + future rule-driven interop only). `subagent_fork` joins the default gated dispatch tools (`['subagent', 'subagent_fork']`) with settle pairing. `dsh-llm-fallbacks@^0.1.0-alpha.4` is a registry dependency with type-only imports — `dist/` carries zero runtime references (`--external` stays the guard). Role→model override deferred to upstream `fallbacks-explicit-role-tool` / N-B1.

<!-- CN -->
- **dsh 插件**：经可选 `dsh-llm-fallbacks` 插件实现基于角色的 subagent 配置——双命令安装契约（`dsh plugin --profile web add @mstar-harness/dsh` + `add dsh-llm-fallbacks`；明确否决折叠进补丁——duplicate loader entry id 启动失败 / 双插件实例）。角色匹配的 `subagent/start` 会把配置的 `rolePersonas[executeAs]` persona 注册为子会话的 agent 作用域 `mstar:role-persona` system-prompt 段；fallbacks 未挂载时降级为同一 Config 源注入 + 一条 debug 日志；`roleMap` 记录为分类桥（仅日志与未来规则驱动互操作）。`subagent_fork` 加入默认门禁工具集（`['subagent', 'subagent_fork']`）并获 settle 配对。`dsh-llm-fallbacks@^0.1.0-alpha.4` 为 registry 依赖且仅类型导入——`dist/` 零运行时引用（`--external` 仍为护栏）。角色→模型覆盖延后至上游 `fallbacks-explicit-role-tool` / N-B1。
