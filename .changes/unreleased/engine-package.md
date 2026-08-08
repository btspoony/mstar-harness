---
packages: root, engine, cli, opencode
---

- Added the **`@mstar-harness/engine`** package scaffold: a version-aligned workspace library (`zod` + `ajv`, `node:*` only, no `bin`) with a typed `ValidationResult` + `readHarnessVersion()` placeholder core, wired into the release surface list (10 → 11), changelog assembly, and root workspaces.

<!-- CN -->
- 新增 **`@mstar-harness/engine`** 包脚手架：版本对齐的工作区库（仅 `zod` + `ajv` + `node:*`，无 `bin`），提供类型化 `ValidationResult` 与 `readHarnessVersion()` 占位 core，并纳入发布面清单（10 → 11）、changelog 组装与根 workspaces。
