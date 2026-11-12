---
category: Harness
packages: root
---

- **Judgment artifacts refuse by name, at the read as well as the resolve**: `evaluate.ts` and `shadow.ts` now translate the supported filesystem failures (`ENOENT`, `EACCES`, `ENOTDIR`, `EISDIR`, `EPERM`) around the actual artifact read, so a file that resolves but cannot be opened reports `jev.artifact-missing: <relative path>` instead of a raw error carrying the canonical absolute path. JSON parsing stays outside that translation, so an unparsable artifact is still reported as a parse error rather than as missing.
- **The browser opener waits under a bound**: `openBrowserBounded` resolves once the platform opener starts and refuses with `capability.browser.unavailable` when it is absent or does not start within 5 s, and with `command.cancelled` on abort, instead of pending forever.
- **The UI comparators fail closed on an empty comparison**: `declaration-diff`, `selector-diff` and `tone-table` exit 1 with a diagnostic when the prototype yields nothing to compare, rather than printing "0 compared, all fine". `selector-diff` counts the prototype key set after the allowlist filter, so a fully allowlisted yield is also a failure. The mutation check treats a missing prototype baseline as "the check cannot run", not as a detected mutation, and adds an emptied-comparison case.
- **The purity guard accepts every legal type-only engine import** (both quote styles, multi-line, default, namespace, default-plus-named) and reports the offending source line by masking type-only imports without shifting newlines.

<!-- CN -->
- **Judgment 工件按名拒绝，读取阶段与解析阶段一致**：`evaluate.ts` 与 `shadow.ts` 现在把受支持的文件系统失败（`ENOENT`、`EACCES`、`ENOTDIR`、`EISDIR`、`EPERM`）包在实际读取外层，因此「能解析但打不开」的文件报 `jev.artifact-missing: <相对路径>`，而不再抛出携带绝对规范路径的原始错误。JSON 解析仍在该转换之外，无法解析的工件仍报解析错误而不是「缺失」。
- **浏览器打开器在界限内等待**：`openBrowserBounded` 在平台打开器启动后即返回；打开器缺失或 5 秒内未启动时以 `capability.browser.unavailable` 拒绝，中止时以 `command.cancelled` 拒绝，不再永久挂起。
- **UI 比较器在空比较上失败关闭**：`declaration-diff`、`selector-diff`、`tone-table` 在原型没有可比内容时以退出码 1 加诊断信息失败，而不是打印「0 个比较，全部一致」。`selector-diff` 在 allowlist 过滤后统计原型键集合，因此「全部被 allowlist 吸收」同样失败。mutation check 把原型基线缺失判为「检查无法运行」而非「检出变异」，并新增空比较用例。
- **纯度守卫接受每一种合法的 type-only 引擎导入**（两种引号、多行、default、namespace、default 加具名），并通过不移动换行的掩码方式报告违规的源码行号。
