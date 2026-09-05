---
packages: root, engine
---

- Added a **`collectFolded` seat-prompt option** to `prReviewSeatPrompt` (Stage-2 only; a Stage 1 seat combined with it throws): one fold bullet after the `## Budget` block tells a deep-tier domain seat to do its own collection — pinned diff pack first, then in-domain changed files, within the budget block.
- Deep PR review now runs **two waves by default when the pinned diff pack exists** — the Stage 1 collect wave folds into the Stage 2 domain seats (`collectFolded`), and the collect wave is kept only in the exceptions (no `diffFile` snapshot, PM judgment), declared in the report `- notes:` as `collect wave folded (pack)` / `collect wave kept (no pack / PM judgment: <reason>)`; the independent cross-domain security seat is never folded.
- Tightened **pack-first bounded seat reads**: seats read the pinned diff pack first, then targeted in-domain opens within `fileOpenCap`, and `deep` fan-out wording stays consistent across the `mstar-audit` prose and the `/amazing-pr-review` command.

<!-- CN -->
- 为 `prReviewSeatPrompt` 新增 **`collectFolded` 席位提示选项**（仅限 Stage 2；与 Stage 1 同用即抛错）：在 `## Budget` 块后追加一条折叠要点，告知 deep 档领域席位自行收集——先读钉扎 diff 包，再开本领域变更文件，且不超预算块。
- Deep PR 评审**默认两波运行（存在钉扎 diff 包时）**：Stage 1 收集波折叠进 Stage 2 领域席位（`collectFolded`），仅在例外时保留收集波（无 `diffFile` 快照、PM 判断），并在报告 `- notes:` 中声明 `collect wave folded (pack)` / `collect wave kept (no pack / PM judgment: <reason>)`；独立跨领域安全席位永不折叠。
- 收紧 **pack-first 有界席位读取**：席位先读钉扎 diff 包，再在 `fileOpenCap` 内定向开本领域文件，`deep` 扇出措辞在 `mstar-audit` 文档与 `/amazing-pr-review` 命令间保持一致。
