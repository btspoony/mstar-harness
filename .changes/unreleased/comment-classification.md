---
category: Harness
packages: root, engine, commands
---

- **Comments must declare a shape.** A non-documentation comment now has to match one of: a marker (`simplify:`, `temporary:`, `shortcut:`) with a bound, a contract pointer (`see <target>`, `ADR-<n>`, `#<n>`, a URL, `docs/…`), a declared prefix (`why:`, `invariant:`, `safety:`, `note:`), `@generated`, or a tracked `TODO`/`FIXME`, which is a shape only when it names a tracking reference. Two shapes are exempt: a `/**` block whose next non-empty line starts with `export`, and a first-line `#!` shebang, which a hash-comment file reads as an execution directive rather than prose.
- **Changed-line ratchet.** The two ranges gate different findings. Whole-tree, only an unbounded marker is a violation: an unclassified comment and an untracked `TODO` are advisory markers there, so a clean whole-tree run says nothing about them. `mstar lint --type code --diff-base <ref>` is the ratchet that closes the change: it fails every unclassified comment on an added or modified line, an untracked `TODO` included, while an untouched finding never fails, so the existing corpus is untouched.
- **CI splits the two ranges.** The existing full-range bound step keeps every tracked marker checked, and a new changed-line step runs the ratchet on the files the diff against the merge base selects, so the comment contract gates a change without asking it to answer for the whole corpus. The whole-tree step reads `--type code`; the ratchet step filters the diff to code extensions and passes `--diff-base` per file.

<!-- CN -->
- **注释必须声明形状。** 非文档注释需匹配下列之一：带 bound 的标记（`simplify:`、`temporary:`、`shortcut:`）、契约指针（`see <target>`、`ADR-<n>`、`#<n>`、URL、`docs/…`）、声明前缀（`why:`、`invariant:`、`safety:`、`note:`）、`@generated`，或带跟踪引用的 `TODO`/`FIXME`（只有写出跟踪引用才算形状）。以下两种形态豁免：下一个非空行以 `export` 开头的 `/**` 块，以及首行 `#!` shebang——在 hash 注释语言里它被当作执行指令读取，而不是对代码的说明。
- **变更行 ratchet。** 两段范围 gate 的 finding 不同。全量步只把无 bound 的标记判为 violation；未分类注释与无跟踪引用的 `TODO` 在全量步下只是 advisory 标记，所以全量步跑绿并不说明它们干净。`mstar lint --type code --diff-base <ref>` 才是把一次变更补齐的 ratchet：新增或修改行上的未分类注释（含无跟踪引用的 `TODO`）一律判为 violation，未被 diff 触及的 finding 永不失败，存量语料不受影响。
- **CI 拆成两段范围。** 既有的全量 bound 步骤保留所有已跟踪标记的检查；新增的变更行步骤只对 merge base 的 diff 选出的文件执行 ratchet，因此注释契约能拦住一次变更，而不要求它为整个存量语料负责。全量步走 `--type code`；变更行步骤先把 diff 过滤到代码扩展名，再逐文件传 `--diff-base`。
