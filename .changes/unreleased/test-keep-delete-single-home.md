---
category: Harness
packages: root
---

- **The test keep/delete rule has one normative home.** `mstar-coding-behavior` § Evidence now states it; the nine audit/role/SDD restatements became pointers, with one self-contained assertion sentence where the seat cannot re-read the skill (the three SDD prompts and the QC checklist). `mstar-audit` and `test-audit.md` keep the auditor obligation to report the non-product-assertion class.
- **QC seat permissions are checked, not assumed.** `agents/qc-specialist*.md` narrowed `git branch*` to the four read-only forms the code-reviewer shell already allowed, and `scripts/agent-shell-permission.test.ts` now fails when one QC shell's `permission` block diverges or drops a key path the code-reviewer superset carries.

<!-- CN -->
- **测试 keep/delete 规则收敛为单一权威。** 规则现由 `mstar-coding-behavior` § Evidence 陈述；审计/角色/SDD 中的九处复述改为指针，仅在席位无法回读该 skill 处（三个 SDD prompt 与 QC checklist）保留一句自足断言。`mstar-audit` 与 `test-audit.md` 保留「报告非产品断言类别」的审计义务。
- **QC 席位权限改为校验而非默认一致。** `agents/qc-specialist*.md` 将 `git branch*` 收窄为 code-reviewer shell 已允许的四条只读形式，新增 `scripts/agent-shell-permission.test.ts`：任一 QC shell 的 `permission` 块偏离、或缺少 code-reviewer 超集拥有的键路径，测试即失败。
