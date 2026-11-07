---
category: Harness
packages: root, dsh
---

- **`mstar-host` → `references/dsh.md` now carries only what an orchestrator acts on**: detection tokens, delegation-channel selection, dispatch shape, `roleGate` / `dispatchBinding`, QC and SDD dispatch defaults, and gotchas. Every plugin-internal fact defers to `packages/dsh/README.md` through one pointer line per block — `§ Web client plugin (workflow panel)`, `§ Gates`, `§ Native command surface`, `§ Agent-flow ledger`. 1034 → 573 lines.
- The README received only the deltas its own sections lacked, never a copy: the panel's settle-to-dispatch pairing, its no-compass iteration inference and the current panel-QA scope; the gated carrier list, the `.mstarc` enforcement sources, the store-authority refusal class, the register-kind classification and a new **`§ Execution read route`** (engine resolver, DB authority, the five-rung lifecycle order and `unbound-multi-active`); the MCP argument-refusal aggregation; and the ledger's single record path, settle branches, child-identity join bounds, immediate cache invalidation, per-boundary target validation and maintainer view. `README.zh.md` mirrors each addition and `README.i18n.yaml` re-records both blob hashes.
- Deleted outright, never migrated: the twelve removed `mstar_<family>_<action>` mirrors and the retired `mstar/engineStatus` narration. Their rationale already lives in `docs/adr/dsh-native-identity-channels.md` § Superseded rationale, so a reader at HEAD no longer meets an inventory of tools that do not exist.
- `dsh.md` stays above the plan's 300-line target at **573 lines**: the surviving sections are orchestration text (delegation channels, PM dispatch, read-only fan-out, harness-dir/dispatchBinding), which the extraction must not cut.

<!-- CN -->
- **`mstar-host` → `references/dsh.md` 现在只保留编排者实际要行动的内容**：识别 token、委派通道选择、派发形态、`roleGate` / `dispatchBinding`、QC 与 SDD 派发默认值、以及 gotchas。所有插件内部事实改为指向 `packages/dsh/README.md`，每个迁出块留一行指针——`§ Web client plugin (workflow panel)`、`§ Gates`、`§ Native command surface`、`§ Agent-flow ledger`。1034 → 573 行。
- README 只收其既有节缺失的增量，绝不整段搬运：面板的 settle-派发配对、无 compass 时的迭代推断与当前面板 QA 范围；受门禁的载体清单、`.mstarc` enforcement 来源、store 权威拒绝类、register 类型分类，以及新增的 **`§ Execution read route`**（engine 解析器、DB 权威、五梯级生命周期顺序与 `unbound-multi-active`）；MCP 参数拒绝的聚合；账本的单记录路径、结算分支、子身份关联边界、立即缓存失效、逐事件边界的目标准校验与维护者视角。`README.zh.md` 逐项镜像，`README.i18n.yaml` 重录两侧 blob 哈希。
- 直接删除、不迁移：十二个已移除的 `mstar_<family>_<action>` 镜像与已退役的 `mstar/engineStatus` 叙述。其理由已记录于 `docs/adr/dsh-native-identity-channels.md` § Superseded rationale，HEAD 上的读者不再面对一份不存在的工具清单。
- `dsh.md` 仍高于 plan 的 300 行目标，实测 **573 行**：存活章节均为编排文本（委派通道、PM dispatch、只读扇出、harness 目录 / `dispatchBinding`），抽取过程不得裁剪。
