# QC Deep Review Lenses（审查透镜 · 单人模式）

Extension of `references/qc-specialist-shared.md`. Read at QC session start when applying deep review per `reviewer-workflow.md`.

> **关键约束**：mstar 派发模型下，QC reviewer 是 PM 派发的 **leaf executor**（`Delegation: forbidden`），**禁止**自行派发任何 subagent 或 persona（`mstar-dispatch-gates` § 承接方反递归 NEVER 红线）。
> 本文件的设计选择：**透镜（lens）而非代理（subagent）**——QC reviewer **本人**在审查时额外覆盖的检查维度，每个透镜是一组结构化问题，审查者在本地逐一回答即可。
> 不派发子 agent，不产生额外对话轮次，不违反反递归约束。

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

## 透镜清单（结构化检查表）

每个透镜是一组审查问题。QC reviewer 在报告中按透镜分节列出发现，每个发现标注来自哪个透镜。

### Modularity Lens
- [ ] 本次变更是否引入了新的模块依赖？方向是否合理？
- [ ] 是否有逻辑被放在不合适的模块/层级中（如 controller 中的业务逻辑、model 中的视图逻辑）？
- [ ] 新引入的公共接口是否职责单一、边界清晰？
- [ ] 是否存在循环依赖或隐含的耦合将被后续变更放大？

### Contract Lens
- [ ] 任何公共 API/接口签名是否发生了不兼容变更？
- [ ] 若有 breaking change，是否在 plan 中声明？是否有迁移说明？
- [ ] 新增的 API 端点是否遵循现有命名和参数约定？
- [ ] 接口返回类型是否稳定（新增字段不使用破坏已有字段解析的方式）？

### Security Lens
- [ ] 变更是否涉及认证/授权流程？session、token、permission 逻辑是否正确？
- [ ] 是否存在未验证的用户输入被直接用于数据库查询、命令执行或文件操作？
- [ ] 敏感数据（密钥、token、密码、PII）是否在日志/错误信息/返回值中泄露？
- [ ] 新增的访问控制点是否覆盖了所有调用路径？

### Correctness Lens
- [ ] 错误处理是否显式、可恢复？是否有吞掉关键异常的 catch-all？
- [ ] 边界条件是否覆盖？（空值、零值、溢出、并发冲突）
- [ ] 状态转换逻辑是否一致？是否存在中间状态会被外部观察到？
- [ ] 返回值/副作用是否与声明一致？

### Performance Lens
- [ ] 是否引入了 N+1 查询？新增的 ORM 调用是否有 eager loading？
- [ ] 循环或批处理中是否有无界操作？
- [ ] 新索引是否必要且不会造成写入性能退化？
- [ ] 大对象/大列表是否做分页或流式处理？

### Reliability Lens
- [ ] 资源（连接、文件句柄、锁）是否在异常路径中也正确释放？
- [ ] 外部服务调用是否有超时和重试策略？
- [ ] 缓存失效策略是否正确（不会长期返回过期数据）？
- [ ] 是否存在可能无限增长的结构（无界缓存、无界日志、无界队列）？

### Auth Lens
- [ ] 认证中间件是否覆盖了所有新增端点？
- [ ] 权限检查是否在业务逻辑执行前完成（先鉴权再操作）？
- [ ] session 生命周期管理是否正确（创建、续期、失效）？
- [ ] 是否有权限提升路径（如 admin 操作需二次确认）？

### Input Validation Lens
- [ ] 所有外部输入（query params、body、headers）是否经过类型/范围/格式验证？
- [ ] 是否存在可通过输入触发的路径遍历、注入或 XSS？
- [ ] 文件上传是否有大小/类型检查？
- [ ] API 返回的错误信息是否在暴露内部实现细节？

### Data Migration Lens
- [ ] migration 是否可回滚？`down` 方法是否存在且正确？
- [ ] 是否对大数据量表使用了非阻塞的 migration 策略？
- [ ] 数据迁移是否保持了一致性（不丢数据、不产生中间脏状态）？
- [ ] 是否考虑了并发写入场景下的迁移安全性？

### Error Handling Lens
- [ ] 异常层级是否清晰（业务异常 vs 系统异常）？
- [ ] 面向用户的错误消息是否安全（不泄露内部细节）？
- [ ] 关键操作失败后的副作用是否被正确处理（事务回滚、补偿操作）？
- [ ] 是否有"静默失败"的路径（错误被忽略但后续逻辑假定成功）？

### Standards Lens
- [ ] 代码风格、命名、文件组织是否符合项目已有约定？
- [ ] 是否引入了与现有方案冲突的重复实现？
- [ ] 新依赖的引入是否有充分理由？
- [ ] 是否遵循了项目 `AGENTS.md` 中的维护契约？

### Testing Lens
- [ ] 对关键逻辑路径是否有测试覆盖？
- [ ] 边界和异常路径是否被测试覆盖？
- [ ] 是否存在仅验证 happy path 而跳过了 failure mode 的测试？
- [ ] 集成测试是否覆盖了与外部服务的交互边界？

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
