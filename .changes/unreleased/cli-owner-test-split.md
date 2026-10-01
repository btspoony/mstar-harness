---
category: Changed
packages: root, cli
---

- Organized **CLI subprocess tests by command owner**, retiring the historical `slice4-cli.test.ts` container while retaining all groups, parameter rows, assertions, and fixture content. Moved groups share the CLI spawn harness and package-local assertion/content support; existing skill, lease, and worktree coverage remains alongside its distinct sibling groups.

<!-- CN -->
- 按**命令属主组织 CLI 子进程测试**，退役历史 `slice4-cli.test.ts` 容器，同时保留全部分组、参数行、断言和夹具内容。迁入分组复用 CLI spawn harness 与包内断言/内容支持模块；既有 skill、lease、worktree 覆盖与各自独立的 sibling 分组并存。
