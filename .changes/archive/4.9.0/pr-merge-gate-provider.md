---
category: Added
packages: commands
---

- **`mstar pr merge-gate` routes through a named provider adapter:** the new `--provider <id>` option (default `github`) selects the registered forge adapter that resolves the PR and enumerates its review threads; an unregistered id refuses with the registered ids, and a forge no adapter serves follows the documented project-tooling path in `pr-delivery.md` or STOPs.

<!-- CN -->
- **`mstar pr merge-gate` 经由具名 provider 适配器执行**：新增 `--provider <id>` 选项（默认 `github`）选择注册的 forge 适配器来解析 PR 并枚举 review thread；未注册的 id 直接拒绝并列出已注册 id，无适配器服务的 forge 按 `pr-delivery.md` 中的项目工具路径处理，否则 STOP。
