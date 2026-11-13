---
category: Fixed
packages: root
---

- **The engine consumer stops pinning its build output, so `pack-consumers` can verify a fresh checkout.** `packages/engine/dist` bytes depend on the build environment, so a manifest written on one machine reported `consumer.digest-mismatch` for `packages/engine/dist/engine.js` on the next. The engine keeps its source closure (engine `src`, engine build scripts, `package.json`, `tsconfig.json`), its runtime floor and its capability; its generated closure is empty and the entrypoint is proved by existence and non-emptiness, exactly as the `cli` and `dsh` consumers already do. No other consumer changed.

<!-- CN -->
- **engine consumer 不再钉死构建产出，`pack-consumers` 因此能在全新检出上完成校验。** `packages/engine/dist` 的字节依赖构建环境，一台机器写出的 manifest 在另一台上报 `consumer.digest-mismatch`（`packages/engine/dist/engine.js`）。engine 保留源码闭包（engine `src`、engine 构建脚本、`package.json`、`tsconfig.json`）、运行时下限与能力声明；generated 闭包为空，entrypoint 改用存在性与非空校验——与 `cli`、`dsh` consumer 的既有做法一致。其余 consumer 未改动。
