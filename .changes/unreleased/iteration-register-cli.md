---
packages: engine,cli
---

- Added **`registerIterationWorkflow`** to the engine: a sibling of `registerPlanWorkflow` that creates the `type: "iteration"` snapshot (compass ref, three branch anchors, Todo plan rows with §1.5-derived `iteration_refs` / `spec_integration_branch` / `merge_target` metadata) plus the root `status.json` entry inside one create-only, root-lock section — version-exact rollback, byte-preserving orphan recovery, and no change to the standalone plan producer.
- Added the **`mstar iteration register`** CLI verb so an iteration can be registered from any checkout with no engine import (exit `0` ok / `1` engine refusal / `2` usage); `mstar workflow register` is unchanged.
- Made the new path discoverable: `mstar-iteration` §1.5 now names the verb instead of a bare engine call, and `mstar-use-cli` indexes the iteration-registration family (its `mstar-harness-core` topic-index row was already wired in d7aca2f6).

<!-- CN -->
- 引擎新增 **`registerIterationWorkflow`**：作为 `registerPlanWorkflow` 的兄弟 producer，在同一把根锁内的 create-only 区段中写入 `type: "iteration"` snapshot（compass ref、三个 branch anchors、携带 §1.5 派生 `iteration_refs` / `spec_integration_branch` / `merge_target` 元数据的 Todo plan 行）与根 `status.json` entry——版本精确 rollback、保留字节的孤儿恢复，且 standalone plan producer 行为不变。
- 新增 **`mstar iteration register`** CLI verb，任意 checkout 无需 engine import 即可登记迭代（exit `0` 成功 / `1` engine 拒绝 / `2` 用法错误）；`mstar workflow register` 保持不变。
- 打通可发现性：`mstar-iteration` §1.5 现命名该 verb 而非裸 engine 调用，`mstar-use-cli` 索引迭代登记 family（其在 `mstar-harness-core` 专题索引中的条目已由 d7aca2f6 先行接线）。
