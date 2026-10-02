---
category: Harness
packages: root
---

- Split the CI `test-cli` job — measured at **594s** on run 37018503961, next-slowest job 249s — into four independent parallel jobs, so CI wall clock is the slowest shard instead of the sum: `test-cli-coordination` (`test/plan-coordination.test.ts`, 163.6s), `test-cli-ops` (the 8 next-heaviest files, ~190.4s combined), `test-cli-web` (the `web/` view-model batch), and `test-cli-suite` (the dynamic remainder).
- The remainder shard computes its own file list at run time — recursive package-wide `find` over `bun test`'s four documented filename classes (`*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, any extension), pruning `node_modules`/`dist`/`.git` and `web`, minus the 9 explicit paths — so a newly added test file joins it automatically, with no shard-list registry or guard script. Discovery is fail-closed: an empty remainder hits an explicit guard that exits 1 with a self-explaining error, never a bare `bun test` that would silently re-run every other shard; the `web/` batch uses the same discovery and passes with a notice when empty.
- Each shard keeps the retired job's setup chain verbatim and now builds the CLI explicitly (`bun run cli:build`, equivalent to the package `build` script the old `bun run --cwd packages/cli test` performed itself), documented in the workflow header.

<!-- CN -->
- 将 CI `test-cli` 任务 —— 在 run 37018503961 实测 **594s**、次慢任务 249s —— 拆为四个独立并行任务，使 CI 墙钟等于最慢分片而非总和：`test-cli-coordination`（`test/plan-coordination.test.ts`，163.6s）、`test-cli-ops`（次重的 8 个文件，合计约 190.4s）、`test-cli-web`（`web/` view-model 批次），以及 `test-cli-suite`（动态余量）。
- 余量分片在运行时自行计算文件清单 —— 在包根递归 `find`，匹配 `bun test` 的四类文档化文件名（`*.test.*`、`*_test.*`、`*.spec.*`、`*_spec.*`，任意扩展名），并剪除 `node_modules`/`dist`/`.git` 与 `web`，再排除 9 个显式路径 —— 新加入的测试文件会自动归入该分片，无需分片清单登记表，也无需守护脚本。发现过程为失败即停：余量为空时会命中显式守卫，以退出码 1 终止并打印自解释错误，绝不退化为裸 `bun test` 而把其他分片静默重跑一遍；`web/` 批次采用同样的发现方式，为空时打印提示并以通过结束。
- 各分片原样保留原任务的 setup 链，并显式构建 CLI（`bun run cli:build`，等价于旧命令 `bun run --cwd packages/cli test` 自行执行的包 `build` 脚本），已在 workflow 头部注释中说明。
