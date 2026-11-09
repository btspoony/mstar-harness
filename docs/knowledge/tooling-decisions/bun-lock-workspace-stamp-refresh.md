---
module: root bun.lock (bun workspaces lockfile) / release-prep tooling
date: 2026-08-30
problem_type: tooling_decision
category: tooling-decisions
severity: low
plan_id: <plan-id>
last_updated: 2026-11-09
tags:
  - bun-lock
  - workspace-stamps
  - lockfile-refresh
  - release-prep
  - bun-1-2-17
  - lockfile-churn
applies_when:
  - bun.lock `workspaces[].version` stamps drift behind member package.json versions (cosmetic staleness after version bumps that bypass a lock refresh)
  - Deciding how to refresh workspace version stamps in an existing bun.lock without dependency-graph churn
  - Assuming `bun install` (any flag or pinned version) will reconcile lock stamps with manifests
related_components:
  - bun.lock
  - packages/engine/package.json
  - packages/cli/package.json
  - packages/dsh/package.json
  - packages/opencode/package.json
  - scripts/prepare-release.ts
---

# bun.lock workspace version stamps 是锁内快照 —— bun 1.2.x 不刷新，1.4.x 由 release:prepare 刷新

## Context（实证矩阵）

2026-08-30 iter-20260830 SP3（关 r2 residual：lock 记 member 3.1.2 vs manifest 3.5.x）。当时 CI 钉 bun 1.2.17（经 `bunx bun@1.2.17` shim，local 1.4.0 不准写锁）下全部实跑验证：

| 路径 | 结果 |
|---|---|
| `bun install`（plain，worktree 与 /tmp 隔离副本双跑） | **0 diff** —— 旧锁的 workspace stamps 原样保留 |
| `bun install --force` | 仅移除 `"configVersion": 0`；stamps 仍陈旧 |
| `bun install --lockfile-only` | 同上，只存盘，stamps 不动 |
| bump 成员 manifest 版本（3.5.1→3.5.2）+ install | 仍 0 diff —— 即使 manifest 真变了也不刷新 |
| 删除 bun.lock 重新生成 | stamps 正确（3.5.1），但 ~125 行 graph churn（传递依赖版本/ integrity 更新、configVersion 丢失、root dep spec 被改写） |

**根因**：bun 对**已存在的锁**做加载/保存时保留 workspace member 的 version stamp 快照；只有全新生成才从 manifest 重读。stamp 是「member package.json version 的快照」，不是 bun 每次 install 都重算的字段。

### 2026-11-09 复核：结论随 bun 版本反转

CI 与 release workflow 现钉 **bun 1.4.0**（`.github/workflows/ci.yml`、`release-prep.yml`、`release.yml` 的 `bun-version: 1.4.0`；本机 1.4.4），该版本**会**为真实仓库布局重写 stamps：`scripts/prepare-release.ts` `syncLockfile()`（:427-476）把刷新委托给 `bun install --lockfile-only --ignore-scripts`，然后**证明它确实动了**（`lockfileWorkspaceDrift` + `lockfileRootRangeDrift`，`scripts/release-surfaces.ts:320,342`）。三个 release commit（`11c3a8f7` v4.3.0、`570d0adf` v4.2.1、`dac1c781` v4.2.0）都是 `bun.lock | 18 +++++-----`：8 个 stamp + 1 条 root range，**零 graph churn**。当前锁状态：8 个 released workspace 全部等于 manifest `4.3.0`，`lockfileVersion 2` / `configVersion 1`。

所以「只有手编辑才能无 churn 对齐」只在 bun 1.2.x 成立；在 1.4.x 上 **`release:prepare` 是 stamps 的唯一 owner**，不该手编辑。

## Guidance

- **让 `bun run release:prepare` 刷 stamps**（bun 1.4.x）。它委托 bun 写锁，再断言 workspace stamps 与 root ranges 都到位；断言失败会打印 `oven-sh/bun#18906` 与 `--force`/升级 bun 的恢复路径——不要绕过它手编辑。
- **零退出码不是「已重写」的证明**：`oven-sh/bun#18906` 会让 bun 在「只有版本变了」的锁上跳过 workspace metadata（`scripts/prepare-release.ts:452` 的注释即此教训，`scripts/prepare-release.test.ts:360-408` 用真实 bun 钉住「确实重写」这一行为）。永远按**读回的值**判定，不按退出码。
- **手编辑只作为残余窗口的兜底**：若某次 bun 拒绝重写且 `--force` 无效，直接改 `workspaces[].version` 仍是安全的——该字段是数据不是结构，`packages` graph 里 workspace 走 `@mstar-harness/<name>@workspace:packages/<dir>` **path 协议 key**（无 version/integrity 绑定），stamp 对齐不会 desync resolution。
- **整锁重生成只在能接受 graph churn 时做**（如依赖统一升级轮）：重生成会顺带刷新 root dep spec 快照，也可能夹带传递依赖升级。
- 校验 bun.lock 要按 **JSONC** 处理（trailing commas）——`Bun.file().json()` 直接炸 SyntaxError；先 text 读 + 去尾逗号再 `JSON.parse`，或按仓内既有做法做文本扫描（`workspaceVersionsFromLockfile` 用 text + `matchBrace`，不 JSON.parse）。
- 验收脚本模式：遍历 `workspaces[]` 非 root 成员，lock stamp vs 成员 `package.json` version 逐一比对，输出 OK/MISMATCH 表（现行实现即 `lockfileWorkspaceDrift`）。

## Why This Matters

- 「跑一次 install 就会修」是直觉陷阱——在 bun 1.2.17 上三类 flag + 真实 manifest bump 全部实证无效；在 1.4.x 上**只有带断言的那条调用**才算修（零退出码仍可能什么都没写）。两个版本都指向同一条纪律：读回值，不读退出码。
- 重生成的 graph churn 会把一次 cosmetic 修复膨胀成难审的 diff，还可能夹带传递依赖升级——STOP 条件（diff 超 stamps 即停）必须先写进 plan。

## When to Apply

- release-prep / 版本对齐轮之后发现 lock stamps 落后 → 跑 `bun run release:prepare`，不要手编辑。
- review 中看到 `bun.lock` 只动了 `workspaces[].version` + root ranges —— 这正是正确形态（三个 release commit 都是 9+/9−）；动了几十上百行反而要警惕夹带 churn。
- 换 bun 版本后复核本页：stamp 重写行为是版本相关的（1.2.17 不写 / 1.4.x 写）。

## Examples

- iter-20260830 SP3（plan <plan-id>）：r2 residual 关闭 commit `c5f87f79`（4 hunks stamps-only + fail-closed timeout 断言加固 `db844038`）；机制证据与四路径矩阵在 `{HARNESS_DIR}/sdd/<plan-id>/task-2-report.md`；QC tri 复核确认手编辑无 resolution hazard（path-protocol keys + lockfileVersion 不变）。**注**：该轮的手编辑是 bun 1.2.17 时代的兜底，不是现在的推荐路径。
- bun 1.4.x 时代的真实形态：`11c3a8f7`（v4.3.0）、`570d0adf`（v4.2.1）、`dac1c781`（v4.2.0）三个 `chore(release): prepare` commit 各 9+/9−，全部是 8 个 workspace stamp + 1 条 root range，无 graph churn。owner 是 `scripts/prepare-release.ts:427` `syncLockfile`。
