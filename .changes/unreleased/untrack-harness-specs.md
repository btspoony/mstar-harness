---
category: Harness
packages: root
---

- **This repository no longer tracks its own harness specs.** `.mstar/specs/` is local-only here again (`.gitignore` back to a single `.mstar/` rule), so an iteration sweep can no longer commit local plan artifacts into the history of the harness source repository. Downstream repositories are unaffected: the `mstar harness scaffold` snippet, the coordination write gate, and the resolver chain still treat `{HARNESS_DIR}/specs/` as a tracked result.

<!-- CN -->
- **本仓库自身不再跟踪 harness specs。** `.mstar/specs/` 在此目录恢复为仅本地存在（`.gitignore` 回到单条 `.mstar/` 规则），迭代收尾扫描不再可能把本地产物提交进 harness 源仓库历史。下游仓库不受影响：`mstar harness scaffold` 片段、coordination 写门禁与解析链仍把 `{HARNESS_DIR}/specs/` 视为可跟踪的结果。
