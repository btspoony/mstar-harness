---
category: Harness
packages: cli
---

- **The reopen CLI case declares its own 30s budget.** `mstar issue CLI bundle > reopen is terminal-only, CAS guarded, and preserves the prior closure note` spawns the built bundle about ten times, so the default 5s bound sat under its real cost on a loaded CI shard (`test-cli-ops-a` failed at 5010ms on main). The case now declares `{ timeout: 30_000 }`; no assertion changed.

<!-- CN -->
- **reopen 的 CLI 用例自带 30s 预算。** `mstar issue CLI bundle > reopen is terminal-only, CAS guarded, and preserves the prior closure note` 约十次拉起构建产物，默认 5s 上限低于它在负载 CI 分片上的真实耗时（main 的 `test-cli-ops-a` 在 5010ms 超时失败）。该用例现在声明 `{ timeout: 30_000 }`；断言未改。
