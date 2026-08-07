# Phase 4 & 5: PR delivery + merge-ready loop

> Loaded by `mstar-iteration` SKILL.md when entering Phase 4/5. **Read `mstar-harness-core` first.** 进入前置：Phase 3 §3.5 exit 全 `[x]`（Phase 4）；Phase 4 PR 已创建（Phase 5）。

## Phase 4: PR delivery（开 PR）

**Precondition**: Phase 3 §3.5 exit 全 `[x]`；close commit 已 push 到 `spec_integration_branch`。

1. 打印 **`## Phase 4: PR delivery`**
2. Resolve target：`metadata.target_branch`（compass frontmatter 镜像）；缺失 → **STOP**，问用户
3. 创建 PR：`spec_integration_branch` → `target_branch`
4. 记录 PR URL / number（Phase 5 会话 SSOT）
5. **Immediately** 进入 **Phase 5** — **Phase 4 exit ≠ 迭代交付完成**

---

## Phase 5: PR merge-ready loop

**Precondition**: Phase 4 PR 已创建且 head = `spec_integration_branch`。

**Loop 理念**（mstar SSOT）：PR 开完后进入 **验证—修复—再验证** 循环，直至 PR 可合并。与 Phase 2 per-plan loop 类似，但对象是 **PR 级** merge 门禁（CI、review、冲突），不是 plan 实现。

### 5.0 Phase boundary

- Phase 5 在 PR head（`spec_integration_branch`）上 push 修复；**禁止**另开替代分支
- **Checkout / worktree（HARD）**：Phase 5 是 PR 级 **hotfix** loop，**不是** Phase 2 plan 实现。修复直接在 **control worktree**（已检出 `spec_integration_branch` 的 checkout）上编辑、commit、再按 §5.1a push。**禁止**为 Phase 5 另开 feature / fix worktree；**禁止**把 Phase 2「control 禁止产品编辑 / 须 feature worktree」套用到 Phase 5。另开 worktree 浪费时间、磁盘与计算，与 Phase 5 快速收敛 CI/review 的目标相悖。
- 产品代码修复 → PM **dispatch** dev/ops（`mstar-dispatch-gates`）；Assignment **`Worktree path`** / cwd = control（`metadata.control_worktree_path` 或当前已在集成分支上的 checkout）；PM 线程不代写实现
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

### 5.1 Loop（repeat until §5.5 exit）

1. **Status** — PR mergeable？required CI？unresolved review threads？**任一 CI/AI review 是否仍在跑？**
2. **Merge conflicts** — blocking 则在 integration 分支**本地**解决；**仅当 §5.1a push gate 满足时**再 push（意图冲突 → **Blocked**）
3. **Reviews** — fetch unresolved threads；triage；dispatch **本地**修复（可在上一波次仍在跑时开工）
4. **CI** — 失败项在 PR 范围内**本地**修复（可提前开工）；**不**在 CI 仍在跑时 push
5. **Push** — 仅当 §5.1a 满足：无 in-flight CI，上一波 CI **与** reviews 均已跑完 → **一次** push 本批修复
6. **Review fix hygiene**（每次因 review 而 push 后）：
   - 在同 thread **comment**（改动 + 验证）
   - **Resolve** when addressed
7. Return to step 1（CI 结束后若出现 **新** reviews → 继续本地修，再等 idle 后 push）

**Optional host helpers（command 层发现；非 `mstar-*` load order）**：

| Priority | Helper | When |
|----------|--------|------|
| 1 | `babysit` or any `*-babysit` skill（first readable `SKILL.md`） | **Default prefer** — CI green + reviews resolved loop |
| 2 | `greploop` | **Optional** — only when the **repo** uses Greptile / has `greploop` available; then run for Greptile **5/5** in addition to babysit/`*-babysit` (or fallback) gates |
| 3 | neither | Command fallback = babysit-equivalent CI + reviews gates |

When both babysit/`*-babysit` and greploop apply: **babysit/`*-babysit` first**（CI + reviews），then optional greploop for Greptile score. Discovery paths → host `commands/iteration-drive` / `iteration-loop` Phase 5.

### 5.2 Phase 5 exit checklist（迭代交付完成）

打印 **`## Phase 5 exit checklist`**；全 `[x]` 后方可宣称 **迭代交付完成**：

- [ ] PR mergeable（无 blocking merge conflicts）
- [ ] All **required** CI checks green on latest head
- [ ] All review threads **resolved**（或用户书面 waive 特定 thread）
- [ ] §5.1 review comment + resolve 已覆盖本轮所有 addressed feedback
- [ ] Host todo `phase-5-pr-merge-ready` 可勾选

PR **merge** 本身可仍由用户手动执行，除非 Assignment 明确授权 auto-merge。
