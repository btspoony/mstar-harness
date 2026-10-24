---
category: Harness
packages: root
---

- **Refusal-quality lint proves interpolated recovery text.** Recovery strings built from a helper or template are now proven statically when every interpolation is an explicit declared-safe identifier (`workflow`, `holderList`); computed expressions, shadowed helpers, and any other identifier fail closed. The two `I-000865` allowlist entries are gone, and a stale allowlist hash now names its tracking issue and the required refresh.
- **Refusal-quality lint: 12 engine-supplied recovery sites are exempted under `I-000872`.** `packages/engine/src/family-refusal.ts` only type-checks the recovery string and proves no reachable command, so the strict static proof cannot cover those refusals; they are recorded as 11 content-hash allowlist entries (one signature covers two call sites), each stating its own cause. Statically provable recovery text still passes with no entry.

<!-- CN -->
- **拒绝质量 lint 可静态证明插值恢复文本。** 由 helper 或模板构造的恢复文本，在插值全部属于显式声明的安全标识符（`workflow`、`holderList`）时通过静态证明；计算表达式、被遮蔽的 helper 及其他标识符一律 fail closed。`I-000865` 的两条 allowlist 条目已移除，过期的 allowlist 哈希现在会报出对应 issue 与需要执行的刷新。
- **拒绝质量 lint：12 个引擎提供的恢复文本站点以 `I-000872` 说明豁免。** `packages/engine/src/family-refusal.ts` 只校验字符串类型，无法证明可到达命令，因此严格静态证明覆盖不到这些拒绝；它们以 11 条内容哈希 allowlist 条目（一个签名覆盖两个调用点）记录，并为每个站点写明实际原因。可静态证明的恢复文本仍无需任何条目即可通过。
