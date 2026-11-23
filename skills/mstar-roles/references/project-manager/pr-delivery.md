# PR delivery: publish, merge-ready, authorize and verify

> Responsibility: publish a PR, drive it to merge-ready, then authorize and verify the merge. `mstar-roles/references/project-manager/workflow-close.md` follows a verified merge. One shared path serves both callers, and each supplies its own route inputs. **Read `mstar-harness-core` first.**

| Caller | Route inputs |
|---|---|
| Iteration | The anchors recorded on the ACTIVE workflow execution row — `branch.integration` (the PR head), `branch.target` (the base) and `integration_worktree_path` — mirrored in the compass frontmatter; the compass `pr_merge_policy` selects the review path. |
| Standalone development | Its registered delivery branch and target. |
| Report-only | None: a report-only workflow has no PR and does not enter this file. |

**Authorization source (one statement for both callers).** An iteration takes `pr_merge_policy` from its compass — exactly one of `reviewed-auto`, `reviewed-bot` or `owner-gated`, confirmed with the user at direction lock and never defaulted; a missing value → STOP and return to the iteration's direction-lock step. A standalone development PR takes the project's merge requirements plus the owner's approval naming the PR and head; absent → STOP and ask, and no compass is invented. **Route entry.** Iteration: its iteration-close exit checklist is all `[x]` and the close commit is pushed to `spec_integration_branch`; after its PR exists, the loop starts on that PR. Standalone: the compound disposition is recorded and the delivery branch head is finalized.

## Publish the PR

1. 打印 **`## Phase 4: PR delivery`**
2. Resolve target：iteration → ACTIVE workflow 执行行 `branch.target`（compass frontmatter 镜像）；standalone → registered target。缺失 → **STOP**，问用户
3. 创建 PR：iteration `spec_integration_branch` → `target_branch`；standalone → registered delivery branch → registered target
4. PR 正文须含 residual 披露节：本迭代各 plan 的 open R# 清单（id + severity + 跟踪位置 + blocker-defer 标记；无 open 时写 `N/A — none open`）—— 职责 → **`mstar-artifacts`**「Findings cleanup modes」
5. PR 正文须写明 compass 记录的 `pr_merge_policy`（`reviewed-auto` / `reviewed-bot` / `owner-gated`）—— reviewer 据此知道本 PR 的 review 由本地 loop 还是挂载的 bot 提供，以及是否被期待给出 merge 批准
6. Follow the shared public PR body interface → `mstar-roles/references/project-manager/pr-description.md`; item 4 above is that interface's residual disclosure applied to the iteration's plans, and item 5 is iteration-only.
7. Record PR URL / number and link the owning-session PM Task Board task (create it when none exists under the board contract) → `mstar-dispatch-gates` § PR feedback ownership (PM only).
8. **Immediately** 进入 **Phase 5** — **Phase 4 exit ≠ 迭代交付完成**

## Fix boundary

- **Iteration.** Phase 5 在 PR head（`spec_integration_branch`）上 push 修复；**禁止**另开替代分支
- **Checkout / worktree（HARD，iteration）**：Phase 5 是 PR 级 **hotfix** loop。产品修复在从 `spec_integration_branch` 出的独立 **fix feature worktree** 上编辑、commit；review 后在 **integration worktree**（路径取 ACTIVE workflow 执行行 `integration_worktree_path`）串行 merge 回 integration，再按 「Push cadence」 push。禁止在 integration 或主 checkout 直接编辑产品代码；三域表 → `mstar-branch-worktree`。
  Hotfix commit 仅用已配置身份；身份缺失或失败则 **Blocked**，不得编造或逐次提交覆盖身份 → `mstar-roles/references/_shared/leaf-executor-core.md`「Git NEVER (repo writes)」。
- **Iteration.** Fix routing and owner recovery → `mstar-dispatch-gates` § PR feedback ownership (PM only); Assignment **`Worktree path`** / cwd = absolute fix feature worktree path; PM merges back in the **integration worktree**.
- **Standalone development.** The fix is committed on the registered delivery branch in its dedicated worktree and pushed under 「Push cadence」, never the primary checkout (fix sites table → `mstar-pr-loop/SKILL.md`); the hotfix identity rule above still applies.
- 禁止为「让 CI 变绿」而改 workflow，除非用户明确授权
- **Push cadence** → 下一节（本地可提前修；**禁止**在 CI / AI review 波次未结束时 push）

## Push cadence (HARD — do not interrupt CI / AI review)

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

