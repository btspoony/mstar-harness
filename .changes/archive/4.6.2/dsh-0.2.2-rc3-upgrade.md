---
packages: dsh
---

- Raised the `@deepseek-ai/dsh-*` corridor from `^0.2.2-rc.1` to `^0.2.2-rc.3` (63 `peerDependencies` entries plus six dev-only helper packages; the `@deepseek-ai/cordis ~4.1.0` peer still holds).
- Adapted the native role-preset channel to the flattened activation spec: since `0.2.2-rc.3` `SubagentActivationSpec` extends the start request instead of nesting it, so the channel merges `agentPreset` into the spec itself and forwards it by identity; the compile-time surface gate in `role-persona.spec.ts` now holds again.
- Migrated the activation-spec fixtures (`role-persona`, `role-gate`, `fork-gate`, `hmr-safety`, `persona-seam-probe`, `install-doctor-e2e`) and the fake `subagents` service to the same shape.
- The install-surface doctor e2e arms its preset-selection assertion only against an installed artifact built for this source tree's dsh corridor, so a published plugin one corridor behind no longer fails the source-level contract.
- Followed the upstream Team package renames (`dsh-agent-team` / `dsh-tool-agent-team`, the removed `dsh-experimental-agent-team-profile` overlay) in the host reference docs, and recorded that `interrupt_agent` ships OFF in every factory profile since `0.2.2-rc.3` (`tool-subagent-control.interrupt: false`).

<!-- CN -->
- 将 `@deepseek-ai/dsh-*` 走廊从 `^0.2.2-rc.1` 提升到 `^0.2.2-rc.3`（63 个 `peerDependencies` 条目加六个仅开发依赖的辅助包；`@deepseek-ai/cordis ~4.1.0` peer 不变）。
- 适配原生 role-preset 通道的扁平化激活 spec：`0.2.2-rc.3` 的 `SubagentActivationSpec` 改为继承 start request 而非嵌套，通道因此把 `agentPreset` 合并进 spec 本身并按 identity 转发；`role-persona.spec.ts` 的编译期表面门禁恢复通过。
- 六个 spec（`role-persona`、`role-gate`、`fork-gate`、`hmr-safety`、`persona-seam-probe`、`install-doctor-e2e`）的激活 spec fixture 与 fake `subagents` 服务同步迁移到同一形状。
- 安装面 doctor e2e 的 preset 选择断言只对“与本源码树同一 dsh 走廊”的已安装产物生效，落后一个走廊的已发布插件不再让源码级契约变红。
- host 参考文档跟进上游 Team 包改名（`dsh-agent-team` / `dsh-tool-agent-team`，以及被删除的 `dsh-experimental-agent-team-profile` overlay），并记录 `0.2.2-rc.3` 起所有出厂 profile 默认关闭 `interrupt_agent`（`tool-subagent-control.interrupt: false`）。
