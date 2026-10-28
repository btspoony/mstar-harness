---
category: Harness
packages: root
---

- Added an **optional external review-seat channel** for `mstar-pr-loop`, gated on a loadable `herdr` skill, its passing environment probe and a detected host-to-agent-kind mapping. If any leg fails, the ordinary in-session path stays unchanged.
- Run each review round through `/amazing-pr-review` in an independent host session in a sibling pane, reusing that session across rounds while the loop session only coordinates fixes.
- Added `mstar-pr-loop` → `references/herdr.md` for channel procedure and recovery, plus one ownership sentence in `mstar-audit` → `references/pr-review.md` keeping synthesis, posting, capture and archive with the review session.

<!-- CN -->
- 为 `mstar-pr-loop` 新增**可选的外部审查席位通道**，仅在可加载 `herdr` skill、其环境探针通过且检测到的宿主有对应 agent kind 时启用；任一条件不满足，原有会话内路径保持不变。
- 每轮通过 `/amazing-pr-review` 在相邻 pane 的独立宿主会话中运行审查，跨轮复用该会话，循环会话仅协调修复。
- 新增 `mstar-pr-loop` → `references/herdr.md` 说明通道流程与恢复，并在 `mstar-audit` → `references/pr-review.md` 增加一句归属规则，将合成、发布、捕获和归档留在审查会话。
