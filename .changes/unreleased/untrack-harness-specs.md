---
category: Harness
packages: root
---

- **This repository no longer tracks its own harness specs.** `.mstar/specs/` is local-only here again (`.gitignore` back to a single `.mstar/` rule), so an iteration sweep can no longer commit local plan artifacts into the history of the harness source repository. Downstream repositories are unaffected: the `mstar harness scaffold` snippet, the coordination write gate, and the resolver chain still treat `{HARNESS_DIR}/specs/` as a tracked result.
- **The plan-workflow lifecycle contract now lives in the skill corpus.** Its semantics — delivery-kind declaration, lifecycle stages, evidence contracts and the engine seam inventory — are the skill reference `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`. Engine module comments, CLI help text, tests and the runtime skills that cite it point at that path instead of a repository-local harness spec.

<!-- CN -->
- **本仓库自身不再跟踪 harness specs。** `.mstar/specs/` 在此目录恢复为仅本地存在（`.gitignore` 回到单条 `.mstar/` 规则），迭代收尾扫描不再可能把本地产物提交进 harness 源仓库历史。下游仓库不受影响：`mstar harness scaffold` 片段、coordination 写门禁与解析链仍把 `{HARNESS_DIR}/specs/` 视为可跟踪的结果。
- **plan workflow 生命周期契约迁入 skill 语料。** 其语义（交付类型声明、生命周期阶段、证据契约、engine seam 清单）现为 skill reference `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`。engine 模块注释、CLI help 文案、测试与引用它的运行时 skills 均指向该路径，而不再指向仓库本地的 harness spec。
