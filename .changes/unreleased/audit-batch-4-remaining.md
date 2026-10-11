---
category: Harness
packages: root, cli, engine, commands, opencode, opencode-v2, dsh, omp
---

- **Removed the dead `judgment review-advice` command** end to end (registration, family, CLI adapter/tests, docs, skill routing). It could never succeed — its only production call passed a null evaluator channel, which the runtime refuses before reading any input. The shadow evaluation path in `packages/judgment` is unchanged. The sandbox calibration worker (`scripts/evaluate.ts`) was migrated off the removed CLI spawn: it now imports the built judgment API bundle and submits via `connectEvaluatorChannel` in the same sandbox/supervisor flow (#440).
- **`hooks/session-context.mjs` is now a bundled artifact**: its source moved to `hooks/src/session-context.ts` and is built through the ZCode hooks builder (engine inlined), so the SessionStart hook runs standalone without `node_modules`; the fail-soft unavailable-authority diagnostic is preserved and covered by a bare-copy smoke test (#446).
- **Gate path resolution is single-sourced in the engine** (`host-gate-paths.ts`) and adopted by all five enforcement sites (opencode v1, opencode-v2, omp, dsh, ZCode write gate): symlink chains are followed to the real landing path with an 8-hop fail-close bound — v1/omp/dsh/ZCode upgrade from one-hop resolution, closing the alias-bypass class fixed in opencode-v2 during batch 1. Each host keeps its own refusal envelope (#442).

<!-- CN -->
- **移除了死命令 `judgment review-advice`**（注册、命令族、CLI 适配器/测试、文档、技能路由全链路）。它从未可能成功——唯一的生产调用传了 null evaluator channel，而运行时在读任何输入前就拒绝 null。`packages/judgment` 的影子评估路径不受影响；沙箱校准 worker（scripts/evaluate.ts）已从被删的 CLI spawn 迁移：现导入构建好的 judgment API bundle 并经 connectEvaluatorChannel 提交，沙箱/supervisor 流程不变 (#440)。
- **`hooks/session-context.mjs` 现为打包产物**：源码移至 `hooks/src/session-context.ts`，经 ZCode hooks builder 构建（内联 engine），SessionStart 钩子可在无 `node_modules` 时独立运行；fail-soft 不可用权威诊断保留并有裸拷贝冒烟测试覆盖 (#446)。
- **门路径解析在 engine 单源化**（`host-gate-paths.ts`）并由全部五个执行点采用（opencode v1、opencode-v2、omp、dsh、ZCode 写门）：符号链接链被解析到真实落点并带 8 跳 fail-close 上限——v1/omp/dsh/ZCode 从一跳解析升级，关闭批次 1 在 opencode-v2 修复过的别名绕过类。各宿主保留自己的拒绝信封 (#442)。
