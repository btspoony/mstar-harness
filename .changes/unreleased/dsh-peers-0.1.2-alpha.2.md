---
category: dsh
packages: dsh
---

- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.2-alpha.2` and migrate the client half off the removed `dsh-client-runtime` onto `dsh-client-store` / `dsh-client-ui-conversation` / `dsh-client-ui-renderer` / `dsh-client-ui-chat` (alpha.2 Remote/store seams). Drop `host-apiproxy` from the client-bundle INLINE_SAFE allowlist. Badge `0.1.2-alpha.2`.
- Bump `dsh-llm-fallbacks` to `^0.4.0-alpha.1`: its 25 peers re-anchor to `^0.1.2-alpha.2` (and `dsh-client-runtime` is dropped upstream), so the lock collapses to a single `0.1.2-alpha.2` dsh line.

<!-- CN -->
- 将 `@deepseek-ai/dsh-*` host peer 升到 `^0.1.2-alpha.2`，客户端 half 从已移除的 `dsh-client-runtime` 迁到 `dsh-client-store` / `dsh-client-ui-conversation` / `dsh-client-ui-renderer` / `dsh-client-ui-chat`（alpha.2 Remote/store 缝）。客户端 bundle INLINE_SAFE 去掉 `host-apiproxy`。badge 更新为 `0.1.2-alpha.2`。
- 升级 `dsh-llm-fallbacks` 至 `^0.4.0-alpha.1`：其 25 个 peer 重新锚定到 `^0.1.2-alpha.2`（上游同时移除 `dsh-client-runtime`），lock 收敛为单一 `0.1.2-alpha.2` dsh 线。
