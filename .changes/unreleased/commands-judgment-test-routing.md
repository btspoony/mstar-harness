---
category: Harness
packages: root, commands
---

- Added **CI test routes for the `commands` and `judgment` packages**: both package manifests now declare `test: "bun test"`, and CI runs each surface as an independent `test-commands` / `test-judgment` job alongside the existing per-package jobs.

<!-- CN -->
- 新增 **`commands` 与 `judgment` 包的 CI 测试路由**：两个包清单现在声明 `test: "bun test"`，CI 以独立的 `test-commands` / `test-judgment` 任务运行这两个测试面，与现有按包任务并列。
