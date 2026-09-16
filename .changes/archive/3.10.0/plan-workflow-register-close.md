---
category: Changed
packages: engine
---

- Added the **plan-level workflow lifecycle seams** (frozen contract `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`): `mstar workflow register` creates a `type: plan` snapshot + root entry create-only under one lock (audit-promotion primitives, exact-version rollback, crash-retry recovery); SDD admission refuses never-registered development plans on a register-governed root (`sdd.context.plan-not-registered`, fail-closed on an unreadable register) while iteration rows and verification-kind workflows keep today's behavior; the phase-6 close gate consults registered delivery-kind evidence for terminal plan snapshots with three stable refusal codes. Audit promotion, iteration creation and coordinator bind are unchanged.

<!-- CN -->
- 新增**计划级 workflow 生命周期接缝**（冻结契约 `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`）：`mstar workflow register` 在单锁内 create-only 创建 `type: plan` snapshot + 根条目（复用 audit-promotion 原语、精确版本回滚、崩溃重试恢复）；SDD 准入对 register 治理根上的未注册开发 plan 拒绝（`sdd.context.plan-not-registered`，register 不可读时 fail-closed），iteration 行与 verification 类 workflow 行为不变；phase-6 关闭 gate 对终态 plan snapshot 校验已登记的交付类型证据（三个稳定拒绝码）。audit promotion、iteration 创建与 coordinator bind 不变。
