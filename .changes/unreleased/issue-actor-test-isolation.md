---
category: Harness
packages: root, cli
---

- **Isolated actor-only CLI regressions:** check close, triage, supersede, and link in separate active-store fixtures so independent subprocess workflows do not consume a single test's timeout. Preserve all state assertions and default time limits; CLI behavior is unchanged.

<!-- CN -->
- **隔离 actor-only CLI 回归：** 将 close、triage、supersede 和 link 分别放入独立的 active-store 夹具，避免多条独立子进程工作流共用一个测试的超时预算；保留全部状态断言及默认超时，不改变 CLI 行为。
