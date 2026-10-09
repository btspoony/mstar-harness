---
category: Changed
packages: engine, omp
---

- **A coordinator bind retry under an explicit operation id is now the recorded replay.** `bindExecutionSession` takes an OPTIONAL `expected` and resolves the workflow's current token from its own header inside the write transaction; the bind request fingerprint carries the freshness-omitted marker instead of a freshly derived token, so the unchanged retry of `{workflowId, operationId}` after the first commit's revision advance is served as the replay rather than `execution.operation-conflict`. A SUPPLIED token keeps its strict-CAS semantics: a stale value still refuses `execution.stale-token`, and the same operation id with a different supplied token stays an operation conflict.
- The host-owned `mstar_coordinator` ACTIVE `bind` forwards an omitted `expected` as omitted (the engine resolves it) and mints the operation id when the caller names none; its `recover` arm still reads the current token from the addressed authority because `recoverExecutionCoordinator` requires an explicit one. The registered tool description, parameter advertisement and the `mstar-host` OMP reference state the same contract.
- **Incompatible-store FILE recovery keeps its engine facts and loaded-module provenance.** The stored-target reader's §4.3 authority veto carries the original thrown `StoreError`, and the FILE recovery boundary projects it through the shared engine-refusal path, so a `store.schema-unsupported` refusal reaches the caller with its three schema-version facts, `loadedEntry` and the incompatible-loaded-build guidance — the same fidelity the bind / show-recovery / ACTIVE-recovery branches already provide.

<!-- CN -->
- **带显式 operation id 的 coordinator bind 重试现在就是已记录的回放。** `bindExecutionSession` 的 `expected` 变为可选，并在写事务内从 workflow 自身 header 解析当前令牌；bind 请求指纹携带"省略新鲜度"的标记而非新推导的令牌，因此首次提交推进 revision 之后，未变更的 `{workflowId, operationId}` 重试会作为回放返回，而不是 `execution.operation-conflict`。显式提供的令牌仍保持严格 CAS 语义：过期值仍以 `execution.stale-token` 拒绝，同一 operation id 携带不同的显式令牌仍是操作冲突。
- 宿主自有的 `mstar_coordinator` ACTIVE `bind` 在调用方省略 `expected` 时按省略转发（由引擎解析），并在未提供 operation id 时自行铸造；其 `recover` 分支仍从被寻址的权威读取当前令牌，因为 `recoverExecutionCoordinator` 要求显式令牌。注册工具描述、参数广告与 `mstar-host` 的 OMP 参考已陈述同一契约。
- **不兼容 store 的 FILE 恢复保留引擎事实与已加载模块来源。** stored-target reader 的 §4.3 权威否决现在携带原始抛出的 `StoreError`，FILE 恢复边界通过共享的 engine-refusal 路径投影它，因此 `store.schema-unsupported` 拒绝会连同三个 schema 版本事实、`loadedEntry` 与不兼容已加载构建的指引一起抵达调用方——与 bind / show-recovery / ACTIVE-recovery 分支既有的保真度一致。
