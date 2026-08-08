# @mstar-harness/dsh

[English](README.md) | 中文

面向 DeepSeek Harness SDK（dsh）的 Morning Star 守护闸门（harness gates）——一个 cordis 函数插件，将 mstar engine 进程内挂载，并在 `Enforcement: hard` 开启时拒绝非法的 `{HARNESS_DIR}/status.json` 写入与被禁止的 subagent 派发。随 dsh Loader 应用启动；各闸门通过 seam 的拒绝通道行使否决权，从不改动工具本身。

## Installation

本包以 workspace 包形式发布（`workspaces: ["packages/*"]`），构建时把 engine 打进 `dist/`（`bun run build`；dist 已被 gitignore）。在 dsh 应用的 `cordis.yml` 中挂载：

```yaml
- name: '@mstar-harness/dsh'
  config:
    harnessDir: .mstar
```

`cordis` 与 `@deepseek-ai/dsh-*` 各 seam 均为 peerDependencies——由组合后的 dsh 应用提供。

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `harnessDir` | `string` | 探测（`.mstar/` → `.agents/` → `plans/`） | 显式 harness 根目录；优先于 engine 探测。 |
| `enforcement` | `'hard' \| 'soft'` | compass，否则仅告警 | 按部署覆盖；`hard` 强制否决，`soft` 回滚 compass/Assignment 的 hard 标记。 |
| `dispatchTools` | `string[]` | `['subagent']` | 派发闸门匹配的委派工具名（dsh subagent 工具的 `toolName` 可重命名实例）。 |
| `dispatchBinding` | `string` | 未设置（跳过预检） | 派发方 agent 自身的 harness 角色；Assignment 的 `Execute as` 等于它即自我递归。 |

## Gates

### Status gate

`fs/write-intent` + `fs/edit-intent` 监听器（以 `prepend` 注册，确保先于 dsh-fs-policy 执行）对 `{HARNESS_DIR}/status.json` 的写入把关：基于当前磁盘文档运行 `validateStatus` + 按 plan 的 `findingsCleanupGate`。fs intent 槽没有 deny 形态——hard 否决即**抛出** `StatusGateError`（`code: 'STATUS_GATE_HARD_BLOCK'`），拒绝瀑布链并使工具调用失败。告警模式（默认）记录日志、发出 `mstar/status-gate` 咨询事件并通过 `next()` 委托。

### Dispatch gate

`tools/pre-execute` 监听器作用于委派工具：解析载荷中的 Assignment 文本，运行与 opencode 对齐的字段校验器（`validateAssignmentFields`、`antiRecursionPrecheck`、`assertDefaultBranchProtected`）以及 dsh 租约闸门。拒绝通道为**不调用** `next()` 而返回 `PreToolDecision { kind: 'deny', reason }`；告警模式记录日志、发出 `mstar/dispatch-gate` 并委托。非 Assignment 提示与非委派工具保持惰性。两种模式下 engine 故障都降级为放行。

### Lease gate

在 opencode 字段集之上新增：对声明 `Execution mode: sdd` 或 plan 行为 `InProgress` 的可写派发，对照 `{HARNESS_DIR}/status.json` 运行 `verifyPlanExecutionLease` 与派发上下文比对（`holder`、`worktree_path`、`working_branch`）。违规使用 dsh 侧 `lease.dispatch.*` 命名空间；只读角色完全跳过该检查。

## Service

`apply` 构造 `ctx.dshMstar`（engine 支撑：`validateStatus`、`validateResidual`、`findingsCleanupGate`、`resolveCompassEnforcement`、`resolveHarnessDir`、`readHarnessVersion`、`applyEnforcement`）。伴随入口 `@mstar-harness/dsh/invariant` 以文档化的空安装器保留包所有权。

## Development

命令（在 `packages/dsh` 下执行）：覆盖率门禁为 `src/` 逐文件 100%（dsh 测试策略）；构建命令把 src 入口 bun 打包进 `dist/`（内联 engine 与 schemastery，cordis 保持外部）并输出 tsc 声明。

```sh
bun test --coverage
bunx tsc --noEmit
bun run build
```

开发期 seam 表面（类型、事件形态）通过 `peer-stubs/` 镜像 dsh-private 提交 `9451be2`（2026-08-07 快照）；dsh-private 基线移动时需同步更新 stub。

## Model Experience

### Request surface and condition

#### What the model sees

本插件不贡献任何自身的 system-prompt 或用户消息文本。其模型可见表面仅在闸门触发时产生：状态否决以工具 `isError` 结果呈现，携带 `{ name: 'StatusGateError', code: 'STATUS_GATE_HARD_BLOCK' }` 及每条违规一行；派发否决以注册表物化的 `PreToolDecision { kind: 'deny', reason }` 错误呈现；告警模式放行产生日志行与 `mstar/status-gate` / `mstar/dispatch-gate` 咨询事件，因此每次闸门决策都能从会话日志重建。

#### Token effect

零直接 token 影响：任何请求都不增删 token；否决与咨询文本仅在闸门触发时存在。

#### KV Cache effect

独立：插件不构造 prompt 前缀，既不创建也不失效缓存状态；工具错误文本随违规变化，但从不参与请求前缀。

## Known Limitations and Deferred Work

- **开发期 peer stubs** —— `@deepseek-ai/dsh-*` 各 seam 在开发/测试期仅为类型 stub（无运行时实现），因此闸门通过真实注册表/fs 工具执行的同一 `ctx.waterfall` 派发来验证；由真实 seam 包组合的应用是部署目标，不在本包测试套件覆盖内。
- **反递归绑定为 Config 声明** —— dsh 在工具执行上下文上不暴露每 agent 角色，故 `dispatchBinding` 声明单一部署级角色；`Execute as` 不同的 Assignment 无法被识别为自我递归，多角色派发方需要按实例拆分插件。
- **租约闸门有意与 opencode 分叉** —— opencode 的 `beforeDispatch` 不运行租约检查；dsh 租约闸门是新增的（`lease.dispatch.*` 码），且仅对可写 SDD/InProgress 派发触发，故对齐覆盖字段集而非租约面。
- **engine 单一版本钉定** —— `@mstar-harness/engine` 为精确 `2.0.0` devDependency，构建时打入 `dist/`（绝非运行时依赖）；`readHarnessVersion()` 读取 bundle 旁的 dsh 包清单，按单一版本不变量保持 `2.0.0`。
- **Schemastery 空数组物化** —— 省略的可选 ARRAY Config 键会物化为 `[]`；派发键通过 `.default(undefined)` 保留省略语义，未来任何可选数组键都必须同样处理。
- **载荷边界** —— 派发闸门校验委派载荷（Assignment 文本），而非子代理的运行时行为；如需向模型可见的子活动建面，事后经 `subagent/start` 观察仍为可选项。
