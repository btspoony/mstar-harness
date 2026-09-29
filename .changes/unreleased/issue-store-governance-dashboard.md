---
category: Harness
packages: root
---

- Documented the issue/catalog SQLite path `{HARNESS_DIR}/store.db` and its authority split from execution JSON (`ArtifactStore`).
- Indexed the `mstar issue …` CLI family (verbs in `--help`; flags not restated in skills).
- Recorded CLI launch floors by entrypoint: Bun `>=1.4.0` for the shebang, Node `>=24.18.0` for explicit `node` on the CLI bundle — not a demand to install both runtimes.
- Added the **catalog authority** in `{HARNESS_DIR}/store.db` (migration 2): project/iteration/plan/document identity, paths, membership, spec/knowledge relations and catalog lifecycle are DB rows, while document bodies stay files and execution routing, leases and frozen inputs stay JSON.
- Replaced the maintained Markdown index obligations (iteration README rows, package Documents tables, specs/knowledge index tables) with **catalog discover / import / register / query** duties; completeness is a DB query, and a missing README is no longer a failure.
- Added the `mstar catalog` verb family (list, show, register, update, link, discover, import, export, reconcile) — verbs and flags live in `--help`.
- Added the **registration journal**: the snapshot/root writes and the catalog delta publish through one recoverable operation (`catalog.registration-pending`, recovered with `mstar catalog reconcile`), and a prepared plan pins its execution input to a catalog revision.
- Added **disposable execution/roadmap projections** (migration 3) with honest freshness and diagnostics, plus the `withStoreRead` read boundary and dashboard DTOs.
- Documented the cross-clone limit: `store.db` is local and gitignored, tracked bodies alone cannot rebuild local catalog history, and discovery reports explicit unknowns. Live index retirement and activation belong to the cutover plan.
- Landed the **capture duty** as settled by compass D18: a confirmed finding becomes an issue in `{HARNESS_DIR}/store.db` at the moment it is confirmed — capture records evidence only, disposition is a separate authorized act, and a recurrence appends an occurrence instead of opening a second issue.
- Made **`mstar-project-governance`「Issue capture」the single authority** (issue contract §6 verbatim): the seat that owns the confirmed outcome captures — the PM seat and a PR-review round's main agent at Stage 3 — while leaf audit/QC/QA seats return evidence and never write the store. The other five owner texts carry pointer landings only.
- Re-pointed the residual-register prose in the artifacts family (`SKILL.md` + `references/status-and-residuals.md`), `mstar-audit` (incl. the PR-review reference) and `mstar-review-qc`, and added the minimal delivery-loop sentence to `mstar-harness-core`: the register is **migration history**, open items are **store issues**, and `mstar status tech-debt` / `mstar status findings-cleanup` read the store. Retired register writers (`mstar status backlog-register` / `backlog-close`) refuse and name the issue verbs; skills never restate flags.
- **Issue-store session envelopes follow the role-scoped naming from main** (PR #266 main-drift fix): the authority checker's `issuedSessionLocation` reuses the engine's `sessionFilePath` rule (`sessions/<role>-<session-id>.json`, role ∈ {`plan-pm`, `coordinator`}) instead of a stale local copy of the old unscoped name — a valid engine-issued envelope is no longer refused with `issue.scope-refused` after the rename, and the CLI `--session` help text names the role-scoped shape.
- **Legacy session envelopes authorize issue mutations again after an upgrade**: the issue store now authorizes a privileged mutation through the workflow's **recorded** session file, accepting that bound path in either engine-issued shape — the canonical `workflows/<id>/sessions/<role>-<session-id>.json` or the pre-#264 bare `workflows/<id>/sessions/<session-id>.json` that released 3.11.0 workflows record (both roles; 3.11.0 had no role prefix). The presented file must be exactly the bound path — a copy at any other path refuses even when byte-identical — and every content binding (workflow, plan row/coordinator record, session id, live lifecycle) is enforced unchanged.
- **Dashboard rows scope by their own workflow** (PR #266 review RV-1): projection plan/lease rows are matched by the tables' own `(workflow_id, plan_id)` key — the same plan id under a plan workflow and an iteration workflow no longer attaches the other workflow's lease, status, progress or pin revision in the workflows view or the iteration execution overlay.
- **Symlink cross-harness register writes are vetoed** (PR #266 review RV-2): a pre-activation register reached through a symlink that lands on another harness's active or unreadable issue authority is refused by the landed context (`project.register.retired` / `store.authority-unavailable`) in all three enforcing copies (ZCode hook, omp gate, dsh store-authority); both contexts pre-activation keep the §7 legacy register path.
- **Catalog imports never leave a silent prefix** (PR #266 review RV-3): a mid-plan `importCatalog` failure rethrows `catalog.import-partial` carrying exactly the applied receipts and the resume instruction — the applied proposals are journalled progress, and re-running the same reviewed plan with the same operationId converges to the full plan exactly once.
- **OpenCode plugin declares its Node floor** (PR #266 review RV-4): `@mstar-harness/opencode` `engines` now requires `node >=24.18.0` (`node:sqlite`) alongside Bun, and the package INSTALL/README name the floor.
- Added **DESIGN.md** for the local read-only governance dashboard: light-theme tokens, four-view navigation, evidence/history presentation, accessibility and explicit empty/stale/error states.
- Added an offline `mstar report` draft generator with explicit caller-supplied fields, finite secret redaction, and a user review step; it does not collect local data or submit issues.
- Documented matching CLI and MCP report usage, absent/unknown values, and the meaning and limits of redaction counts.

<!-- CN -->
- 记录 issue/catalog SQLite 路径 `{HARNESS_DIR}/store.db` 及其与执行 JSON（`ArtifactStore`）的权威分界。
- 索引 `mstar issue …` CLI 族（动词以 `--help` 为准；技能文不复述标志）。
- 按入口记录 CLI 运行时下限：shebang 为 Bun `>=1.4.0`，显式 `node` 跑 CLI bundle 为 Node `>=24.18.0`——不是要求两套运行时都装。
- 新增 **catalog 权威**（`{HARNESS_DIR}/store.db`，migration 2）：project/iteration/plan/document 的身份、路径、归属、spec/knowledge 关系与 catalog 生命周期是 DB 行；正文仍是文件，执行路由、lease 与冻结输入仍是 JSON。
- 把需维护的 Markdown 索引义务（迭代 README 行、package Documents 表、specs/knowledge 索引表）替换为 **catalog discover / import / register / query** 职责；完整性改为 DB 查询，README 缺失不再是失败。
- 新增 `mstar catalog` 动词族（list、show、register、update、link、discover、import、export、reconcile）——动词与标志以 `--help` 为准。
- 新增 **registration journal**：snapshot/根 entry 写入与 catalog delta 经同一个可恢复操作发布（`catalog.registration-pending`，用 `mstar catalog reconcile` 收口），且 prepare 的 plan 把执行输入 pin 到某个 catalog revision。
- 新增 **可丢弃的执行/roadmap 投影**（migration 3），诚实报告新鲜度与诊断；新增 `withStoreRead` 读边界与 dashboard DTO。
- 记录跨 clone 限制：`store.db` 本地且默认 gitignored，仅凭 tracked 正文无法重建本地 catalog 历史，discovery 以显式 unknowns 报告。live 索引退役与激活归 cutover plan。
- 按 compass D18 落地 **capture duty**：确认的 finding 在确认当刻落为 `{HARNESS_DIR}/store.db` 的 issue —— 捕获只记证据，处置是独立的授权动作；同一 finding 再次出现追加 occurrence，而不是新开第二个 issue。
- **`mstar-project-governance`「Issue capture」成为唯一权威**（issue contract §6 逐字）：确认其结论的席位负责捕获 —— PM 席位，以及 PR-review 轮次 Stage 3 的 main agent；leaf audit/QC/QA 席位只回证据、不写 store。其余五处只做指针落点。
- `mstar-artifacts` 家族（`SKILL.md` + `references/status-and-residuals.md`）、`mstar-audit`（含 PR-review 参考）与 `mstar-review-qc` 的 residual register 表述改为指向 issue store，并在 `mstar-harness-core` 补最小交付循环句：register 是**迁移历史**，open item 是 store 的 **issue**，`mstar status tech-debt` / `mstar status findings-cleanup` 读 store。已退役的 register 写入动词（`mstar status backlog-register` / `backlog-close`）拒绝并指向 issue 动词；技能文不复述标志。
- **issue store 的会话信封遵循 main 的角色限定命名**（PR #266 main 漂移修复）：authority 检查的 `issuedSessionLocation` 改为复用引擎的 `sessionFilePath` 规则（`sessions/<role>-<session-id>.json`，role ∈ {`plan-pm`、`coordinator`}），不再保留旧未限定命名的本地副本——重命名后合法的引擎签发信封不再被 `issue.scope-refused` 拒绝，CLI `--session` 帮助文本同步写明角色限定形态。
- **升级后旧版会话信封恢复 issue 变更授权**：issue store 现在经由 workflow **记录的**会话文件授权特权变更，该绑定路径接受两种引擎签发形状——规范形式 `workflows/<id>/sessions/<role>-<session-id>.json` 或已发布 3.11.0 workflow 记录的 #264 之前裸形式 `workflows/<id>/sessions/<session-id>.json`（两种角色；3.11.0 无角色前缀）。呈递文件必须与绑定路径完全一致——任何其他路径上的副本即使字节相同也一律拒绝——且全部内容绑定（workflow、plan 行/coordinator 记录、session id、存活生命周期）保持不变。
- **Dashboard 行按所属 workflow 取数**（PR #266 评审 RV-1）：projection 的 plan/lease 行改用表自身的 `(workflow_id, plan_id)` 键匹配——同一 plan id 同时存在于 plan workflow 与 iteration workflow 时，workflows 视图与 iteration 执行 overlay 不再附着另一个 workflow 的 lease、状态、进度或 pin revision。
- **拒绝符号链接跨 harness 的 register 写入**（PR #266 评审 RV-2）：pre-activation register 经符号链接落到另一 harness 的 active/不可读 issue authority 时，由落点上下文拒绝（`project.register.retired` / `store.authority-unavailable`），三份执行副本（ZCode hook、omp gate、dsh store-authority）语义一致；双方都 pre-activation 时保留 §7 legacy register 路径。
- **目录导入不再留下静默前缀**（PR #266 评审 RV-3）：`importCatalog` 中途失败改以 `catalog.import-partial` 显式抛出，携带已应用的 receipt 与恢复指引——已应用部分是持久化的 journal 进度，用同一 operationId 重跑同一评审 plan 即可幂等收敛到完整 plan、恰好一次。
- **OpenCode 插件声明 Node 版本下限**（PR #266 评审 RV-4）：`@mstar-harness/opencode` 的 `engines` 在 Bun 之外新增 `node >=24.18.0`（`node:sqlite`），包内 INSTALL/README 同步写明该下限。
- 新增本地只读治理面板的 **DESIGN.md**：定义浅色主题令牌、四视图导航、证据与历史展示、可访问性，以及明确的空数据、过期和错误状态。
- 新增离线 `mstar report` 草稿生成器：仅使用调用方明确提供的字段，应用有限的 secret 脱敏模式，并要求用户检查；不会收集本地数据或提交 issue。
- 补充 CLI 与 MCP 报告用法、`absent`/`unknown` 值，以及脱敏计数的含义与局限。
