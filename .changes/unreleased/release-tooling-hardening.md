---
category: Harness
packages: root
---

- **`release:prepare` now refuses a version the registry already publishes.** The check runs at the version-selection point, before any changelog or manifest is touched: a target version that an already-published release surface carries refuses with the recovery (choose a different version and re-run), and an unreadable registry prints an explicit skip line — the read is bounded, so a hung registry degrades to that statement instead of stalling the release. `release:validate`'s offline tag gate still makes no network call.
- **The `env-injection-seams-removed` fragment declares `packages: engine`** (plus its CN block behind the marker), so an engine change is assembled into `packages/engine/CHANGELOG.md` instead of the root changelogs.
- **`INSTALL.md` gains a 3.x → 4.x upgrade section**: the plan-PM product route removal (one workflow coordinator drives every row through ordinary prepare/progress/issue/complete), the no-argument `/iteration-drive`, the CLI + host-plugin re-install, and the release CHANGELOG entry as the complete change list.

<!-- CN -->
- **`release:prepare` 现在拒绝 registry 已发布的版本。** 该检查位于版本选择点、任何 changelog 或清单被改写之前：目标版本若已存在于任一已发布 surface 上，则带恢复指引拒绝（换一个版本后重跑）；registry 不可读时打印明确的跳过行——读取有超时上限，registry 挂起会退化为该声明而不会卡住发布。`release:validate` 的离线 tag 门禁仍不发网络请求。
- **`env-injection-seams-removed` 碎片现声明 `packages: engine`**（中文块置于标记之后），因此引擎变更被装配进 `packages/engine/CHANGELOG.md`，不再进入根 changelog。
- **`INSTALL.md` 新增 3.x → 4.x 升级章节**：plan-PM 产品路线移除（唯一 workflow coordinator 通过普通 prepare/progress/issue/complete 推进行）、无参数的 `/iteration-drive`、CLI 与宿主插件重装，以及以发布版 CHANGELOG 条目为完整清单。
