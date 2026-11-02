---
packages: engine, commands, cli
---

- **A cycle that was open at upgrade time no longer survives as a lie.** The
  single watermark column used to hold the planned target for a pending row.
  Migration 16 created the new column but left those rows claiming they had copied
  content they never took, so the stale-page guard compared against a revision
  nothing holds and skipped every older page — the bug the split exists to remove,
  persisting across the upgrade. The migration now moves the value across.
- **Authorization refusals keep their code and recovery.** A closed browser tab,
  a mismatched state or a refused registration used to escape as a plain Error and
  reach the operator as `internal-error` with a generic recovery. The failures now
  carry their own code and recovery, the command turns them into a refusal
  envelope, and `linear.auth-timeout` is covered.
- **An exported key is a real fallback.** When the stored credential had expired
  and the host could not refresh it, the import refused even with a working
  `LINEAR_API_KEY` exported — the branch that falls back to it could never be
  reached. It now falls through, and the refusal (when there is nothing to fall
  back to) names both `mstar linear auth` and the environment variable.
- **The restore gate fails closed.** The migration lookup behind
  `pending_target` defaulted to a version number, so a renamed migration entry
  would have re-enabled that column on stores that never had it; it defaults to
  the conservative value its siblings use.

<!-- CN -->
- **升级时仍未闭合的循环不再以谎言的形式存活。** 此前唯一的那个水位列对 pending 行存的是“计划目标”。
  迁移 16 建了新列，却把这些行留在“声称复制了从未复制的内容”的状态，于是陈旧页守卫拿一个没有任何行持有的版本去比较，
  把更旧的页面全部跳过——正是这次拆列要消除的 bug，跨升级存活下来。现在迁移会把值搬过去。
- **授权拒绝保留自己的错误码与恢复路径。** 此前浏览器标签页关闭、state 不匹配或注册被拒，会以普通 Error 逃逸，
  到操作者手里变成 `internal-error` 加一句通用恢复文案。现在失败自带 code 与 recovery，命令把它们转成拒绝信封，
  并且 `linear.auth-timeout` 有了覆盖。
- **导出的 key 是真正的回退。** 当存储的凭据已过期且宿主无法刷新时，即使导出了可用的 `LINEAR_API_KEY`，导入也会拒绝——
  那条回退分支根本走不到。现在会走回退；确实无处可退时，拒绝文案同时给出 `mstar linear auth` 与环境变量两条路径。
- **恢复门禁改为失闭。** `pending_target` 背后的迁移查找把默认值写成了版本号，迁移改名后会在从未有过该列的 store 上
  重新打开该列；现在改用与其同类一致的保守默认值。
