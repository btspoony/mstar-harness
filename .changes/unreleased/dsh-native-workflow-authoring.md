---
category: Changed
packages: root, opencode, dsh, omp
---

- **dsh docs**: the package README now documents the recommended `workflowNames` allowlist for the native read-only fan-out path on dsh — `mstar-qc-tri` (plan QC tri), `mstar-audit-fanout` (large-repo `/codebase-audit`), `mstar-pr-seats` (`/amazing-pr-review deep`) — with the production-overlay note in the same place: with the shipped empty allowlist every name is *unknown*, which the default `workflowGate: 'warn'` turns into one survivable `workflow.name.unknown` advisory; a deployment that also wants unknown names vetoed sets `workflowGate: 'hard'` in the profile layer. No default changed — `workflowGate` stays `'warn'` and `workflowNames` stays unset (operator overlays, never mstar defaults).
- **dsh read-only fan-out (docs)**: `skills/mstar-host/references/dsh.md` gains the **Read-only fan-out via the `workflow` tool** section and `references/dsh-workflow-scripts.md` ships the copy-pasteable `script` + `meta` templates for the three names; `commands/codebase-audit.md` and `commands/amazing-pr-review.md` carry the dsh-conditional sentence (slash → native `workflow` tool → conversation `workflow-run` node, other hosts unchanged), and `skills/mstar-sdd/SKILL.md` notes the plan QC tri MAY run through the qc-tri script while per-task implementers stay serial `subagent`.

<!-- CN -->
- **dsh 文档**：包 README 现记录 dsh 原生只读扇出路径的推荐 `workflowNames` 白名单——`mstar-qc-tri`（plan QC tri）、`mstar-audit-fanout`（大型仓库 `/codebase-audit`）、`mstar-pr-seats`（`/amazing-pr-review deep`）——并在同处给出生产覆盖层说明：出厂空名单下每个名字都是 *unknown*，默认 `workflowGate: 'warn'` 把它变成运行可存活的一条 `workflow.name.unknown` 咨询；若还要否决 unknown 名字，部署在 profile 层设置 `workflowGate: 'hard'`。默认值未变——`workflowGate` 仍为 `'warn'`、`workflowNames` 仍未设置（二者都是操作者覆盖，绝非 mstar 默认）。
- **dsh 只读扇出（文档）**：`skills/mstar-host/references/dsh.md` 新增 **Read-only fan-out via the `workflow` tool** 一节，`references/dsh-workflow-scripts.md` 提供三个名字可直接复制的 `script` + `meta` 模板；`commands/codebase-audit.md` 与 `commands/amazing-pr-review.md` 携带 dsh 条件句（斜杠命令 → 原生 `workflow` 工具 → 会话 `workflow-run` 节点，其它宿主不变），`skills/mstar-sdd/SKILL.md` 注明 plan QC tri 可走 qc-tri 脚本，而逐任务实现者仍为串行 `subagent`。
