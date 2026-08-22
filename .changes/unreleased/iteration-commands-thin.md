---
category: Harness
packages: root, opencode
---

- **Thinned the iteration slash commands** (`/iteration-start`, `/iteration-drive`, `/iteration-loop`) into wrappers: shared PM invariants, session todos, the continuous-execution STOP list, and the assignment-preflight bash (warn-only + `enforcement: hard` fail-fast) now live once in `skills/mstar-iteration/references/command-shared-invariants.md`, and `mstar-iteration` points at it. Frontmatter (`name` / `description` / `agent` / `input`) and each command's unique bits (start grill-me, drive helper discovery, loop do-not-load-grill-me) are unchanged.
- **Trigger-strong `mstar-iteration` description**: the skill now loads for "start an iteration" / "drive the iteration" / "run an autonomous loop" even when no `/iteration-*` slash command fires; phase labels no longer treat command names as phase names.

<!-- CN -->
- **三个迭代命令瘦身为薄包装**：共享的 PM 不变量、会话 todos、连续执行 STOP 清单与派发预检 bash（可选 warn-only + `enforcement: hard` fail-fast）统一收敛到 `skills/mstar-iteration/references/command-shared-invariants.md` 单份，`mstar-iteration` 指向该引用。frontmatter 命令名 / `description` / `agent` / `input` 与各命令独有内容（start 的 grill-me、drive 的 helper/完成定义、loop 的不加载 grill-me）保持不变。
- **`mstar-iteration` 描述触发增强**：即使宿主未触发 `/iteration-*` 斜杠命令，"start an iteration" / "drive the iteration" / "run an autonomous loop" 等自然语言也可加载该 skill；阶段标签不再以命令名充当阶段名。
