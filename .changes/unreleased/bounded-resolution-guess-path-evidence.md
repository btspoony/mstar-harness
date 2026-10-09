---
category: Harness
packages: cli
---

- Historical R3 (3 calls, pass) and intermediate R4 (initialize infrastructure error, 0 calls) evidence remain archived in their respective run directories; R4 predates the initialize-response fix.
- Refreshed current acceptance evidence in `eval/r5-guess-path/` on full SHA `3c0f0eea8c9f6298d701e472da81f2a8ffd8de73`: the local-built-CLI stdio MCP guess path recorded 3 calls (failed near-miss, catalog recovery, corrected call), graded pass, with run/report exit 0.
- Made the evaluator driver clone-portable: it derives repository root from `import.meta.url`, accepts `MSTAR_SKILL_EVAL_REPO_ROOT` and `MSTAR_SKILL_EVAL_DURABLE_DIR`, and records the current full SHA and built CLI identity/help hash. From a clone, run `bun run --cwd packages/cli build && bun scripts/skill-eval/run-bounded-resolution-real.ts`.
- **model compliance stays unverified (scripted client, no LLM)**.

<!-- CN -->
- 历史 R3（3 次调用，通过）和中间 R4（initialize 基础设施错误，0 次调用）证据仍分别保留在各自运行目录；R4 发生在 initialize 响应修复之前。
- 已在完整 SHA `3c0f0eea8c9f6298d701e472da81f2a8ffd8de73` 上，将当前验收证据刷新到 `eval/r5-guess-path/`：本地构建 CLI 的 stdio MCP 猜测路径记录 3 次调用（近似错误工具名、目录恢复、修正后的调用），判定通过，run/report 退出码均为 0。
- 使评估驱动可在任意检出中运行：从 `import.meta.url` 推导仓库根目录，支持 `MSTAR_SKILL_EVAL_REPO_ROOT` 和 `MSTAR_SKILL_EVAL_DURABLE_DIR`，并记录当前完整 SHA 与已构建 CLI 身份 / 帮助哈希。克隆后运行 `bun run --cwd packages/cli build && bun scripts/skill-eval/run-bounded-resolution-real.ts`。
- **模型遵循情况仍未验证（脚本化客户端，未调用 LLM）**。
