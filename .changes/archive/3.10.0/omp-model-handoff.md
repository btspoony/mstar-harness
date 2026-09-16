---
category: Changed
packages: root, omp
---

- Added the opt-in **coordinator model handoff** to `@mstar-harness/omp`: a new extension entry (`extensions/model-handoff.js`, published through manifest `omp.extensions`, engine inlined, its single host import resolved by the running host) plus native plugin settings `modelHandoff` (off by default) and `handoffTarget` (`@default` \| `@smol`). A **new** Morning Star iteration start in the bound coordinator session arms `@slow` before substantive Prepare, and a complete Phase 1 — specialist returns, locked Prepare, distinct matching integration checkout, verified required push — switches that one session to the saved target once. Ordinary chat, leaf and plan-scoped sessions stay inert; no role mapping, goal objective or workflow state is written, and a manual model change while the switch waits cancels it for that session only.
- Pinned the package's OMP host contract: optional peer and development dependency `@oh-my-pi/pi-coding-agent@18.2.1`, Bun floor `>=1.3.14`, and a `bundle-smoke` case that unpacks the published tarball and drives it through the host's own plugin discovery, extension loader and custom-tool loader in a disposable host root with no engine package installed. It replaces the previous source-text bundle assertions (emitted symbol, no bare engine import) with that runtime behaviour.
- Documented the native `/settings` → Plugins path, persistence and its user-scope limitation (a project-only install has no native settings row), supported entries and modes, coordinator binding, full-Phase-1 readiness, cancellation, replay and failure semantics in the OMP host reference and the package README.

<!-- CN -->
- 为 `@mstar-harness/omp` 新增可选启用的 **coordinator 模型交接**：新的扩展入口（`extensions/model-handoff.js`，经 manifest `omp.extensions` 发布，engine 内联，唯一宿主 import 由运行中的宿主解析），以及原生插件设置 `modelHandoff`（默认关闭）与 `handoffTarget`（`@default` \| `@smol`）。被绑定的 coordinator 会话在**新**迭代开始时先切到 `@slow` 再做实质性 Prepare；Phase 1 完整完成后（专家回执齐备、Prepare 已冻结、独立且分支匹配的 integration checkout、必需推送已验证）仅该会话切换一次到已保存的目标角色。普通对话、leaf 会话与 plan-scoped 会话保持无动作；不写角色映射、goal 目标或 workflow 状态；等待期间的手动模型变更只取消该会话本次交接。
- 固定本包的 OMP 宿主契约：可选 peer 与开发依赖 `@oh-my-pi/pi-coding-agent@18.2.1`、Bun 下限 `>=1.3.14`，并新增 `bundle-smoke` 用例——解包已发布 tarball，在未安装 engine 包的可支配宿主根中经由宿主自身的插件发现、扩展加载器与自定义工具加载器驱动它。它取代了此前基于源码文本的 bundle 断言（符号存在、无裸 engine import）。
- 在 OMP 宿主参考与包 README 中记录原生 `/settings` → Plugins 路径、持久化及其 user-scope 限制（project-only 安装没有原生设置行）、支持的入口与模式、coordinator 绑定、完整 Phase 1 就绪条件、取消、重放与失败语义。
