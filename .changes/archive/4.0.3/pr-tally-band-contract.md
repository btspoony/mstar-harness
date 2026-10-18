---
category: Changed
packages: engine
---

- **Documented the tally `band` producer/envelope split on the published type** (requested by issue #504). The `PrTallyResult` doc now states that `computePrTally` always emits `band`, that an `mstar.review/v1` envelope tally carries the `MstarReviewTally` shape where `band` is optional, and that the envelope validator accepts a band-less tally as legacy-valid — so a consumer constructing a typed tally no longer has to infer the split from the schema description. Types, validator, schemas and generated bundles are unchanged.

<!-- CN -->
- **在已发布类型上记录 tally `band` 的生产者/信封差异**（issue #504 提出）。`PrTallyResult` 的文档现在说明：`computePrTally` 总是输出 `band`；`mstar.review/v1` 信封 tally 采用 `MstarReviewTally` 形态、其 `band` 可选；信封校验器接受缺失 `band` 为 legacy-valid —— 构造类型化 tally 的消费者不必再从 schema 描述里推断该差异。类型、校验器、schema 与生成产物均无变化。
