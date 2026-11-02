---
category: Harness
packages: cli,commands
---

- **Refusals name the owning skill.** Every refusal envelope whose command has a documented owner now carries `details.skill` (for example `skill: mstar-artifacts` on `plan show`), and a default-generated recovery appends one `Owning skill: <name>.` sentence; a caller-supplied `recovery` is preserved verbatim.
- **CLI help points at the owning skill.** `mstar <family> <verb> --help` ends with a `Skill: <name>` line when the command has an owner (CLI route only — MCP tool descriptions are unchanged), and top-level `mstar-harness --help` tells agents to read `mstar-use-cli` first and get exact contracts via `mstar schema --command <id>`.
- **One source of truth for command→skill.** The prose table in `mstar-use-cli` drops its `Owning skill` column; the mapping is derived from the command definitions. No command surface, flag or `--skill` verb was added.

<!-- CN -->
- **拒绝信封标注所属 skill。** 凡有归属文档的命令，其拒绝信封现在携带 `details.skill`（如 `plan show` 的 `skill: mstar-artifacts`）；默认生成的 recovery 追加一句 `Owning skill: <name>.`，调用方自带的 `recovery` 保持逐字不变。
- **CLI 帮助指向所属 skill。** `mstar <family> <verb> --help` 在命令有归属时以 `Skill: <name>` 行结尾（仅 CLI 路由，MCP 工具描述不变）；顶层 `mstar-harness --help` 提示先读 `mstar-use-cli`，并用 `mstar schema --command <id>` 获取精确契约。
- **command→skill 只有一份权威。** `mstar-use-cli` 的任务表删除 `Owning skill` 列，该映射由命令定义推导。未新增任何命令表面、标志或 `--skill` 动词。
