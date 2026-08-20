---
category: Harness
packages: root, dsh
---
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.8` line (`^0.1.0-rc.8`; `@deepseek-ai/cordis` stays `^4.0.1`). Local rc.7→rc.8 source review of consumed seams found no adapter-code break: the only consumed-surface change is `dsh-commands` `CommandRuntime.execute` gaining a required `images` argument (plugin registrations unaffected; test call sites updated) and an additive `CommandInvocation.attachments` field. Lock freshly resolved to a single rc.8 hoist (`dsh-client-web-react` stays at rc.7 — the latest published); `dsh-llm-fallbacks` moved 0.2.0 → 0.2.2 with the 9-key service-surface drift STOP gate updated in kind.

<!-- CN -->
- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.0-rc.8` 线（`^0.1.0-rc.8`；`@deepseek-ai/cordis` 保持 `^4.0.1`）。对照本地 rc.7→rc.8 源码，已消费 seam 无需改适配层：唯一涉及的消费面变化是 `dsh-commands` 的 `CommandRuntime.execute` 新增必填 `images` 参数（插件注册不受影响，仅测试调用点更新）以及 `CommandInvocation` 新增 `attachments` 字段（纯增量）。lock 全新解析为单份 rc.8 hoist（`dsh-client-web-react` 保持 rc.7——npm 最新发布版）；`dsh-llm-fallbacks` 由 0.2.0 移至 0.2.2，9 键服务面 drift STOP gate 同步更新。
