---
category: Harness
packages: root, cli, engine, commands
---

- **Deleted `mstar sdd evidence capture|verify`.** No gate consumed the retained bundle: the record schema, input digests, tool fingerprints and reuse assessment are gone, together with the CLI capture runner and its MCP effects.
- Retaining a check's output is now a plain redirect to a file under `{SDD_DIR}/evidence/` with the path cited in the report; reviewers read the raw log and never re-run the command.
- The remaining `mstar sdd` verbs (`workspace`, `task-brief`, `review-package`, `check-context`) are unchanged.

<!-- CN -->
- **删除 `mstar sdd evidence capture|verify`。** 没有任何门禁读取所保留的证据包：记录 schema、输入摘要、工具指纹与复用评估一并移除，CLI capture 运行器及其 MCP effects 同样删除。
- 保留一次检查的输出现在就是重定向到 `{SDD_DIR}/evidence/` 下的日志文件，并在报告中引用该路径；评审者读取原始日志，绝不重跑命令。
- 其余 `mstar sdd` 动词（`workspace`、`task-brief`、`review-package`、`check-context`）保持不变。
