---
packages: dsh
---

- **The engine-status plans segment comes from one assembler on both model-facing surfaces.** The compact `agent/pre-step` row and the always-on `mstar:engine-status` digest each built the `plans: …` text themselves, so an empty registry read `plans: none registered` in the row but `plans: none` in the digest. Both now call `plansSegment` in `catalog.ts`: an empty registry is `none registered`, an all-Done workflow is `all done`, and only the row cap stays per-surface. `tests/system-prompt.spec.ts` pins the digest's LENGTH ceiling with a 40-row registry, so an unbounded registry fails a test before it can grow the injected prompt.

<!-- CN -->
- **engine-status 的 plans 段在两个模型可见表面上由同一个装配函数生成。** `agent/pre-step` 的紧凑行与常驻的 `mstar:engine-status` digest 各自拼 `plans: …` 文本，于是空注册表在行里读作 `plans: none registered`、在 digest 里读作 `plans: none`。现在两者都调用 `catalog.ts` 的 `plansSegment`：空注册表是 `none registered`，全部 Done 是 `all done`，只有每行的 cap 仍按表面各自持有。`tests/system-prompt.spec.ts` 用一个 40 行的注册表钉住 digest 的**长度**上限，因此无界注册表会先撞到失败的测试，而不会撑大注入的 prompt。
