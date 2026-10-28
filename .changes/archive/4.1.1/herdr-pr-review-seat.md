---
category: Harness
packages: root
---

- Added an **optional external review-seat channel** for `mstar-pr-loop`, gated on a loadable `herdr` skill, its passing environment probe and a detected host-to-agent-kind mapping. If any leg fails, the ordinary in-session path stays unchanged.
- Run each review round through `/amazing-pr-review` in an independent host session in a sibling pane, reusing that session across rounds while the loop session only coordinates fixes.
- Added `mstar-pr-loop` → `references/herdr.md` for channel procedure and recovery, plus one ownership sentence in `mstar-audit` → `references/pr-review.md` keeping synthesis, posting, capture and archive with the review session.
- Added a controlled **authorized optional-capability reference** exception to `mstar-host` § Host hooks so this channel's adapter can remain in `mstar-pr-loop/references/herdr.md`, provided the loaded external skill is the sole command/lifecycle authority and wins on differences, adapter tokens stay in their owner file, and the default path stays complete with a plain fallback for every failed gate leg.

<!-- CN -->
- 为 `mstar-pr-loop` 新增**可选的外部审查席位通道**，仅在可加载 `herdr` skill、其环境探针通过且检测到的宿主有对应 agent kind 时启用；任一条件不满足，原有会话内路径保持不变。
- 每轮通过 `/amazing-pr-review` 在相邻 pane 的独立宿主会话中运行审查，跨轮复用该会话，循环会话仅协调修复。
- 新增 `mstar-pr-loop` → `references/herdr.md` 说明通道流程与恢复，并在 `mstar-audit` → `references/pr-review.md` 增加一句归属规则，将合成、发布、捕获和归档留在审查会话。
- 在 `mstar-host` § Host hooks 增加受控的 **authorized optional-capability reference** 例外，使该通道的 adapter 可保留在 `mstar-pr-loop/references/herdr.md`，条件是：已加载的外部 skill 是命令与生命周期的唯一权威且差异时以其为准、adapter 专有词仅留在所属文件、默认路径保持完整且每个门禁条件失败都有明确回退。
