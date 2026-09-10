---
category: dsh
packages: dsh
---

- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.5-rc.1` and refresh the lock against the `0.1.5-rc.1` line (badge `0.1.5-rc.1`). Corridor rollup from `dsh-v0.1.2-rc.1` through alphas (`0.1.3-alpha.1/2`, `0.1.5-alpha.1/2`) to this RC. No `dsh-session-persistence-sqlite` / `dsh-client-runtime` pin is added (neither is published at `0.1.5-rc.1`). Remote / `dsh-api-remotes` stays; `host-apiproxy` stays out of the client-bundle INLINE_SAFE allowlist; `SessionEvent.ignorable` usage is kept. The fallbacks-only / transitive dsh packages are declared as `@mstar-harness/dsh` peers at the same caret so those packages resolve into the checked graph and the `peer-deps.spec.ts` single-line guard covers the whole family.
- Lock converges to a single `0.1.5-rc.1` dsh line. No root `package.json` overrides.

- Compensate for `@deepseek-ai/dsh-client-store` / `dsh-client-ui-primitives` / `dsh-client-ui-renderer` publishing without their former runtime dependencies: add `zustand`/`immer`, the previous primitives markdown/shiki stack, and `use-sync-external-store` as `@mstar-harness/dsh` **devDependencies** so client-seam tests and typecheck can load the registry packages.

<!-- CN -->
- 将 `@deepseek-ai/dsh-*` host peer 升到 `^0.1.5-rc.1`，lock 刷新到 `0.1.5-rc.1` 线（badge 更新为 `0.1.5-rc.1`）。走廊自 `dsh-v0.1.2-rc.1` 经 alphas（`0.1.3-alpha.1/2`、`0.1.5-alpha.1/2`）汇总到本 RC。不新增 `dsh-session-persistence-sqlite` / `dsh-client-runtime` 钉定（两者均未发布 `0.1.5-rc.1`）。Remote / `dsh-api-remotes` 保持不变；`host-apiproxy` 仍不在客户端 bundle INLINE_SAFE 白名单中；`SessionEvent.ignorable` 用法保留。fallbacks-only / 传递 dsh 包同样以该 caret 声明为 `@mstar-harness/dsh` peer，使这些包解析进受检图，`peer-deps.spec.ts` 单行守卫覆盖整个家族。
- lock 收敛为单一 `0.1.5-rc.1` dsh 线。未添加 root `package.json` overrides。
- 补偿 `@deepseek-ai/dsh-client-store` / `dsh-client-ui-primitives` / `dsh-client-ui-renderer` 发布物去掉原 runtime dependencies：将 `zustand`/`immer`、原 primitives markdown/shiki 栈与 `use-sync-external-store` 加为 `@mstar-harness/dsh` **devDependencies**，以便 client-seam 测试与 typecheck 能加载 registry 包。
