---
category: Changed
packages: dsh
---

- Added the **dispatch-role gate** (`roleGate`, default `hard`) at the subagent start seam: an explicit `Execute as:` / `Act as:` / `Role:` declaration — or a backticked/bold already-declared role id — is normalized into the canonical Assignment header before the preset merge, so `rolePresets` and the fallbacks persona chain bind the role instead of silently starting a role-less child. `hard` refuses only a start with no reliable declaration (the message names the missing field, the exact fix and the `roleGate: warn|off` escape hatch); `warn` advises once per apply; `off` disables the gate. Non-harness projects, prompts that already carry a usable declaration, requests carrying `agentPreset`, and unknown providers pass through silently.
- Documented `roleGate` in the dsh README (EN/ZH) and the host dispatch reference.

<!-- CN -->
- 在子代理启动缝隙新增**派发角色闸门**（`roleGate`，默认 `hard`）：显式的 `Execute as:` / `Act as:` / `Role:` 声明——或反引号/加粗的已声明角色 id——会在 preset 合并前被归一化为规范的 Assignment 头，使 `rolePresets` 与 fallbacks persona 链真正绑定角色，而不是静默启动无角色子代理。`hard` 只拒绝完全没有可靠角色声明的启动（消息点名缺失字段、确切修复与 `roleGate: warn|off` 逃生口）；`warn` 每次 apply 提醒一次；`off` 关闭闸门。非 harness 项目、已携带可用声明的 prompt、携带 `agentPreset` 的请求以及未知提供者一律静默直通。
- 在 dsh README（中英）与 host 派发参考文档中记录 `roleGate`。
