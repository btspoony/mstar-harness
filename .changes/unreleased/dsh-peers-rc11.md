---
category: Harness
packages: root, dsh
---
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.1-rc.1` line (`^0.1.1-rc.1`; `@deepseek-ai/cordis` stays `^4.0.1`). Verified against the `0.1.0-rc.8 → 0.1.1-rc.1` diff (deepseek-harness @ `528c682e06`): every consumed server-side package changed docs/package.json only, client-side consumed surface changed additively, and the `__ModuleLoader__` handoff survives — zero adapter-code changes. No checklist seam (credentials records, pi-ai auth, index-inject, session-projection) is consumed. Lock re-resolved to a single `0.1.1-rc.1` hoist (`dsh-client-web-react` holds at `0.1.0-rc.7` — max published, pulled only by `dsh-llm-fallbacks@0.2.2` peers). No previously blocked mstar-dsh goals were unblocked by this line.

<!-- CN -->
- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.1-rc.1` 线（`^0.1.1-rc.1`；`@deepseek-ai/cordis` 保持 `^4.0.1`）。对照 deepseek-harness @ `528c682e06` 的 `0.1.0-rc.8 → 0.1.1-rc.1` diff 验证：所有已消费的服务端包仅变更文档/`package.json`，客户端已消费面为纯增量，`__ModuleLoader__` 握手原样存活——零适配层改动。未消费任何 checklist seam（credentials records、pi-ai auth、index-inject、session-projection）。lock 全新解析为单份 `0.1.1-rc.1` hoist（`dsh-client-web-react` 保持 `0.1.0-rc.7`——npm 最新发布版，仅由 `dsh-llm-fallbacks@0.2.2` peers 拉取）。此线未解锁任何此前被阻塞的 mstar-dsh 目标。
