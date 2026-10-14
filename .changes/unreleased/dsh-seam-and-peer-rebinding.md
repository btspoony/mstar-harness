---
category: Harness
packages: dsh
---

- Removed the `MSTAR_STORE_TEST_RUNNER` environment gate from the workflow-ledger test drain; tests now invoke the explicit drain without production behavior being selectable through the process environment.
- Rebound background job settlement to the pinned `@deepseek-ai/dsh-jobs` `JobRegistry.events.subscribe` lifecycle API. Terminal `settled` events carry the job projection used to pair background dispatches; the obsolete `onJobDone` call was removed.

<!-- CN -->
- 移除了 workflow-ledger 测试 drain 上的 `MSTAR_STORE_TEST_RUNNER` 环境变量门控；测试显式调用 drain，生产行为不再能由进程环境选择。
- 后台作业结算改为使用固定版本 `@deepseek-ai/dsh-jobs` 的 `JobRegistry.events.subscribe` 生命周期 API。终态 `settled` 事件携带用于关联后台派发的作业投影；已移除过时的 `onJobDone` 调用。
