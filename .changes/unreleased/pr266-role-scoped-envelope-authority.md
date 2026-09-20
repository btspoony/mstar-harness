---
category: Harness
packages: root
---

- **Issue-store session envelopes follow the role-scoped naming from main** (PR #266 main-drift fix): the authority checker's `issuedSessionLocation` reuses the engine's `sessionFilePath` rule (`sessions/<role>-<session-id>.json`, role ∈ {`plan-pm`, `coordinator`}) instead of a stale local copy of the old unscoped name — a valid engine-issued envelope is no longer refused with `issue.scope-refused` after the rename, and the CLI `--session` help text names the role-scoped shape.

<!-- CN -->
- **issue store 的会话信封遵循 main 的角色限定命名**（PR #266 main 漂移修复）：authority 检查的 `issuedSessionLocation` 改为复用引擎的 `sessionFilePath` 规则（`sessions/<role>-<session-id>.json`，role ∈ {`plan-pm`、`coordinator`}），不再保留旧未限定命名的本地副本——重命名后合法的引擎签发信封不再被 `issue.scope-refused` 拒绝，CLI `--session` 帮助文本同步写明角色限定形态。
