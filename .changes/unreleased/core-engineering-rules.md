---
category: Harness
packages: root
---
- `mstar-harness-core` now carries a "核心研发守则" (core engineering rules) section: seven global engineering invariants — no backward-compatibility layers (remove obsolete paths), simplest implementation over speculative abstraction/configuration/indirection, grow the system in layers on top of a working product, modular components with separated concerns, prefer established well-maintained libraries, lean on existing project dependencies before adding packages, and make architectural decisions for the long term (no intended-to-be-replaced stopgaps). Injected into the mandatory entry skill so every role loads them; operational detail remains in `mstar-coding-behavior`, whose Simplicity First section now links up to these invariants to keep the two layers drift-free.
- Rules provenance recorded in `ATTRIBUTION.md` (source: a post by Marcos Hernanz on X).

<!-- CN -->
- `mstar-harness-core` 新增「核心研发守则」：七条全局工程不变量 —— 不留向后兼容层（删除废弃路径）、最简实现、拒绝投机抽象/配置/间接层、分层生长（永远在可工作产品之上叠加，不用未完成的复杂度换可工作的产品）、组件模块化且关注点分离、优先成熟维护良好的库、先复用项目内依赖再考虑新包、架构决策面向长期（不接受注定被替换的权宜之计）。注入强制入口 skill，所有角色统一加载；实现级操作细节仍在 `mstar-coding-behavior`，其 Simplicity First 节已回链守则，防止两层漂移。
- 守则出处已记入 `ATTRIBUTION.md`（来源：Marcos Hernanz 的 X 帖子）。
