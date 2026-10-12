---
category: Harness
packages: root, engine, commands, cli, dsh, omp, opencode, opencode-v2
---

- **Removed application file/directory mutexes** without a replacement mutex protocol. Native SQLite transactions/CAS, authorization and genuine workflow integration ownership remain; ordinary notes and documents are not authority.
- **Workflow notes are a plain append log**: repeated IDs/submissions append again, one LF-framed `O_APPEND` write preserves peer bytes on failure, tolerant readers continue past partial records, and receipts return the note ID without an accepted-operation replay promise.
- **Dsh host state uses the existing control-root database** for events, accepted source identities, scan bounds, bindings and newest status emissions, without JSONL tail/index/cursor/cache authority or file compaction. Native session logging continues before ACTIVE authority; unavailable persistence reports supported init/upgrade recovery. Engine-status reads preserve native refusal causes and distinguish a true addressed no-row answer from absent, staged, corrupt and schema-refused authority.
- **Legacy execution recovery imports directly** through `store upgrade`, retaining original v1/v2 source bytes; standalone `mstar migrate` staging and internal status/snapshot writers are retired. Database backup captures a consistent native image; restore replaces all authority domains transactionally on the same live database with a new epoch, without freezing or rolling back ordinary files. Fresh-store failures distinguish unpublished filesystem failure from an already-published store whose handle could not open, with phase-specific public recovery.

<!-- CN -->
- **完整移除应用层文件/目录互斥锁**，不引入替代互斥协议。保留 SQLite 原生事务/CAS、授权及真实 workflow integration ownership；普通笔记与文档不成为权威。
- **Workflow notes 改为普通追加日志**：重复 ID/提交再次追加，一次带 LF 边界的 `O_APPEND` 写入在失败时保留其他写者字节，容错读取越过不完整记录，回执仅返回笔记 ID，不承诺 accepted-operation 回放。
- **Dsh host 状态使用现有 control-root 数据库**保存事件、已接受来源身份、扫描下界、绑定与最新状态发射，不再使用 JSONL tail/index/cursor/cache 权威或文件压缩。ACTIVE 权威建立前原生会话日志继续记录，持久化不可用如实提供 init/upgrade 恢复；engine-status 读取保留原生拒绝原因，并区分真实定址无记录与 authority 缺失、staged、损坏和 schema 拒绝。
- **旧执行状态经 `store upgrade` 直接导入**，保留原始 v1/v2 来源字节；退役独立 `mstar migrate` staging 与内部 status/snapshot writer。数据库备份生成一致原生镜像；restore 在同一 live 数据库内以事务替换全部权威域并提交新 epoch，不冻结或回滚普通文件。新建 store 的失败区分未发布的文件系统故障与已发布但无法打开句柄的 store，并提供各阶段对应的公共恢复路径。
