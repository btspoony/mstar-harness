---
packages: engine, cli
---

- Added a **provenance-citation finder** to the engine: `findProvenanceCitations` reports dated plan/iteration id tokens and dated local-harness deeplinks in tracked text. Example slugs, version tokens, placeholder shapes, plain dates and undated layout lines are never reported, and sdd deeplinks stay owned by the existing ephemeral-citation check.
- Exposed the scan on the CLI as `mstar lint --type provenance <target>`: an explicit-only content type (inference never selects it) that applies the finder to the target file or every file collected from a directory walk, with unchanged exit semantics (1 = citations found, 2 = usage). `docs/cli.md` registers the new `--type` value.

<!-- CN -->
- 引擎新增**溯源引用发现器**：`findProvenanceCitations` 报告文本中带日期的 plan/迭代 ID token 与含日期实例段的本地 harness 深链。示例 slug、版本号、占位形态、纯日期与无日期布局行零误报；sdd 深链仍归既有 ephemeral 引用检查独占。
- CLI 以 `mstar lint --type provenance <target>` 开放该扫描：显式内容类型（推断永不选中），对目标文件或目录收集到的每个文件运行发现器；退出码语义不变（1 = 存在引用，2 = 用法错误）。`docs/cli.md` 已登记新 `--type` 取值。
