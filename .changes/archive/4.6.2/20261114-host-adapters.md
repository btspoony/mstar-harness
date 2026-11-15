---
category: Changed
packages: opencode, opencode-v2, dsh
---

- **The plugin-level below-floor runtime refusal is covered again.** A test installs the engine stub before importing the plugin, proves no store read happens, and restores the real exports afterwards so the replacement cannot leak into later files of the same process.
- **The frontmatter parity test asserts a parsed value.** The real-asset half compares a loaded `description` against an independent parse of the same file, for one agent and one command, instead of checking that keys exist.
- **The engine-status first render is a stated contract.** A workspace key that is not yet memoized answers with the version-only summary while the store-backed read warms in the background; a spec pins that first render and the second one after the refresh.

<!-- CN -->
- **插件层 below-floor 运行时拒绝恢复测试覆盖。** 新用例在 import 插件前注入 engine stub，证明未读取 store，并在结束后恢复真实导出，避免替换泄漏到同进程后续文件。
- **frontmatter 对齐测试断言解析值。** 真实资产部分把加载到的 `description` 与同文件独立解析结果比较（agent 与 command 各一），不再只检查键是否存在。
- **engine-status 首帧成为明示契约。** 尚未 memo 的工作区键先返回仅版本摘要，同时在后台预热 store 读取；新 spec 固定首帧与刷新后的第二帧。
