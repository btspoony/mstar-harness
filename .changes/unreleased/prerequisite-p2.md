---
category: Changed
packages: engine, cli
---

- Routed every registered-plan pointer through the ONE path resolver (prerequisite contract §4): `resolveRegisteredPlanFile` / `PlanPathError` are exported from the engine barrel beside `planDeclaredHeaders`, so registration, the Prepare append and later readiness share one parser instead of restating the `{PLAN_DIR}/<plan-id>.md` convention.
- `mstar iteration register` now persists the **canonical absolute** plan path in the snapshot instead of copying the caller's spelling, and the catalog registration preflight resolves and refuses an iteration row pointer **before** the first `prepared` journal row — a repository-relative `.mstar/plans/<id>.md` input is refused (received form, base, expected canonical target, permitted forms) with no root, snapshot or journal write; the normalized request is what gets hashed, stored and handed to the producer, and the shipped transport derives its default operation id from that same normalized workflow, so equivalent spellings of one target share one operation identity.
- The Prepare `appendPlans` pointer check consumes the same resolver (its private fence-aware parser is gone); the `invalid-plan` refusal vocabulary and codes are preserved and now carry the resolver's typed path detail, and a missing/non-string append pointer refuses with that code instead of escaping as a raw path `TypeError`. Standalone/audit catalog location schemas are unchanged.

<!-- CN -->
- 所有已注册 plan 指针统一走 **唯一** 路径解析器（前置契约 §4）：引擎 barrel 在 `planDeclaredHeaders` 之外导出 `resolveRegisteredPlanFile` / `PlanPathError`，注册、Prepare append 与后续 readiness 共用同一解析器，不再各自复述 `{PLAN_DIR}/<plan-id>.md` 约定。
- `mstar iteration register` 现在把 **规范化绝对路径** 写入 snapshot，而不再原样复制调用方拼写；catalog 注册预检会在第一条 `prepared` journal 行之前解析并拒绝 iteration 行指针——仓库相对拼写 `.mstar/plans/<id>.md` 会带着（收到的形式、base、期望的规范目标、允许的形式）被拒绝，且不产生 root、snapshot 或 journal 写入；被规范化的请求才是参与哈希、入库并交给 producer 的表示，且 shipped 入口的默认 operation id 也由同一份规范化 workflow 推导，同一目标的等价拼写共享同一 operation 身份。
- Prepare `appendPlans` 的指针校验改用同一解析器（其私有 fence-aware 解析器已删除）；`invalid-plan` 拒绝词汇与错误码保持不变，并附带解析器的类型化路径详情；缺失或非字符串的 append 指针会返回该错误码，而不再以原生路径 `TypeError` 逃逸。standalone/audit 的 catalog 位置 schema 不变。
