---
category: Harness
packages: root, dsh
---
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.7` line (`^0.1.0-rc.7`; `@deepseek-ai/cordis` stays `^4.0.1`). Local rc.6→rc.7 source review of consumed seams found no adapter-code break (`createUserMessage` / `ToolExecution` / `PreToolDecision` / `PreStepDecision` / `FsWriteIntent` / dump-config `disabled: true` unchanged; `apps/cli/src` version-only). Lock purged every entry below `0.1.0-rc.7` — 62 unique `@deepseek-ai/dsh-*` packages, single hoisted copy each, 0 nested copies. Root `dependencies` stays engine-only.

<!-- CN -->
- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.0-rc.7` 线（`^0.1.0-rc.7`；`@deepseek-ai/cordis` 保持 `^4.0.1`）。对照本地 rc.6→rc.7 源码，已消费 seam 无需改适配层（`createUserMessage` / `ToolExecution` / `PreToolDecision` / `PreStepDecision` / `FsWriteIntent` / dump-config `disabled: true` 未变；`apps/cli/src` 仅为版本号）。lock 清除所有低于 `0.1.0-rc.7` 的条目——62 个唯一 `@deepseek-ai/dsh-*` 包、每包单份 hoisted、0 个嵌套副本。根 `dependencies` 保持仅 engine。
