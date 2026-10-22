---
packages: dsh
---

- **A cross-root `mstar_plan_bind` no longer loses its adopted control root on a host restart.** The plugin opens one `mstar_execution_binding_roots` storage domain when the host provides the storage-domain service and mirrors every adoption receipt and clear into it, so the workflow ledger's attribution and the native `mstar_execution_clear` still resolve the root the bind selected after a restart — with no resume re-bind, and without ever writing the workspace root.
- The storage-domain service stays optional: a host without it, a refused `open` (including an HMR re-apply meeting `already-open`), or a fiber torn down while the open was in flight leaves the previous per-process receipt in place, logs one warning naming the cause, and never blocks the plugin from mounting. The resume re-bind stays the named recovery for that degraded case.
- The seam's disposer uninstalls it before closing the domain, so no consumer reads a closing handle and the queued durable writes are drained on a graceful shutdown.

<!-- CN -->
- **跨根 `mstar_plan_bind` 采纳的控制根不再随宿主重启丢失。** 宿主提供 storage-domain 服务时，插件开启一个 `mstar_execution_binding_roots` 存储域，把每次采纳回执与清除都镜像进去，于是重启后 workflow ledger 的归属解析与原生 `mstar_execution_clear` 仍能解析到该 bind 选定的根 —— 无需 resume 重绑，也绝不写入工作区根。
- storage-domain 服务仍属可选：宿主没有该服务、`open` 被拒绝（含 HMR 重挂载遇到 `already-open`）、或 fiber 在 open 在途时被拆除，都保留原有的进程内回执、以一条警告点名原因，且绝不阻断插件挂载。该降级场景的恢复路径仍是 resume 重绑。
- 该 seam 的清理器先卸载再关闭存储域，因此不会有消费者读到正在关闭的句柄，正常退出时会排空已排队的持久写。
