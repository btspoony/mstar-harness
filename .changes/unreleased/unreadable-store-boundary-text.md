---
packages: commands
---

- **Unreadable-store boundary stated on both refusal surfaces**: `store.corrupt` recovery text on
  `project` and `status` no longer advertises `mstar store restore` — `store execution
  restore-preview`/`restore` need a successful inventory of the live store, so a physically
  unreadable store is not restorable online. The text states the preserved-bytes boundary, the one
  supported continuation (a fresh harness in the repository's ignored `.mstar` child, bootstrapped
  with `MSTAR_HARNESS_DIR=<fresh> mstar harness scaffold <repo-root>` → `mstar store init --harness`
  → `mstar catalog discover --harness`), and that the rebuild recovers no authority, issues or
  execution history. Decision record:
  `docs/adr/implemented/process/2026-11-12-unreadable-store-boundary.md`.

<!-- CN -->
- **两条拒绝面统一声明不可读存储边界**：`project` 与 `status` 上 `store.corrupt` 的恢复文案不再推荐
  `mstar store restore`——`store execution restore-preview`/`restore` 需要能成功盘点活存储，因此物理
  上不可读的存储无法在线恢复。文案改为声明「保留字节即证据」这一边界、唯一受支持的续做路径（在仓库
  被忽略的 `.mstar` 子目录下新建 harness，经 `MSTAR_HARNESS_DIR=<fresh> mstar harness scaffold
  <repo-root>` → `mstar store init --harness` → `mstar catalog discover --harness` 引导），并说明
  重建不会恢复原有权威、issue 与执行历史。决策记录见
  `docs/adr/implemented/process/2026-11-12-unreadable-store-boundary.md`。
