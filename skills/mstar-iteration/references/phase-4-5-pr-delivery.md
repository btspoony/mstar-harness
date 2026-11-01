# Phase 4 & 5: PR delivery + merge-ready loop

> Loaded by `mstar-iteration` SKILL.md when entering Phase 4/5. **Read `mstar-harness-core` first.** 进入前置：Phase 3 §3.5 exit 全 `[x]`（Phase 4）；Phase 4 PR 已创建（Phase 5）。

## Phase 4: PR delivery（开 PR）

**Precondition**: Phase 3 §3.5 exit 全 `[x]`；close commit 已 push 到 `spec_integration_branch`。

1. 打印 **`## Phase 4: PR delivery`**
2. Resolve target：ACTIVE workflow 执行行 `branch.target`（compass frontmatter 镜像）；缺失 → **STOP**，问用户
3. 创建 PR：`spec_integration_branch` → `target_branch`
4. PR 正文须含 residual 披露节：本迭代各 plan 的 open R# 清单（id + severity + 跟踪位置 + blocker-defer 标记；无 open 时写 `N/A — none open`）—— 职责 → **`mstar-artifacts`**「Findings cleanup modes」
5. PR 正文须写明 compass 记录的 `pr_merge_policy`（`reviewed-auto` / `owner-gated`）—— reviewer 据此知道本 PR 是否被期待给出 merge 批准
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

> **Engine check (when available):** run `mstar iteration push-cadence [--ci-running] [--review-wave]` (or `import { pushCadenceProbe } from "@mstar-harness/engine"` in a host hook) to probe the push gate above. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.
History rewrite / force-with-lease / 改写后证据失效规则 SSOT → `mstar-branch-worktree`「History rewrite 与推送安全」节；本节只管 push 时序。

### 5.1b Two review surfaces（HARD — both must settle）

A PR can carry **two independent review surfaces**, and merge-ready requires both **when both exist**:

| Surface | Owner | Evidence |
|---|---|---|
| **Internal PR loop** (only when `reviewed-auto`) | `mstar-pr-loop` | its settled, posted `ship it` on the current head |
| **External AI review** — only when a review bot is actually attached/enabled on the PR (Greptile, Bugbot, or equivalent) | that bot, on the PR | its **own passing bar** on the current head — for Greptile that is the loop's **5/5** score — plus a non-failing check and no unresolved finding at or above the blocking tier (a P1/must-fix blocks; a failing check caused by the review itself is a blocking state) |

- **No bot attached → `N/A`, not blocked.** When no external review bot is configured on the PR, record `External AI review: N/A — no bot attached` in the Phase 5 evidence (`qc-consolidated`-equivalent note or the PR body) and proceed on the internal surface alone. Do not invent a bot result and do not treat the absence as a green verdict.
- **A bot that is attached is mandatory.** Once a bot has reviewed the head (or a check for it exists), its bar applies as above; you may not disable or ignore it to reach merge-ready.

- The external surface is a **loop**, not a one-shot read: drive it to its passing bar (Greptile: 5/5) by fixing confirmed findings and re-running it on a new head, exactly as the internal loop is driven to `ship it`. A green check with a sub-threshold score (for example Greptile below 5/5) is **not** settled.
- A `ship it` from the internal loop **never** waives an unresolved external finding or a sub-threshold external score; an external bot's silence is not evidence either — read its verdict and its inline comments on the current head.
- If the bot reports findings, treat them like QC findings: confirm each against the code, fix the valid ones, and record why an invalid one is rejected. Re-run the bot only by pushing a new head (§5.1a) or its documented retrigger.
- A bot check that fails for infrastructure reasons (quota, app error) is still **not green**: state the cause, and either retrigger or obtain the user's written waiver naming the surface and the head.
- The two surfaces settle independently; do not stop the internal loop because the bot is green, and do not merge because the internal loop is green while the bot is red.

### 5.1 Loop（repeat until §5.2 第 1–5 项全 `[x]`）

1. **Status** — PR mergeable？required CI？unresolved review threads？**任一 CI/AI review 是否仍在跑？**
2. **Merge conflicts** — blocking 则在 integration 分支**本地**解决；**仅当 §5.1a push gate 满足时**再 push（意图冲突 → **Blocked**）
3. **Review dispatch（按 compass `pr_merge_policy`）** — `reviewed-auto`：PR 级 review 归 **`mstar-pr-loop`** 所有——它自己跑 review → fix → re-review 循环，并按 §5.1a 的 push cadence 推进；**不要**在每个 §5.1 迭代里另起第二个 review loop。§5.1 在该轮内**暂停第 4 步的 review 修复分派与第 6 步的 push**——这两项由该 loop 一并执行（§5.1a 仍逐次适用，单一 pusher，避免同一 head 两个推手）。**第 5 步的 required-CI 修复保留**：可由 §5.1 本地开工，但其 push 同样走该 loop 的批（§5.1a），不得另起第二推手。§5.1 仍负责 mergeable 与 required-CI 观测。§5.3 读取该 loop 在当前 PR head 上最终 settled、已 posted 的 `ship it` 报告作为授权。`owner-gated`：**完全**不起 PR 级 review loop，**人类 owner** 的 review 就是 gate，Phase 5 停在 merge-ready 等其书面批准
4. **Reviews** — fetch unresolved threads；triage；dispatch **本地**修复（可在上一波次仍在跑时开工）
5. **CI** — 失败项在 PR 范围内**本地**修复（可提前开工）；**不**在 CI 仍在跑时 push
6. **Push** — 仅当 §5.1a 满足：无 in-flight CI，上一波 CI **与** reviews 均已跑完 → **一次** push 本批修复
7. **Review fix hygiene**（每次 push 后；`reviewed-auto` 轮内即该 loop 的那次 push）：
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
- [ ] **External AI review** settled on the latest head at its own passing bar (Greptile: 5/5), check not failing, no unresolved blocking finding — or explicitly `N/A — no bot attached`; a user-written waiver names the surface, finding/score and head — §5.1b
- [ ] All review threads **resolved**（或用户书面 waive 特定 thread）
- [ ] §5.1 review comment + resolve 已覆盖本轮所有 addressed feedback
- [ ] Host todo `phase-5-pr-merge-ready` 可勾选
- [ ] **Merge authorization** — satisfied per §5.3
- [ ] PR **merge** 完成后进入 **Phase 6**：追加 todo `phase-6-post-merge-close`，执行 post-merge close（`references/phase-6-post-merge-close.md` §6.1–§6.4）

