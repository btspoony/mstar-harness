---
category: Harness
packages: root
---

- **dsh plugin**: the web client module manifest moved from the top-level `dshClient` field to the nested `dsh.client` (`platform: 'web'` + declared inject faces), matching upstream `client-modules` discovery (`dsh.client` + `exports["./client"]`). The legacy top-level key is removed — upstream has no compatibility fallback, so the old field silently un-discovered the client half and dropped the workflow panel from the web boot manifest (`window.__DSH_BOOT__.entries`). A manifest-contract regression test now freezes the new contract and fails first if upstream renames the field again.

<!-- CN -->
- **dsh 插件**：web 客户端模块清单从顶层 `dshClient` 字段迁移到嵌套 `dsh.client`（`platform: 'web'` + 声明的 inject 面），对齐上游 `client-modules` 发现逻辑（`dsh.client` + `exports["./client"]`）。旧顶层键已移除——上游无兼容回退，旧字段会静默导致客户端半体不被发现，使 "MStar 工作流" 面板从 web boot manifest（`window.__DSH_BOOT__.entries`）中消失。新增 manifest 契约防回归测试冻结新契约，上游若再次改名会先行报警。
