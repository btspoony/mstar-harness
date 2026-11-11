---
packages: commands
---

- **Unreadable-store boundary stated on both refusal surfaces**: `store.corrupt` recovery text on
  `project` and `status` no longer advertises `mstar store restore`, and no longer reports every
  `store.corrupt` as a physically unreadable file. The code covers a store that cannot be inventoried —
  a file no reader can open, or a store that opens but fails its own verification — so the text names
  `store execution restore-preview` as the operation that settles which case applies: it either
  inventories the live store against the backup point and names the loss a restore would cost, or it
  refuses and leaves both files untouched. The text states the preserved-bytes boundary, the one
  supported continuation (a fresh harness in the repository's ignored `.mstar` child, bootstrapped
  with `MSTAR_HARNESS_DIR=<fresh> mstar harness scaffold <repo-root>` → `mstar store init --harness`
  → `mstar catalog discover --harness`), and that the rebuild recovers no authority, issues or
  execution history. Decision record:
  `docs/adr/implemented/process/2026-11-12-unreadable-store-boundary.md`.

<!-- CN -->
- **两条拒绝面统一声明不可读存储边界**：`project` 与 `status` 上 `store.corrupt` 的恢复文案不再推荐
  `mstar store restore`，也不再把这个 code 一律描述成物理不可读的文件。该 code 覆盖的是「无法盘点」
  的存储——任何 reader 都打不开的文件，或能打开但自身校验失败的存储——因此文案把
  `store execution restore-preview` 指明为判别动作：它要么对着备份点盘点活存储并说明 restore 会付出
  的损失，要么拒绝并保持两个文件原样。文案声明「保留字节即证据」这一边界、唯一受支持的续做路径（在
  仓库被忽略的 `.mstar` 子目录下新建 harness，经 `MSTAR_HARNESS_DIR=<fresh> mstar harness scaffold
  <repo-root>` → `mstar store init --harness` → `mstar catalog discover --harness` 引导），并说明
  重建不会恢复原有权威、issue 与执行历史。决策记录见
  `docs/adr/implemented/process/2026-11-12-unreadable-store-boundary.md`。
