---
packages: root, engine, cli, opencode
---

- **Engine hardening (QC fix wave, slice 1)**: lease location/orphan/dual-write verify (`lease.verify.*`) moved into `@mstar-harness/engine` (CLI `mstar lease verify` is now a thin wrapper); `archiveResiduals` gained a plan-id path-traversal guard, the status write lock, and append dedup; `withStatusWriteLock` gained an ownership guard (never removes another writer's lockdir), a `holder.pid` crash-diagnosis file, and fast-fail reentrancy detection; `readHarnessVersion` reads the module's own manifest first (published installs no longer regress to `0.0.0`); `tech-debt-rollup` parity now mirrors jq `//` exactly (`false`/`0` edges tested against the bash oracle); residual closed-lifecycle completeness (`closed_at` + `closure_note`) and plan-row `Done` ⇒ no-lease invariants added. Release prep now ensures the `@mstar-harness/engine` registry row + package-history link in root changelog heads.

<!-- CN -->
- **Engine 加固（slice 1 QC 修复波）**：lease 位置/孤儿/双写校验（`lease.verify.*`）移入 `@mstar-harness/engine`（CLI `mstar lease verify` 改为薄包装）；`archiveResiduals` 增加 plan-id 路径穿越防护、状态写锁与追加去重；`withStatusWriteLock` 增加所有权防护（绝不删除其他 writer 的 lockdir）、`holder.pid` 崩溃诊断文件与快速失败的重入检测；`readHarnessVersion` 优先读取模块自身 manifest（发布安装不再回退为 `0.0.0`）；`tech-debt-rollup` 奇偶校验精确镜像 jq `//`（`false`/`0` 边界用例对照 bash oracle）；新增残项关闭完整性（`closed_at` + `closure_note`）与 plan 行 `Done` ⇒ 无 lease 不变量。发布脚本在根 changelog 头部确保 `@mstar-harness/engine` 注册表行与包历史链接。
