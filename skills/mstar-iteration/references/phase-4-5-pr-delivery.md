# Phase 4 & 5: PR delivery + merge-ready loop

> Loaded by `mstar-iteration` SKILL.md when entering Phase 4/5. **Read `mstar-harness-core` first.** 进入前置：Phase 3 §3.5 exit 全 `[x]`（Phase 4）；Phase 4 PR 已创建（Phase 5）。

## Phase 4: PR delivery（开 PR）

**Precondition**: Phase 3 §3.5 exit 全 `[x]`；close commit 已 push 到 `spec_integration_branch`。

1. 打印 **`## Phase 4: PR delivery`**
2. Resolve target：ACTIVE workflow 执行行 `branch.target`（compass frontmatter 镜像）；缺失 → **STOP**，问用户
3. 创建 PR：`spec_integration_branch` → `target_branch`
4. PR 正文须含 residual 披露节：本迭代各 plan 的 open R# 清单（id + severity + 跟踪位置 + blocker-defer 标记；无 open 时写 `N/A — none open`）—— 职责 → **`mstar-artifacts`**「Findings cleanup modes」
5. PR 正文须写明 compass 记录的 `pr_merge_policy`（`reviewed-auto` / `reviewed-bot` / `owner-gated`）—— reviewer 据此知道本 PR 的 review 由本地 loop 还是挂载的 bot 提供，以及是否被期待给出 merge 批准
6. 记录 PR URL / number（Phase 5 会话 SSOT）
7. **Immediately** 进入 **Phase 5** — **Phase 4 exit ≠ 迭代交付完成**

---

## Phase 5: PR merge-ready loop

**Precondition**: Phase 4 PR 已创建且 head = `spec_integration_branch`。

**Loop 理念**（mstar SSOT）：PR 开完后进入 **验证—修复—再验证** 循环，直至 PR 可合并。与 Phase 2 per-plan loop 类似，但对象是 **PR 级** merge 门禁（CI、review、冲突），不是 plan 实现。

### 5.0 Phase boundary

- Phase 5 在 PR head（`spec_integration_branch`）上 push 修复；**禁止**另开替代分支
- **Checkout / worktree（HARD）**：Phase 5 是 PR 级 **hotfix** loop。产品修复在从 `spec_integration_branch` 出的独立 **fix feature worktree** 上编辑、commit；review 后在 **integration worktree**（路径取 ACTIVE workflow 执行行 `integration_worktree_path`）串行 merge 回 integration，再按 §5.1a push。禁止在 integration 或主 checkout 直接编辑产品代码；三域表 → `mstar-branch-worktree`。
  Hotfix commit 仅用已配置身份；身份缺失或失败则 **Blocked**，不得编造或逐次提交覆盖身份 → `mstar-roles/references/_shared/leaf-executor-core.md`「Git NEVER (repo writes)」。
- 产品代码修复 → PM **dispatch** dev/ops（`mstar-dispatch-gates`）；Assignment **`Worktree path`** / cwd = 绝对 fix feature worktree 路径；merge 回 integration 由 PM 在 **integration worktree** 执行；PM 线程不代写实现
- 禁止为「让 CI 变绿」而改 workflow，除非用户明确授权
- **Push cadence** → **§5.1a**（本地可提前修；**禁止**在 CI / AI review 波次未结束时 push）

### 5.1a Push cadence（HARD — 防打断 CI / AI review）

发现 CI 失败或 review 问题时，**允许本地提前修**（含 dispatch implement/ops、落盘 commit），但 **`git push`（更新 PR head）必须等上一波次跑完**。

| 允许 | 禁止 |
|------|------|
| CI/review **进行中**就开始本地诊断与修复 | 当前 head 上仍有 **CI queued/in_progress**，或 **AI review 波次**（Bugbot / Greptile / 等价 bot）未结束时 **push** |
| CI **全部结束后**出现新的 review 评论 → 继续本地修，批完再 push | 为「抢时间」在 CI 仍在跑时 push（会取消/孤儿化进行中的 CI 与 **AI reviews**，浪费 token 且无完整结果） |
| 一批本地修复 **合并为一次 push**（本 head 波次 settled 后） | 同一波次未 settled 就连续多次 push |

