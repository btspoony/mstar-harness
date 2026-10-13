---
category: Harness
packages: engine
---

- **The legacy importers state their trust boundary instead of implying a security one.** Both leaf readers (`execution-minimal-import.ts`, `host-state-import.ts`) now document that they assume the control root is trusted and defend against **accidental** symlink traversal. The execution importer's device/inode comparison rejects a leaf swap but is defeated by an ancestor directory replaced **before** its probe; the DSH importer checks only its parent directory's type, so a parent or higher ancestor replaced after that check can lead the open to a different regular file. Where a supported flow imports a tree the operator does not trust, the correct shape is a staged, re-validated private copy — not descriptor anchoring.
- **The guard's reach is described, never implied.** `O_NOFOLLOW` and `O_NONBLOCK` are applied as `?? 0` and degrade independently: a runtime omitting `O_NOFOLLOW` loses only the final-symlink refusal, and one omitting `O_NONBLOCK` loses only the non-blocking open; the regular-file `fstat` refusal (and the execution reader's device/inode comparison) remain in both cases. No Windows CI runs today. `docs/commands.md` carries the boundary and guard-reach paragraph beside the existing `--ack-skip-workflow` recovery. No read path, refusal text or exit code changes.

<!-- CN -->
- **旧数据导入器改为陈述其信任边界，而非暗示安全边界。** 两处叶子读取器（`execution-minimal-import.ts`、`host-state-import.ts`）现在明确：它们假定 control root 可信，防的是**意外**符号链接穿越。执行导入器的 device/inode 比对能拒绝叶子被换，但若祖先目录在该探测**之前**被替换则失效；DSH 导入器只检查其父目录类型，因此该检查之后被替换的父目录或更上层祖先仍可能让 open 落到另一个普通文件。若某个受支持流程要导入操作者不信任的树，正确形态是暂存并重新校验的私有副本，而非目录描述符锚定。
- **守卫的实际覆盖范围被明确描述，而非默认成立。** `O_NOFOLLOW` 与 `O_NONBLOCK` 以 `?? 0` 方式应用，且各自独立退化：运行时缺少 `O_NOFOLLOW` 只失去最终符号链接拒绝，缺少 `O_NONBLOCK` 只失去非阻塞打开；两种情况下普通文件 `fstat` 拒绝（以及执行读取器的 device/inode 比对）仍然成立。当前没有 Windows CI。`docs/commands.md` 在既有 `--ack-skip-workflow` 恢复旁新增该边界与守卫范围段落。读取路径、拒绝文本与退出码均不变。
