---
category: Harness
packages: root
---

- **The dsh panel prose now describes the payload that ships.** The panel section documents the session digest (`enforcement`, `knowledge` carried but never rendered, `selection`, the `iteration` fallback, `leafSignal`) and the one-shot read path; the retired five-view snapshot, its freshness footer, `retained.selection`, the five-second poll and the panel-generation layout prose (section nav, meta dock, kanban and roadmap anchors, the agents canvas, `projectGraph`, `IterationInfoSection`) are deleted. `README.i18n.yaml` pins re-recorded.
- **`mainWorktreeBranch` is documented as the primary-checkout branch**, distinct from the integration branch, matching the readiness comparison that fails `branch-mismatch` on inequality.
- **The `reviewed-bot` matrix separates internal `skipped` from published `success` / `failure` / `neutral`**, and the two sites that still asserted a per-commit review now follow the bot's trigger mode. Live OpenCode claims name the manifest pin (`2.2.5`), and `packages/ui/src` comments cite `prototype.html`.
- **The hash-gate contract is discoverable from `scripts/lint-hash-gates.ts`**: marker syntax, required justification and review path sit beside `AUTHORIZED_MARKER_PREFIX`. The lifecycle contract records the accepted pre-proof audit limit, and the accepted low-sweep limits are written up as a proposed ADR.

<!-- CN -->
- **dsh 面板文档现在描述的是实际交付的 payload。** 面板章节写明会话摘要（`enforcement`、承载但不渲染的 `knowledge`、`selection`、`iteration` 回退成员、`leafSignal`）与一次性读取路径；已退役的五视图快照、其新鲜度页脚、`retained.selection`、5 秒轮询，以及那一代面板布局描述（分区导航、meta 小面板、kanban 与 roadmap 锚点、agents 画布、`projectGraph`、`IterationInfoSection`）均已删除。`README.i18n.yaml` 的 pin 已重新记录。
- **`mainWorktreeBranch` 现记为 primary checkout 分支**，与 integration 分支区分，与「不相等即 `branch-mismatch`」的就绪比对一致。
- **`reviewed-bot` 矩阵把内部 `skipped` 与已发布的 `success` / `failure` / `neutral` 分开**，两处仍断言「每个 commit 都 review」的站点改为跟随 bot 的触发模式。OpenCode 的现行声明改为点名 manifest pin（`2.2.5`），`packages/ui/src` 注释改引 `prototype.html`。
- **hash-gate 契约可从 `scripts/lint-hash-gates.ts` 发现**：marker 语法、必需的理由与评审路径就在 `AUTHORIZED_MARKER_PREFIX` 旁。lifecycle 契约记录了已接受的 pre-proof audit 限制，低扫已接受限制另立提案 ADR。
