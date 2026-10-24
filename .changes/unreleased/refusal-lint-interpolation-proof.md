---
category: Harness
packages: root
---

- **Refusal-quality lint proves interpolated recovery text.** Recovery strings built from a helper or template are now proven statically when every interpolation is an explicit declared-safe identifier (`workflow`, `holderList`); computed expressions, shadowed helpers, and any other identifier fail closed. The two `I-000865` allowlist entries are gone, and a stale allowlist hash now names its tracking issue and the required refresh.

<!-- CN -->
- **拒绝质量 lint 可静态证明插值恢复文本。** 由 helper 或模板构造的恢复文本，在插值全部属于显式声明的安全标识符（`workflow`、`holderList`）时通过静态证明；计算表达式、被遮蔽的 helper 及其他标识符一律 fail closed。`I-000865` 的两条 allowlist 条目已移除，过期的 allowlist 哈希现在会报出对应 issue 与需要执行的刷新。
