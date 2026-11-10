---
category: Fixed
packages: omp
---

- **Leaf-seat prefix idempotency (#694):** the omp `tool_call` handler no longer stacks `export MSTAR_LEAF_SEAT=1; ` onto a command it already revised — leaf-session bash commands previously accumulated one marker per host re-fire (up to 361 consecutive copies in one transcript). One predicate now recognises only the contiguous leading chain of this hook's own exports (`MSTAR_HOST_SESSION_ID`, `MSTAR_LEAF_SEAT`) and stops at the first other statement, so the marker stays fail-closed: a command that merely mentions it (`echo 'export MSTAR_LEAF_SEAT='`, `grep MSTAR_LEAF_SEAT=`) still receives the prefix, and a caller's own leading `export MSTAR_HOST_SESSION_ID=…; ` is still respected.

<!-- CN -->
- **Leaf-seat 前缀幂等（#694）：** omp `tool_call` handler 不再对已改写的命令重复叠加 `export MSTAR_LEAF_SEAT=1; `——此前 leaf 会话的 bash 命令会在每次宿主重放时多出一个标记（单条 transcript 记录中最多出现 361 个连续副本）。现在由一个判定函数只识别本 hook 自身导出的连续前导链（`MSTAR_HOST_SESSION_ID`、`MSTAR_LEAF_SEAT`），遇到第一个其它语句即停止，因此标记仍保持 fail-closed：仅在文本中提及该标记的命令（`echo 'export MSTAR_LEAF_SEAT='`、`grep MSTAR_LEAF_SEAT=`）依旧会获得前缀，调用方自带的 `export MSTAR_HOST_SESSION_ID=…; ` 也依旧被尊重。
