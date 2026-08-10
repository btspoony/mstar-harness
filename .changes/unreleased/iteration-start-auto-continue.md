---
category: Harness
packages: root, opencode
---
- `/iteration-start`: auto-continue into Phase 2→5 (execute → close → PR → merge-ready) after Phase 1 lock + integration branch, by default. New `pause` arg stops after Phase 1 (run `/iteration-drive` to resume). `/iteration-drive` remains standalone for re-entry/resume on an already-locked iteration. Updated `iteration-loop` vs-commands table, README/README_CN command tables + workflow diagrams, OpenCode package quick start; added routing eval `iteration-start-auto-continue-phase2`.

<!-- CN -->
- `/iteration-start`：Phase 1 锁定 + integration branch 后默认自动推进 Phase 2→5（execute → close → PR → merge-ready）。新增 `pause` 参数可止于 Phase 1（后续用 `/iteration-drive` 恢复）。`/iteration-drive` 仍作为独立 re-entry/resume 命令保留。同步更新 `iteration-loop` 对比表、README/README_CN 命令表与流程图、OpenCode 包 quick start；新增 routing eval `iteration-start-auto-continue-phase2`。
