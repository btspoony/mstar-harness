---
category: Harness
packages: root
---

- The security-review deep-dive (`skills/mstar-audit/references/security-review.md`) expands its coverage and false-positive discipline: §2 gains explicit severity anchors (informational → critical) plus anti-strengthening rules; §8 hunting angles gain concrete `Signal:` clauses; the §9a–§9h category folds gain item-level exclusions and new checks (OAuth/SAML binding, WebAuthn, supply-chain/CI trust, infra/IAM, data isolation, AI/LLM trust); three new folds — §9i desktop/mobile/local IPC, §9j memory safety & binary (source review only), §9k availability & resource exhaustion; new §12 "Static evidence required" rule; new §13 "Per-class exclusion rules" (self-injection, existing-permission-check, crypto-error/write-only-validation) with a pointer line routing every other false-positive signal class to its owning section; and new §14 protocol/RPC/messaging invariants.

<!-- CN -->
- 安全审查深读指南（`skills/mstar-audit/references/security-review.md`）扩展覆盖面与误报纪律：§2 新增显式严重度锚点（informational → critical）与反升级规则；§8 侦查角度补充具体 `Signal:` 信号；§9a–§9h 类别折叠新增逐条排除与新增检查项（OAuth/SAML 绑定、WebAuthn、供应链/CI 信任、基础设施/IAM、数据隔离、AI/LLM 信任）；新增三个折叠——§9i 桌面/移动/本地 IPC、§9j 内存安全与二进制（仅源码审查）、§9k 可用性与资源耗尽；§12 新增「静态证据必需」规则；新增 §13「按类别排除规则」（自我注入、已存在权限检查、加密错误分支/仅写路径校验），并以一行指针把其余误报信号类别路由到各自归属章节；新增 §14 协议/RPC/消息不变量。
