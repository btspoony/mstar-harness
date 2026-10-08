---
category: Harness
packages: root
---

- Re-split the CLI test shards from four jobs to six (`test-cli-ops` → `test-cli-ops-a` + `test-cli-ops-b`; `test-cli-suite` → `test-cli-suite-a` + `test-cli-suite-b` with the dynamic remainder dealt out by alternating rows of the `LC_ALL=C`-sorted discovery list), capping CI wall clock near ~3 min after both shards drifted past 5 min; full-suite coverage and the fail-closed empty-selection guard are unchanged.

<!-- CN -->
- 将 CLI 测试分片从 4 个 job 拆为 6 个（`test-cli-ops` → `test-cli-ops-a` + `test-cli-ops-b`；`test-cli-suite` → `test-cli-suite-a` + `test-cli-suite-b`，动态剩余按 `LC_ALL=C` 排序后的奇偶行对半分配），在两个分片漂移到 5 分钟以上后将 CI 墙钟时间压回约 3 分钟；全量覆盖与空集 fail-closed 守卫语义不变。
