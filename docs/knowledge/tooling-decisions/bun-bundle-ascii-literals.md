---
module: packages/cli build chain (bun-build bundles; engine + cli src literals)
date: 2026-08-16
last_updated: 2026-11-09
problem_type: tooling_decision
category: tooling-decisions
severity: high
plan_id: <plan-id>
tags:
  - bun-build
  - bundling
  - non-ascii
  - unicode-escapes
  - regex-literals
  - ci-guards
applies_when:
  - Shipping a bun-built (`bun build --target node`) CLI bundle whose source contains non-ASCII (em/en-dash, CJK) characters inside regex or string literals
  - A validator/parser works in source form or under `node` but misparses or garbles the same code when the bun-executed bundle runs
  - Considering source-level `\uXXXX` escapes as "the fix" for bundle-encoding issues
related_components:
  - packages/engine/src/dispatch.ts
  - scripts/escape-dist-literals.ts
  - scripts/ascii-literal-utils.ts
  - scripts/lint-ascii-literals.ts
  - packages/cli/test/bundle-smoke.test.ts
---

# bun bundle 会误码代码字面量里的原始多字节 UTF-8 —— 两层修复 + 双守门

## Context（事故与定界）

2026-08-16 用户报告：`mstar-harness dispatch validate` 对合法的 `Branch policy: direct on main — <reason>`（UTF-8 em-dash，文件字节已 hexdump 确认 `e2 80 94`）误报双 violation（`branch-policy-missing-reason` + `default-branch.protected`），且 CLI 的 fix 提示把 `—` 渲染成 `â`（latin-1 误读再编码的典型 mojibake）。

隔离矩阵（全部实跑证据，iteration spec §7.1）：

| 执行面 | 结果 |
|---|---|
| npm 安装 CLI（bun 执行 366KB `// @bun` bundle） | **FAIL**（em/en-dash 分隔符解析失败 + 输出乱码） |
| `node` 执行**同一 bundle 文件** | OK |
| `bun` import engine dist（ESM） | OK |
| 从 bundle 原样字节提取函数置于小文件、bun 直跑 | OK |
| bundle 内正则字符类替换为 `[\u2014\u2013]` 转义形式后 bun 直跑 | OK |

**定界**：bundle 文件本身是合法 UTF-8（严格校验通过、regex 字节干净）；缺陷是 **bun 1.2.17 运行时执行该形态大 bundle 时，对代码内（regex/字符串）字面量的原始多字节 UTF-8 解码错误**——与数据文件无关（`readFileSync(utf8)` + 正则处理数据里的 em-dash 全部正常）。当时 dist 的 `#!/usr/bin/env bun` shebang 使所有 CLI 调用都走此路径（现 shebang 为 `#!/usr/bin/env node`，`packages/cli/src/index.ts`；`bundle-smoke` 仍用 bun 跑 bundle，守门未变）。

## Guidance（两层修复 + 双守门）

**坑 1：源码 `\uXXXX` 转义必要但不充分。** `bun build` 会把源码中的字符串 `\uXXXX` 转义**规范化回原始 UTF-8 字节**再写出（regex 字面量转义存活、字符串转义被还原——iter 期间实测发现）。因此只改源码，构建产物仍带原始字节。

1. **源码层**：所有参与机械检查的代码字面量（regex 字符类、violation 消息、fix 提示）写 `\uXXXX` 转义——语义不变，任何运行时/打包器免疫，也让源码 diff 可审。
2. **dist 层**：build 后处理 escaper（`scripts/escape-dist-literals.ts`，commentMask 剥离注释后仅转义代码区非 ASCII）接入 CLI build 链——与 bun build 的转义再规范化行为解耦。
3. **双守门**：
   - `bun run lint:ascii-literals`（CI 步骤 `Lint ASCII literals (src code)`）——拦**源码层**复发（当前扫描 `packages/engine/src` + `packages/cli/src` + `hooks/src` 的代码字面量非 ASCII → exit 1 报 file:line:col）；
   - `packages/cli/test/bundle-smoke.test.ts`——拦 **dist 层**复发：em/en-dash 合法 fixture 解析 + **missing-reason 场景 stderr 含字面 `—` 且无 `â`** 的渲染断言。关键认知：em/en-dash **解析**用例只行使源码层 regex 转义（bun build 不还原 regex 转义），**只有 fix-hint 字符串渲染断言真正行使 escaper 路径**——摘除 escaper 时 CI 必红。

## Why This Matters

- 该 bug 类**只在 bun 执行大 bundle 时显形**：源码测试、node 执行、小文件提取全绿——常规测试金字塔全部漏过，只有「跑构建产物」的 smoke 能拦。
- 事故钉的是 bun 1.2.17；当前 CI 钉 bun 1.4.4（`.github/workflows/ci.yml` `bun-version`），而 `lint:ascii-literals`（:1105）、CLI build 链里的 `escape-dist-literals.ts`、`bundle-smoke.test.ts` 三道守门**全部仍在**——它们是版本无关的保险（任何 runtime 解码 raw 多字节都可能再犯），不是针对已修 bug 的死代码。
- 守门若无渲染断言，摘除 escaper 后 CI 仍绿（守门被静默解除）——本仓 fix wave 3 的起因正是 QC tri 发现「零测试 + smoke 不钉 escaper」。
- commentMask 类启发式有假阳性边界（`i++ / 2 // 注释`：相邻 `++` 应视作操作数而非正则开启）——必须配行为测试而非只测 happy path。

## When to Apply

- 任何 bun-build 产物含非 ASCII 代码字面量（尤其中文仓的 error message / 分隔符语法 `—`）。
- 设计「语法分隔符」类契约时：**数据面**接受 Unicode（em/en/ascii 全兼容），**代码面**只依赖 ASCII——契约 token 永远 ASCII，兼容性在解析器里实现。
- 新增构建链脚本时遵循本仓约定：`scripts/<name>.test.ts` 同名测试 + CI 'Test scripts' step 接线（当前 25 个 `scripts/*.test.ts` 全量在 CI 跑）。

## Examples

- 修复 commit `8d81112`（20 文件转义 + escaper + lint + smoke）与守门加固 `bd7adeb`（scripts 25 测试 + commentMask 根因修复 + en-dash/渲染断言）；证据链：iteration `iter-<plan-id>` spec §7（复现矩阵）/ §7.5（两层结构）、`{HARNESS_DIR}/sdd/<plan-id>/`（TDD FAIL→PASS + QC/QA 报告）。
- 判定「数据面 UTF-8 合法且必要 vs 代码字面量 ASCII-only」的裁决记录：spec §7.4——全面 ASCII 化防不到此 bug 类（数据文件解码正常），只伤双语文档。
