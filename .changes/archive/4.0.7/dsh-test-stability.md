---
packages: root, engine, dsh
---

- **Two flaky suites now assert their own property instead of the store's wire image.** `packages/dsh/tests/native-commands.spec.ts` acquires one store connection per fixture root when the store is created or seeded, keeps it through the case's assertions and closes it in cleanup, so the clear and durable-slot reads meet an open store rather than the journal-less WAL shape a just-closed writer leaves for the next read-only open; the durable-slot reader also fails with the store's own reason instead of folding an unreadable store into "no record". `packages/engine/src/host-state-store.test.ts` proves a schema-refused read mutates nothing through logical content — the shared `store_meta.revision` and the recorded `dsh_status_emissions` row, compared across the read on one held connection — and names the element that changed, instead of comparing the store file's bytes before and after.
- Neither suite gained a retry, sleep or second attempt: the ordering that produced the failure is gone, not waited out.

<!-- CN -->
- **两个偶发失败的套件改为断言自身属性，不再断言库文件的字节镜像。** `packages/dsh/tests/native-commands.spec.ts` 在 fixture 建立 store 时为每个根目录取得唯一一条连接，贯穿用例断言并在清理阶段关闭，于是 clear 与持久槽读取面对的是一个仍然打开的 store，而不是刚关闭的 writer 留给下一次只读打开的「无 journal WAL」形态；持久槽读取器也改为以 store 自身的原因失败，不再把无法读取的 store 折叠成「没有记录」。`packages/engine/src/host-state-store.test.ts` 通过逻辑内容证明「schema 被拒的读取不改变任何东西」——在读取前后经同一条保活连接比较共享的 `store_meta.revision` 与已记录的 `dsh_status_emissions` 行，并点明变化的是哪一个元素，而不是比较读取前后库文件的字节。
- 两个套件都没有加入重试、sleep 或第二次尝试：产生失败的顺序被移除，而不是被等待掉。
