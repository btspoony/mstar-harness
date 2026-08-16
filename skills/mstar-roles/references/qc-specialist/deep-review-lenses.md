# QC Deep Review Lenses（审查透镜 · 单人模式）

Extension of `references/qc-specialist-shared.md`. Read at QC session start when applying deep review per `reviewer-workflow.md`.

> **关键约束**：mstar 派发模型下，QC reviewer 是 PM 派发的 **leaf executor**（`Delegation: forbidden`），**禁止**自行派发任何 subagent 或 persona（`mstar-dispatch-gates` § 承接方反递归 NEVER 红线）。
> 本文件的设计选择：**透镜（lens）而非代理（subagent）**——QC reviewer **本人**在审查时额外覆盖的检查维度，每个透镜是一组结构化问题，审查者在本地逐一回答即可。
> 不派发子 agent，不产生额外对话轮次，不违反反递归约束。
> 透镜问题用 **diff / read / grep** 回答；**禁止**为回答透镜去跑 test/build/lint（与 `reviewer-workflow.md` 一致）。

## Deep review 触发规则（自动判定，无需人工指定）

QC reviewer 在开工时根据以下信号自判是否启用 deep review。满足 **≥2 条**即触发。

### 触发信号

| # | 信号 | 检测方式 |
|---|------|---------|
| S1 | **变更规模大** | `git diff --stat <Review range>` → 变更行数 ≥ 200 或 变更文件数 ≥ 8 |
| S2 | **触及敏感模块** | diff 中包含 `auth/`、`payment/`、`security/`、`permission/`、`login/`、`migration/`、`db/migrate/`、`schema/` 路径 |
| S3 | **首次涉足新领域** | `{KNOWLEDGE_DIR}` 中不存在 diff 触及的模块名；或 plan metadata 标记为首次实现 |
| S4 | **数据结构变更** | diff 中包含 DDL（`CREATE TABLE`、`ALTER TABLE`、`ADD COLUMN`、schema 文件、migration 文件） |
| S5 | **plan 显式声明高风险** | plan 正文或 `status.json` 的 plan metadata 中包含 `high-risk`、`critical-path`、`breaking-change` 标记 |
| S6 | **多模块耦合** | diff 跨越 ≥3 个不同模块/包/目录边界 |

**判定**：满足 ≥2 条 → 启用 deep review。QC reviewer 在报告 `## Scope` 节中写明判定依据（例：`Deep review: triggered (S1: 350 lines / 12 files, S2: auth/ + payment/)`）。

## 透镜选择

触发后，QC reviewer 根据信号匹配相关透镜。每个 reviewer 身份有默认透镜，再按触发的信号追加特定透镜。

### 默认透镜（各 reviewer 始终覆盖）

| Reviewer | 默认透镜 |
|----------|---------|
| QC1 (architecture/maintainability) | **Modularity Lens** + **Contract Lens** |
| QC2 (security/correctness) | **Security Lens** + **Correctness Lens** + **Bounds Lens** + **Real-Entry-Path Lens** |
| QC3 (performance/reliability) | **Performance Lens** + **Reliability Lens** + **Enforcement-Path Lens** + **Ownership / Derived-State Lens** |

### 按信号追加透镜

| 触发信号 | 追加透镜 | 适用于 |
|---------|---------|-------|
| S2 (敏感模块) | **Auth Lens**（若涉及 auth/login）、**Data Migration Lens**（若涉及 DDL/migration）、**Input Validation Lens**（若涉及用户输入/API） | 全体 |
| S3 (新领域) | **Standards Lens**、**Testing Lens** | 全体 |
| S4 (数据结构变更) | **Data Migration Lens** | 全体 |
| S5 (显式高风险) | **全部透镜**（每个 reviewer 覆盖自己身份相关的所有透镜） | 全体 |

---

## 透镜清单（每透镜一行焦点；详细追问由 reviewer 按专业判断展开；新增透镜各附 ≤4 条结构化追问，均可由 diff/read/grep 回答）

每个透镜是一组审查焦点。QC reviewer 在报告中按透镜分节列出发现，每个发现标注来自哪个透镜（`Source Type: deep-lens: <Lens>`）。

