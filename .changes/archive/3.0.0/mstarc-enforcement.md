---
category: Harness
packages: root, cli, dsh, engine, opencode
---
- `.mstarc` `[config] enforcement=hard|soft` declares the repo hard-gate policy (invalid values ignored). Precedence: explicit Config > Assignment `Enforcement: hard` header flag (dispatch only) > `.mstarc` > iteration compass > warn-only — `.mstarc` `soft` is a local rollback against a hard compass, `hard` hardens flag-less dispatches and gates. New engine `resolveMstarcEnforcement` / `resolveRepoEnforcement`; dsh gates, opencode hook and omp hook now compose the repo policy.

<!-- CN -->
- `.mstarc` `[config] enforcement=hard|soft` 声明仓库级硬门禁策略（非法值忽略）。优先级：显式 Config > Assignment `Enforcement: hard` 头标记（仅派发）> `.mstarc` > 迭代 compass > 默认 warn-only——`.mstarc` `soft` 可回滚 hard compass，`hard` 硬化无标记的派发与各闸门。新增 engine `resolveMstarcEnforcement` / `resolveRepoEnforcement`；dsh 各闸门、opencode hook 与 omp hook 现均组合仓库策略。
