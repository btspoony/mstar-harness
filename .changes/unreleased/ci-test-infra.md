---
category: Harness
packages: root, cli, engine
---

- Split the CI `test-cli` job — measured at **594s** on run 37018503961, next-slowest job 249s — into four independent parallel jobs, so CI wall clock is the slowest shard instead of the sum: `test-cli-coordination` (`test/plan-coordination.test.ts`, 163.6s), `test-cli-ops` (the 8 next-heaviest files, ~190.4s combined), `test-cli-web` (the `web/` view-model batch), and `test-cli-suite` (the dynamic remainder).
- The remainder shard computes its own file list at run time — recursive package-wide `find` over `bun test`'s four documented filename classes (`*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, any extension), pruning `node_modules`/`dist`/`.git` and `web`, minus the 9 explicit paths — so a newly added test file joins it automatically, with no shard-list registry or guard script. Discovery is fail-closed: an empty remainder hits an explicit guard that exits 1 with a self-explaining error, never a bare `bun test` that would silently re-run every other shard; the `web/` batch uses the same discovery and passes with a notice when empty.
- Each shard keeps the retired job's setup chain verbatim and now builds the CLI explicitly (`bun run cli:build`, equivalent to the package `build` script the old `bun run --cwd packages/cli test` performed itself), documented in the workflow header.
- Re-split the CLI test shards from four jobs to six (`test-cli-ops` → `test-cli-ops-a` + `test-cli-ops-b`; `test-cli-suite` → `test-cli-suite-a` + `test-cli-suite-b` with the dynamic remainder dealt out by alternating rows of the `LC_ALL=C`-sorted discovery list), capping CI wall clock near ~3 min after both shards drifted past 5 min; full-suite coverage and the fail-closed empty-selection guard are unchanged.
- Organized **CLI subprocess tests by command owner**, retiring the historical `slice4-cli.test.ts` container while retaining all groups, parameter rows, assertions, and fixture content. Moved groups share the CLI spawn harness and package-local assertion/content support; existing skill, lease, and worktree coverage remains alongside its distinct sibling groups.
- Raised the timeout for the `CLI init --target dsh` adapter cases: each spawns `bun run src/index.ts` (a cold TypeScript start plus the adapter's own subprocess work), and the default 5s budget sat close enough to the CI runner's cost that a single slow start failed the suite.
- Removed the reintroduced duplicate `binding` test group (a byte-identical 420-line copy) from `packages/engine/test/coordination.test.ts`; the eight binding contracts remain owned by `packages/engine/test/coordination-bind.test.ts`, and production coordination code plus shared fixtures are unchanged.
- **Isolated actor-only CLI regressions:** check close, triage, supersede, and link in separate active-store fixtures so independent subprocess workflows do not consume a single test's timeout. Preserve all state assertions and default time limits; CLI behavior is unchanged.
- **Remediated three lint backlogs** covering roughly 480 sites across Rule #341 refusal recoveries, help reachability, and frozen-invariant hash-gate structure.
- **Made the gates enforceable:** refusal-quality and help-reachability now pass with empty allowlists, and the hash-gates CI step blocks on violations. Hash-gates reports 3 authorized gates and 11 replay-allowed sites separately from violations.
- **Defined explicit marker semantics:** `// reachability: manual — <reason>` records a site-specific manual recovery only when its reason is non-empty; `// hash-gate: authorized — <reason>` authorizes the adjacent invariant gate only with a non-empty rationale. These markers classify their own sites and do not suppress sibling findings.
- No machine-local store identifiers were added to tracked content.
- Added an **over-design lint family** enforcing the frozen #341/#365 contracts in CI: `lint:refusal-quality` (structured-channel cause/recovery presence) and `lint:help-reachability` (recovery text must name reachable verbs/flags), alongside the now-CI-wired `lint:hash-gates` (`continue-on-error` pending tracked triage of pre-existing main findings). Bounded allowlists reference real tracking issues.
- Added a **QC judge lens** (`overdesign-judge.md`, required on engine/commands diffs): the rules AST cannot decide — gate necessity vs the declared operating model, gate-vs-contract agreement, self-written-output classification, protocol sizing — advisory by design so the judge never becomes a new over-gate.
- Added a **known-answer backtest suite** proving the family catches its historical instance classes from #340/#341, with honest not-covered rows routed to judged examples.

<!-- CN -->
- 将 CI `test-cli` 任务 —— 在 run 37018503961 实测 **594s**、次慢任务 249s —— 拆为四个独立并行任务，使 CI 墙钟等于最慢分片而非总和：`test-cli-coordination`（`test/plan-coordination.test.ts`，163.6s）、`test-cli-ops`（次重的 8 个文件，合计约 190.4s）、`test-cli-web`（`web/` view-model 批次），以及 `test-cli-suite`（动态余量）。
- 余量分片在运行时自行计算文件清单 —— 在包根递归 `find`，匹配 `bun test` 的四类文档化文件名（`*.test.*`、`*_test.*`、`*.spec.*`、`*_spec.*`，任意扩展名），并剪除 `node_modules`/`dist`/`.git` 与 `web`，再排除 9 个显式路径 —— 新加入的测试文件会自动归入该分片，无需分片清单登记表，也无需守护脚本。发现过程为失败即停：余量为空时会命中显式守卫，以退出码 1 终止并打印自解释错误，绝不退化为裸 `bun test` 而把其他分片静默重跑一遍；`web/` 批次采用同样的发现方式，为空时打印提示并以通过结束。
- 各分片原样保留原任务的 setup 链，并显式构建 CLI（`bun run cli:build`，等价于旧命令 `bun run --cwd packages/cli test` 自行执行的包 `build` 脚本），已在 workflow 头部注释中说明。
- 将 CLI 测试分片从 4 个 job 拆为 6 个（`test-cli-ops` → `test-cli-ops-a` + `test-cli-ops-b`；`test-cli-suite` → `test-cli-suite-a` + `test-cli-suite-b`，动态剩余按 `LC_ALL=C` 排序后的奇偶行对半分配），在两个分片漂移到 5 分钟以上后将 CI 墙钟时间压回约 3 分钟；全量覆盖与空集 fail-closed 守卫语义不变。
- 按**命令属主组织 CLI 子进程测试**，退役历史 `slice4-cli.test.ts` 容器，同时保留全部分组、参数行、断言和夹具内容。迁入分组复用 CLI spawn harness 与包内断言/内容支持模块；既有 skill、lease、worktree 覆盖与各自独立的 sibling 分组并存。
- 提高 `CLI init --target dsh` 适配器用例的超时：每个用例都会 spawn `bun run src/index.ts`（冷启动 TypeScript + 适配器自身的子进程工作），默认 5s 预算与 CI runner 的实际开销过于接近，单次启动偏慢即导致套件失败。
- 从 `packages/engine/test/coordination.test.ts` 移除重新引入的重复 `binding` 测试组（420 行字节级相同副本）；八个 binding 契约继续由 `packages/engine/test/coordination-bind.test.ts` 独家持有，生产 coordination 代码与共享 fixtures 均不变。
- **隔离 actor-only CLI 回归：** 将 close、triage、supersede 和 link 分别放入独立的 active-store 夹具，避免多条独立子进程工作流共用一个测试的超时预算；保留全部状态断言及默认超时，不改变 CLI 行为。
- **完成三类 lint 积压整改**，覆盖约 480 个位置：Rule #341 拒绝恢复、帮助可达性，以及冻结不变量 hash-gate 结构。
- **使门禁真正生效：** refusal-quality 与 help-reachability 现以空 allowlist 通过；hash-gates CI 步骤现会阻断违规。hash-gates 将 3 个已授权门禁和 11 个允许重放的位置与违规项分别报告。
- **明确标记语义：** `// reachability: manual — <reason>` 仅在理由非空时标记该单一位置的人工恢复；`// hash-gate: authorized — <reason>` 仅在理由非空时授权相邻的不变量门禁。标记只分类其自身位置，不会屏蔽相邻位置的发现。
- 跟踪内容未加入任何机器本地 store 标识符。
- 新增**过度设计 lint 家族**在 CI 强制执行 #341/#365 冻结契约：`lint:refusal-quality`（结构化拒绝通道的 cause/recovery 存在性）与 `lint:help-reachability`（恢复文本必须指向可达动词/旗标），并入已接线的 `lint:hash-gates`（`continue-on-error`，待既有 main 违规分诊后翻阻断）；有界豁免清单均以真实跟踪 issue 为凭。
- 新增 **QC 判例透镜**（`overdesign-judge.md`，engine/commands diff 必读）：承载 AST 无法判定的规则——门限对运行模型的必要性、门限与契约一致性、自写记录重验、协议尺度——设计为 advisory，判例席自身不得成为新的过度门禁。
- 新增**已知答案回测套件**，证明该家族能抓住 #340/#341 的历史实例类，未覆盖类如实标注并转入判例审查。
