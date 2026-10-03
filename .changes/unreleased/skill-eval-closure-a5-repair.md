---
category: Harness
packages: root
---

- Re-freeze the skill-eval closure inventory onto reachable `origin/main` (`c42c16b4`): the prior BASE revision was unreachable after a history rewrite. The BASE-tree owner hashes now match that reachable revision, while current-byte hashes remain pinned. For anchors already absent from this BASE, the check guards against reintroduction rather than proving their historical removal. The current file contains 35 tests; the historical 37-test count is not a requirement for the repaired gate (#357).

<!-- CN -->
- 将 skill-eval 闭包清单重新冻结到可达的 `origin/main`（`c42c16b4`）：此前 BASE 版本在历史改写后已不可达。BASE 树文件哈希现与该可达版本一致，当前字节哈希继续固定。对于在此 BASE 中已不存在的锚点，检查用于防止重新引入，而非证明其历史删除。当前文件包含 35 个测试；历史上的 37 个测试数不是修复后门禁的要求（#357）。
