---
category: Harness
packages: engine
---

- **A terminal workflow's held integration lease is now releasable through `mstar session recover`.** When a crash or a foreign writer leaves the lease held on a lifecycle that is already `completed` / `failed` / `stopped`, the existing recovery call takes the workflow token, the lease's recorded holder as `--prior-session`, and an attestation naming that holder as stopped/reloaded, then writes the released tombstone and its operation receipt. Nothing else moves: the terminal header keeps its bytes and revision, the snapshot, registry membership and every coordinator row stay as recorded, and no session is rebound or revoked.
- **The release is guarded, not a second writer.** A terminal workflow with no held lease keeps the previous closed-lifecycle refusal verbatim, a request that does not name the lease's recorded holder is refused, an attestation that does not cover that holder is refused, and a superseded workflow token is still the CAS. Every other terminal request is refused exactly as before.
- **The `PHASE6_DANGLING_LEASE` recovery text now names the route that exists.** It points at `mstar status validate` for the workflow token and then at `mstar session recover` for the release, and states that only the lease is released; the previous "a terminal workflow cannot be recovered, record a residual" outcome is gone.

<!-- CN -->
- **终态 workflow 持有的 integration lease 现可通过 `mstar session recover` 释放。** 当崩溃或外部写入方在已是 `completed` / `failed` / `stopped` 的生命周期上留下仍被持有的 lease 时，现有 recovery 调用取 workflow token、把 lease 记录的 holder 作为 `--prior-session`、并附带把该 holder 记为 stopped/reloaded 的 attestation，随后写入 released 墓碑与对应 operation receipt。其余一切不动：终态 header 的字节与 revision 保持不变，snapshot、registry 归属与全部 coordinator 行保持记录时的样子，不会重新绑定或吊销任何 session。
- **该释放是受保护的，不是第二个写入方。** 终态 workflow 若没有持有的 lease，仍原样保留此前的 closed-lifecycle 拒绝；未指名 lease 记录 holder 的请求被拒绝；attestation 未覆盖该 holder 的请求被拒绝；被取代的 workflow token 仍然是 CAS。其余针对终态 workflow 的请求与之前完全一致地被拒绝。
- **`PHASE6_DANGLING_LEASE` 的恢复文案现在指向真实存在的路径。** 它先用 `mstar status validate` 取 workflow token，再用 `mstar session recover` 执行释放，并说明只释放 lease；原先「终态 workflow 无法 recovery，只能记 residual」的结论已删除。
