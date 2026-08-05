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
| QC2 (security/correctness) | **Security Lens** + **Correctness Lens** |
| QC3 (performance/reliability) | **Performance Lens** + **Reliability Lens** |

### 按信号追加透镜

| 触发信号 | 追加透镜 | 适用于 |
|---------|---------|-------|
| S2 (敏感模块) | **Auth Lens**（若涉及 auth/login）、**Data Migration Lens**（若涉及 DDL/migration）、**Input Validation Lens**（若涉及用户输入/API） | 全体 |
| S3 (新领域) | **Standards Lens**、**Testing Lens** | 全体 |
| S4 (数据结构变更) | **Data Migration Lens** | 全体 |
| S5 (显式高风险) | **全部透镜**（每个 reviewer 覆盖自己身份相关的所有透镜） | 全体 |

---

## 透镜清单（每透镜一行焦点；详细追问由 reviewer 按专业判断展开）

每个透镜是一组审查焦点。QC reviewer 在报告中按透镜分节列出发现，每个发现标注来自哪个透镜（`Source Type: deep-lens: <Lens>`）。

- **Modularity Lens** — 新依赖方向合理；无逻辑错放层级（controller 业务逻辑、model 视图逻辑）；公共接口职责单一边界清晰；无循环依赖/隐含耦合。
- **Contract Lens** — 公共 API/接口签名无未声明 breaking change（有则 plan 声明 + 迁移说明）；新端点遵循命名/参数约定；返回类型稳定（新字段不破坏已有解析）。
- **Security Lens** — 认证/授权/session/token/permission 逻辑正确；未验证输入未直入 DB/命令/文件；敏感数据（密钥/token/PII）未在日志/错误/返回值泄露；新访问控制点覆盖所有调用路径。
- **Correctness Lens** — 错误处理显式可恢复（无吞关键异常的 catch-all）；边界条件覆盖（空/零/溢出/并发）；状态转换一致（无外部可观察中间态）；返回值/副作用与声明一致。
- **Performance Lens** — 无 N+1 查询（ORM eager loading）；循环/批处理无无界操作；新索引必要且不退化写入；大对象/列表分页或流式。
- **Reliability Lens** — 资源（连接/句柄/锁）异常路径也释放；外部调用有超时+重试；缓存失效正确（不长期返回过期）；无可能无限增长的结构（无界缓存/日志/队列）。
- **Auth Lens** — 认证中间件覆盖所有新端点；权限检查在业务逻辑前（先鉴权再操作）；session 生命周期正确（创建/续期/失效）；权限提升路径需二次确认。
- **Input Validation Lens** — 外部输入（query/body/headers）经类型/范围/格式验证；无可触发路径遍历/注入/XSS；文件上传有大小/类型检查；错误信息不暴露内部实现细节。
- **Data Migration Lens** — migration 可回滚（`down` 存在且正确）；大表用非阻塞策略；数据一致（不丢/无脏中间态）；并发写入下安全。
- **Error Handling Lens** — 异常层级清晰（业务 vs 系统）；面向用户错误消息安全；关键操作失败副作用正确处理（事务回滚/补偿）；无"静默失败"路径。
- **Standards Lens** — 风格/命名/文件组织符项目约定；无与现有冲突的重复实现；新依赖有充分理由；遵循项目 `AGENTS.md` 维护契约。
- **Testing Lens** — 关键逻辑路径有覆盖；边界/异常路径覆盖；无仅 happy-path 跳 failure-mode；集成测试覆盖外部服务交互边界。

---

## 透镜发现与主审查的整合

所有透镜发现归入主报告的 `## Findings` 三节（Critical / Warning / Suggestion）中，每个发现的 `Source Type` 标注为对应透镜名（如 `deep-lens: Security Lens`），与主审查者的 `manual-reasoning` 发现同等待遇。

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
  - Confidence: High
```

报告中无需专门统计透镜数量或列出"未应用的透镜"——报告中只出现实际应用且有发现的透镜。无任何发现的透镜不出现在报告中。

## 例外：不适用 deep review 的情况

即使触发信号阈值达标，以下情况 QC reviewer 仍按默认单透镜模式审查：

- **Re-review（targeted re-review）**：只在原报告基础上验证修复点，不重新扩展审查范围
- **Hotfix**：时间窗口不允许扩展审查，按 hotfix 压缩路径处理（事后在 plan notes 中补 deep review 追记）
- **上下文限制**：宿主会话上下文不足以加载透镜内容时，标记为 `Deep review: skipped (context constraint)` 并仅执行默认审查
