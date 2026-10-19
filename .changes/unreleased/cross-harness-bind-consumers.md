---
category: Harness
packages: root
---

- **A cross-harness bind's consumers resolve the harness the bind selected.** The workflow-ledger attribution and the native `mstar_execution_clear` tool no longer re-derive the harness from the workspace: both resolve the session's selected root (the root the bind adoption recorded), so a bind naming a different control root is attributed from, and cleared in, THAT root while the workspace root is never written; the ledger target carries its own harness dir so the scan bound and event append act on the binding's store.
- **The `--identity-env` docs state the identity lock.** `bundle/README.md` and `bundle/cordis.patch.yml` no longer describe the declared identity as a per-call-overridable default: declaring the channel locks the connection (no published session selector, caller-supplied session ids stripped), and per-caller identity is a per-mount fact.

<!-- CN -->
- **跨 harness bind 的消费者解析 bind 所选的 harness。** workflow-ledger 归因与原生 `mstar_execution_clear` 工具不再从 workspace 反推 harness：两者都解析会话被选定的 root（bind 采纳时记录的 root），点名另一个 control root 的 bind 从该 root 归因、在该 root 清除，workspace root 全程零写入；ledger target 自带 harness dir，扫描水位与事件追加作用于绑定所在的 store。
- **`--identity-env` 文档对齐身份锁定。** `bundle/README.md` 与 `bundle/cordis.patch.yml` 不再把声明的身份描述为可被按调覆盖的默认值：声明该通道即锁定连接（不发布 session selector、调用方提供的 sessionId 被剥离），每调用者身份是每个 mount 的事实。
