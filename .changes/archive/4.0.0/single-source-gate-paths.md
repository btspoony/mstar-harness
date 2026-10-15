---
category: Harness
packages: root, engine, opencode, opencode-v2, dsh, omp
---

- **Gate path resolution is single-sourced in the engine**: `@mstar-harness/engine` now owns the landing-path resolver (`landedPathOf`, the chained form) and the case-folded authority naming/classification, and the OpenCode v1, OpenCode v2, omp, dsh and ZCode write gates import it instead of keeping hand copies. The copies had drifted — four of them followed a single symlink hop while v2 followed the chain — so a two-link alias chain to a harness authority file (`store.db` / `-wal` / `-shm`) bypassed the gate. Every gate now resolves the chain (8-hop bound, cycle/overflow refuses fail-closed with `write.symlink-resolution-refused`) and classifies case-variant authority names identically; each host keeps its own refusal envelope (#442).

<!-- CN -->
- **门禁路径解析在引擎里单源化**：`@mstar-harness/engine` 现在拥有落点解析器（`landedPathOf`，链式形式）与大小写折叠的权威命名/分类，OpenCode v1、OpenCode v2、omp、dsh 与 ZCode 写门改为导入它，不再各自保留手工副本。这些副本已经漂移——四份只跟随一跳符号链接，而 v2 跟随整条链——因此两跳别名链指向 harness 权威文件（`store.db` / `-wal` / `-shm`）时能绕过门禁。现在所有门禁都解析完整链接链（8 跳上限，环形/越界以 `write.symlink-resolution-refused` fail-close 拒绝），大小写变体权威名在各宿主分类一致；各宿主保留自己的拒绝外形 (#442)。
