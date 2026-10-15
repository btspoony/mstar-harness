---
category: Harness
packages: root
---

- **The release workflows cap the inlined changelog section to the platform body limits.** `scripts/extract-changelog-section.ts` gains `--max-bytes <n>`; `Release prep` passes `60000` (GitHub rejects a PR body over 65536 characters) and `Release` passes `120000` (Release body limit 125000). A 4.0.0-sized release line is ~133 KB, so `gh pr create` was failing with `Body is too long` and the Release publish would have failed the same way.
- Truncation cuts on a line boundary — never mid-line or mid-code-point — and appends `> Truncated at <n> bytes to fit the platform body limit. Full section: \`CHANGELOG.md\`.` Absent `--max-bytes` keeps the previous uncapped output byte-for-byte. An unusable cap is refused with the offending value and the exact recovery instead of silently producing a longer body: a non-integer or non-positive value names the input it got, and a cap too small to carry the truncation notice itself is refused with the smallest usable value — that notice is the operator's pointer to the full section in `CHANGELOG.md`.

<!-- CN -->
- **发布工作流现在会把内联的 changelog 段落裁剪到平台正文上限。** `scripts/extract-changelog-section.ts` 新增 `--max-bytes <n>`：`Release prep` 传 `60000`（GitHub 拒绝超过 65536 字符的 PR 正文），`Release` 传 `120000`（Release 正文上限 125000）。4.0.0 规模发布行约 133 KB，因此 `gh pr create` 报 `Body is too long` 失败，Release 发布也会以同样方式失败。
- 裁剪落在行边界——绝不截断行或码点——并追加 `> Truncated at <n> bytes to fit the platform body limit. Full section: \`CHANGELOG.md\`.`；不传 `--max-bytes` 时输出与旧脚本逐字节一致。不可用的上限会被拒绝，并指明越界值与确切补救方式：非整数或非正值会报出收到的输入；若上限小到连它必须携带的截断提示都放不下，则会被拒绝并报出最小可用值——该提示是操作者指向完整 `CHANGELOG.md` 段落的指引。