> **Engine check:** run `mstar iteration push-cadence [--ci-running] [--review-wave]` (engine `pushCadenceProbe`) to probe the push gate above. On `fail`, do not proceed — fix and re-run. Contract → `mstar-use-cli/references/checks-and-lints.md` § Engine check callouts.
History rewrite / force-with-lease / 改写后证据失效规则 SSOT → `mstar-branch-worktree`「History rewrite 与推送安全」节；本节只管 push 时序。

## Review paths and surfaces (HARD — one path, every attached surface settles)

**Iteration.** Phase 5 has exactly **two review paths**; the compass `pr_merge_policy` selects one at Phase 1. They differ only in who produces the review: the local loop **initiates** rounds, the bot path **receives** whatever rounds the bot starts under its own trigger mode — push-triggered or manual, never assumed. **Standalone development.** It has no compass policy: its review surfaces are the review bots the project attaches, each settled on the current head by its own bar (Bot evidence below), and the local `mstar-pr-loop` only when the user explicitly requests it — never started on its own (→ `mstar-pr-loop/SKILL.md`「Scope」).

| `pr_merge_policy` | Review path | Who produces the review | Evidence read |
|---|---|---|---|
| `reviewed-auto` | **Local loop** | `mstar-pr-loop` | its settled, posted `ship it` on the current head |
| `reviewed-bot` | **Bot-driven** | the attached review bot (mstar-inspector, Greptile, Bugbot or equivalent), on the PR — detected by its **check-run name**, never by its bot login | every artifact the bot actually publishes, per § Bot evidence, bound to this head — the check's conclusion on this head; from a bot that publishes the `publication:v1` marker, the overall review comment (the ordinary PR review report: verdict, tally, every finding including a disclosed omitted set, and the exact `sha=`) and the anchored line comments; a marker-less bot (for example Greptile) binds through its check's `head_sha` and that check's own bound conclusion alone, and its **5/5** score must come from an artifact bound to this head (the check's `output.summary`, or a comment the same run published) — with no failing check and no unresolved finding at or above the blocking tier (a P1/must-fix blocks; a failing check caused by the review itself is a blocking state) |
| `owner-gated` | none | nobody — the human owner's written approval (an attached bot still reviews the PR; its bar stays a surface of this section) | the human owner's written approval of the current head |

- **`reviewed-bot` never starts a local loop.** The bot owns PR review; Phase 5 monitors it like any other third-party reviewer: wait for the newest review/existing check on the current head, triage its findings through 「Merge-ready loop」 step 4, fix valid ones locally, and push under 「Push cadence」 — which is also what re-triggers the bot when it follows pushes. Under a manual trigger mode, use the bot's documented retrigger (for mstar-inspector, a PR comment from the PR author or repo owner that @mentions the App) instead of inventing a second review.
- **Under the iteration `reviewed-bot` policy only, no bot attached is a configuration failure, not `N/A`.** STOP and return to Phase 1 — that policy's direction-lock recovery — to re-confirm the policy, or attach/enable the bot; never silently downgrade to `reviewed-auto` or proceed unreviewed.
- **Under `reviewed-auto`, an attached bot stays mandatory** (its own passing bar plus the non-failing check and blocking-finding rule above). It is a second surface there, not a substitute for `ship it`.
- **No bot attached → `N/A`, not blocked** — only outside `reviewed-bot`. When no external review bot is configured on the PR, record `External AI review: N/A — no bot attached` in the Phase 5 evidence (`qc-consolidated`-equivalent note or the PR body) and proceed on the internal surface alone. Do not invent a bot result and do not treat the absence as a green verdict.
- **A bot that is attached is mandatory.** Once a bot has reviewed the head (or a check for it exists), its bar applies as above; you may not disable or ignore it to reach merge-ready.
- The bot surface settles on a **loop of pushes**, not a one-shot read: drive it to its passing bar by fixing confirmed findings and letting the bot re-review the new head — you never drive it with a local review driver. A green check with a sub-threshold result (for example Greptile below 5/5) is **not** settled.
- A `ship it` from the internal loop **never** waives an unresolved bot finding or a sub-threshold bot score; a bot's silence is not evidence either — read its verdict and its inline comments on the current head.
- If the bot reports findings, treat them like QC findings: confirm each against the code, fix the valid ones, and record why an invalid one is rejected. Re-run the bot only by pushing a new head (「Push cadence」) or its documented retrigger.
- A bot check that fails for infrastructure reasons (quota, app error) is still **not green**: state the cause, and either retrigger or obtain the user's written waiver naming the surface and the head.
- Review paths settle independently of the bot surface: do not stop the local loop because the bot is green, and do not merge because the local loop is green while the bot is red.

#### Bot evidence (every attached bot)

