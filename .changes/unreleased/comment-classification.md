---
category: Harness
packages: root, engine, commands
---

- **Comments must declare a shape.** A non-documentation comment now has to match one of: a marker (`simplify:`, `temporary:`, `shortcut:`) with a bound, a contract pointer (`see <target>`, `ADR-<n>`, `#<n>`, a URL, `docs/…`), a declared prefix (`why:`, `invariant:`, `safety:`, `note:`), or `@generated`. A `/**` block immediately followed by an `export` declaration is the only exemption.
- **Changed-line ratchet.** `mstar lint --type code --diff-base <ref>` raises unclassified comments and unbounded markers on added or modified lines to violations; the same findings stay advisory without a diff base, so the existing corpus is untouched.
- **CI splits the two ranges.** A full-range bound step keeps every tracked marker checked, and a separate changed-line step enforces the comment contract on the diff. The full step uses two directory walks (6.6s) instead of 837 process spawns (69.9s).

<!-- CN -->
- **注释必须声明形状。** 非文档注释需匹配下列之一：带 bound 的标记（`simplify:`、`temporary:`、`shortcut:`）、契约指针（`see <target>`、`ADR-<n>`、`#<n>`、URL、`docs/…`）、声明前缀（`why:`、`invariant:`、`safety:`、`note:`）或 `@generated`。紧邻 `export` 声明的 `/**` 块是唯一豁免。
- **变更行 ratchet。** `mstar lint --type code --diff-base <ref>` 把新增/修改行上的未分类注释与无 bound 标记升为 violation；不带 diff base 时仍为 advisory，存量语料不受影响。
- **CI 拆成两段范围。** 全量 bound 步骤保留所有已跟踪标记的检查，变更行步骤在 diff 上执行注释契约。全量步骤用两次目录走查（6.6s），替代 837 次进程派生（69.9s）。
