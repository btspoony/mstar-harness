---
category: Harness
packages: root, commands
---

- Repaired the first red runs of the newly registered `test-judgment` / `test-commands` jobs: shadow-supervisor container-only cases now probe for their declared environment (Linux platform, listable `/proc`, writable `/mnt/output`) and skip with a visible reason naming the missing capability on hosts without it, while the `test-judgment` CI job pre-creates a runner-writable `/mnt/output` so the cases run there and a capability guard fails the job when the mount is absent instead of silently dropping the witness, and the synthesis-pack tests assert `validatePack` content equality (`toEqual`) since validation intentionally returns a normalized derived copy, not the same reference. The controlled-mailbox integration test widens its worker poll budget (1s→6s), child cap (2s→the pilot's 10s ceiling) and test timeout, which a loaded CI runner outran (observed 1.1s round trip) without changing the lifecycle contract it witnesses.

<!-- CN -->
- 修复新注册的 `test-judgment` / `test-commands` 任务首轮红榜：shadow-supervisor 仅容器用例现在探测其声明环境（Linux 平台、可列出 `/proc`、可写 `/mnt/output`），无该能力的宿主上以可见原因跳过（点名缺失能力）而非直接失败；`test-judgment` CI 任务预置 runner 可写的 `/mnt/output` 使这些用例真正运行，能力守卫在挂载缺失时让任务红榜而非静默丢弃见证；synthesis-pack 测试改为断言 `validatePack` 内容相等（`toEqual`），因为校验有意返回规范化的派生副本而非同一引用。受控邮箱集成测试放宽其 worker 轮询预算（1s→6s）、child 上限（2s→pilot 的 10s 上限）与测试超时：高负载 CI runner 的往返实测 1.1s 会超出旧预算，其见证的生命周期契约不变。
