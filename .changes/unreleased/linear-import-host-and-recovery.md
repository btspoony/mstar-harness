---
packages: engine, commands
---

- **The import has a working host.** `mstar issue-sync import` no longer requires a host-supplied `issueProvider`:
  the Linear probe and listing adapter moved from the dsh package into the engine (they had no dsh-specific
  dependency), a streamable-HTTP JSON-RPC transport was added, and one assembly joins probe + adapter + transport
  over a single handshake. The command builds that assembly itself, so every environment can run the import; a
  host override still wins where one exists. Previously every real run refused `linear.list-unimplemented`, which
  no operator could recover from.
- **A completed scan rewinds its page pointer.** Leaving the cursor on the last page made every earlier page
  unreachable, so an issue edited there was never read again. A scan that finishes now clears the pointer and the
  next run walks from the first page, skipping per item through the ledger; a scan that STOPS (a stranded item,
  the page bound, a thrown page) keeps its pointer, because rewinding there would re-request the same failing page
  from the top on every run and lose the position that made progress possible.
- **An interrupted write resumes; a failed one retries.** A `pending` row whose remote revision EQUALED the
  recorded watermark used to be closed as applied without copying any field — only a strictly older revision is
  stale now. A `failed` row used to replay its own failed receipt because the retry reused the attempt's operation
  id; each attempt now has its own, so the row can actually recover.
- **Restore no longer leaves sync state behind.** `project_bindings`, `issue_sync_state` and `sync_cursor` joined
  the backup inventory and the replacement order, so a restore restores the bindings and cursors its issues
  describe rather than the issues alone.
- **Custom harness layouts bind correctly.** `readRepoLinearBinding` walked to the parent of the harness
  directory; it now walks up to the first directory holding `.git` and falls back to the parent only when no
  checkout is found, so a harness placed anywhere still reads the repository's own `.mstarc`.

<!-- CN -->
- **导入有了可用的宿主。** `mstar issue-sync import` 不再要求宿主提供 `issueProvider`：Linear 探测与列表适配器从
  dsh 包移入 engine（它们本无 dsh 专有依赖），新增 streamable-HTTP JSON-RPC 传输，并由一处装配在单次握手上把
  探测、适配器与传输接起来。命令自己构造该装配，因此任何环境都能跑导入；宿主覆盖仍然优先。此前每次真实运行都以
  `linear.list-unimplemented` 拒绝，操作者无从恢复。
- **完成的扫描会重置页指针。** 把游标停在最后一页会让之前每一页都不可达，那里改动的 issue 永远不会再被读取。
  现在扫描完成即清除指针，下次从头走，靠账本逐条跳过；而**停止**的扫描（搁浅条目、页数上限、抛错的页）保留指针，
  因为在那里重置会让每次运行都从头重请求同一个失败页，并丢掉让进展成为可能的位置。
- **中断的写入会续做，失败的会重试。** 远端版本与记录水位**相等**的 `pending` 行过去会被当作已应用关闭却不复制
  任何字段——现在只有严格更旧的版本才算过期。`failed` 行过去会重放自己失败的收据，因为重试复用了那次尝试的操作 id；
  现在每次尝试各有其 id，行才能真正恢复。
- **恢复不再丢下同步状态。** `project_bindings`、`issue_sync_state`、`sync_cursor` 已加入备份清单与替换顺序，
  因此恢复会连同绑定与游标一起恢复，而不是只恢复它们描述的 issue。
- **自定义 harness 布局也能正确绑定。** `readRepoLinearBinding` 过去走到 harness 目录的父目录；现在向上找到第一个
  含 `.git` 的目录，找不到才回退，因此 harness 放在任何位置都能读到本仓库自己的 `.mstarc`。
