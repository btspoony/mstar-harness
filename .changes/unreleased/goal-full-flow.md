---
category: Harness
packages: root, opencode
---

- Added a **host-agnostic full-flow goal rule** in `mstar-host`: any host exposing a `/goal` command (Codex Goal Mode, omp, future code agents) must set the goal to running the **complete flow to its end** — whether advancing an iteration (start → per-plan cycles → close → PR delivery → merge-ready loop) or non-iteration work (specify → clarify → plan → tasks → implement → plan QC tri + QA gate → Done) — never a sub-stage goal.
- Removed the Codex-specific `references/codex-plan-goal-mode-bridge.md`; goal text rules now live host-agnostically in `mstar-host` SKILL.md, and Codex Plan Mode reads `references/_shared/plan-mode-bridge-core.md` directly.

<!-- CN -->
- `mstar-host` 新增**宿主无关的全流程 goal 规则**：凡暴露 `/goal` 指令的宿主（Codex Goal Mode、omp 及未来 code agent），无论推进 iteration 还是非 iteration，都必须将「完整走完全流程」设置为 goal（iteration：start → per-plan cycles → close → PR delivery → merge-ready loop；per-plan：specify → clarify → plan → tasks → implement → plan QC tri + QA gate → Done），不得只设子阶段 goal。
- 移除 Codex 专属 `references/codex-plan-goal-mode-bridge.md`：goal 文本规则改为宿主无关，统一收在 `mstar-host` SKILL.md；Codex Plan Mode 直接读 `references/_shared/plan-mode-bridge-core.md`。
