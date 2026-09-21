---
category: Changed
packages: cli
---

- Raised the timeout for the `CLI init --target dsh` adapter cases: each spawns `bun run src/index.ts` (a cold TypeScript start plus the adapter's own subprocess work), and the default 5s budget sat close enough to the CI runner's cost that a single slow start failed the suite.

<!-- CN -->
- 提高 `CLI init --target dsh` 适配器用例的超时：每个用例都会 spawn `bun run src/index.ts`（冷启动 TypeScript + 适配器自身的子进程工作），默认 5s 预算与 CI runner 的实际开销过于接近，单次启动偏慢即导致套件失败。
