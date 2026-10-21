---
category: Changed
packages: cli, omp
---

- **Identity injection is decided per selected `action`, not per family tool.** A folded family publishes its `sessionId` selector ONCE for the whole tool, so the `omp` `mcp-identity` extension filled the host id into every call of a mixed family — and the CLI refuses a selector the selected action does not declare, so every non-identity action of such a family (`mstar_status` → `tech-debt`, `mstar_milestone` → `list`, …) was unusable on OMP, refused with a "drop `sessionId`" recovery the hook undid on the next call. The extension now reads the per-action answer from the published `x-mstar-selectors` index and passes a call whose action declares no selector through untouched; when the action DOES declare it, the host id still replaces any caller-supplied value. The CLI publishes that index on every family with a selector, stating exactly the accepting actions its own refusal names.

<!-- CN -->
- **身份注入改为按所选 `action` 判定，而不是按家族工具判定。** 折叠后的家族把 `sessionId` 选择器对整个工具只发布一次，于是 `omp` 的 `mcp-identity` 扩展会把宿主 id 填入混合家族的每次调用；而 CLI 会拒绝所选 action 未声明的选择器，导致这类家族里所有非身份 action（`mstar_status` → `tech-debt`、`mstar_milestone` → `list` 等）在 OMP 上完全不可用——拒绝信息让调用方「丢掉 `sessionId`」，而扩展下一次调用又会把它填回去。现在扩展从已发布的 `x-mstar-selectors` 索引读取按 action 的事实：所选 action 未声明选择器的调用原样透传；声明了的仍然由宿主 id 覆盖调用方自带值。CLI 在所有带选择器的家族上发布该索引，其内容与拒绝信息点名的接受 action 完全一致。
