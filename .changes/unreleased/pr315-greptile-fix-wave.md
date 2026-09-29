---
category: Harness
packages: engine, commands, cli
---

- **`roadmap replace` states its own comparison basis.** Both `--expect-project` and `--expect-roadmap` are now irreducible caller claims (the frozen roadmap-content-authority contract already declared them required): an omitted claim was previously derived from the same transaction read, which made the guard compare the authority against itself and let a stale read silently overwrite a newer update. Omitting either is one aggregated usage refusal naming both flags; a stale claim still refuses `roadmap.revision-conflict` with nothing written.
- **MCP tool schemas no longer advertise fields the handler does not read.** Payload descriptors are composed into a registered tool schema only when they name a declared `z.unknown()` field; `persist.write`'s per-kind contracts are keyed by its `kind` argument value, so they were injected as callable `status`/`snapshot`/`review`/`json` document fields while the handler reads the document from `input`/`file` only. They stay published through the `schema` family.
- **A declared string-or-null payload field keeps its type.** `IssueTriage.owner` (`"string | null"`) no longer degrades to an unbounded `z.unknown()` in the published payload schema; the JSON-schema `type: ["string", "null"]` the domain declares is what a caller sees.
- **Cancellation during a dashboard start stops the listener it created.** A cancelled request that had already started a dashboard now closes and evicts that handle instead of leaking a connection-scoped service; a handle another call already owns is reused and left running.

<!-- CN -->
- **`roadmap replace` 明确声明自身比较基准。** `--expect-project` 与 `--expect-roadmap` 现均为不可推导的调用方声明（冻结的 roadmap-content-authority 契约本已声明为必填）：此前省略的声明由同一事务内的读取推导，使守卫变成权威自比，过期的读取可静默覆盖更新的内容。省略任一即为一次聚合 usage 拒绝并同时点出两个 flag；过期声明仍以 `roadmap.revision-conflict` 拒绝且不写入任何内容。
- **MCP 工具 schema 不再暴露处理器不读取的字段。** 仅当 payload descriptor 命名一个已声明的 `z.unknown()` 字段时才注入注册的工具 schema；`persist.write` 的按 kind 契约以 `kind` 参数值为键，因而被注入为可调用的 `status`/`snapshot`/`review`/`json` 文档字段，而处理器只从 `input`/`file` 读取文档。这些契约仍通过 `schema` 族发布。
- **声明的 string-or-null 载荷字段保持其类型。** `IssueTriage.owner`（`"string | null"`）不再在发布的载荷 schema 中退化为无约束的 `z.unknown()`；调用方看到的是域声明的 JSON-schema `type: ["string", "null"]`。
- **仪表板启动期间取消会停止其创建的监听器。** 已启动仪表板的请求被取消时，现会关闭并逐出该句柄，而不再泄漏 connection 作用域的服务；已被其他调用持有的句柄会被复用并保持运行。