This procedure holds for every attached bot: the iteration `reviewed-bot` path, the external surface under iteration `reviewed-auto` and `owner-gated`, and the bots attached to a standalone development PR. A bot publishes up to **three** artifacts for one head — the check, an overall review comment, and anchored line comments; a transition reads every artifact that bot actually publishes (a marker-less bot may publish no marked review comment), never a thread list alone. **Identify the bot by its check-run name, plus its publication marker only if it publishes one, never by a bot login** — the account is `<slug>[bot]` and varies per installation, while the check name is the stable key. For mstar-inspector the name is exactly `mstar-inspector review` and the comment marker prefix is `<!-- mstar-inspector:review:v1`; another bot uses its own check name, plus its own marker only if it publishes one, and is detected the same way:

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

- **The comment body is the ordinary PR review report, not a bot-specific format.** It carries the same layout and vocabulary as `mstar-audit` → `mstar-audit/references/pr-review.md`: the verdict token (`ship it` / `needs fixes` / `blocked` / `incomplete`), the tally table by merge class (`must-fix` / `should-fix` / `may-fix` / `nit`), `## 📋 Review`, and one `### Findings` block per finding with evidence, location, category and merge class. Read it through that contract — the merge class decides whether a finding blocks, and the tally-derived verdict is the same verdict the local path publishes. Do not invent a bot-only parser or a second finding schema.

- **Findings live in the comment body, not only in threads.** Read the whole comment: a `(+N more findings omitted)` footer means the merge-class cap hid findings — those still count as reported, so reopen the omitted set from the bot's dashboard or treat them as unresolved rather than assuming only threads exist.
- **Bind every artifact to one head.** Always the bot check's `head_sha` plus **that check's own conclusion bound to this head**, and each line comment's `commit_id`; the comment's `publication:v1 … sha=` only from a bot that publishes that marker — a marker-less bot (for example Greptile) binds through its check's `head_sha` and bound conclusion alone, with no comment-marker requirement. Every artifact the bot does publish must equal `gh pr view --json headRefOid`. Any other head is a stale round and authorizes nothing, with the single exception below; a short `commit <sha7>` line in the comment is a hint, never the binding value.
- **An empty increment inherits from the reviewed head.** mstar-inspector acks a head whose `base...head` is empty: it publishes no new review, while its check on **that** head terminalizes to the reviewed head's result as an inherited `success`/`failure` (`terminalizeCheck(…, "skipped", sinceSha)` → `decideConclusion`'s inherited branch, fail-closed). So on such a head the check is authoritative while the review comment still carries the older `sha=`. Accept that pair only when the two heads carry identical content — `gh api "repos/<owner>/<repo>/compare/<comment-sha>...<head>" --jq '{status, ahead_by, behind_by, files: (.files|length)}'` returns `files == 0` with `status` `identical` or `ahead` — and record both heads (`reviewed` and `current`) in the Phase 5 evidence. A different tree, a non-ancestor, no check on the current head, or no settled comment stays unsettled. A bot that publishes no such marker (for example Greptile) has no inheritance path: push a new head and let that head's own review settle, or clear a blocking finding or a sub-threshold score with a written waiver that names the finding or score it waives — a waiver naming only a head is an escalation record only and never authorizes merge.
- **Conclusion matrix** (mstar-inspector): `success` = published and at or above the App gate — the only merge-ready conclusion, except for the inherited result named under `skipped`; `skipped` = an **internal** terminalization, never a published conclusion: an empty increment acks via `terminalizeCheck(…, "skipped", sinceSha)` and publishes no new review, so **the check carries the reviewed head's inherited `success`/`failure`** — an inherited result is the documented exception to the published half of `success` (accepted only under the 「Review paths and surfaces」 empty-increment binding: identical content, both heads recorded), and an inherited `failure` stays `failure`; `failure` = gate missed, degraded, unpublished, superseded or unknown, so read `summary` when present to name the cause; `neutral` = an empty increment with no inheritable result, meaning **this head has no bot verdict** — not settled: wait for a new head or one documented retrigger, and if `neutral` **repeats** on that head, name its exits instead of looping — the user's written waiver naming the surface and the **exact head** (「Review paths and surfaces」 infrastructure shape), which is a documented escalation only (`neutral` has no finding or score to waive, so it does **not** authorize merge), or the 「Merge authorization」 Phase 1 `pr_merge_policy` re-record, which is an escalation that changes which gate governs the PR, never an authorization that clears it — an attached bot's own bar still applies under `reviewed-auto` and `owner-gated` (「Review paths and surfaces」, 「Merge authorization」), disabling or detaching it to reach merge-ready is forbidden, so the head still needs a real bot verdict; never endless retriggering and never a PM-issued waiver; `queued`/`in_progress` = still running — not settled; **no run at all** on this head = no bot verdict here (not an inheritance signal — an empty increment already carries an inherited check) — not settled. Never translate `failure`/`neutral`/absence into a pass.

