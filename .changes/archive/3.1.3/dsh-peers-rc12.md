---
category: Harness
packages: root, dsh
---
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.1-rc.2` line (`^0.1.1-rc.2`; `@deepseek-ai/cordis` stays `^4.0.1`; `dsh-llm-fallbacks` stays `^0.3.0` — its 0.3.3 peers are `^0.1.1-rc.1`, satisfied by the rc.2 line). Verified against the `0.1.1-rc.1 → 0.1.1-rc.2` diff (deepseek-harness @ `b150a55`): the change is the unified image/Files request pipeline plus the permission-preset copy-and-default revert — the plugin consumes none of those surfaces (no image region reads, no attachment request payloads, no permission-preset default-copy helpers; the only `preset`/`permission` references are the `dsh-llm-fallbacks` role-seed registry and a dsh-core `/permission` command precedent), so zero adapter-code changes. Lock re-resolved to a single `0.1.1-rc.2` line — zero `0.1.1-rc.1` (and older) copies anywhere, no `dsh-client-web-react` holdover.

<!-- CN -->
- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.1-rc.2` 线（`^0.1.1-rc.2`；`@deepseek-ai/cordis` 保持 `^4.0.1`；`dsh-llm-fallbacks` 保持 `^0.3.0`——其 0.3.3 的 peers 为 `^0.1.1-rc.1`，可由 rc.2 线满足）。对照 deepseek-harness @ `b150a55` 的 `0.1.1-rc.1 → 0.1.1-rc.2` diff 验证：变更内容为统一的 image/Files 请求管线与 permission-preset copy-and-default 回退——插件未消费其中任何面（无 image 区域读取、无 attachment 请求 payload、无 permission-preset default-copy 辅助；仅有的 `preset`/`permission` 引用是 `dsh-llm-fallbacks` 角色 seed 注册表与 dsh-core `/permission` 命令先例），零适配层改动。lock 全新解析为单份 `0.1.1-rc.2` 线——任意位置零 `0.1.1-rc.1`（及更旧）副本，无 `dsh-client-web-react` holdover。
