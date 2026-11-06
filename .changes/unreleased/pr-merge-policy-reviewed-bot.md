---
category: Harness
packages: root
---

- Added **`pr_merge_policy: reviewed-bot`**, a second review path beside `reviewed-auto`: an attached review bot (mstar-inspector, Greptile, Bugbot or equivalent) reviews every push on its own, so Phase 5 receives and monitors that review instead of starting a local loop. The bot's newest review on the current head reaching its own gate — for mstar-inspector the `mstar-inspector review` check concluding `success` — is the merge authorization; a missing bot is a configuration failure that returns to Phase 1, not `N/A`.
- **The bot path has an executable evidence loop.** Phase 5 step 4 reads all three bot artifacts — the check conclusion, the overall review comment (verdict, tally, every finding including a disclosed omitted set, and the full reviewed `sha=`), and the anchored line comments — instead of treating unresolved threads as the whole finding set. The pre-merge head reconciliation compares `check.head_sha` and the comment's `publication:v1 … sha=` against `gh pr view --json headRefOid`; a `failure`, `neutral`, in-progress or missing run is never a pass, and `reviewed-bot` has no delta ack.
- **The bot is identified by its check-run name and publication marker, never by its bot login,** and its comment body is the ordinary PR review report: verdict token, tally by merge class, `## 📋 Review` and per-finding blocks are read through `mstar-audit` → `references/pr-review.md` rather than a bot-only parser.
- **`mstar-pr-loop` now belongs to the `reviewed-auto` path only.** Under `reviewed-bot` the loop never starts; the bot's findings are triaged like any third-party reviewer's through Phase 5 step 4.
- Updated `mstar-iteration` Phase 1 selection, Phase 4/5 review-path and merge-authorization sections, helper discovery, `mstar-harness-core`, `mstar-roles`, the iteration commands, `docs/runtime-reference.md` and both READMEs.

<!-- CN -->
- 新增 **`pr_merge_policy: reviewed-bot`**，作为 `reviewed-auto` 之外的第二条 review 路径：挂载的 review bot（mstar-inspector、Greptile、Bugbot 或等价物）会跟随每次 push 自行 review，Phase 5 只接收并监控该 review，不再自起本地 loop。该 bot 在当前 head 上最新一次 review 达到其自身门——mstar-inspector 为 `mstar-inspector review` check 判定 `success`——即构成 merge 授权；无 bot 挂载属于配置失效并回到 Phase 1，而不是记 `N/A`。
- **`mstar-pr-loop` 现在只属于 `reviewed-auto` 路径。** `reviewed-bot` 下该 loop 不启动；bot 的 findings 与其他第三方 reviewer 一样，经 Phase 5 第 4 步 triage 处理。
- **bot 路径具备可执行证据闭环。** Phase 5 第 4 步读取 bot 的三处产物——check 结论、整体 review comment（verdict、tally、全部 finding 含被折叠的 omitted 集合、以及完整的 reviewed `sha=`）、anchored line comments——不再把未解决线程当作全部 findings。merge 前的 head 对账比较 `check.head_sha` 与 comment 的 `publication:v1 … sha=` 是否都等于 `gh pr view --json headRefOid`；`failure`、`neutral`、进行中或缺 run 都不算通过，且 `reviewed-bot` 下没有 delta ack。
- **bot 以 check-run 名与发布 marker 识别，绝不按 bot 登录名**，其 comment 正文即普通 PR review 报告：verdict token、按 merge class 的 tally、`## 📋 Review` 与逐条 finding 块，均按 `mstar-audit` → `references/pr-review.md` 读取，而不是另造 bot 专用解析器。
- 更新 `mstar-iteration` 的 Phase 1 选择项、Phase 4/5 的 review 路径与 merge 授权、helper 发现、`mstar-harness-core`、`mstar-roles`、迭代命令、`docs/runtime-reference.md` 与两份 README。
