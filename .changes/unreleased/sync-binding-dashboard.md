---
category: Harness
packages: root
---

- **Stored project correspondence on the read.** `SyncBindingDTO` gains `projectBindings` — the `project_id` → `remote_project` rows from `project_bindings`, read-only and ordered by project id; a missing or unopenable store answers `[]` instead of failing the view. The binding view model turns the payload into three display records (identity, correspondence, readiness): a readiness state that arrives without a cause is refused rather than rendered, `not-probed` keeps its own cause so an unasked question stays distinct from a missing `[linear]` declaration, and no record carries a credential field.
- **Sync-binding screen.** The design system's `sync-binding` panel is now a product screen: `SyncBinding` renders the `.mstarc [linear]` identity, one correspondence row per stored binding (with an explicit empty state when the store holds none), and the probe's readiness state paired with the cause the read supplied. A null binding renders the reader's refusal (`bindingError`) verbatim in the identity block's place, in every readiness state's own tone. No issue row, no failure counter and no token reaches the panel. Exported from `@mstar-harness/ui`, with both locales complete.

<!-- CN -->
- **读取携带已存储的项目对应关系。** `SyncBindingDTO` 新增 `projectBindings` —— 来自 `project_bindings` 的 `project_id` → `remote_project` 行，只读、按项目 id 排序；store 缺失或无法打开时返回 `[]`，而不是让视图失败。绑定视图模型把该载荷转换为三条展示记录（身份、对应关系、就绪状态）：缺少原因的就绪状态会被拒绝而非渲染；`not-probed` 保留自己的原因，使“尚未提问”与“未声明 `[linear]`”始终是两个答案；任何记录都不携带凭据字段。
- **同步绑定界面。** 设计系统的 `sync-binding` 面板现在成为产品界面：`SyncBinding` 渲染 `.mstarc [linear]` 身份、每条已存储绑定对应一行（store 中没有绑定行时显示明确的空状态），以及探测器给出的就绪状态与其读取时携带的原因。绑定为 null 时，面板在身份字段的位置原样显示读取方的拒绝信息（`bindingError`），并沿用各就绪状态自己的色调。问题行、失败计数与令牌都不会出现在该面板。界面从 `@mstar-harness/ui` 导出，两种语言的文案均已齐备。
