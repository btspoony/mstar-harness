---
category: Harness
packages: root, cli, engine, dsh, omp
---

- **Removed every byte-snapshot, digest-equality and hard-coded-content assertion from the test suites.** These assertions are unstable by construction — a read-only SQLite open leaves `-wal`/`-shm` beside the store, an unflushed write can live only in the WAL, build artifacts differ between bun versions, whitespace and key order vary — and they describe implementation bytes instead of the behavior under test. `AGENTS.md` now states the prohibition in the same terms, including that a hash may still be computed as an *input* but never be the thing an assertion compares.
- `MCP control-root admission class > an absolute harness B from a host launched in A touches only B` (I-001050) now asserts the store's `issues` and `store_operations` row counts instead of a directory snapshot. Verified red by pointing the capture at `A` (reports `issues: 1`).
- `prreview-execution-cli`, `sdd-evidence`, `migrate`, `projection`, `execution-ledgers`, `store-upgrade-minimal`, `execution-consumers`, `evaluation-integrity`, `review-advice`, `runtime`, `execution-host-inventory`, `prepare-release`, `core` and the skill-eval suites lost their digest and pinned-version assertions; each test keeps its behavioral assertions.
- A companion test pins the contract the new row-count assertion relies on: a read-only store open leaves those row counts untouched.
- `@mstar-harness/omp` no longer computes or returns the inventory digests: `historyExportBodyDigest`, `historyExportDigest` and `inventoryDigest` are removed, and `export` carries the document alone. Nothing in the repository read or compared them, and their only test expression was a digest comparison.

<!-- CN -->
- **移除测试套件中所有的字节快照、digest 相等与硬编码内容断言。** 这类断言在构造上就不稳定 —— 只读打开 SQLite 会在库旁留下 `-wal`/`-shm`，未落盘的写入可能只存在于 WAL，构建产物随 bun 版本不同，空白与键序会变 —— 而且它们描述的是实现字节，不是被测行为。`AGENTS.md` 现以同样措辞写明该禁令，包括：hash 仍可作为**输入**计算，但绝不能是断言比较的对象。
- `MCP control-root admission class > an absolute harness B from a host launched in A touches only B`（I-001050）改为断言 store 的 `issues` 与 `store_operations` 行数，不再做目录快照。已做红验证：把 capture 指向 `A` 时报 `issues: 1`。
- `prreview-execution-cli`、`sdd-evidence`、`migrate`、`projection`、`execution-ledgers`、`store-upgrade-minimal`、`execution-consumers`、`evaluation-integrity`、`review-advice`、`runtime`、`execution-host-inventory`、`prepare-release`、`core` 及 skill-eval 套件去掉了 digest 与写死版本断言；每个测试保留其行为断言。
- 新增一个伴随测试锁定新行数断言所依赖的契约：只读打开 store 不会改变这些行数。
- `@mstar-harness/omp` 不再计算或返回 inventory 摘要：`historyExportBodyDigest`、`historyExportDigest` 与 `inventoryDigest` 已移除，`export` 只带文档本身。仓库内没有任何代码读取或比较它们，而它们唯一的测试表达形式就是摘要比较。
