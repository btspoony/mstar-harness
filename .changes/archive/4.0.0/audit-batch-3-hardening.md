---
category: Harness
packages: root, cli, engine, commands
---

- The **installer now refuses to clobber user files**: symlinked/non-regular config targets are refused with a named recovery instead of being silently replaced; an incomplete `~/.mstar/harness` clone self-heals (kept aside as `.broken-<timestamp>`, one re-clone) instead of blocking every future install; failed paired ZCode marketplace writes restore both prior file contents (#452).
- **Published command schemas now state what the engine enforces**: issue closure payloads publish disposition-specific `requiredWhen` branches (`anyOf` derived from the engine's `ClosureEvidence` registry, including disposition overrides), and `plan.complete` publishes/validates its declared completion-evidence shape — clients composing calls from the published schema no longer hit invisible refusals (#451).
- The **issue action vocabulary has one source**: engine exports `ISSUE_ACTIONS`/`ISSUE_ACTION_NAMES` (payload, read, CAS and closure-disposition facts per action); the CLI derives its verb tables from it instead of four hand-maintained lists — drift is now a compile error, published ids pinned by parity tests. Token set and behavior unchanged (#453 remainder).

<!-- CN -->
- **安装器现在拒绝破坏用户文件**：符号链接/非常规配置目标会被拒绝并给出恢复指引而非静默替换；不完整的 `~/.mstar/harness` 克隆可自愈（保留为 `.broken-<timestamp>` 并重试一次克隆）而非永久阻塞后续安装；成对的 ZCode marketplace 写入失败时恢复两个文件的先前内容 (#452)。
- **发布的命令 schema 如实陈述引擎强制约束**：issue closure 载荷按生效 disposition 发布 `requiredWhen` 分支（`anyOf` 派生自引擎 `ClosureEvidence` 注册表，含 disposition 覆盖），`plan.complete` 发布并校验其声明的完成证据结构——按发布 schema 组装调用的客户端不再撞上不可见的拒绝 (#451)。
- **issue 动作词汇单源化**：engine 导出 `ISSUE_ACTIONS`/`ISSUE_ACTION_NAMES`（每个动作的 payload、read、CAS 与 closure disposition 事实）；CLI 的动词表改为从其派生，替代四份手工清单——漂移现为编译错误，发布 id 由一致性测试钉住。令牌集与行为不变 (#453 余量)。
