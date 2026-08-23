---
category: Harness
packages: root, cli
---

- **Unified the three CLI `execFileSync` wrappers** into a single `runCliCommand` helper (`packages/cli/src/exec.ts`): `runCommand` (shared-install), `runOmp` (omp), and `runDsh` (dsh) are now thin calls with today's defaults — no public signature or behavior change. Timeout / env / dry-run can no longer drift independently across the wrappers; `runDsh` keeps its `env: process.env` + `timeout` contract (dsh PATH injection in tests).
- **Engine git env-pin regression test (test-only)**: `packages/engine/test/exec-env.test.ts` now detects any git `execFileSync` call whose options carry an empty env (`env: {}` / `env: { PATH: "" }`) across `path.ts` / `sdd.ts` / `worktree.ts` — production env handling is untouched.

<!-- CN -->
- **三个 CLI `execFileSync` 包装统一为一个 `runCliCommand` 助手**（`packages/cli/src/exec.ts`）：`runCommand`（shared-install）、`runOmp`（omp）、`runDsh`（dsh）变为薄包装，公开签名与行为不变；timeout / env / dry-run 不再可能在三个包装间各自漂移，`runDsh` 保留 `env: process.env` + `timeout` 契约（测试中依赖 PATH 注入 fake dsh）。
- **Engine git env 固定回归测试（仅测试）**：`packages/engine/test/exec-env.test.ts` 断言 `path.ts` / `sdd.ts` / `worktree.ts` 中任何 git `execFileSync` 调用的 options 不得携带空 env（`env: {}` / `env: { PATH: "" }`）——不修改任何生产 env 行为。
