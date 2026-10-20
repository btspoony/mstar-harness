---
category: Changed
packages: cli
---

- **The MCP server publishes one tool per command family instead of one per command.** `tools/list` was the largest fixed cost of every agent session: 113 tools and ~190k characters of input schemas and descriptions, 66% of that description text being a `CLI: mstar … --flags` usage line a tool caller cannot run. Each family now publishes one `mstar_<family>` tool with a required `action` selecting a real command, a merged field set derived from the command descriptors, and a compact description (purpose, one line of required fields per action, pointer to `mstar_schema`). Measured on the same probe: 113 tools → 33, published payload 327,811 → 29,908 characters (~91k → ~8k tokens).
- **Admission is unchanged.** Every call still resolves to its command's own descriptor and composed schema, so validation strictness, aggregated refusals, `defaultSessionId`/`defaultHarness` handling and the identity lock behave exactly as before; an unknown `action` refuses with the family's real action list plus the recovery. `mstar_schema` remains the field-detail authority, and `renderCommandContract` no longer spends MCP description budget on CLI usage syntax.

<!-- CN -->
- **MCP 服务器改为每个命令家族发布一个工具。** `tools/list` 是每个 agent 会话最大的固定成本：113 个工具、约 19 万字符的输入 schema 与描述，其中 66% 的描述文本是工具调用方无法执行的 `CLI: mstar … --flags` 用法行。现在每个家族只发布一个 `mstar_<family>` 工具，必填 `action` 选择真实命令，字段集由命令描述符合并推导，描述保持紧凑（家族用途、每个 action 一行的必填字段、指向 `mstar_schema` 的指引）。同一探针实测：113 → 33 个工具，发布负载 327,811 → 29,908 字符（约 91k → 8k token）。
- **准入语义不变。** 每次调用仍解析到该命令自身的描述符与组合 schema，校验严格度、聚合拒绝、`defaultSessionId`/`defaultHarness` 处理与身份锁与之前完全一致；未知 `action` 会带家族真实 action 列表与恢复路径拒绝。`mstar_schema` 仍是字段细节权威，`renderCommandContract` 不再把 CLI 用法语法计入 MCP 描述预算。
