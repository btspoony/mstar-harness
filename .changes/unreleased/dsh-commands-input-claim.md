---
packages: root
---

- **dsh plugin**: mstar slash commands (`/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`) now declare an `input` hint (new frontmatter `input:` in `commands/*.md`), so the dsh web client **claims** them on menu pick instead of executing immediately: `/name ` is inserted into the composer with the command highlight, the arg hint shows as ghost text, and the line submits only on Enter — the same interaction as `/plan` / `/goal` / `/advisor`. User-typed args are appended to the steered command message as a `## User input` section; quoted frontmatter values (description/input) now register unquoted. Updated `mstar-host/references/dsh.md`.

<!-- CN -->
- **dsh 插件**：mstar 斜杠命令（`/iteration-start`、`/iteration-drive`、`/iteration-loop`、`/codebase-audit`）现在声明 `input` hint（`commands/*.md` 新增 frontmatter `input:`），dsh web 客户端在菜单点选后会 **claim** 命令而非立即执行：`/name ` 以命令高亮插入输入框、参数 hint 以 ghost text 提示、按 Enter 才提交——与 `/plan`、`/goal`、`/advisor` 相同的交互。用户键入的参数以 `## User input` 小节追加进 steer 的命令消息；带引号的 frontmatter 值（description/input）现在按去引号注册。更新 `mstar-host/references/dsh.md`。
