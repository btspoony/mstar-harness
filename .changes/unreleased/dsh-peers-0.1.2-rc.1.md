---
category: dsh
packages: dsh
---

- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.2-rc.1` and refresh the lock against the `0.1.2-rc.1` line (badge `0.1.2-rc.1`). Alpha.3 already removed the optional SQLite session persistence upstream — nothing to migrate, and no `dsh-session-persistence-sqlite` / `dsh-client-runtime` pin is added (neither is published at `0.1.2-rc.1`). Remote / `dsh-api-remotes` stays; `host-apiproxy` stays out of the client-bundle INLINE_SAFE allowlist; `SessionEvent.ignorable` usage is kept.
- Lock converges to a single `0.1.2-rc.1` dsh line. `dsh-llm-fallbacks@0.4.0-alpha.1` (dev-time-only) still peers `^0.1.2-alpha.3`, and bun pins a prerelease range to the exact published version, so the three fallbacks-only peer-resident packages (`@deepseek-ai/dsh-api-session-controller`, `dsh-util-time`, `dsh-util-workspace-path`) are declared as `@mstar-harness/dsh` peers at `^0.1.2-rc.1` — all three are published at that tag and carry zero mstar imports, keeping the resolved graph on one line (the `peer-deps.spec.ts` single-line guard).

<!-- CN -->
- 将 `@deepseek-ai/dsh-*` host peer 升到 `^0.1.2-rc.1`，lock 刷新到 `0.1.2-rc.1` 线（badge 更新为 `0.1.2-rc.1`）。alpha.3 已在上游移除可选的 SQLite 会话持久化——无需迁移，也不新增 `dsh-session-persistence-sqlite` / `dsh-client-runtime` 钉定（两者均未发布 `0.1.2-rc.1`）。Remote / `dsh-api-remotes` 保持不变；`host-apiproxy` 仍不在客户端 bundle INLINE_SAFE 白名单中；`SessionEvent.ignorable` 用法保留。
- lock 收敛为单一 `0.1.2-rc.1` dsh 线。`dsh-llm-fallbacks@0.4.0-alpha.1`（仅开发期）仍以 `^0.1.2-alpha.3` 声明 peer，而 bun 会把预发布 range 钉到精确发布的版本，因此三个仅由 fallbacks 拉入的 peer 常驻包（`@deepseek-ai/dsh-api-session-controller`、`dsh-util-time`、`dsh-util-workspace-path`）作为 `@mstar-harness/dsh` 的 peer 声明为 `^0.1.2-rc.1`——三者均已发布该 tag 且 mstar 对其零导入，解析图保持单行（`peer-deps.spec.ts` 单行守卫）。
