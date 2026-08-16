---
category: Harness
packages: dsh
---

- **dsh plugin**: session-start harness context without copy-paste — a GLOBAL `mstar:harness-rules` system-prompt pointer section (order 2: after the deployment persona 0 / child role persona 1, before `plan:policy` 50) carrying presence / enforcement word / resolved `{HARNESS_DIR}` / one "read `skill://mstar-harness-core` first" directive, plus an `mstar:engine-status` runtime-context snapshot (watermark + iteration gate + one compact state line — a bounded projection over the catalog source, never the full status.json). Both register on the GLOBAL prompt layer (root session AND every dispatched child), carry zero complete `{{...}}` groups (STRICT interpolation safe), and the child-scoped `mstar:role-persona` section stays byte-stable (regression-locked).
- **dsh plugin**: the section's enforcement word is **live per assembly** — the section text is a provider that re-reads the compass (`resolveCompassEnforcement`, the same existing read the gates and the catalog use; no new config key), so a mid-session compass `soft`/`hard` flip appears in the next prompt assembly without re-registration. Injection degrades contained (service absent → one debug log; registration failure → warn; boot never affected).

<!-- CN -->
- **dsh 插件**：会话启动即带 harness 上下文，免粘贴——在**全局** prompt 层注册 `mstar:harness-rules` system-prompt 指针段（order 2：deployment persona 0 / child role persona 1 之后、`plan:policy` 50 之前；存在性 / enforcement 词 / 已解析 `{HARNESS_DIR}` / 一条"先读 `skill://mstar-harness-core`"指引）与 `mstar:engine-status` 运行时上下文快照（版本号 + 迭代门禁 + 一行紧凑状态——catalog 同源数据的有界投影，绝不输出全量 status.json）。root 会话与每个派发 child 均可见；构造上零完整 `{{...}}` 组（STRICT 插值安全）；child 作用域 `mstar:role-persona` 段保持字节稳定（回归锁定）。
- **dsh 插件**：段的 enforcement 词**按 assembly 实时解析**——段文本为 text provider，每次组装重新读取 compass（`resolveCompassEnforcement`，与 gates/catalog 同一既有读取面，不新增配置键），会话中 compass 的 `soft`/`hard` 切换在下一次 prompt 组装即时生效，无需重新注册。注入降级受控（服务缺失 → 一条 debug log；注册失败 → warn；boot 永不受影响）。
