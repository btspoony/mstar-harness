---
category: Fixed
packages: root, commands, cli
---

- **A refusal no longer echoes credentials an operator pasted.** `--adopt` reports a malformed value through the same URL-userinfo redaction the transport layer uses, so `https://user:pass@host` arrives as `https://[redacted]@host` in both the usage refusal and the duplicate-entry refusal. The operator still sees which value was rejected.
- **A label-discovery query failure recovers toward the real repair.** The shared `linear.query-failed` recovery described resuming an import, which does not apply when push's label walk hits a provider page that advertises a next page without a cursor; it now states that re-running reads the same page and refuses identically, and names the provider envelope as the defect.
- **The MCP caller-identity refusal for `plan.bind` names a host-neutral route.** It printed the dsh native tool as the recovery to every host; the CLI entry is now the stated route, with the native tool described as an optional host surface (dsh's remains named as the example).
- **The packaged-install smoke receipt lists the bootstrap asset it requires.** The probe already rejected a tarball without `AGENTS.md`; the recorded `assets` object now says `bootstrap: true` so the receipt and the requirement agree.
- **The dual-key adapter test asserts the observable validation result** instead of pinning the mutation of its options object, so moving the resolved generation does not redden a behaviour-preserving refactor.

<!-- CN -->
- **拒绝文本不再回显操作者粘贴的凭据。** `--adopt` 报错走与传输层相同的 URL userinfo 脱敏，`https://user:pass@host` 在用法拒绝与重复条目拒绝中都变成 `https://[redacted]@host`，操作者仍能看到被拒的是哪个值。
- **label discovery 的查询失败改为指向真正的修复。** 共享的 `linear.query-failed` recovery 原先只讲恢复 import cursor，而 push 的 label 遍历命中“宣称还有下一页却没有 cursor”的 provider 页时并不适用；现在说明重跑会读到同一页并同样被拒，并点名这是 provider 信封缺陷。
- **`plan.bind` 的 MCP caller-identity 拒绝文本给出中立的入口。** 原先向所有 host 打印 dsh 原生工具作为恢复路径；现在以 CLI 入口为正式路径，把原生工具描述为可选的宿主能力（dsh 的实现仍作为示例点名）。
- **打包安装 smoke 的 receipt 列出它实际要求的 bootstrap 资产。** 探针本就会拒绝缺少 `AGENTS.md` 的 tarball，现在记录里的 `assets` 对象补上 `bootstrap: true`，使 receipt 与要求一致。
- **dual-key adapter 测试只断言可观察的校验结果**，不再钉死 options 对象的字段改写，因此把解析出的 generation 换个位置不会让保持行为的重构变红。