**Push gate（每次 push 前必须核对）**：

1. 当前 PR head 的 **required CI**（及已启动的检查）均已 **completed**（success / failure / cancelled — 不得仍为 queued / in_progress）
2. 附着在该 head 的 **AI / bot review 波次**已跑完（无进行中的 review job；若宿主无法探测 job，则至少等 CI settled **且** review 评论不再增长一小段稳定窗口后再 push）
3. 仅当 **1–2 满足** 且本地仍有未推送修复时，才 **push 一次**
4. Push 后：等 **新 head** 的 CI + reviews 全部跑完 → 再决定下一轮本地修 / push

**顺序记忆**：`observe findings → fix locally early → wait until CI + review wave idle → push batch → wait new wave → repeat`。

> **Engine check:** run `mstar iteration push-cadence [--ci-running] [--review-wave]` (engine `pushCadenceProbe`) to probe the push gate above. On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.
History rewrite / force-with-lease / 改写后证据失效规则 SSOT → `mstar-branch-worktree`「History rewrite 与推送安全」节；本节只管 push 时序。

### 5.1b Review paths and surfaces（HARD — one path, every attached surface settles）

Phase 5 has exactly **two review paths**; the compass `pr_merge_policy` selects one at Phase 1. They differ only in who produces the review: the local loop **initiates** rounds, the bot path **receives** rounds the bot starts on every new commit.

| `pr_merge_policy` | Review path | Who produces the review | Evidence read |
|---|---|---|---|
| `reviewed-auto` | **Local loop** | `mstar-pr-loop` | its settled, posted `ship it` on the current head |
| `reviewed-bot` | **Bot-driven** | the attached review bot (mstar-inspector, Greptile, Bugbot or equivalent), on the PR — detected by its **check-run name**, never by its bot login | all three artifacts per § Bot evidence — the check's conclusion on this head, the overall review comment (the ordinary PR review report: verdict, tally, every finding including a disclosed omitted set, and the exact `sha=`), and the anchored line comments; for Greptile the **5/5** score — with no failing check and no unresolved finding at or above the blocking tier (a P1/must-fix blocks; a failing check caused by the review itself is a blocking state) |
| `owner-gated` | none | nobody — the human owner's written approval (an attached bot still reviews the PR; its bar stays a §5.1b surface) | the human owner's written approval of the current head |

- **`reviewed-bot` never starts a local loop.** The bot owns PR review; Phase 5 monitors it like any other third-party reviewer: wait for the newest review/existing check on the current head, triage its findings through §5.1 step 4, fix valid ones locally, and push under §5.1a — which is also what re-triggers the bot when it follows pushes. Under a manual trigger mode, use the bot's documented retrigger (for mstar-inspector, a PR comment from the PR author or repo owner that @mentions the App) instead of inventing a second review.
- **`reviewed-bot` with no bot attached is a configuration failure, not `N/A`.** STOP and return to Phase 1 to re-confirm the policy, or attach/enable the bot; never silently downgrade to `reviewed-auto` or proceed unreviewed.
- **Under `reviewed-auto`, an attached bot stays mandatory** (its own passing bar plus the non-failing check and blocking-finding rule above). It is a second surface there, not a substitute for `ship it`.
- **No bot attached → `N/A`, not blocked** — only outside `reviewed-bot`. When no external review bot is configured on the PR, record `External AI review: N/A — no bot attached` in the Phase 5 evidence (`qc-consolidated`-equivalent note or the PR body) and proceed on the internal surface alone. Do not invent a bot result and do not treat the absence as a green verdict.
- **A bot that is attached is mandatory.** Once a bot has reviewed the head (or a check for it exists), its bar applies as above; you may not disable or ignore it to reach merge-ready.
- The bot surface settles on a **loop of pushes**, not a one-shot read: drive it to its passing bar by fixing confirmed findings and letting the bot re-review the new head — you never drive it with a local review driver. A green check with a sub-threshold result (for example Greptile below 5/5) is **not** settled.
- A `ship it` from the internal loop **never** waives an unresolved bot finding or a sub-threshold bot score; a bot's silence is not evidence either — read its verdict and its inline comments on the current head.
- If the bot reports findings, treat them like QC findings: confirm each against the code, fix the valid ones, and record why an invalid one is rejected. Re-run the bot only by pushing a new head (§5.1a) or its documented retrigger.
- A bot check that fails for infrastructure reasons (quota, app error) is still **not green**: state the cause, and either retrigger or obtain the user's written waiver naming the surface and the head.
- Review paths settle independently of the bot surface: do not stop the local loop because the bot is green, and do not merge because the local loop is green while the bot is red.

