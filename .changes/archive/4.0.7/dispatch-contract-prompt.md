---
category: Changed
packages: dsh
---

- **Delegation contract in the harness prompt block.** When the Agent Teams layer is mounted, `mstar:harness-rules` now also names `spawn_teammate` as the default dispatch channel for writable work and requires every delegation prompt (`workflow agent()` included) to open with `## Assignment` + `Execute as: <role>`. A coordinator that is mid-task on something else does not open `mstar-host` → `references/dsh.md`, which until now was the only place either fact was written down — and neither the dispatch gate (no pre-start seam on `workflow`) nor the role gate can correct a header-less dispatch after the fact.

<!-- CN -->
- **harness 提示块内的派发契约。** 挂载 Agent Teams 层时，`mstar:harness-rules` 现在还会说明：`spawn_teammate` 是 writable 工作的默认通道，且每个派发 prompt（含 `workflow agent()`）必须以 `## Assignment` + `Execute as: <role>` 开头。此前这两条只写在 `mstar-host` → `references/dsh.md`，而正忙于其它任务的会话不会打开它——事后的 dispatch gate（`workflow` 没有 pre-start 接缝）与 role gate 都无法纠正一个没有 header 的派发。
