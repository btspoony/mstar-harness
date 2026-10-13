---
category: Harness
packages: engine
---

- **The legacy importers state their trust boundary instead of implying a security one.** Both leaf readers (`execution-minimal-import.ts`, `host-state-import.ts`) now document that they assume the control root is trusted and defend against **accidental** symlink traversal: a swapped *ancestor directory* is followed by the open into a regular file that then passes the same-descriptor `fstat`, so a writer already inside the control root is outside the guard's model. Where a supported flow imports a tree the operator does not trust, the correct shape is a staged, re-validated private copy — not descriptor anchoring (#472 / I-000629).
- **The guard's reach is described, never implied.** `O_NOFOLLOW` and `O_NONBLOCK` are applied as `?? 0`, so where a runtime omits one the leaf open degrades silently to a plain open (no Windows CI runs today); `docs/commands.md` carries the boundary and guard-reach paragraph beside the existing `--ack-skip-workflow` recovery. No read path, refusal text or exit code changes.

<!-- CN -->
- **旧数据导入器改为陈述其信任边界，而非暗示安全边界。** 两处叶子读取器（`execution-minimal-import.ts`、`host-state-import.ts`）现在明确：它们假定所读 control root 可信，防的是**意外**符号链接穿越——被换掉的**祖先目录**会被 open 跟随到普通文件并通过同一描述符的 `fstat` 校验，因此已身处 control root 内的写者不在该守卫模型内。若某个受支持流程要导入操作者不信任的树，正确形态是**暂存并重新校验的私有副本**，而非目录描述符锚定 (#472 / I-000629)。
- **守卫的实际覆盖范围被明确描述，而非默认成立。** `O_NOFOLLOW` 与 `O_NONBLOCK` 以 `?? 0` 方式应用，运行时缺少其一则叶子打开会静默退化为普通 open（当前没有 Windows CI）；`docs/commands.md` 在既有 `--ack-skip-workflow` 恢复旁新增该边界与守卫范围段落。读取路径、拒绝文本与退出码均不变。
