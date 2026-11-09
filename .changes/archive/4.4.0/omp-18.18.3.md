---
category: Harness
packages: root, omp
---

- **omp host baseline `18.16.0` → `18.18.3`** in the root and `@mstar-harness/omp` devDependencies. The optional peer stays `^18.3.0` (any 18.x host), so no consumer constraint moves; `bun.lock` re-resolves the `@oh-my-pi/*` stack to `18.18.3` and drops the provider dependencies that line no longer carries.
- No adapter change was required: the plugin consumes the extension/plugin loader, session manager, event bus, MCP tool bridge and legacy pi-ai shim surfaces, none of which changed shape across `18.16.0` → `18.18.3` (the line's breaking entries are the `ask` tool form, `logoutCredential`, `SessionStorage.hasAssistantTurn` and the Rust SDK types).

<!-- CN -->
- **omp 宿主基线 `18.16.0` → `18.18.3`**（根与 `@mstar-harness/omp` 开发依赖）。可选 peer 保持 `^18.3.0`（任意 18.x 宿主），消费者约束不变；`bun.lock` 将 `@oh-my-pi/*` 栈重新解析到 `18.18.3`，并移除该版本线不再携带的 provider 依赖。
- 无需适配层改动：插件消费的是扩展/插件加载器、session manager、event bus、MCP 工具桥与 legacy pi-ai shim 面，这些在 `18.16.0` → `18.18.3` 之间未变形（该版本线的破坏性条目是 `ask` 工具形态、`logoutCredential`、`SessionStorage.hasAssistantTurn` 与 Rust SDK 类型）。
