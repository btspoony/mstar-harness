---
category: Changed
packages: dsh, cli
---

- Raised the `@deepseek-ai/dsh-*` peer cohort and the architectural dev pins (`dsh-client-ui-*`, `dsh-scope`, `dsh-session-format-v3-to-v4`, `dsh-tool-executor-native`, `dsh-util-code-language`) to `0.2.2-rc.5`; the rc.3 → rc.5 audit finds no removed export, no package-set change and no session-format change, so the plugin consumes the same surfaces.
- Bridged the role declaration to `dsh-llm-fallbacks`: its reader resolves a role only from the body-label `**Execute as**: <id>` header and stops at the first `---`, so a front-matter `execute_as` Assignment left its fallback chain, persona and notice row unbound. With the fallbacks capability mounted, the role channel now prepends that one header line ahead of the opening fence at dispatch time; the document, the role channel and the dispatch gate keep reading front matter.
- Moved the `dsh-llm-fallbacks` pin to `0.8.11` in both places at once (`packages/dsh` devDependency and the CLI `mstar.dshLlmFallbacks`), whose peers are the same `^0.2.2-rc.5` cohort.

<!-- CN -->
- 将 `@deepseek-ai/dsh-*` peer 队列与架构型 dev pin（`dsh-client-ui-*`、`dsh-scope`、`dsh-session-format-v3-to-v4`、`dsh-tool-executor-native`、`dsh-util-code-language`）升到 `0.2.2-rc.5`；rc.3 → rc.5 适配审计确认无导出删除、无包集合变化、无会话格式变化，插件消费的接口面不变。
- 为 `dsh-llm-fallbacks` 桥接角色声明：它的阅读器只从正文标签 `**Execute as**: <id>` 头部解析角色，并在第一个 `---` 处停止，因此仅有 front matter `execute_as` 的 Assignment 会让其回退链、persona 与通知行无法绑定。fallbacks 能力已挂载时，角色通道在派发时把这一行头部插到开围栏之前；文档、角色通道与派发门禁仍只读 front matter。
- 把 `dsh-llm-fallbacks` pin 一次性移到 `0.8.11`（`packages/dsh` devDependency 与 CLI `mstar.dshLlmFallbacks` 两处同步），其 peer 队列同样是 `^0.2.2-rc.5`。
