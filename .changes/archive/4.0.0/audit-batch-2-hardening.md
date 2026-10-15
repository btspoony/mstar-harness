---
category: Harness
packages: root, omp, dsh, cli, engine, commands
---

- The **omp gate hook now fails closed**: an unexpected error inside a gate returns an explicit deny envelope (gate name + error summary) instead of `undefined`, which the host read as allow; envelope-construction failures rethrow (#443).
- **dsh `workflow-policy` gains direct decision tests**: allowlist normalization/boundaries, mode behaviors, unknown-name handling, ask-cache hit/miss and key normalization, and uncovered-plan precedence, with mutation-bite proof (#444).
- The **codex agent installer caps retained backups** at the 3 newest per target (mtime-ordered, best-effort pruning that cannot fail an install) (#448, partial — engine receipts/ledger retention remains open).
- **Projection reads skip the rewrite when nothing changed**: an unchanged generation fingerprint with intact published rows performs no SQL write; changed inputs render byte-identical legacy output; deleted/corrupt published rows are rebuilt (#449).
- The **loopback dashboard now requires a per-launch random token**: the CLI prints the tokenized URL once, valid tokens set an HttpOnly SameSite=Strict cookie for in-page requests, missing/wrong tokens get a state-free 403; Host/Origin checks unchanged (#450).

<!-- CN -->
- **omp 门钩子现在 fail-close**：门内未预期错误返回显式 deny 信封（门名 + 错误摘要）而非被宿主解读为放行的 `undefined`；deny 信封构造失败则重新抛出 (#443)。
- **dsh `workflow-policy` 获得直接决策测试**：允许清单规范化/边界、各模式行为、未知名称处理、ask 缓存命中/未命中与键规范化、未覆盖计划优先级，附变异咬合证明 (#444)。
- **codex agent 安装器限制备份保留**：每个目标仅保留最新 3 个（按 mtime 排序、尽力而为的清理不会导致安装失败）(#448，部分——engine 回执/台账保留仍开放)。
- **projection 读路径在无变化时跳过重写**：代次指纹未变且已发布行完好时不产生 SQL 写；输入变化时渲染字节等同的旧版输出；已发布行被删/损坏时重建 (#449)。
- **回环 dashboard 现要求每次启动的随机令牌**：CLI 启动时打印带令牌的 URL，有效令牌设置 HttpOnly SameSite=Strict cookie 供页内请求使用，缺失/错误令牌返回无状态泄露的 403；Host/Origin 校验保持不变 (#450)。