## Merge-ready loop

**Precondition**: the route's PR is created and its head is the route's head branch (iteration: `spec_integration_branch`).

**Loop 理念**（mstar SSOT）：PR 开完后进入 **验证—修复—再验证** 循环，直至 PR 可合并。与 Phase 2 per-plan loop 类似，但对象是 **PR 级** merge 门禁（CI、review、冲突），不是 plan 实现。（repeat until the Merge-ready checklist items 1–5 are all `[x]`）

1. **Status** — PR mergeable？required CI？unresolved review threads？**任一 CI/AI review 是否仍在跑？**
2. **Merge conflicts** — blocking 则**本地**解决：iteration 在 integration 分支；standalone development 在 registered delivery branch 的专属 worktree。**仅当 「Push cadence」 push gate 满足时**再 push（意图冲突 → **Blocked**）
3. **Review dispatch** — **Iteration（按 compass `pr_merge_policy`）**：`reviewed-auto`：PR 级 review 归 **`mstar-pr-loop`** 所有——它自己跑 review → fix → re-review 循环，并按 「Push cadence」 的 push cadence 推进；**不要**在每个 merge-ready 迭代里另起第二个 review loop。「Merge-ready loop」 在该轮内**暂停第 4 步的 review 修复分派与第 6 步的 push**——这两项由该 loop 一并执行（「Push cadence」 仍逐次适用，单一 pusher，避免同一 head 两个推手）。**第 5 步的 required-CI 修复保留**：可由 「Merge-ready loop」 本地开工，但其 push 同样走该 loop 的批（「Push cadence」），不得另起第二推手。「Merge-ready loop」 仍负责 mergeable 与 required-CI 观测。「Merge authorization」 读取该 loop 在当前 PR head 上最终 settled、已 posted 的 `ship it` 报告作为授权。`reviewed-bot`：**不**起任何本地 review loop——挂载的 bot 按其自身触发模式（push 触发或手动触发）产出 review，「Merge-ready loop」 只监控该 review 是否已落到当前 head 并达到其自身门（「Review paths and surfaces」），其 findings 走第 4 步普通第三方 triage，push 仍守 「Push cadence」。`owner-gated`：**完全**不起 PR 级 review loop，**人类 owner** 的 review 就是 gate，Phase 5 停在 merge-ready 等其书面批准。**Standalone development**：不按 compass 选择——按项目挂载的 review surface 推进，每个 bot 按其自身门在 current head settled（「Review paths and surfaces」）；只有用户明确要求时才运行本地 `mstar-pr-loop`，不得自行启动；一旦用户明确要求，该 loop 即拥有本轮的 review 修复分派与 PR-head push 批次，「Merge-ready loop」 在该轮内**暂停第 4 步的 review 修复分派与第 6 步的 push**（含 required-CI 修复的 push），挂载 bot 与 required-CI 观测仍归本 loop（「Push cadence」 仍逐次适用，单一 pusher）。
4. **Reviews** — `reviewed-auto`：fetch unresolved threads；triage；dispatch **本地**修复（可在上一波次仍在跑时开工）。`reviewed-bot`：读 bot 在当前 head 上的证据并按 「Review paths and surfaces」 Bot evidence 取全量 findings——整体 review comment（全部 finding 块，含被折叠的 omitted 声明）、anchored line comments（行内副本，即可 resolve 的 thread）、`mstar-inspector review` check（结论与 summary）；**不要**只 fetch threads 就当作该 head 的全部 findings。triage 与本地修复同本地路径，bot 已自行 resolve 的线程不重复处理。
5. **CI** — 失败项在 PR 范围内**本地**修复（可提前开工）；**不**在 CI 仍在跑时 push
6. **Push** — 仅当 「Push cadence」 满足：无 in-flight CI，上一波 CI **与** reviews 均已跑完 → **一次** push 本批修复
7. **Review fix hygiene**（每次 push 后；`reviewed-auto` 轮内即该 loop 的那次 push，`reviewed-bot` 下即 bot 按自身触发模式开始下一轮的那次 push——手动触发时为该 bot 的文档化重触发）：
   - 在同 thread **comment**（改动 + 验证）
   - **Resolve** when addressed
8. Return to step 1（CI 结束后若出现 **新** reviews → 继续本地修，再等 idle 后 push）

