---
category: Harness
packages: root
---

- **Engine authority guards state one cause per operation class.** A committed `workflow.compass-ref` retry on a staged authority now refuses with the transition cause every other operation kind uses (other readers keep their messages byte-identical; ACTIVE replay is unchanged). The `store execution export|restore|restore-preview` control-root guard now compares by filesystem identity — `realpath`, with `dev`+`ino` as the tie-break — so a symlinked spelling of the live root is refused; an unreadable comparison refuses instead of admitting, while an absent control root (an explicitly configured but unscaffolded harness) is admitted because it protects no live store.

<!-- CN -->
- **引擎权威守卫按操作类别统一陈述原因。** 已提交的 `workflow.compass-ref` 重试在 staged 权威下现在给出与其他操作相同的 transition 原因（其他 reader 文案逐字节不变；ACTIVE 重放行为不变）。`store execution export|restore|restore-preview` 的 control-root 守卫改为按文件系统身份比较——`realpath`，以 `dev`+`ino` 作为并列判定——因此指向活根的 symlink 拼写会被拒绝；无法解析的比较会拒绝而非放行；而显式配置但尚未脚手架化的 control root 因不存在受保护的活 store 而被允许。
