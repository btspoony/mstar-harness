---
category: Harness
packages: root
---

- Added nine **architecture decision records** under `docs/adr/implemented/` for decisions that outlived their working specifications: standalone versus iteration completion routes, one-definition CLI/MCP parity, recovery-first intent resolution, bounded review seats, the complete unpaged dashboard project list, Markdown roadmap authority, the single static store upgrade, PR review score bands, and the one-way marker-identified Linear push.
- Grouped them by fate and domain (`architecture/`, `feature/`, `process/`) and kept each record to the contract's live `Problem` / `Decision` / `Alternatives considered` / `Consequences` shape; implementation-era plan text and local process identifiers are not carried over.

<!-- CN -->
- 在 `docs/adr/implemented/` 新增 **九条架构决策记录**，覆盖那些已超出其工作规格生命周期的决策：standalone 与 iteration 完成路由的区分、单一命令定义生成 CLI/MCP、recovery-first 意图解析、有界评审席位、完整的无分页 dashboard 项目列表、Markdown roadmap 权威、单一静态 store 升级、PR review 分数带，以及基于 marker 的单向 Linear push。
- 按 fate 与领域（`architecture/`、`feature/`、`process/`）归类，每条记录只保留契约要求的现行 `Problem` / `Decision` / `Alternatives considered` / `Consequences` 结构；不搬运实现期的计划正文与本地过程标识。
