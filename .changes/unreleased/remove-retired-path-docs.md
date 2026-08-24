---
packages: root, opencode
---

- **Docs describe current state only**: removed truly retired-path prose from runtime skills — `{PLAN_DIR}/reports/` (legacy report location; no code or migration path references it) and the retired `{HARNESS_DIR}/notes.json` (no code creates or reads it; runtime notes live in `workflows/<id>/notes.jsonl`). Compat behaviors verified against shipped code and kept: `designs/` read-only `{SPECS_DIR}` fallback (`resolveSpecsDir`), legacy flat delivery-compass read/migrate directives, `.agents/` discovery chain, and all v1→v2 migration guards.

<!-- CN -->
- **文档只描述现状**：从运行时 skills 中移除真正已废弃路径的描述 —— `{PLAN_DIR}/reports/`（旧报告目录；无代码引用、无迁移指令）与已停产的 `{HARNESS_DIR}/notes.json`（无代码创建或读取；运行时 notes 走 `workflows/<id>/notes.jsonl`）。经出厂代码核实的兼容行为全部保留：`designs/` 只读 `{SPECS_DIR}` 回退（`resolveSpecsDir`）、legacy 扁平 delivery-compass 的读兼容/迁移指令、`.agents/` 发现链，以及全部 v1→v2 迁移护栏。
