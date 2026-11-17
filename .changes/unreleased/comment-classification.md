---
category: Harness
packages: root, engine, commands
---

- **Comments must declare a shape.** A non-documentation comment now has to match one of: a marker (`simplify:`, `temporary:`, `shortcut:`) with a bound, a contract pointer (`see <target>`, `ADR-<n>`, `#<n>`, a URL, `docs/…`), a declared prefix (`why:`, `invariant:`, `safety:`, `note:`), or `@generated`. Two shapes are exempt: a `/**` block whose next non-empty line starts with `export`, and a first-line `#!` shebang, which a hash-comment file reads as an execution directive rather than prose.
- **Changed-line ratchet.** `mstar lint --type code --diff-base <ref>` raises unclassified comments and unbounded markers on added or modified lines to violations; the same findings stay advisory without a diff base, so the existing corpus is untouched.
- **CI splits the two ranges.** The existing full-range bound step keeps every tracked marker checked, and a new changed-line step runs the ratchet on the files the diff against the merge base selects, so the comment contract gates a change without asking it to answer for the whole corpus. The whole-tree step reads `--type code`; the ratchet step filters the diff to code extensions and passes `--diff-base` per file.

<!-- CN -->
- **注释必须声明形状。** 非文档注释需匹配下列之一：带 bound 的标记（`simplify:`、`temporary:`、`shortcut:`）、契约指针（`see <target>`、`ADR-<n>`、`#<n>`、URL、`docs/…`）、声明前缀（`why:`、`invariant:`、`safety:`、`note:`）或 `@generated`。以下两种形态豁免：下一个非空行以 `export` 开头的 `/**` 块，以及首行 `#!` shebang——在 hash 注释语言里它被当作执行指令读取，而不是对代码的说明。
- **变更行 ratchet。** `mstar lint --type code --diff-base <ref>` 把新增/修改行上的未分类注释与无 bound 标记升为 violation；不带 diff base 时仍为 advisory，存量语料不受影响。
- **CI 拆成两段范围。** 既有的全量 bound 步骤保留所有已跟踪标记的检查；新增的变更行步骤只对 merge base 的 diff 选出的文件执行 ratchet，因此注释契约能拦住一次变更，而不要求它为整个存量语料负责。全量步走 `--type code`；变更行步骤先把 diff 过滤到代码扩展名，再逐文件传 `--diff-base`。