- **Modularity Lens** — 新依赖方向合理；无逻辑错放层级（controller 业务逻辑、model 视图逻辑）；公共接口职责单一边界清晰；无循环依赖/隐含耦合。
- **Contract Lens** — 公共 API/接口签名无未声明 breaking change（有则 plan 声明 + 迁移说明）；新端点遵循命名/参数约定；返回类型稳定（新字段不破坏已有解析）；docs-match-code：config/defaults/errors/wire fields/events 变更同 diff 更新 README/JSDoc；双语仓对照同步。
- **Security Lens** — 认证/授权/session/token/permission 逻辑正确；未验证输入未直入 DB/命令/文件；敏感数据（密钥/token/PII）未在日志/错误/返回值泄露；新访问控制点覆盖所有调用路径。（与 **Enforcement-Path Lens** 互指：访问控制点自身的正确性归本透镜；拒绝/校验路径的执行与旁路追迹归 Enforcement-Path）
- **Correctness Lens** — 错误处理显式可恢复（无吞关键异常的 catch-all）；边界条件覆盖（空/零/溢出/并发）；状态转换一致（无外部可观察中间态）；返回值/副作用与声明一致。
- **Performance Lens** — 无 N+1 查询（ORM eager loading）；循环/批处理无无界操作；新索引必要且不退化写入；大对象/列表分页或流式。
- **Reliability Lens** — 资源（连接/句柄/锁）异常路径也释放；外部调用有超时+重试；缓存失效正确（不长期返回过期）；无可能无限增长的结构（无界缓存/日志/队列）。（与 **Lifecycle & Concurrency Lens** 互指：资源释放/超时重试/缓存失效归本透镜；对象生命周期与并发时序（发布竞态/取消/重入/清理完整性）归 Lifecycle & Concurrency）
- **Auth Lens** — 认证中间件覆盖所有新端点；权限检查在业务逻辑前（先鉴权再操作）；session 生命周期正确（创建/续期/失效）；权限提升路径需二次确认。
- **Input Validation Lens** — 外部输入（query/body/headers）经类型/范围/格式验证；无可触发路径遍历/注入/XSS；文件上传有大小/类型检查；错误信息不暴露内部实现细节。
- **Data Migration Lens** — migration 可回滚（`down` 存在且正确）；大表用非阻塞策略；数据一致（不丢/无脏中间态）；并发写入下安全。
- **Error Handling Lens** — 异常层级清晰（业务 vs 系统）；面向用户错误消息安全；关键操作失败副作用正确处理（事务回滚/补偿）；无"静默失败"路径。
- **Standards Lens** — 风格/命名/文件组织符项目约定；无与现有冲突的重复实现；新依赖有充分理由；遵循项目 `AGENTS.md` 维护契约。
- **Testing Lens** — 关键逻辑路径有覆盖；边界/异常路径覆盖；无仅 happy-path 跳 failure-mode；集成测试覆盖外部服务交互边界；断言必须在目标回归上失败；验证外部状态/logs/events/disposal，不复述实现、不信任 agent 自报。
- **Lifecycle & Concurrency Lens** — 对象生命周期与并发时序：① publication 前无竞态（无其他路径可观察到未初始化状态）？② await 期间取消/超时传播到被等待任务且资源正确回收？③ reentry 前所有权已转移或显式保留？④ detach 清理完整（监听器/句柄移除），disposal 在 quiescent（无 in-flight 任务）时执行？（与 **Reliability Lens** 互指：资源/超时/缓存归 Reliability；生命周期/并发时序归本透镜）
- **Ownership / Derived-State Lens** — ① 每个保留值（字段/闭包捕获/缓存条目）是 borrowed 还是 owned，借用方生命周期不超过所有者？② 每个 cache/UI echo/replay/query view 追溯到 documented success point 与 authoritative source？③ 派生状态（缓存/投影/回显）的失效点与权威源同步声明？
- **Bounds Lens** — ① 完整产出（含 wrapper/metadata/封套行）的 owner 明确，边界检查覆盖完整产出而非仅载荷？② tiny/exact limit 被探测（空/最小/恰好等于上限）？③ 超大单块（单条记录超上限）被拒绝/截断而非绕过按行/按条门禁？④ 多字节文本（UTF-8 多字节字符）按字节上限而非字符数处理？
- **Enforcement-Path Lens** — ① 每个 deny/veto 路径追到实际执行拒绝的操作（而非仅声明策略）？② 直调/wrapper/facade/schema-less 路径/listener 顺序等旁路调用方是否都经同一校验点？③ 观察/记录侧（listener/consumer/回调）不会绕过主校验路径写入状态或缓存？（与 **Security Lens** 互指：访问控制点自身正确性归 Security；拒绝/校验路径的执行与旁路追迹归本透镜）
- **Real-Entry-Path Lens** — ① 测试/覆盖走 shipped entry（CLI/bin/loader/plugin boot）而非 hand-mounted 等价物（手工装配的组件实例）？② 真实入口的启动/挂载顺序（注册时序）被覆盖？

---

## 透镜发现与主审查的整合

所有透镜发现归入主报告的 `## Findings` 三节（Critical / Warning / Suggestion）中，每个发现的 `Source Type` 标注为对应透镜名（如 `deep-lens: Security Lens`），与主审查者的 `manual-reasoning` 发现同等待遇。

每个透镜 finding 必须附 **diff / read / grep 锚点** + **预期 vs 实际（Expected vs observed）**——无锚点不入报告（宁可漏报不虚报）。

```markdown
## Scope
- plan_id: <id>
- Review range: <hash..hash>
- Deep review: triggered (S1: 280 lines / 10 files, S2: auth/ + migration/)
- Lenses applied: Security Lens, Auth Lens, Data Migration Lens, Modularity Lens, Contract Lens

## Findings
### 🔴 Critical
- [DS-001] Auth middleware missing on POST /api/admin/users → <fix>
  - Source Type: deep-lens: Auth Lens
  - Verification: diff/read/grep anchor（`src/routes/admin.ts:41-52` 缺 auth 中间件引用 vs `src/middleware/auth.ts` 注册路径）
  - Expected vs observed: 预期所有 `/api/admin/*` 经 auth 中间件 vs 实际 `POST /api/admin/users` 直入 handler
  - Confidence: High
```

报告中无需专门统计透镜数量或列出"未应用的透镜"——报告中只出现实际应用且有发现的透镜。无任何发现的透镜不出现在报告中。

## 例外：不适用 deep review 的情况

即使触发信号阈值达标，以下情况 QC reviewer 仍按默认单透镜模式审查：

- **Re-review（targeted re-review）**：只在原报告基础上验证修复点，不重新扩展审查范围
- **Hotfix**：时间窗口不允许扩展审查，按 hotfix 压缩路径处理（事后在 plan notes 中补 deep review 追记）
- **上下文限制**：宿主会话上下文不足以加载透镜内容时，标记为 `Deep review: skipped (context constraint)` 并仅执行默认审查
