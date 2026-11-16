---
category: Changed
packages: commands
---

- **The `refuse-nohost` import case is deterministic (test-only).** `packages/commands/src/families/issue-sync.test.ts` no longer lets ambient state decide the outcome: it points `MSTAR_LINEAR_CREDENTIAL` at an empty path inside the fixture, deletes `LINEAR_API_KEY` and stubs `fetch` to throw, which the built-in transport maps to `unreachable`. Previously a stored credential at `~/.config/mstar/linear/credential.json` refused `linear.reauth-required` from `resolveStoredToken` before any provider was assembled — failing the case on a machine that had ever run `mstar linear auth` — while with no credential the assembly spent a real call to `mcp.linear.app` whose network result became the probe state, so the case passed without exercising what it asserted.
- The stubbed transport records its call, so the case now asserts exactly one `linear.host-unavailable` after proving the built-in provider was built and reached the wire. The guard against a `linear.list-unimplemented` refusal is kept.

<!-- CN -->
- **`refuse-nohost` 的 import 用例现在确定（仅测试）。** `packages/commands/src/families/issue-sync.test.ts` 不再由环境态决定结果：把 `MSTAR_LINEAR_CREDENTIAL` 指向 fixture 内的空路径、删除 `LINEAR_API_KEY`，并把 `fetch` 打桩为抛错（内置传输层将其映射为 `unreachable`）。此前 `~/.config/mstar/linear/credential.json` 里的存量凭据会在任何 provider 装配前由 `resolveStoredToken` 拒绝为 `linear.reauth-required`——凡跑过 `mstar linear auth` 的机器上该用例即失败；而无凭据时装配会真实调用 `mcp.linear.app`，用网络结果充当探针状态，于是用例在未检验其断言内容的情况下通过。
- 打桩的传输层会记录调用，因此用例现在断言恰好一次 `linear.host-unavailable`，且先证明内置 provider 已被装配并抵达传输层。对 `linear.list-unimplemented` 拒绝的防护保留。
