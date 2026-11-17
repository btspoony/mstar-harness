---
category: Harness
packages: root, engine, commands
---

- **Constraint ladder for recurring corrections.** `mstar-coding-behavior` gains a reference that routes a correction to the strongest surviving constraint — remove the choice, add a deterministic check, verify at runtime, and only then write prose — and treats a repeatedly misused interface as a design defect (`occurrence >= 2`).
- **Comment standard with a machine-checked subset.** A new reference classifies comments into must-write, must-not-write and conditional, with drift / license / substitute failure modes and a marker contract: a `simplify:` or `temporary:` label records a bound (an `upgrade:` clause or a tracking reference) and never licenses the pattern.
- **`mstar lint --type code` checks comments.** It now reports commented-out code and ownerless `TODO` as advisory markers, and fails on a `simplify:` / `temporary:` label without a bound. One shared tokenizer (`packages/engine/src/comment-scan.ts`) serves the detectors and the ASCII-literal tooling. The gate walks `packages` and `scripts`.
- **Audit exception tightened.** A documented bounded decision stays out of findings only while its ceiling and removal path hold and it has not been copied into a new site.

<!-- CN -->
- **重复纠正的约束阶梯。** `mstar-coding-behavior` 新增参考：把纠正落到最强的可行约束——移除选项、加确定性检查、运行时验证，最后才写 prose；反复误用的接口按设计缺陷处理（`occurrence >= 2`）。
- **注释规范与可检查子集。** 新增参考把注释分为必写、禁写与条件写，区分漂移、许可、替代三种失败模式，并规定标记契约：`simplify:` / `temporary:` 必须带 bound（`upgrade:` 子句或跟踪引用），标记不是许可。
- **`mstar lint --type code` 检查注释。** 注释掉的代码与无主 `TODO` 作为 advisory 提示；缺少 bound 的 `simplify:` / `temporary:` 标记则失败。检测器与 ASCII 字面量工具共用单一 tokenizer（`packages/engine/src/comment-scan.ts`），门禁覆盖 `packages` 与 `scripts`。
- **收紧 audit 例外。** 已记录的边界决策只有在 ceiling 与移除路径仍成立、且未被复制到新位置时才排除在 finding 之外。
