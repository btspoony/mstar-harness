---
category: Harness
packages: root
---

- **Guard 10 names the rule owner and reports a stale allowlist entry.** An exception reason now passes only when it names the owning `skills/` path (or the covered file plus the word `owner`); a reason that merely repeats the covered file is a parked duplicate and fails. An entry whose `file` + `normalizedHash` matches no scanned site is reported by file, so a deleted or reworded rule cannot leave a silently stale exemption.
- **The placeholder classifier separates the lifecycle word from the token, and plan verification gained a surface map.** `Todo` is domain state while `TBD`/`TODO`/`TBA` still fail, and frontmatter/fenced blocks stay exempt. A Files entry on a code surface must name that surface's mapped check (`packages/*/src` and `hooks/src` literals → `bun run lint:ascii-literals`; `skills/**` → `bun run validation:drift`; repo-root `scripts/*.ts` → its own test or run), otherwise `lint.plan-quality.verification-set` fires. Fenced examples are not read, so an example can neither add a surface nor satisfy a missing check. `plan-quality-bar.md` and `plan.main.md` document the map.
- **CLI test suites share one spawn runner.** `packages/cli/test/harness.ts` exposes `runCli` honoring `MSTAR_CLI_ENTRY` (built entry when a job has one, source entry otherwise), pins out the ambient execution-identity markers, and bounds a hung child; the CLI shard jobs that already build the CLI set that entry in their env.
- **The skills-mount HMR case has an explicit timeout.** The same-context provider-removal spec waits on fiber disposal and re-mount, so it carries a 30s bound instead of Bun's 5s default (I-001045).
- **Two unreachable coordination refusal families left the vocabulary.** The Prepare-amendment and JSON identity-recovery code lists are removed from `COORDINATION_ERROR_CODES`; the plan-path reader now propagates its own `plan-path.*` codes unmapped.

<!-- CN -->
- **Guard 10 现在要求 reason 指名规则 owner，并报告陈旧的 allowlist 条目。** 例外 reason 只有在指名真正的 owner `skills/` 路径（或本文件加 `owner` 一词）时才通过；仅重复被覆盖文件的 reason 属于停放的重复条目，判定失败。某条目的 `file` + `normalizedHash` 匹配不到任何已扫描站点时按文件报告，因此删除或改写规则不会留下静默失效的豁免。
- **占位符分类区分生命周期词与占位 token，计划校验新增 surface 映射。** `Todo` 属于领域状态，而 `TBD`/`TODO`/`TBA` 仍然失败，frontmatter 与围栏块保持豁免。Files 条目一旦落在代码 surface 上，就必须指名该 surface 对应的检查（`packages/*/src` 与 `hooks/src` 字面量 → `bun run lint:ascii-literals`；`skills/**` → `bun run validation:drift`；仓库根 `scripts/*.ts` → 其自身测试或运行），否则触发 `lint.plan-quality.verification-set`。围栏示例不被读取，因此示例既不能引入 surface，也不能满足缺失的检查。`plan-quality-bar.md` 与 `plan.main.md` 记录了该映射。
- **CLI 测试套件共用同一个 spawn runner。** `packages/cli/test/harness.ts` 暴露遵循 `MSTAR_CLI_ENTRY` 的 `runCli`（作业已构建时用构建产物入口，否则用源码入口），清除环境中的执行身份标记，并为挂起的子进程设置超时；已构建 CLI 的 CLI shard 作业在 env 中设置该入口。
- **skills-mount HMR 用例有了显式超时。** same-context provider removal 用例等待 fiber 释放与重新挂载，因此使用 30 秒上限而非 Bun 默认的 5 秒（I-001045）。
- **两个不可达的 coordination 拒绝族移除出词表。** Prepare-amendment 与 JSON identity-recovery 的错误码列表从 `COORDINATION_ERROR_CODES` 中删除；plan-path 读取器改为原样传播自身的 `plan-path.*` 码。
