---
category: Changed
packages: cli, commands, engine
---

- `mstar store upgrade --operator <name>` is the sole default execution-state upgrade: it opens or creates the store, imports recognizable records in one run, activates authority, and returns one result with skipped items. Unknown and unresolved sources remain at their original paths; no attestation, inventory, staged manifest, coverage gate, activation barrier, or command-owned recovery point is required.
- Removed `store safe-upgrade` and the staged execution `preview`, `apply`, `activate`, `retire`, and `abort` verbs. Standalone `store backup` remains; execution `restore-preview`, `restore`, and `export` remain as independent backup/disaster-recovery and live-state reporting utilities.
<!-- CN -->
- `mstar store upgrade --operator <name>` 是唯一默认执行状态升级路径：一次命令打开或创建 store、导入可识别记录、激活 authority，并返回包含跳过项的一行结果。未知与无法解析的源文件保留在原路径；无需 attestation、inventory、staged manifest、coverage gate、激活屏障或命令自带恢复点。
- 删除 `store safe-upgrade` 及 staged execution 的 `preview`、`apply`、`activate`、`retire`、`abort` 动词。独立 `store backup` 保留；execution 的 `restore-preview`、`restore` 与 `export` 作为独立备份/灾难恢复及 live-state 报告工具保留。
