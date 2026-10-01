---
category: Changed
packages: commands, cli
---

- **Bounded command contract discovery.** `mstar schema` now resolves one bounded selector: an exact command id returns the full leaf contract (description, effects, CLI syntax, caller/derived requirement ownership, input and payload JSON schemas), `--family <name>` returns a compact id+description list, and the issue-payload query keeps its published shape. The exactly-one-selector choice is expressed in the published input schema itself (an `anyOf` of strict per-selector objects), so `{}` or colliding selectors are refused at the input boundary with the grouped valid-selector guidance; CLI leaf help and MCP tool descriptions render the same descriptor table.
- **Typed `worktree check --tracks` payload.** The L2 `--tracks` option is a published typed array (`array of {worktreePath, workingBranch}`): the input schema, the runtime boundary validation, the CLI JSON decoding, and the discovery descriptor all share one schema, so the published contract no longer advertises a JSON-string form. Refusals carry indexed `tracks[N].<field>` paths before the gate runs, and the family keeps no JSON parser of its own. Payload options keep the generic list decoding (a lone `--worktree` path or comma-separated values still decode as a one-element list), but a JSON object passed to a payload option is refused by the declared schema instead of being wrapped into a one-element array. All L1/L2 domain checks are unchanged.

<!-- CN -->
- **有界命令契约发现。** `mstar schema` 现在解析一个有界选择器：精确命令 id 返回完整叶子契约（描述、副作用、CLI 语法、调用方/派生需求归属、输入与载荷 JSON schema），`--family <name>` 返回紧凑的 id+描述列表，issue 载荷查询保持既有输出形态。「恰好一个选择器」的约束直接表达在发布的输入 schema 中（每个选择器一个 strict 分支的 `anyOf`），`{}` 或冲突选择器会在输入边界以分组后的合法选择器引导被拒绝；CLI 叶子帮助与 MCP 工具描述渲染同一张描述符表。
- **`worktree check --tracks` 载荷类型化。** L2 的 `--tracks` 选项是已发布的类型化数组（`{worktreePath, workingBranch}` 数组）：输入 schema、运行时边界校验、CLI JSON 解码与发现描述符共享同一份 schema，发布契约不再宣称 JSON 字符串形态。拒绝消息在门禁执行前携带带索引的 `tracks[N].<字段>` 路径，家族代码不再自带 JSON 解析器。payload 选项保留通用列表解码（单个 `--worktree` 路径或逗号分隔值仍解码为单元素列表），但传给 payload 选项的 JSON 对象会按声明 schema 被拒绝，而不是被包裹成单元素数组。全部 L1/L2 领域检查保持不变。
