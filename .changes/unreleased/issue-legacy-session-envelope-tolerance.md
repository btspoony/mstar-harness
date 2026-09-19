---
category: Harness
packages: root
---

- **Legacy plan-pm session envelopes authorize issue mutations again after an upgrade**: the issue store's engine-issued path check now also accepts the pre-#264 bound form `workflows/<id>/sessions/<session-id>.json` for the `plan-pm` role, so sessions created by the released 3.11.0 engine keep their authority (`issue.scope-refused` no longer blocks them). Path shape only — every content binding (workflow, plan row, session id, recorded `session_file`) is enforced unchanged, and the coordinator role keeps canonical-only naming.

<!-- CN -->
- **升级后旧版 plan-pm 会话信封恢复 issue 变更授权**：issue store 的引擎签发路径校验现在对 `plan-pm` 角色同时接受 #264 之前的绑定形式 `workflows/<id>/sessions/<session-id>.json`，已发布 3.11.0 引擎创建的会话不再被 `issue.scope-refused` 拒绝。仅放宽路径形状——全部内容绑定（workflow、plan 行、session id、记录的 `session_file`）保持不变，coordinator 角色仍只接受规范命名。