**Optional host helpers（command 层发现；非 `mstar-*` load order）**：

| Priority | Helper | When |
|----------|--------|------|
| 1 | `babysit` or any `*-babysit` skill（first readable `SKILL.md`） | **Default prefer** — CI green + reviews resolved loop |
| 2 | `greploop` | **Driver for the mandatory external bar** — the external bot's settlement is required per 「Review paths and surfaces」; when the repo uses Greptile, drive it with `greploop` to the loop's **5/5** target. Without the helper, achieve the same bar manually and read the bot's score, check and inline comments directly |
| 3 | neither | Command fallback = babysit-equivalent CI + reviews gates |

When both babysit/`*-babysit` and greploop apply: **babysit/`*-babysit` first**（CI + reviews），then optional greploop for Greptile score. Discovery paths → **`mstar-iteration/references/pr-helper-discovery.md`**（command 层按需发现）。

## Merge-ready checklist

打印 **`## Phase 5 exit checklist`**；**第 1–5 项全 `[x]` = merge-ready**（第 6 项是 merge-ready 的 todo 勾选动作，其条件即第 1–5 项），第 7 项（**Merge authorization**）是 merge 与进入 Phase 6 的独立前置（见「Merge authorization」），第 8 项为 transition marker（merged 后才可勾）。**整表全 `[x]` 只在 merge 之后成立**（Phase 6 进入前置），不得作为 merge-ready 的定义或 `phase-5-pr-merge-ready` todo 的关闭条件（否则要求先 merge，`owner-gated` 下自相矛盾）；**Standalone development 路线：声明 merge-ready 之前必须已取得只读 close-state probe 的记录结果，且其中只有预期的 running-state 代码；出现 defect 代码即在该代码清除前不算 merge-ready**（命令、预期代码与 defect 恢复归其所有者：`workflow-close.md` 的 engine-check callout 与 `plan-management.md`「Merge-ready precondition」）；此后唯一出口是 **Phase 6**（PR merged 后执行 `mstar-roles/references/project-manager/workflow-close.md`：Terminal write → Unregister → Projection reconciliation → Cleanup handoff）——本 checklist **不是**「迭代交付完成」：

