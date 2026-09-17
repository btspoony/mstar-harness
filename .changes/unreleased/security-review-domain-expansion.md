---
category: Harness
packages: root
---

- The security-review deep-dive gains §13 "Per-class exclusion rules": three residual exclusion decisions not owned elsewhere — self-injection/own-data (requires an effect on another principal, origin, or protected shared state), existing-permission-check (the check must bind the principal, resource, action, and entry path; presence neither proves nor refutes), and crypto-error/write-only-validation (requires untrusted data reaching the weaker read/fallback path plus an effect; safe failure refutes) — plus one pointer line routing every other false-positive signal class to its existing owning section instead of duplicating it.

<!-- CN -->
- 安全审查深读指南新增 §13「按类别排除规则」：三条尚无归属的残余排除判定——自我注入/攻击者自身数据（须证明影响另一主体、另一来源或受保护的共享状态）、已存在权限检查（检查须绑定该主体、资源、动作与入口路径；存在本身既不证实也不排除绕过）、加密错误分支/仅写路径校验（须证明不可信数据到达更弱的读取/回退路径并产生效果；安全失败即反驳）——外加一行指针，把其余误报信号类别路由到各自已有的归属章节而不重复抄写。