### 5.3 Merge authorization（HARD）

**Merge 是独立的授权动作**：merge-ready、required CI 全绿、QC Approve、review `ship it` **各自单独出现时都不构成** merge 授权。授权只在 `pr_merge_policy` 对应下表**完整**谓词成立时才存在——`reviewed-auto` 要求 settled + 已 posted + `head` 等于当前 PR head 三者同时满足；`owner-gated` 只认下表定义的**人类 owner** 书面批准。

|`pr_merge_policy`|Merge 授权来源|
|---|---|
|`reviewed-auto`|**同时**满足 (a) 一份 **settled、已 posted**、且 `head` 等于**当前** PR head 的 `ship it` 报告（`mstar-pr-loop` 的 `ship it` 行），与 (b) §5.1b 的外部 AI review（**仅当存在挂载的 bot**；无 bot 时记 `N/A`）在当前 head 达到其自身通过线（Greptile 为 5/5）、检查不失败且无未解决的 blocking finding（或用户针对该 finding/分数的书面 waive）——(a)(b) 缺一不可|
|`owner-gated`|**人类 owner 本人**（操作者/用户，**不是**本 harness 的 coordinator 席位）对**当前** PR head 的**显式书面** merge 批准；PM 自己的 owner 席位不构成该批准。外部 AI review 达到其通过线（Greptile 5/5）且无 blocking finding 仍是 merge-ready 前置（§5.1b；**仅当挂载 bot，无 bot 记 `N/A`**），owner 批准不豁免它，除非自身即为对该 finding/分数的书面 waive|

- **`reviewed-auto` 未满足 → STOP**：等 PR 级 review 跑到 settled 的 `ship it`，**并且**（仅当挂载了外部 review bot；无 bot 时该面记 `N/A`）等 §5.1b 的外部 AI review 在当前 head 达到其通过线（Greptile 5/5）、无 blocking finding；任一未满足都不得 merge，二者不能互相替代。若授权报告或外部 verdict 的 `head` 已不是当前 PR head（中间有 push），重跑对应面取新结论。恢复路径：给出上述授权报告 + 外部 review 结论，或**重新进入 Phase 1 的 §1.2 流程**——加载 `mstar-iteration` → `references/phase-1-prepare.md`，按其「必须与用户显式确认，绝不默认」规则与用户重新确认后改动 compass 记录的 policy，新增 `## Decisions` 行记 `source: user`，并刷新 Phase 4 步骤 5 写入 PR 正文的 policy 行。PM **不得**在 Phase 5 就地改写 `pr_merge_policy`。
- **`owner-gated` 未满足 → hard stop**：给出 PR 链接 + merge-ready 证据后**等待**；**人类 owner**（操作者/用户，**不是** coordinator 席位）书面批准前不得 merge，任何自动化证据（mergeable / CI 绿 / QC Approve / `ship it`）都不能替代。恢复路径：人类 owner 书面批准当前 PR head，或**重新进入 Phase 1 的 §1.2 流程**——加载 `mstar-iteration` → `references/phase-1-prepare.md`，按其「必须与用户显式确认，绝不默认」规则与用户重新确认后改动 compass 记录的 policy，新增 `## Decisions` 行记 `source: user`，并刷新 Phase 4 步骤 5 写入 PR 正文的 policy 行。PM **不得**在 Phase 5 就地改写。
- **`pr_merge_policy` 缺失 → STOP**：**绝不**推断默认值。恢复路径：**重新进入 Phase 1 的 §1.2 流程**——加载 `mstar-iteration` → `references/phase-1-prepare.md`，按其「必须与用户显式确认，绝不默认」规则与用户确认该字段，写入 compass frontmatter 并在 `## Decisions` 记 `source: user`。

**Merge 前的 head 对账（可执行，不是谓词的复述）**：执行 merge 的前一步，取 `gh pr view <n> --json headRefOid` 与授权报告记录的 `head` 逐字比较。

- 相等 → 授权成立，可以 merge。
- 不等 → **授权已失效**。授权之后任何 push 都作废它，包括 doc-only 的 changelog 补齐、allowlist 增删、注释修正——"delta 很小"不是理由，因为小 delta 同样会引入不准确的断言。此时只有两条合法出路：取**新 head** 的完整结论，或对该 head 做一次**窄 delta ack**（同一席位签发，记录 `reviewed_head`、新 head、delta 的文件范围、以及"是否仍维持原结论"）。delta ack 不是新 review：它只在 delta 不触及代码/测试/配置/生成产物时可用，且必须写明被确认的 delta 范围。

**谁执行 merge**：`reviewed-auto` 下，§5.3 授权谓词成立后由 **PM** 执行 merge；`owner-gated` 下，**人类 owner** 可自行 merge，或书面批准后由 PM 执行。两种 policy 都只在 §5.3 满足后才 merge；verified merge 之后进入 **Phase 6** —— merge 不是生命周期终点。