- [ ] PR mergeable（无 blocking merge conflicts）
- [ ] All **required** CI checks green on latest head
- [ ] **Review path + external AI review** settled on the latest head — `reviewed-auto`: a settled, posted `ship it` from `mstar-pr-loop`; `reviewed-bot`: the attached bot's review reached its own passing bar on that head (mstar-inspector `success`, Greptile 5/5 — never `N/A`, never `failure`/`neutral`, never in progress); on an empty increment only a marker-publishing bot inherits — the head's own check carries an inherited result from an ancestor whose content equals this head (「Review paths and surfaces」) — while a marker-less bot has no inheritance path and must settle through its own check on this head; `owner-gated`: none of these is the gate — the human approval below is, while an attached bot still counts as the external surface. **Whenever a bot is attached, 「Merge authorization」's per-bot passing bar applies under every policy** — `reviewed-auto` and `owner-gated` included: that bot reached its own passing bar on this head exactly as 「Merge authorization」's row requires (mstar-inspector `success`, Greptile 5/5 — a marker-less bot's bar is its own scored threshold read from an artifact bound to this head; an unbound score is unsettled), with no blocking finding unresolved; a merely non-failing check, the local `ship it`, or the owner's approval never substitutes for it. Record `N/A — no bot attached` only when no bot is attached; a user-written waiver names the surface, finding/score and exact head — 「Review paths and surfaces」, 「Merge authorization」; a repeated `neutral` has no finding or score to waive, so no waiver authorizes it. **Standalone development**: each attached review bot settled on the current head by its own bar; the local `mstar-pr-loop` only on the user's explicit request.
- [ ] All review threads **resolved**（或用户逐条书面 waive 特定 thread）；`reviewed-bot` 下整体 comment 中的每条 finding 已 addressed 或书面 waive（成文的 omitted findings 同样适用）。该项同时是 「Unresolved conversation gate」 的输入：归在 checklist 不免除 merge 前的独立枚举，以及存在未解决项时的两次确认
- [ ] 「Merge-ready loop」 review comment + resolve 已覆盖本轮所有 addressed feedback
- [ ] Host todo `phase-5-pr-merge-ready` 可勾选
- [ ] **Merge authorization** — satisfied per 「Merge authorization」, and 「Unresolved conversation gate」 passed (no unresolved thread, or each named and confirmed twice)
- [ ] PR **merge** 完成后进入 **Phase 6**：追加 todo `phase-6-post-merge-close`，执行 post-merge close（`mstar-roles/references/project-manager/workflow-close.md`）

## Merge authorization (HARD)

**Iteration route.** **Merge 是独立的授权动作**：merge-ready、required CI 全绿、QC Approve、review `ship it` **各自单独出现时都不构成** merge 授权。授权只在 `pr_merge_policy` 对应下表**完整**谓词成立**且 「Unresolved conversation gate」 通过**时才存在——`reviewed-auto` 要求 settled + 已 posted + `head` 等于当前 PR head 三者同时满足；`reviewed-bot` 要求挂载 bot 在该 head 上的最新 review 已达其自身门；`owner-gated` 只认下表定义的**人类 owner** 书面批准。**Standalone development route.** Authorization is the owner's explicit merge instruction naming the PR and the current head, on top of the merge-ready checklist and the unresolved-conversation gate. When it is absent, STOP and ask the owner; no compass is invented and nothing returns to an iteration direction lock. The three-row predicate table and the STOP recoveries below are the iteration route.

|`pr_merge_policy`|Merge 授权来源|
|---|---|
|`reviewed-auto`|**同时**满足 (a) 一份 **settled、已 posted**、且 `head` 等于**当前** PR head 的 `ship it` 报告（`mstar-pr-loop` 的 `ship it` 行），与 (b) 「Review paths and surfaces」 的外部 AI review（**仅当存在挂载的 bot**；无 bot 时记 `N/A`）在当前 head 达到其自身通过线（Greptile 为 5/5，mstar-inspector 为 `mstar-inspector review` check `success`）、检查不失败且无未解决的 blocking finding（或用户针对该 finding/分数的书面 waive）——(a)(b) 缺一不可|
|`reviewed-bot`|挂载 bot 对**当前** PR head 的最新 review **已 settled 且达到其自身门**（mstar-inspector：按 check 名 `mstar-inspector review` 定位，**不按 bot 登录名**，判为 `success` 即已发布且不低于该 App 的 gate；Greptile：5/5），证据按 「Review paths and surfaces」 Bot evidence 读取该 bot 实际发布的每个 artifact 并绑定同一 head——**发布** `publication:v1` marker 的 bot 需整体 review comment 的 `sha=` 等于该 head，空增量时按 「Review paths and surfaces」 的继承规则绑定内容相同的已 settled 基线并记录两个 head；**无 marker 的 bot** 仅以 check 的 `head_sha` 与该 check 自身绑定的 conclusion 绑定此 head，其分数须来自绑定该 head 的 artifact（未绑定的分数不算 settled），且**没有继承路径**，**`failure`、`neutral`、进行中或缺 run 都不算 settled**，整体 comment（即普通 PR review 报告格式）中被折叠的 omitted findings 同样计入未解决项；该 head 上无未解决的 blocking finding（或用户针对该 finding/分数的书面 waive；重复 `neutral` 无 finding 或分数，不在其列）。**不要**另取本地 `ship it`——该 policy 下本地 loop 不运行；无 bot 挂载属于配置失效，不是授权成立|
|`owner-gated`|**人类 owner 本人**（操作者/用户，**不是**本 harness 的 coordinator 席位）对**当前** PR head 的**显式书面** merge 批准；PM 自己的 owner 席位不构成该批准。外部 AI review 达到其通过线且无 blocking finding 仍是 merge-ready 前置（「Review paths and surfaces」；**仅当挂载 bot，无 bot 记 `N/A`**），owner 批准不豁免它，除非自身即为对该 finding/分数的书面 waive|

- **`reviewed-auto` 未满足 → STOP**：等 PR 级 review 跑到 settled 的 `ship it`，**并且**（仅当挂载了外部 review bot；无 bot 时该面记 `N/A`）等 「Review paths and surfaces」 的外部 AI review 在当前 head 达到其通过线、无 blocking finding；任一未满足都不得 merge，二者不能互相替代。若授权报告或外部 verdict 的 `head` 已不是当前 PR head（中间有 push），重跑对应面取新结论。恢复路径：给出上述授权报告 + 外部 review 结论，或**重新进入 Phase 1 的 §1.2 流程**——加载 `mstar-iteration/references/phase-1-prepare.md`，按其「必须与用户显式确认，绝不默认」规则与用户重新确认后改动 compass 记录的 policy，新增 `## Decisions` 行记 `source: user`，并刷新 Phase 4 步骤 5 写入 PR 正文的 policy 行。PM **不得**在 Phase 5 就地改写 `pr_merge_policy`。
- **`reviewed-bot` 未满足 → STOP**：等挂载 bot 在当前 head 上的最新 review 跑完并达到其自身门（未发布/低于门/check 失败都不算），无阻塞 finding。若最新 verdict 的 head 已不是当前 PR head（中间有 push），等 bot 跟随该新 head 产出新 review，或按其文档化重触发（mstar-inspector 为 PR 作者或 repo owner 在 PR 评论中 @mention 该 App），**不得**改用本地 loop 顶替。同一 head 上 `neutral` **重复**时按 「Review paths and surfaces」 的具名出口收口——用户书面 waive（点名 surface 与确切 head）仅是升级记录，`neutral` 无 finding 或分数可 waive，**不构成**授权。Phase 1 `pr_merge_policy` 重录同样是**升级而非授权**：它改变的是门禁归属，不会清除挂载 bot 的门——bot 仍挂载时，其自身达到通过线在 `reviewed-auto` 与 `owner-gated` 下依旧是 merge-ready 前置（「Review paths and surfaces」：为达成 merge-ready 而停用、忽略或脱离它被禁止），所以重录后该 head 仍然需要一个**真实 bot verdict**。因此要真正推进，用户只能决定如何让该 head 取得 verdict——推一个含真实内容的新 head（空增量仍是 `neutral`），或按其文档化方式重触发（mstar-inspector 为 PR 作者或 repo owner 在 PR 评论中 @mention 该 App）；没有 finding 或分数可 waive，也没有可补发的授权，bot 面本身失效时那是 Phase 1 要与用户确认的**升配**问题，不是 merge 授权。不得无限重触发。无 bot 挂载或 bot 已停用 → 恢复路径：重新进入 Phase 1 §1.2 与用户重新确认 policy（改走 `reviewed-auto` 或 `owner-gated`，`source: user`），或为该 PR 挂载/启用 bot 后重试；PM **不得**在 Phase 5 就地改写。
- **`owner-gated` 未满足 → hard stop**：给出 PR 链接 + merge-ready 证据后**等待**；**人类 owner**（操作者/用户，**不是** coordinator 席位）书面批准前不得 merge，任何自动化证据（mergeable / CI 绿 / QC Approve / `ship it`）都不能替代。恢复路径：人类 owner 书面批准当前 PR head，或**重新进入 Phase 1 的 §1.2 流程**——加载 `mstar-iteration/references/phase-1-prepare.md`，按其「必须与用户显式确认，绝不默认」规则与用户重新确认后改动 compass 记录的 policy，新增 `## Decisions` 行记 `source: user`，并刷新 Phase 4 步骤 5 写入 PR 正文的 policy 行。PM **不得**在 Phase 5 就地改写。
- **`pr_merge_policy` 缺失（iteration 路线）→ STOP**：**绝不**推断默认值。恢复路径：**重新进入 Phase 1 的 §1.2 流程**——加载 `mstar-iteration/references/phase-1-prepare.md`，按其「必须与用户显式确认，绝不默认」规则与用户确认该字段，写入 compass frontmatter 并在 `## Decisions` 记 `source: user`。

## Unresolved conversation gate (HARD — before head reconciliation, independent of pr_merge_policy)

- **枚举**：merge 前必须针对**当前** PR 枚举全部 review thread，执行 `mstar pr merge-gate --pr <n>`（它读取每条 thread 的作者、`path:line` 与首条评论，分页耗尽即拒绝）；人类与 bot 都算，**不按 merge class 过滤**，`isResolved: false` 的每一条都是未解决项，`isOutdated` 不豁免。
- **门**：未解决项 > 0 时**不得 merge**，唯一出口是「恢复路径」的逐条 waive + 两次确认，或全部 resolve——owner 批准、`ship it`、CI 绿、「Merge authorization」 谓词成立都不能替代本 gate；本 gate 不因 thread 被归在 「Merge-ready checklist」 第 4 项而免检。
- **清单**：PM 必须逐条列出 `author.login`、`path:line`、首条评论要点（bot 报告有 merge class 时一并给出），不得只报数量或以「有些评论」概括。
- **两次确认**：存在未解决项时（clean 枚举按 「Merge-ready checklist」 第 4 项直接通过，不需用户确认），展示清单后发出**第一次**明确询问「是否确认合并」；用户确认后，PM 必须复述同一清单与当前 head 并发起**第二次**确认，之后才可执行 merge。两次确认之间发生 push、出现新的未解决 thread 或清单变化 → 前一次确认作废并重走；确认结果写入 `--confirm` 文件（`{head, confirmations: 2, threads: [<thread id>...], digest}`，`digest` 取自该命令对未解决清单的输出），**head 对账（「Head reconciliation before merge」）之后、执行 merge 之前必须重跑同一条命令复验**——新 head、未解决集合变化（含新出现的未解决 thread、某条未解决 thread 被重新打开）或未解决 thread 的首条评论被编辑都会使复验失败，即无授权。
- **waive 粒度**：笼统的「合并」「可以了」不构成 waive；waive 必须逐条点名（thread id 或 `path:line` + 作者），且点名的是**该 thread**——只点名 head 或 surface 的 waive 不适用本 gate。
- **恢复路径**：修复后 resolve（或由 reviewer/bot 自行 resolve）即通过；用户逐条书面 waive 且经上述两次确认亦通过——两者之外没有第三种出路。
- **`owner-gated`**：owner 自行 merge 时 PM 无法拦截，但 PM **不得**把未解决项记为 resolved，也不得丢弃清单；由 PM 执行的 merge（含 owner 书面批准后的执行）一律先过本 gate。owner 在确认前自行 merge → Phase 6 仍按「verified merge 已发生」进入，入口记录该 head 上的未解决 thread 清单与**实际处置**（逐条 resolved-in-fact / still-open，不得写成已确认或已 waive），保留到 close；这不豁免下一次 merge 的 gate。

## Head reconciliation before merge

**可执行，不是谓词的复述。** 执行 merge 的前一步，取 `gh pr view <n> --json headRefOid`，与该 policy 的授权证据绑定的 head 逐字比较（standalone：与 owner 明确 merge 指示中命名的 head 比较；任何 push 作废该指示，owner 须重新点名新 head）：

- `reviewed-auto` → 授权报告的 `head`。
- `reviewed-bot` → bot 证据的 head：bot check 的 `head_sha` 必须等于 `headRefOid`，且该 check **自身**的 conclusion 绑定在这个 head 上（mstar-inspector 按 check 名 `mstar-inspector review` 定位，不按 bot 登录名）；**发布** `publication:v1` marker 的 bot 另需整体 review comment 的 `sha=` 等于 `headRefOid`，或**空增量继承**时为内容完全相同的祖先（该 head 的 check 已按继承结果 terminalize；`compare/<comment-sha>...<head>` 返回 `files == 0` 且 `status` 为 `identical` / `ahead`），并在 Phase 5 证据里同时记录 `reviewed` 与 `current` 两个 head。**无 marker 的 bot**（例如 Greptile）绑定到此为止：其 check 的 `head_sha` 与自身 conclusion 只决定按哪个 head 判定，不构成授权——授权仍按 「Merge authorization」 该 policy 行成立（达到该 bot 自身门且无未解决的 blocking finding）；它也没有继承路径：只能等它对新 head 产出 review，或就某个 blocking finding / 未达门的分数取得点名该 finding 或分数的书面 waive——只点名 head 的 waive 仅是升级记录，**不构成**授权。只有短 sha（`commit <sha7>`）或只有 line comments 不算绑定。
- `owner-gated` → 人类 owner 书面批准所针对的 head。

- 相等 → 授权成立；但 head 相等本身不授权 merge：该 head 上适用的最终 thread-gate 复验（「Unresolved conversation gate」）也必须通过，才可 merge。
- 不等 → **授权已失效**。授权之后任何 push 都作废它，包括 doc-only 的 changelog 补齐、allowlist 增删、注释修正——"delta 很小"不是理由，因为小 delta 同样会引入不准确的断言。此时合法出路按 policy：`reviewed-auto` / `owner-gated` 下取**新 head** 的完整结论，或对该 head 做一次**窄 delta ack**（同一席位签发，记录 `reviewed_head`、新 head、delta 的文件范围、以及"是否仍维持原结论"；delta ack 不是新 review，只在 delta 不触及代码/测试/配置/生成产物时可用，且必须写明被确认的 delta 范围）；`reviewed-bot` 下**没有** delta ack——bot 只能对自己的 head 出结论，出路只有等它对该新 head 产出 review，或按其文档化重触发后取其结论。

## Who performs the merge

**谁执行 merge**：`reviewed-auto` 与 `reviewed-bot` 下，「Merge authorization」 授权谓词成立**且 「Unresolved conversation gate」 通过**后由 **PM** 执行 merge；`owner-gated` 下，**人类 owner** 可自行 merge，或书面批准后由 PM 执行（PM 执行前同样先过 「Unresolved conversation gate」）。三种 policy 都只在 「Merge authorization」 满足且 「Unresolved conversation gate」 通过后才 merge。**Standalone development**：由 **人类 owner** 自行 merge，或 owner 明确指示后由 PM 执行（PM 执行前同样先过「Unresolved conversation gate」）。verified merge 之后进入 **Phase 6** —— merge 不是生命周期终点。
