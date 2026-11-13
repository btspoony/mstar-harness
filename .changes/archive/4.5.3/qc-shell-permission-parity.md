---
category: Harness
packages: root
---

- **QC seat permissions are checked, not assumed.** `agents/qc-specialist*.md` narrowed `git branch*` to the four read-only forms the code-reviewer shell already allowed (a prefix wildcard admitted `-d`/`-D`/`-m`/`-M`/`-c`/`-C`), and `scripts/agent-shell-permission.test.ts` now fails when one QC shell's `permission` block diverges or drops a key path the code-reviewer superset carries.

<!-- CN -->
- **QC 席位权限改为校验而非默认一致。** `agents/qc-specialist*.md` 将 `git branch*` 收窄为 code-reviewer shell 已允许的四条只读形式（此前前缀通配会放行 `-d`/`-D`/`-m`/`-M`/`-c`/`-C`），并新增 `scripts/agent-shell-permission.test.ts`：任一 QC shell 的 `permission` 块偏离、或缺少 code-reviewer 超集拥有的键路径，测试即失败。
