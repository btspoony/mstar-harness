---
category: Harness
packages: root
---

- **The store-cutover suite no longer dirties the worktree.** It rebuilds the committed ZCode bundles in `beforeAll` and used to leave them rewritten in place, so a green run showed a dirty tree and could silently replace an artifact it was testing. The two tracked bundles are snapshotted at load and restored in `afterAll`; assertions are unchanged.

<!-- CN -->
- **store-cutover 套件不再弄脏工作区。** 它在 `beforeAll` 重建已提交的 ZCode bundle，并原样留在原地，导致一次绿色运行后工作区变脏，还可能悄悄替换掉它正在测试的产物。现在两条受版本控制的 bundle 在加载时快照、在 `afterAll` 还原；断言未变。
