---
category: dsh
packages: dsh
---

- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.3-alpha.1` (badge `0.1.3-alpha.1`). First 0.1.3 line; SessionHandle lifecycle / async `agentLoop.create()` and Session format v2 are upstream themes — scan if touching session persistence. No `dsh-session-persistence-sqlite` / `dsh-client-runtime` pin is added (neither is published at `0.1.3-alpha.1`). Lock refresh blocked until the line is visible on the registry; peers/manifest/badge updated ahead of publish.
- Fallbacks-only peer-resident packages remain declared as `@mstar-harness/dsh` peers at `^0.1.3-alpha.1` (no root package.json overrides; no host-version prose bumps).

<!-- CN -->
- 将 `@deepseek-ai/dsh-*` host peer 升到 `^0.1.3-alpha.1`（badge 更新为 `0.1.3-alpha.1`）。首个 0.1.3 线标签；上游破坏性主题含 SessionHandle 生命周期 / 异步 `agentLoop.create()` 与 Session format v2——若触及会话持久化需扫描。不新增 `dsh-session-persistence-sqlite` / `dsh-client-runtime` 钉定（两者均未发布 `0.1.3-alpha.1`）。在 registry 可见该版本前 lock 刷新受阻；peers/manifest/badge 已先行更新。
- fallbacks-only peer 常驻包仍作为 `@mstar-harness/dsh` peers 声明为 `^0.1.3-alpha.1`（无 root package.json overrides；未改动散文/注释中的 host 版本号）。
