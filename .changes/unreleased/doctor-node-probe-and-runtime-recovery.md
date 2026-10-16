---
category: Fixed
packages: root
---

- **The doctor probes the `node` its launches resolve.** Every host MCP config launches `npx`, which runs the CLI on the `node` executable on PATH — the doctor now probes that executable's own version instead of reporting the version the doctor's own process happens to expose (a source/development run reports its runner's emulated Node version, which is not a Node install). When the probe fails, the target reports an **unverified** Node floor as a mismatch rather than aligning a launch that cannot start.
- **The `status validate` runtime recovery no longer advises a no-op retry.** It names the entrypoint's Node floor and states that a retry which does not change the executing runtime reproduces the refusal, so an operator on an unsupported runtime switches runtime instead of re-running the same command.
- Regression coverage for both: the below-floor CLI legs assert the store recovery names the invoked verb (upgrade with its options, `store init` as its own command) and that the `status validate` recovery states the unchanged-retry fact; the doctor suite asserts an unprobed launch runtime is a mismatch; the SDD evidence suite asserts the recorded tool fingerprint identifies the runtime that actually ran the capture.

<!-- CN -->
- **doctor 改为探测其启动真正会用的 `node`。** 每个宿主 MCP 配置都以 `npx` 启动，而 `npx` 用 PATH 上的 `node` 执行 CLI——doctor 现在探测该可执行文件自身的版本，而不再报告 doctor 进程碰巧暴露的版本（从源码运行时那是该运行器模拟出的 Node 版本，并非本机 Node 安装）。探测失败时，该目标以 **unverified** 的 Node 下限报为 mismatch，而不是把无法启动的配置报成 aligned。
- **`status validate` 的运行时 recovery 不再给出无效重试建议。** 它指明入口的 Node 下限，并说明"不改变执行运行时的重试会复现该拒绝"，让处于不支持运行时的操作者去换运行时，而不是重跑同一条命令。
- 两条都补了回归：低于下限的 CLI 用例断言 store recovery 指出被调用的 verb（upgrade 带其选项、`store init` 作为自身命令），且 `status validate` 的 recovery 含"未改变则复现"这一事实；doctor 套件断言未探测到的启动运行时为 mismatch；SDD 证据套件断言记录的工具指纹标明真正执行捕获的运行时。
