---
category: Harness
packages: root, engine, commands
---

- **Commented-out-code detection declares its language scope.** The check reads C-family comment runs only; a hash-dialect file (shell, Python, Ruby) returns no finding by design, and `comments.md` states the limit instead of implying coverage.
- **A TODO/FIXME marker must open the comment content.** Prose that merely names the marker ("the TODO rule", "see TODO:") is no longer reported, so the whole-tree advisory carries real tasks and the ratchet cannot fail a rule sentence.
- **The lint module header cites the marker authority.** `comments.md` § Markers owns the labels, the `shortcut:` spelling and the bound; `SKILL.md` keeps only the workaround sentence.
- **Copied bounded-shortcut markers are removed.** The walk ceiling is marked where `MAX_WALK_FILES` is defined, and the shadow read points at the canonical judgment marker instead of repeating it.

<!-- CN -->
- **注释掉的代码检测明确语言范围。** 该检查只读 C 家族注释；shell、Python、Ruby 的 `#` 注释文件按设计不产出 finding，`comments.md` 写明这一限制，而不是暗示覆盖。
- **TODO/FIXME 标记必须开启注释内容。** 仅在句中出现该词的散文（"the TODO rule"、"see TODO:"）不再被报，全量 advisory 只留真实任务，ratchet 也不会把规则说明句判失败。
- **lint 模块头指向标记权威。** 标签、`shortcut:` 写法与 bound 由 `comments.md` § Markers 拥有；`SKILL.md` 只保留 workaround 那一句。
- **删除复制的有界捷径标记。** 遍历上限只在 `MAX_WALK_FILES` 定义处标记，shadow 的读取改为指向 judgment 的规范标记，不再逐字复制。
