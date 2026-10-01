---
category: Changed
packages: commands, cli
---

- **Bounded command contract discovery.** `mstar schema` now resolves one bounded selector: an exact command id returns the full leaf contract (description, effects, CLI syntax, caller/derived requirement ownership, input and payload JSON schemas), `--family <name>` returns a compact id+description list, and the issue-payload query keeps its published shape. Unknown or colliding selectors are refused with the grouped valid selectors instead of dumping nested schemas; CLI leaf help and MCP tool descriptions render the same descriptor table.
- **Typed `worktree check --tracks` payload.** The L2 `--tracks` option now has a published payload descriptor (`array of {worktreePath, workingBranch}`) that drives CLI JSON decoding, MCP's composed object-array field, and family pre-gate validation — the input field itself stays an opaque transport placeholder. Malformed members are refused with indexed paths before the gate runs, and the family no longer runs its own JSON parser. All L1/L2 domain checks are unchanged.

<!-- CN -->
- **有界命令契约发现。** `mstar schema` 现在解析一个有界选择器：精确命令 id 返回完整叶子契约（描述、副作用、CLI 语法、调用方/派生需求归属、输入与载荷 JSON schema），`--family <name>` 返回紧凑的 id+描述列表，issue 载荷查询保持既有输出形态。未知或冲突的选择器将以分组后的合法选择器拒绝，而不是倾倒嵌套 schema；CLI 叶子帮助与 MCP 工具描述渲染同一张描述符表。
- **`worktree check --tracks` 载荷类型化。** L2 的 `--tracks` 选项现在发布载荷描述符（`{worktreePath, workingBranch}` 数组），由它驱动 CLI JSON 解码、MCP 组合出的对象数组字段与家族的门禁前校验——输入字段本身保持为不透明的传输占位符。畸形成员在门禁执行前以带索引的路径被拒绝，家族代码不再自带 JSON 解析器。全部 L1/L2 领域检查保持不变。
