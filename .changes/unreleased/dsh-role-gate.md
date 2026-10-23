---
category: Changed
packages: dsh
---

- Added the **dispatch-role gate** (`roleGate`, default `hard`) at the subagent start seam: an explicit `Execute as:` / `Act as:` / `Role:` declaration — or a backticked/bold already-declared role id — is normalized into the canonical Assignment header before the preset merge, so `rolePresets` and the fallbacks persona chain bind the role instead of silently starting a role-less child. Every `Execute as` header line is repaired with its label normalized (the parsers bind the LAST line, case-sensitively), and a declaration quoted inside a fenced code block is ignored. `hard` refuses a start with no reliable declaration — or with two or more distinct ones, naming the ids and the exactly-one rule — with the exact fix and the mode-appropriate recovery (`warn` advises once per apply and suggests `off`); `off` skips only the refusal, a single explicit declaration is still normalized. The non-harness exemption is judged at the child's EFFECTIVE start directory (absolute `cwd`, relative resolved against the parent's, omitted inherited from the parent session), so the default `subagent` / `spawn_teammate` starts are gated by the parent's directory. Prompts that already carry a usable declaration, requests carrying `agentPreset`, and unknown providers pass through silently.
- `roleGate` is the plugin's only `volatile` config field: it is read from the Loader's live config reference on every start, so the dsh plugin configuration form can edit it and the save (written into the profile patch) applies on the next subagent start without a reload.
- Documented `roleGate` in the dsh README (EN/ZH) and the host dispatch reference.

<!-- CN -->
- 在子代理启动缝隙新增**派发角色闸门**（`roleGate`，默认 `hard`）：显式的 `Execute as:` / `Act as:` / `Role:` 声明——或反引号/加粗的已声明角色 id——会在 preset 合并前被归一化为规范的 Assignment 头，使 `rolePresets` 与 fallbacks persona 链真正绑定角色，而不是静默启动无角色子代理。头部中每一条 `Execute as` 行都会被修复并归一化标签（解析器区分大小写且绑定**最后一条**）；围栏代码块里引用的声明会被忽略。`hard` 拒绝没有可靠角色声明的启动——或存在两个及以上不同声明（消息点名这些 id 与"只能有一个"规则）——并给出确切修复与**与模式匹配**的恢复路径（`warn` 每次 apply 咨询一次且建议 `off`）；`off` 只跳过拒绝，单一显式声明仍会被归一化。非 harness 豁免按子代理**实际**启动目录判定（绝对 `cwd`；相对 `cwd` 相对父目录解析；缺省 `cwd` 继承父会话目录），因此默认的 `subagent` / `spawn_teammate` 启动会按父目录受闸。已携带可用声明的 prompt、携带 `agentPreset` 的请求以及未知提供者一律静默直通。
- `roleGate` 是插件唯一的 `volatile` 配置字段：每次启动都从 Loader 的实时配置引用读取，因此 dsh 插件配置页可编辑它，保存（写入 profile patch）在下一次子代理启动即生效，无需重载。
- 在 dsh README（中英）与 host 派发参考文档中记录 `roleGate`。
