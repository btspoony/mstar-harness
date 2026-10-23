---
packages: dsh
---

- **A cross-root `mstar_plan_bind` no longer loses its adopted control root on a host restart.** The plugin opens one `mstar_execution_binding_roots` storage domain when the host provides the storage-domain service and mirrors every adoption receipt and clear into it, so the workflow ledger's attribution and the native `mstar_execution_clear` still resolve the root the bind selected after a restart — with no resume re-bind, and without ever writing the workspace root.
- The storage-domain service stays optional: a host that provides it after the apply installs the seam when the service arrives, while a host that never provides it keeps today's per-process receipt and warns once, at the first adoption, that the receipt is not durable. The bind's wait for the durable acknowledgment is bounded, so a stalled backend or a close that never settles its pending writes logs the cause once and answers from that receipt. A refused `open` (including an HMR re-apply meeting `already-open`), an install that fails after the domain already opened, or a fiber torn down while the open was in flight leaves that receipt in place, logs one warning naming the cause and its recovery (restart so the next apply retries the open or install, then a resume re-bind carrying the original session reference records the receipt durably), and never blocks the plugin from mounting. The resume re-bind stays the named recovery for the per-process receipt itself.
- The seam's disposer uninstalls it before closing the domain, so no consumer reads a closing handle; draining the queued durable writes is the domain's job when the host shuts down gracefully (host behaviour).

<!-- CN -->
- **跨根 `mstar_plan_bind` 采纳的控制根不再随宿主重启丢失。** 宿主提供 storage-domain 服务时，插件开启一个 `mstar_execution_binding_roots` 存储域，把每次采纳回执与清除都镜像进去，于是重启后 workflow ledger 的归属解析与原生 `mstar_execution_clear` 仍能解析到该 bind 选定的根 —— 无需 resume 重绑，也绝不写入工作区根。
- storage-domain 服务仍属可选：宿主在 apply 之后才提供该服务时，seam 会在服务到达时安装；始终不提供时，保留原有的进程内回执，并在首次采纳时警告一次该回执不持久。bind 等待持久确认的时长有上限：后端停滞、或关闭时排队写永不落定，都以一条警告点名原因并从该回执作答。`open` 被拒绝（含 HMR 重挂载遇到 `already-open`）、存储域已开启但 install 阶段失败、或 fiber 在 open 在途时被拆除，都保留该回执、以一条警告点名原因与恢复路径（重启宿主，让下一次 apply 重试 open 或 install，然后以携带原 session reference 的 resume 重绑把回执持久化），且绝不阻断插件挂载。该降级场景的恢复路径仍是 resume 重绑。
- 该 seam 的清理器先卸载再关闭存储域，因此不会有消费者读到正在关闭的句柄；已排队的持久写由存储域在宿主正常退出时排空（宿主行为）。
