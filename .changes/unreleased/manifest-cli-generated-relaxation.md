---
category: Harness
packages: root
---

- **The CLI consumer stops being byte-pinned.** The packaging manifest now records the closure a consumer can honestly reproduce: the CLI keeps its source closure, runtime floor and capability, and its generated closure is empty, because its single `mstar-harness.js` bundle comes out with different bytes across checkouts for a reason nobody has reproduced. A recorded digest described the building machine, not the source.
- **An empty generated closure is a legitimate state.** The producer and `--check` refuse an empty generated tree or artifact only for a layout that declares generated files, and the entrypoint is proved by existence and non-emptiness instead of membership in the pinned set. No manifest schema field was added; the consumers that pin bytes (`omp`, `opencode`, `zcode`) keep them unchanged.

<!-- CN -->
- **CLI consumer 不再钉死字节。** 打包 manifest 现在只记录每个 consumer 能诚实复现的闭包：CLI 保留源码闭包、运行时下限与能力声明，generated 闭包为空——它唯一的 `mstar-harness.js` bundle 在不同检出上产出不同字节，根因至今未复现。此前记录的摘要描述的是构建机器，不是源码。
- **空 generated 闭包是合法状态。** producer 与 `--check` 仅在布局声明了 generated 文件时才拒绝空的 generated 树或产物；entrypoint 改用存在性与非空校验，取代「必须在已钉死集合内」。未新增任何 manifest schema 字段；仍钉字节的 consumer（`omp`、`opencode`、`zcode`）保持不变。
