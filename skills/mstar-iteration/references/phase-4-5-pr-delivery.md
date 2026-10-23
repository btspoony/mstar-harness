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

### 5.1 Loop（repeat until §5.2 第 1–4 项全 `[x]`）

1. **Status** — PR mergeable？required CI？unresolved review threads？**任一 CI/AI review 是否仍在跑？**
2. **Merge conflicts** — blocking 则在 integration 分支**本地**解决；**仅当 §5.1a push gate 满足时**再 push（意图冲突 → **Blocked**）
3. **Review dispatch（按 compass `pr_merge_policy`）** — `reviewed-auto`：PR 级 review 归 **`mstar-pr-loop`** 所有——它自己跑 review → fix → re-review 循环，并按 §5.1a 的 push cadence 推进；**不要**在每个 §5.1 迭代里另起第二个 review loop。§5.1 只保留 mergeable / required CI / review thread resolve / push 的所有权；§5.3 读取该 loop 在当前 PR head 上最终 settled、已 posted 的 `ship it` 报告作为授权。`owner-gated`：**完全**不起 PR 级 review loop，owner review 就是 gate，Phase 5 停在 merge-ready
4. **Reviews** — fetch unresolved threads；triage；dispatch **本地**修复（可在上一波次仍在跑时开工）
5. **CI** — 失败项在 PR 范围内**本地**修复（可提前开工）；**不**在 CI 仍在跑时 push
6. **Push** — 仅当 §5.1a 满足：无 in-flight CI，上一波 CI **与** reviews 均已跑完 → **一次** push 本批修复
7. **Review fix hygiene**（每次因 review 而 push 后）：
   - 在同 thread **comment**（改动 + 验证）
   - **Resolve** when addressed
8. Return to step 1（CI 结束后若出现 **新** reviews → 继续本地修，再等 idle 后 push）

**Optional host helpers（command 层发现；非 `mstar-*` load order）**：

| Priority | Helper | When |
|----------|--------|------|
| 1 | `babysit` or any `*-babysit` skill（first readable `SKILL.md`） | **Default prefer** — CI green + reviews resolved loop |
| 2 | `greploop` | **Optional** — only when the **repo** uses Greptile / has `greploop` available; then run for Greptile **5/5** in addition to babysit/`*-babysit` (or fallback) gates |
| 3 | neither | Command fallback = babysit-equivalent CI + reviews gates |

When both babysit/`*-babysit` and greploop apply: **babysit/`*-babysit` first**（CI + reviews），then optional greploop for Greptile score. Discovery paths → `mstar-iteration` §5 (iteration command layer).

### 5.2 Phase 5 exit checklist（merge-ready → enter Phase 6）

打印 **`## Phase 5 exit checklist`**；**第 1–4 项全 `[x]` = merge-ready**（第 5 项是 merge-ready 的 todo 勾选动作，其条件即第 1–4 项），第 6 项（**Merge authorization**）是 merge 与进入 Phase 6 的独立前置（§5.3），第 7 项为 transition marker（merged 后才可勾）。**整表全 `[x]` 只在 merge 之后成立**（Phase 6 进入前置），不得作为 merge-ready 的定义或 `phase-5-pr-merge-ready` todo 的关闭条件（否则要求先 merge，`owner-gated` 下自相矛盾）；此后唯一出口是 **Phase 6**（PR merged 后执行 `references/phase-6-post-merge-close.md` §6.1–§6.4）——本 checklist **不是**「迭代交付完成」：

- [ ] PR mergeable（无 blocking merge conflicts）
- [ ] All **required** CI checks green on latest head
- [ ] All review threads **resolved**（或用户书面 waive 特定 thread）
- [ ] §5.1 review comment + resolve 已覆盖本轮所有 addressed feedback
- [ ] Host todo `phase-5-pr-merge-ready` 可勾选
- [ ] **Merge authorization** — satisfied per §5.3
- [ ] PR **merge** 完成后进入 **Phase 6**：追加 todo `phase-6-post-merge-close`，执行 post-merge close（`references/phase-6-post-merge-close.md` §6.1–§6.4）

### 5.3 Merge authorization（HARD）

**Merge 是独立的授权动作**：merge-ready、required CI 全绿、QC Approve、review `ship it` **各自都不**构成 merge 授权。

| `pr_merge_policy` | Merge 授权来源 |
|---|---|
| `reviewed-auto` | 一份 **settled、已 posted**、且 `head` 等于**当前** PR head 的 `ship it` 报告（`mstar-pr-loop` 的 `ship it` 行） |
| `owner-gated` | owner 对**当前** PR head 的**显式书面** merge 批准 |

- **`reviewed-auto` 未满足 → STOP**：等 PR 级 review 跑到 settled 的 `ship it`；若该报告 `head` 已不是当前 PR head（中间有 push），重跑该 review 取新报告。恢复路径：给出上述授权报告，或回 Phase 1 改动记录的 policy。
- **`owner-gated` 未满足 → hard stop**：给出 PR 链接 + merge-ready 证据后**等待**；owner 书面批准前不得 merge，任何自动化证据（mergeable / CI 绿 / QC Approve / `ship it`）都不能替代。恢复路径：owner 书面批准当前 PR head，或回 Phase 1 改动记录的 policy。
- **`pr_merge_policy` 缺失 → STOP**：回 Phase 1 补齐，**绝不**推断默认值。恢复路径：§1.2 与用户确认该字段，写入 compass frontmatter 并在 `## Decisions` 留 `source`。

**谁执行 merge**：`reviewed-auto` 下，§5.3 授权谓词成立后由 **PM** 执行 merge；`owner-gated` 下，owner 可自行 merge，或书面批准后由 PM 执行。两种 policy 都只在 §5.3 满足后才 merge；verified merge 之后进入 **Phase 6** —— merge 不是生命周期终点。
