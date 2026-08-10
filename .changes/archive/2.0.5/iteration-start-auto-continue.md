---
category: Harness
packages: root, opencode
---
- `/iteration-start`: accepts an optional `direction` hint (constrains §2 candidates, seeds §3 grill-me — start stays interactive) and a `pause` flag; auto-continues into Phase 2→5 (execute → close → PR → merge-ready) after Phase 1 lock + integration branch, by default. `/iteration-drive` remains standalone for re-entry/resume on an already-locked iteration. Updated `iteration-loop` vs-commands table, README/README_CN command tables + workflow diagrams, OpenCode package quick start; added routing eval `iteration-start-auto-continue-phase2`.

<!-- CN -->
- `/iteration-start`：新增可选 `direction` 提示（约束 §2 候选、种子 §3 grill-me —— start 仍为交互式）与 `pause` 标志；Phase 1 锁定 + integration branch 后默认自动推进 Phase 2→5（execute → close → PR → merge-ready）。`/iteration-drive` 仍作为独立 re-entry/resume 命令保留。同步更新 `iteration-loop` 对比表、README/README_CN 命令表与流程图、OpenCode 包 quick start；新增 routing eval `iteration-start-auto-continue-phase2`。
