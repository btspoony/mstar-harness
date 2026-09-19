---
category: Harness
packages: root
---

- **Legacy session envelopes authorize issue mutations again after an upgrade**: the issue store now authorizes a privileged mutation through the workflow's **recorded** session file, accepting that bound path in either engine-issued shape — the canonical `workflows/<id>/sessions/<role>-<session-id>.json` or the pre-#264 bare `workflows/<id>/sessions/<session-id>.json` that released 3.11.0 workflows record (both roles; 3.11.0 had no role prefix). The presented file must be exactly the bound path — a copy at any other path refuses even when byte-identical — and every content binding (workflow, plan row/coordinator record, session id, live lifecycle) is enforced unchanged.

<!-- CN -->
- **升级后旧版会话信封恢复 issue 变更授权**：issue store 现在经由 workflow **记录的**会话文件授权特权变更，该绑定路径接受两种引擎签发形状——规范形式 `workflows/<id>/sessions/<role>-<session-id>.json` 或已发布 3.11.0 workflow 记录的 #264 之前裸形式 `workflows/<id>/sessions/<session-id>.json`（两种角色；3.11.0 无角色前缀）。呈递文件必须与绑定路径完全一致——任何其他路径上的副本即使字节相同也一律拒绝——且全部内容绑定（workflow、plan 行/coordinator 记录、session id、存活生命周期）保持不变。