#### Bot evidence（`reviewed-bot` only）

A bot publishes up to **three** artifacts for one head — the check, an overall review comment, and anchored line comments; a transition reads every artifact that bot actually publishes (a marker-less bot may publish no marked review comment), never a thread list alone. **Identify the bot by its check-run name, plus its publication marker only if it publishes one, never by a bot login** — the account is `<slug>[bot]` and varies per installation, while the check name is the stable key. For mstar-inspector the name is exactly `mstar-inspector review` and the comment marker prefix is `<!-- mstar-inspector:review:v1`; another bot uses its own check name, plus its own marker only if it publishes one, and is detected the same way:

```bash
SHA=$(gh pr view <n> --repo <owner>/<repo> --json headRefOid --jq .headRefOid)
# 1. Check conclusion — same name can carry several runs; page through and take the newest completed run for this head
gh api --paginate "repos/<owner>/<repo>/commits/$SHA/check-runs?check_name=mstar-inspector%20review&per_page=100" \
  --jq '.check_runs[] | {status, conclusion, head_sha, completed_at, summary: .output.summary}'
# 2. Overall review comment — full findings, tally, and the exact reviewed head in `publication:v1 … sha=`
gh api --paginate "repos/<owner>/<repo>/issues/<n>/comments?per_page=100" \
  --jq '.[] | select(.body|startswith("<!-- mstar-inspector:review:v1")) | {updated_at, head: (.body|capture("sha=(?<s>[0-9a-f]+)").s), verdict: (.body|capture("Verdict: `(?<v>[^`]*)`").v), body}'
# 3. Anchored line comments — the findings that also exist as resolvable threads on this head
gh api --paginate "repos/<owner>/<repo>/pulls/<n>/comments?per_page=100" \
  --jq '.[] | select(.commit_id == "'"$SHA"'") | {path, line, body}'
```

- **The comment body is the ordinary PR review report, not a bot-specific format.** It carries the same layout and vocabulary as `mstar-audit` → `references/pr-review.md`: the verdict token (`ship it` / `needs fixes` / `blocked` / `incomplete`), the tally table by merge class (`must-fix` / `should-fix` / `may-fix` / `nit`), `## 📋 Review`, and one `### Findings` block per finding with evidence, location, category and merge class. Read it through that contract — the merge class decides whether a finding blocks, and the tally-derived verdict is the same verdict the local path publishes. Do not invent a bot-only parser or a second finding schema.

- **Findings live in the comment body, not only in threads.** Read the whole comment: a `(+N more findings omitted)` footer means the merge-class cap hid findings — those still count as reported, so reopen the omitted set from the bot's dashboard or treat them as unresolved rather than assuming only threads exist.
- **Bind every artifact to one head.** Always the bot check's `head_sha` plus **that check's own conclusion bound to this head**, and each line comment's `commit_id`; the comment's `publication:v1 … sha=` only from a bot that publishes that marker — a marker-less bot (for example Greptile) binds through its check's `head_sha` and bound conclusion alone, with no comment-marker requirement. Every artifact the bot does publish must equal `gh pr view --json headRefOid`. Any other head is a stale round and authorizes nothing, with the single exception below; a short `commit <sha7>` line in the comment is a hint, never the binding value.
- **An empty increment inherits from the reviewed head.** mstar-inspector acks a head whose `base...head` is empty: it publishes no new review, while its check on **that** head terminalizes to the reviewed head's result as an inherited `success`/`failure` (`terminalizeCheck(…, "skipped", sinceSha)` → `decideConclusion`'s inherited branch, fail-closed). So on such a head the check is authoritative while the review comment still carries the older `sha=`. Accept that pair only when the two heads carry identical content — `gh api "repos/<owner>/<repo>/compare/<comment-sha>...<head>" --jq '{status, ahead_by, behind_by, files: (.files|length)}'` returns `files == 0` with `status` `identical` or `ahead` — and record both heads (`reviewed` and `current`) in the Phase 5 evidence. A different tree, a non-ancestor, no check on the current head, or no settled comment stays unsettled. A bot that publishes no such marker (for example Greptile) has no inheritance path: push a new head or obtain a written waiver naming the head.
- **Conclusion matrix** (mstar-inspector): `success` = published and at or above the App gate — the only merge-ready conclusion; `failure` = gate missed, degraded, unpublished, superseded or unknown, so read `summary` when present to name the cause; `neutral` = an empty increment with no inheritable result, meaning **this head has no bot verdict** — not settled: wait for a new head or one documented retrigger, and if `neutral` **repeats** on that head, name its exits instead of looping — the user's written waiver naming the surface and the **exact head** (§5.1b infrastructure shape) or the §5.3 Phase 1 `pr_merge_policy` re-record; never endless retriggering and never a PM-issued waiver; `queued`/`in_progress` = still running — not settled; **no run at all** on this head = no bot verdict here (not an inheritance signal — an empty increment already carries an inherited check) — not settled. Never translate `failure`/`neutral`/absence into a pass.

### 5.1 Loop（repeat until §5.2 第 1–5 项全 `[x]`）

1. **Status** — PR mergeable？required CI？unresolved review threads？**任一 CI/AI review 是否仍在跑？**
2. **Merge conflicts** — blocking 则在 integration 分支**本地**解决；**仅当 §5.1a push gate 满足时**再 push（意图冲突 → **Blocked**）
3. **Review dispatch（按 compass `pr_merge_policy`）** — `reviewed-auto`：PR 级 review 归 **`mstar-pr-loop`** 所有——它自己跑 review → fix → re-review 循环，并按 §5.1a 的 push cadence 推进；**不要**在每个 §5.1 迭代里另起第二个 review loop。§5.1 在该轮内**暂停第 4 步的 review 修复分派与第 6 步的 push**——这两项由该 loop 一并执行（§5.1a 仍逐次适用，单一 pusher，避免同一 head 两个推手）。**第 5 步的 required-CI 修复保留**：可由 §5.1 本地开工，但其 push 同样走该 loop 的批（§5.1a），不得另起第二推手。§5.1 仍负责 mergeable 与 required-CI 观测。§5.3 读取该 loop 在当前 PR head 上最终 settled、已 posted 的 `ship it` 报告作为授权。`reviewed-bot`：**不**起任何本地 review loop——挂载的 bot 在每个新 head 上自行产出 review，§5.1 只监控该 review 是否已落到当前 head 并达到其自身门（§5.1b），其 findings 走第 4 步普通第三方 triage，push 仍守 §5.1a（该 push 即 bot 的下一轮触发）。`owner-gated`：**完全**不起 PR 级 review loop，**人类 owner** 的 review 就是 gate，Phase 5 停在 merge-ready 等其书面批准
4. **Reviews** — `reviewed-auto`：fetch unresolved threads；triage；dispatch **本地**修复（可在上一波次仍在跑时开工）。`reviewed-bot`：读 bot 在当前 head 上的证据并按 §5.1b Bot evidence 取全量 findings——整体 review comment（全部 finding 块，含被折叠的 omitted 声明）、anchored line comments（行内副本，即可 resolve 的 thread）、`mstar-inspector review` check（结论与 summary）；**不要**只 fetch threads 就当作该 head 的全部 findings。triage 与本地修复同本地路径，bot 已自行 resolve 的线程不重复处理。
5. **CI** — 失败项在 PR 范围内**本地**修复（可提前开工）；**不**在 CI 仍在跑时 push
6. **Push** — 仅当 §5.1a 满足：无 in-flight CI，上一波 CI **与** reviews 均已跑完 → **一次** push 本批修复
7. **Review fix hygiene**（每次 push 后；`reviewed-auto` 轮内即该 loop 的那次 push，`reviewed-bot` 下即触发 bot 新 review 的那次 push）：
   - 在同 thread **comment**（改动 + 验证）
   - **Resolve** when addressed
8. Return to step 1（CI 结束后若出现 **新** reviews → 继续本地修，再等 idle 后 push）

**Optional host helpers（command 层发现；非 `mstar-*` load order）**：

| Priority | Helper | When |
|----------|--------|------|
| 1 | `babysit` or any `*-babysit` skill（first readable `SKILL.md`） | **Default prefer** — CI green + reviews resolved loop |
| 2 | `greploop` | **Driver for the mandatory external bar** — the external bot's settlement is required per §5.1b; when the repo uses Greptile, drive it with `greploop` to the loop's **5/5** target. Without the helper, achieve the same bar manually and read the bot's score, check and inline comments directly |
| 3 | neither | Command fallback = babysit-equivalent CI + reviews gates |

When both babysit/`*-babysit` and greploop apply: **babysit/`*-babysit` first**（CI + reviews），then optional greploop for Greptile score. Discovery paths → `mstar-iteration` §5 (iteration command layer).

### 5.2 Phase 5 exit checklist（merge-ready → enter Phase 6）

打印 **`## Phase 5 exit checklist`**；**第 1–5 项全 `[x]` = merge-ready**（第 6 项是 merge-ready 的 todo 勾选动作，其条件即第 1–5 项），第 7 项（**Merge authorization**）是 merge 与进入 Phase 6 的独立前置（§5.3），第 8 项为 transition marker（merged 后才可勾）。**整表全 `[x]` 只在 merge 之后成立**（Phase 6 进入前置），不得作为 merge-ready 的定义或 `phase-5-pr-merge-ready` todo 的关闭条件（否则要求先 merge，`owner-gated` 下自相矛盾）；此后唯一出口是 **Phase 6**（PR merged 后执行 `references/phase-6-post-merge-close.md` §6.1–§6.4）——本 checklist **不是**「迭代交付完成」：

- [ ] PR mergeable（无 blocking merge conflicts）
- [ ] All **required** CI checks green on latest head
- [ ] **Review path + external AI review** settled on the latest head — `reviewed-auto`: a settled, posted `ship it` from `mstar-pr-loop`; `reviewed-bot`: the attached bot's review reached its own passing bar on that head (mstar-inspector `success`, Greptile 5/5 — never `N/A`, never `failure`/`neutral`, never in progress), or, on an empty increment, the head's own check carries an inherited result from an ancestor whose content equals this head (§5.1b); `owner-gated`: none of these is the gate — the human approval below is, while an attached bot still counts as the external surface. **Whenever a bot is attached, §5.3's per-bot passing bar applies under every policy** — `reviewed-auto` and `owner-gated` included: that bot reached its own passing bar on this head exactly as §5.3's row requires (mstar-inspector `success`, Greptile 5/5 — a marker-less bot's bar is its own scored threshold; its check only binds which head is judged), with no blocking finding unresolved; a merely non-failing check, the local `ship it`, or the owner's approval never substitutes for it. Record `N/A — no bot attached` only when no bot is attached; a user-written waiver names the surface, finding/score and exact head — §5.1b, §5.3
- [ ] All review threads **resolved**（或用户书面 waive 特定 thread）；`reviewed-bot` 下整体 comment 中的每条 finding 已 addressed 或书面 waive（成文的 omitted findings 同样适用）
- [ ] §5.1 review comment + resolve 已覆盖本轮所有 addressed feedback
- [ ] Host todo `phase-5-pr-merge-ready` 可勾选
- [ ] **Merge authorization** — satisfied per §5.3
- [ ] PR **merge** 完成后进入 **Phase 6**：追加 todo `phase-6-post-merge-close`，执行 post-merge close（`references/phase-6-post-merge-close.md` §6.1–§6.4）

### 5.3 Merge authorization（HARD）

**Merge 是独立的授权动作**：merge-ready、required CI 全绿、QC Approve、review `ship it` **各自单独出现时都不构成** merge 授权。授权只在 `pr_merge_policy` 对应下表**完整**谓词成立时才存在——`reviewed-auto` 要求 settled + 已 posted + `head` 等于当前 PR head 三者同时满足；`reviewed-bot` 要求挂载 bot 在该 head 上的最新 review 已达其自身门；`owner-gated` 只认下表定义的**人类 owner** 书面批准。

|`pr_merge_policy`|Merge 授权来源|
|---|---|
|`reviewed-auto`|**同时**满足 (a) 一份 **settled、已 posted**、且 `head` 等于**当前** PR head 的 `ship it` 报告（`mstar-pr-loop` 的 `ship it` 行），与 (b) §5.1b 的外部 AI review（**仅当存在挂载的 bot**；无 bot 时记 `N/A`）在当前 head 达到其自身通过线（Greptile 为 5/5，mstar-inspector 为 `mstar-inspector review` check `success`）、检查不失败且无未解决的 blocking finding（或用户针对该 finding/分数的书面 waive）——(a)(b) 缺一不可|
|`reviewed-bot`|挂载 bot 对**当前** PR head 的最新 review **已 settled 且达到其自身门**（mstar-inspector：按 check 名 `mstar-inspector review` 定位，**不按 bot 登录名**，判为 `success` 即已发布且不低于该 App 的 gate；Greptile：5/5），证据按 §5.1b Bot evidence 三处读取并绑定同一 head（空增量时按 §5.1b 的继承规则绑定内容相同的已 settled 基线，并记录两个 head），**`failure`、`neutral`、进行中或缺 run 都不算 settled**，整体 comment（即普通 PR review 报告格式）中被折叠的 omitted findings 同样计入未解决项；该 head 上无未解决的 blocking finding（或用户针对该 finding/分数的书面 waive）。**不要**另取本地 `ship it`——该 policy 下本地 loop 不运行；无 bot 挂载属于配置失效，不是授权成立|
|`owner-gated`|**人类 owner 本人**（操作者/用户，**不是**本 harness 的 coordinator 席位）对**当前** PR head 的**显式书面** merge 批准；PM 自己的 owner 席位不构成该批准。外部 AI review 达到其通过线且无 blocking finding 仍是 merge-ready 前置（§5.1b；**仅当挂载 bot，无 bot 记 `N/A`**），owner 批准不豁免它，除非自身即为对该 finding/分数的书面 waive|

- **`reviewed-auto` 未满足 → STOP**：等 PR 级 review 跑到 settled 的 `ship it`，**并且**（仅当挂载了外部 review bot；无 bot 时该面记 `N/A`）等 §5.1b 的外部 AI review 在当前 head 达到其通过线、无 blocking finding；任一未满足都不得 merge，二者不能互相替代。若授权报告或外部 verdict 的 `head` 已不是当前 PR head（中间有 push），重跑对应面取新结论。恢复路径：给出上述授权报告 + 外部 review 结论，或**重新进入 Phase 1 的 §1.2 流程**——加载 `mstar-iteration` → `references/phase-1-prepare.md`，按其「必须与用户显式确认，绝不默认」规则与用户重新确认后改动 compass 记录的 policy，新增 `## Decisions` 行记 `source: user`，并刷新 Phase 4 步骤 5 写入 PR 正文的 policy 行。PM **不得**在 Phase 5 就地改写 `pr_merge_policy`。
- **`reviewed-bot` 未满足 → STOP**：等挂载 bot 在当前 head 上的最新 review 跑完并达到其自身门（未发布/低于门/check 失败都不算），无阻塞 finding。若最新 verdict 的 head 已不是当前 PR head（中间有 push），等 bot 跟随该新 head 产出新 review，或按其文档化重触发（mstar-inspector 为 PR 作者或 repo owner 在 PR 评论中 @mention 该 App），**不得**改用本地 loop 顶替。同一 head 上 `neutral` **重复**时按 §5.1b 的具名出口收口——用户书面 waive（点名 surface 与确切 head）或 Phase 1 `pr_merge_policy` 重录——不得无限重触发。无 bot 挂载或 bot 已停用 → 恢复路径：重新进入 Phase 1 §1.2 与用户重新确认 policy（改走 `reviewed-auto` 或 `owner-gated`，`source: user`），或为该 PR 挂载/启用 bot 后重试；PM **不得**在 Phase 5 就地改写。
- **`owner-gated` 未满足 → hard stop**：给出 PR 链接 + merge-ready 证据后**等待**；**人类 owner**（操作者/用户，**不是** coordinator 席位）书面批准前不得 merge，任何自动化证据（mergeable / CI 绿 / QC Approve / `ship it`）都不能替代。恢复路径：人类 owner 书面批准当前 PR head，或**重新进入 Phase 1 的 §1.2 流程**——加载 `mstar-iteration` → `references/phase-1-prepare.md`，按其「必须与用户显式确认，绝不默认」规则与用户重新确认后改动 compass 记录的 policy，新增 `## Decisions` 行记 `source: user`，并刷新 Phase 4 步骤 5 写入 PR 正文的 policy 行。PM **不得**在 Phase 5 就地改写。
- **`pr_merge_policy` 缺失 → STOP**：**绝不**推断默认值。恢复路径：**重新进入 Phase 1 的 §1.2 流程**——加载 `mstar-iteration` → `references/phase-1-prepare.md`，按其「必须与用户显式确认，绝不默认」规则与用户确认该字段，写入 compass frontmatter 并在 `## Decisions` 记 `source: user`。

**Merge 前的 head 对账（可执行，不是谓词的复述）**：执行 merge 的前一步，取 `gh pr view <n> --json headRefOid`，与该 policy 的授权证据绑定的 head 逐字比较：

- `reviewed-auto` → 授权报告的 `head`。
- `reviewed-bot` → bot 证据的 head：bot check 的 `head_sha` 必须等于 `headRefOid`，且该 check **自身**的 conclusion 绑定在这个 head 上（mstar-inspector 按 check 名 `mstar-inspector review` 定位，不按 bot 登录名）；**发布** `publication:v1` marker 的 bot 另需整体 review comment 的 `sha=` 等于 `headRefOid`，或**空增量继承**时为内容完全相同的祖先（该 head 的 check 已按继承结果 terminalize；`compare/<comment-sha>...<head>` 返回 `files == 0` 且 `status` 为 `identical` / `ahead`），并在 Phase 5 证据里同时记录 `reviewed` 与 `current` 两个 head。**无 marker 的 bot**（例如 Greptile）绑定到此为止：其 check 的 `head_sha` 与自身 conclusion 只决定按哪个 head 判定，不构成授权——授权仍按 §5.3 该 policy 行成立（达到该 bot 自身门且无未解决的 blocking finding）；它也没有继承路径，只能等它对新 head 产出 review，或取得书面 waive。只有短 sha（`commit <sha7>`）或只有 line comments 不算绑定。
- `owner-gated` → 人类 owner 书面批准所针对的 head。

- 相等 → 授权成立，可以 merge。
- 不等 → **授权已失效**。授权之后任何 push 都作废它，包括 doc-only 的 changelog 补齐、allowlist 增删、注释修正——"delta 很小"不是理由，因为小 delta 同样会引入不准确的断言。此时合法出路按 policy：`reviewed-auto` / `owner-gated` 下取**新 head** 的完整结论，或对该 head 做一次**窄 delta ack**（同一席位签发，记录 `reviewed_head`、新 head、delta 的文件范围、以及"是否仍维持原结论"；delta ack 不是新 review，只在 delta 不触及代码/测试/配置/生成产物时可用，且必须写明被确认的 delta 范围）；`reviewed-bot` 下**没有** delta ack——bot 只能对自己的 head 出结论，出路只有等它对该新 head 产出 review，或按其文档化重触发后取其结论。

**谁执行 merge**：`reviewed-auto` 与 `reviewed-bot` 下，§5.3 授权谓词成立后由 **PM** 执行 merge；`owner-gated` 下，**人类 owner** 可自行 merge，或书面批准后由 PM 执行。三种 policy 都只在 §5.3 满足后才 merge；verified merge 之后进入 **Phase 6** —— merge 不是生命周期终点。
