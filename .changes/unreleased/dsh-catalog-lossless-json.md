---
packages: root
---

- **dsh plugin**: fix the unified `mstar-engine-status` catalog row breaking the session round (`session event "user/message" carries non-JSON-serializable data`) when the iteration-gate section cannot be built — no `status.json`, no active steering compass, or an unreadable control doc. The optional `iteration` key is now omitted instead of present-as-`undefined`, keeping the appended message losslessly JSON-serializable at the `Session.append` boundary.

<!-- CN -->
- **dsh 插件**：修复统一 `mstar-engine-status` 目录行在迭代门禁段无法构建时（无 `status.json`、无 active 舵向 compass 或控制文档不可读）导致整轮会话失败的问题（`session event "user/message" carries non-JSON-serializable data`）。可选的 `iteration` 键现在改为省略而非以 `undefined` 呈现，注入消息在 `Session.append` 边界保持无损 JSON 可序列化。
