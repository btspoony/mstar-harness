---
packages: dsh
---

- **A failed harness-prompt registration no longer leaks what already landed.** When `registerHarnessPrompt`'s `mstar:engine-status` context registration threw after the `mstar:harness-rules` section had registered, the contained failure path only logged: the section (and its captured resolver closure) stayed on the prompt layer with no disposer, because the fiber effect that owns both disposers is installed only on the success path. Both collected disposers are now run from the failure path through the same individually guarded, never-throws helper the success disposer uses, so a half-registered prompt layer unwinds to nothing. `onRegistered` still fires only after both entries land.

<!-- CN -->
- **harness-prompt 注册失败不再遗留已落地的条目。** 当 `registerHarnessPrompt` 的 `mstar:engine-status` context 注册在 `mstar:harness-rules` section 已注册之后抛错时，被吞掉的失败路径只记录日志：该 section（连同其闭包捕获的 resolver）留在 prompt 层且没有 disposer，因为持有两个 disposer 的 fiber effect 只装在成功路径上。现在失败路径会通过成功 disposer 所用的同一个逐个兜底、永不抛出的 helper 运行两个已收集的 disposer，因此半完成的注册会退化为空。`onRegistered` 仍只在两个条目都落地后才触发。
