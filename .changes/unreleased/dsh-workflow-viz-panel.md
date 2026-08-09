---
packages: root
---

- **dsh plugin**: the `@mstar-harness/dsh` package now ships a **web client plugin** (workflow panel) on the same `mstar` bundle row — `dshClient` + `exports["./client"]` discover the client half automatically (no separate profile layer or install step). The plugin registers a `conversation.view` view-ring tab (`id: 'mstar-workflow'`, `order: 20`) rendering the latest `mstar-engine-status` catalog row as a structured panel: watermark (version / harness dir / enforcement), iteration phase-gate section (transition, all-plans-done, gate verdict + violations, status/compass anchors), workspace-state section (plan board, residuals, branch/policy anchors, leases, knowledge, direction) and a freshness marker; refresh follows the session snapshot (no polling). Bundle ships as a closure-factory CJS artifact (`dist/client.js`) served at `/plugins/@mstar-harness/dsh/client.js`; local install into the `web` profile is verified.
- **dsh plugin**: **Known limitations** — the panel is a structured segmented presentation this iteration; the graphical workflow canvas (react-flow DAG) is the NEXT iteration scope (compass Roadmap Position). No react-flow dependency or panel render-shape change lands here.

<!-- CN -->
- **dsh 插件**：`@mstar-harness/dsh` 包现随附 **web 客户端插件**（工作流面板），与服务器半体共享同一 `mstar` bundle 行——`dshClient` + `exports["./client"]` 使客户端半体被自动发现（无需独立 profile 层或安装步骤）。插件在 `conversation.view` view ring 注册一个 tab（`id: 'mstar-workflow'`、`order: 20`），以结构化面板渲染最新 `mstar-engine-status` catalog 行：水印（版本 / harness 目录 / enforcement）、迭代相位段（transition、all-plans-done、gate 判定 + 违规、status/compass 锚点）、工作区状态段（plan 看板、residual、分支/策略锚点、租约、知识、方向）与新鲜度标记；刷新跟随会话快照（不轮询）。bundle 以 closure-factory CJS 产物（`dist/client.js`）在 `/plugins/@mstar-harness/dsh/client.js` 提供；已验证本地安装进 `web` profile。
- **dsh 插件**：**Known limitations**——本迭代面板为结构化分段呈现；图形化流程画（react-flow DAG）为**下迭代**范围（compass Roadmap Position）。本迭代不引入 react-flow 依赖、不改面板渲染形态。
