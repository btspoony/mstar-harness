---
category: Fixed
packages: engine,commands
---

- **`store upgrade` refuses to strand an open mirror run.** A combined store whose `sync_runs` still holds a run now refuses `store.upgrade-sync-run-open` before the schema passes migration 20 — the fence the last released 4.8.x build refuses — and the recovery names that build's own `issue-sync apply` settlement. After the advance neither build could settle it.
- **The combined upgrade branch now honours the documented automatic attestation.** It reaches the same provision-and-retry path as the legacy import (`advanceSchemaWithGeneratedAttestation`), so `store upgrade --help`'s promise holds on both branches.
- **A bound remote checkout with no cache is no longer told to run `store init`.** The catalog journal's `collaboration.not-initialized` refusal on that path names the reviewed `remote bind` instead, with the code and lane message unchanged.
- Removed forbidden byte/JSON snapshot assertions from `catalog-registration.test.ts` and `execution-coordination.test.ts` in favour of semantic assertions, and moved the remote journal scenario to `packages/engine/test/` per the test-layout rule.

<!-- CN -->
- **`store upgrade` 拒绝搁置未结束的镜像运行。** 组合库的 `sync_runs` 仍有运行记录时，在 schema 越过 migration 20（最后一个已发布 4.8.x 版本拒绝的围栏）之前以 `store.upgrade-sync-run-open` 拒绝；恢复指引指向该版本自己的 `issue-sync apply` 结算方式，越过之后两个版本都无法结算。
- **组合升级分支现遵守文档承诺的自动 attestation。** 它与 legacy import 走同一条 provision-and-retry 路径（`advanceSchemaWithGeneratedAttestation`），因此 `store upgrade --help` 的承诺在两个分支上都成立。
- **已绑定但缺少 cache 的 remote checkout 不再被告知运行 `store init`。** 该路径上 catalog journal 的 `collaboration.not-initialized` 拒绝改为指向经审查的 `remote bind`，错误码与 lane 消息保持不变。
- 移除 `catalog-registration.test.ts` 与 `execution-coordination.test.ts` 中禁止的字节/JSON 快照断言，改为语义断言；并把 remote journal 场景按测试布局规则移到 `packages/engine/test/`。
