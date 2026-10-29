---
category: Harness
packages: dsh
---

- **Leaf-signal disclosure (#619):** the panel snapshot now carries `leafSignal` — `{ active, reason?, recovery? }` — and the host writes one `mstar-leaf-signal` warning the first time the `shellEnv` service is found absent. A dsh composition without `@deepseek-ai/dsh-shell-env` never injects `DSH_MSTAR_LEAF_SEAT`, so a leaf-launched CLI silently loses the engine's `coordination.leaf-seat` refusal; that silent degradation is now stated with its recovery (add `@deepseek-ai/dsh-shell-env` to the composition). The probe is per panel read, never cached, so a service that loads later flips the field to `active` without a restart. Nothing here hard-fails and the plugin still loads without the service.
- **Scope boundary (do not widen):** the field and the warning report the missing `shellEnv` service ONLY. They say nothing about the environment channel's other, separately declared limit — a leaf that strips the marker itself (`env -u`, `sudo`'s `env_reset`) remains indistinguishable, and no part of this change detects or fixes that. Carrying the variable is a precondition of attesting it, not something this disclosure establishes.

<!-- CN -->
- **Leaf 信号披露（#619）：** 面板快照新增 `leafSignal` 字段——`{ active, reason?, recovery? }`；当发现 `shellEnv` 服务缺失时，宿主首次写出一条 `mstar-leaf-signal` 警告。缺少 `@deepseek-ai/dsh-shell-env` 的 dsh 组合永远不会注入 `DSH_MSTAR_LEAF_SEAT`，于是 leaf 启动的 CLI 会静默失去引擎的 `coordination.leaf-seat` 拒绝；这一静默降级现在被明确披露并给出恢复路径（在组合中加入 `@deepseek-ai/dsh-shell-env`）。探测在每次面板读取时进行、从不缓存，因此后加载的服务无需重启即可让字段变为 `active`。此处不做任何硬失败，缺服务时插件照常加载。
- **范围边界（不得扩大）：** 该字段与警告只报告 `shellEnv` 服务缺失这一件事，与环境通道另一条单独声明的限制无关——leaf 自行剥离该标记（`env -u`、`sudo` 的 `env_reset`）仍不可区分，本次改动既不检测也不修复该情形。携带该变量是声明该事实的前提，而不是本披露所建立的能力。
