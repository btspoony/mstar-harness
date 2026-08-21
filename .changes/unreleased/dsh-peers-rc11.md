---
category: Harness
packages: root, dsh
---
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.1-rc.1` line (`^0.1.1-rc.1`; `@deepseek-ai/cordis` stays `^4.0.1`; `dsh-llm-fallbacks` re-aligned `^0.2.0` → `^0.3.0` so its peers land on `^0.1.1-rc.1`). Verified against the `0.1.0-rc.8 → 0.1.1-rc.1` diff (deepseek-harness @ `528c682e06`): every consumed server-side package changed docs/package.json only, client-side consumed surface changed additively, and the `__ModuleLoader__` handoff survives — zero adapter-code changes. No checklist seam (credentials records, pi-ai auth, index-inject, session-projection) is consumed. Lock re-resolved to a single `0.1.1-rc.1` line — zero `0.1.0-rc.8` copies anywhere, and the `dsh-client-web-react` rc.7 holdover is eliminated (fallbacks 0.3.3 dropped that peer); `@oh-my-pi/*` / `@bufbuild/protobuf` resolutions are unchanged from the previous lock. No previously blocked mstar-dsh goals were unblocked by this line.

<!-- CN -->
- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.1-rc.1` 线（`^0.1.1-rc.1`；`@deepseek-ai/cordis` 保持 `^4.0.1`；`dsh-llm-fallbacks` 重新对齐 `^0.2.0` → `^0.3.0`，使其 peers 落在 `^0.1.1-rc.1`）。对照 deepseek-harness @ `528c682e06` 的 `0.1.0-rc.8 → 0.1.1-rc.1` diff 验证：所有已消费的服务端包仅变更文档/`package.json`，客户端已消费面为纯增量，`__ModuleLoader__` 握手原样存活——零适配层改动。未消费任何 checklist seam（credentials records、pi-ai auth、index-inject、session-projection）。lock 全新解析为单份 `0.1.1-rc.1` 线——任意位置零 `0.1.0-rc.8` 副本，`dsh-client-web-react` rc.7 holdover 已消除（fallbacks 0.3.3 移除了该 peer）；`@oh-my-pi/*` / `@bufbuild/protobuf` 解析与此前 lock 一致。此线未解锁任何此前被阻塞的 mstar-dsh 目标。
