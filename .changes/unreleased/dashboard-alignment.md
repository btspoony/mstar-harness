---
packages: root, dsh
---

- **Focus** now renders the confirmed four panels — Active workflow with the plan board, Open residual issues, Milestones, and Latest iteration with the five-step gate — all three project panels fed by ONE shared `overview` dashboard-view read. Every session fact is kept, each panel resolves its own absence arm, a failed overview read degrades those panels only, and no lifecycle starts no polling.
- **Overview** drops the "Dated history (table alternative)" disclosure and its copy: the issue-flow chart, legend, gap note and range meta stay.
- **Project page**: the roadmap's direction moves into the header (falling back to the catalog description), the catalog-identity, roadmap-authority, stored-markdown and stored-facts blocks are removed, and the Roadmap feature gains a target-ordered milestone timeline (open / total per node, missing targets last, plus an unassigned-issues node) above the unchanged milestone board.
- **Milestone write channel** on the project page: create, edit name/target/status, assign and unassign issues, and remove an empty milestone — one engine verb per action with the observed store revision, the store's own refusal surfaced verbatim in place, and the read re-issued after either arm. A transport-ambiguous write retries with the SAME operation id, so the engine replays its receipt instead of writing twice.
- **Iterations** list and detail read the engine DTO: the lifecycle column and filter are the execution lifecycle (`active` / `completed` / `stopped`, catalog archive state stays on the detail), a new Projects column carries the iteration's project membership, plan counts come from the DTO's composed membership (no local join), and terminal iterations answer their projected execution. The attribution-based empty/absent arms and the scoped project filter are unchanged.
- `packages/ui/design-system/prototype.html`, `snapshot.json` and `DESIGN.md` follow the prototype-first order: the project-detail and iterations templates carry the confirmed baseline, and the new timeline and write controls are declared identically in the prototype and the product stylesheet.

<!-- CN -->
- **Focus** 现在渲染确认基线的四个面板——Active workflow（含计划看板）、Open residual issues、Milestones、Latest iteration（含五步闸门）；其中三个项目面板共用**一次** `overview` 仪表盘视图读取。既有会话事实全部保留，每个面板独立解析自己的空缺臂，overview 读取失败只降级这三个面板，无活动生命周期时不轮询。
- **Overview** 移除「有日期历史（表格替代）」折叠块及其文案：Issue 流走势图、图例、差异说明与区间元信息保留。
- **项目页**：路线图方向移入页头（无方向时回落到 catalog 描述）；catalog 身份、路线图权威、存储 Markdown、存储事实四个文档块移除；Roadmap 功能新增按目标日期排序的里程碑时间线（每节点含 open / total，无目标者排末尾，另加一个未归属事项节点），其下保持原里程碑板。
- **里程碑写通道**（项目页）：创建、编辑名称/目标/状态、分配与取消分配事项、移除空里程碑——每个动作对应一个引擎写命令并携带读取到的存储版本，存储自身的拒绝原文就地呈现，成功或拒绝之后都重新发起读取。传输结果不明的写会以**相同的**操作 ID 重试，由引擎回放已记录回执而非重复写入。
- **Iterations** 列表与详情读取引擎 DTO：生命周期列与筛选使用执行生命周期（`active` / `completed` / `stopped`，catalog 归档状态留在详情页），新增 Projects 列呈现迭代的项目成员关系，计划计数取自 DTO 自身组合的成员关系（不做本地 join），终态迭代也能给出其投影执行状态。基于 attribution 的空缺臂与项目范围筛选保持不变。
- `packages/ui/design-system/prototype.html`、`snapshot.json` 与 `DESIGN.md` 按「原型优先」顺序同步：项目详情与迭代模板已载入确认基线，时间线与写控件的样式声明在原型与产品样式表中逐一相同。
