---
category: Harness
packages: root
---

- Scoped the E2E evidence boundary to development plans: `mstar-harness-core` § 定向执行与验证边界, `mstar-phase-gates` § 最小证据要求, `mstar-artifacts` plan-quality-bar + `plan.main.md`, and `mstar-e2e` now agree that real-browser / device / installed-deployment E2E is never a development plan's task nor any gate's evidence obligation — it lives only in a separately requested `mstar-e2e` workflow, whose named scenario rows are that workflow's own plan rows, while each layer proves itself through its own unit/integration tests.

<!-- CN -->
- 把 E2E 证据边界限定在开发 plan 内：`mstar-harness-core` § 定向执行与验证边界、`mstar-phase-gates` § 最小证据要求、`mstar-artifacts` 的 plan-quality-bar 与 `plan.main.md`、以及 `mstar-e2e` 现口径一致——真实浏览器/真机/安装部署 E2E 永不是开发 plan 的 task，也不是任何 gate 的证据义务；它只存在于用户显式请求的独立 `mstar-e2e` workflow，其命名场景即该 workflow 自身的 plan rows，各层则以自身单测/集成测试自证。
