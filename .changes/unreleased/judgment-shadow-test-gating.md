---
category: Harness
packages: root, commands
---

- Repaired the first red runs of the newly registered `test-judgment` / `test-commands` jobs: the shadow-supervisor confinement case probes its declared environment (Linux platform, listable `/proc`, writable `/mnt/output`, which the CI job pre-creates runner-writable) and a capability guard fails the CI run with the named missing capability instead of silently skipping the witness; the study-closure cases now run everywhere through the supervisor's public controlled-provider inputs over the real mailbox protocol (the live-provider witness remains a documented gap), two latent assertion defects they had never exercised were fixed (missing assessor evidence fields and unbalanced receipt accounting), and the synthesis-pack tests assert `validatePack` content equality (`toEqual`) since validation intentionally returns a normalized derived copy, not the same reference. The controlled-mailbox integration test widens its worker poll budget (1s→6s), child cap (2s→the pilot's 10s ceiling) and test timeout, which a loaded CI runner outran (observed 1.1s round trip) without changing the lifecycle contract it witnesses.

<!-- CN -->
- 修复新注册的 `test-judgment` / `test-commands` 任务首轮红榜：shadow-supervisor 禁闭用例探测其声明环境（Linux 平台、可列出 `/proc`、可写 `/mnt/output`——CI 任务预置 runner 可写目录），能力守卫在 CI 缺失能力时以点名原因红榜而非静默跳过见证；study 闭环用例改经 supervisor 公开受控 provider 输入与真实 mailbox 协议全平台执行（live provider 见证仍为显式记录缺口），并修复其中两个从未被执行到的断言缺陷（缺失评估证据字段、receipt 记账不平衡）；synthesis-pack 测试改为断言 `validatePack` 内容相等（`toEqual`），因为校验有意返回规范化的派生副本而非同一引用。受控邮箱集成测试放宽其 worker 轮询预算（1s→6s）、child 上限（2s→pilot 的 10s 上限）与测试超时：高负载 CI runner 的往返实测 1.1s 会超出旧预算，其见证的生命周期契约不变。
