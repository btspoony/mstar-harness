---
category: Changed
packages: root
---

- **A 5.0 migration guide now covers the collaboration authority change end to end.** `docs/migration-5.0.md` states the breaking summary, the reviewed ladder (`store upgrade`, then `store collaboration plan`, `apply`, `activate` with the operator's cutover attestation), a worked cutover taken from this repository's own plan/apply/activate receipts, the split authority, remote `status`/`bind`/`observe` with the freshness window, rebind and its `collaboration.stale-binding` refusals, the verified backup pair and create-only restore, and recovery rows for the refusal classes its documented flows produce, leaving the complete refusal map to the remote collaboration skill and the tracked contract. `INSTALL.md` gains an `Upgrading from 4.x` section that links it.
- **The guide states two limits instead of implying they are solved.** Cross-authority project moves are not in 5.0 (`moveIssue` refuses a remote checkout with `collaboration.mode-unavailable`) and remain tracked under `I-001235`; live Linear behaviour is unverified because the remote lane, cache, outbox, and sandbox handoff are proven only against the controlled host fixture.
- **Downgrade is an access loss, and the guide says so.** After the fence the last released 4.8.x build refuses the execution store as `store.schema-unsupported` and never opens the separate collaboration database, so its issue, catalog, project, roadmap, milestone, and findings reads stop until a 5.0 build is installed and reloaded.

<!-- CN -->
- **新增 5.0 迁移指南，完整覆盖协作权威变更。** `docs/migration-5.0.md` 说明破坏性变更摘要、审查过的阶梯（`store upgrade`，随后 `store collaboration plan`、`apply`、带操作者 cutover attestation 的 `activate`）、取自本仓库真实 plan/apply/activate 回执的完整迁移示例、拆分后的权威、远程 `status`/`bind`/`observe` 与新鲜度窗口、rebind 及其 `collaboration.stale-binding` 拒绝、经验证的备份镜像对与 create-only 恢复，以及文档所述流程会产生各拒绝类的恢复行；完整拒绝码映射归属远程协作 skill 与受跟踪的契约。`INSTALL.md` 新增 `Upgrading from 4.x` 小节并链接该指南。
- **指南明确写出两项限制，而不是暗示已经解决。** 跨权威项目移动未进入 5.0（`moveIssue` 在 remote 检出以 `collaboration.mode-unavailable` 拒绝），仍由 `I-001235` 跟踪；实时 Linear 行为未经验证，因为远程 lane、缓存、outbox 与沙箱交接只在受控宿主 fixture 上得到证明。
- **降级等于失去访问权，指南已写明。** fence 之后，最后发布的 4.8.x 构建会以 `store.schema-unsupported` 拒绝执行库，且从不打开独立的协作数据库，因此其 issue、目录、项目、路线图、里程碑与 findings 读取都会停止，直到安装并重载 5.0 构建。
