---
category: Changed
packages: engine
---

- Extended the existing Prepare-amendment header cases for the reviewed-plan branch declarations. An appended plan carrying the descriptive `**Working branch policy:**` line beside its `**Working branch:**` declaration is accepted, and the accepted row's `working_branch` is the branch that declaration names. A plan offering only the policy wording still refuses `coordination.prepare-amendment.invalid-plan` before any write, with the refusal naming the missing declaration, the plan row and the reviewed file; the descriptive policy line never substitutes for the declaration. Test-only: no production parser, precedence or refusal contract changed.

<!-- CN -->
- 扩展现有 Prepare 修正的 header 用例，覆盖受审 plan 的分支声明：追加的 plan 若在 `**Working branch:**` 声明旁带有描述性的 `**Working branch policy:**` 一行，仍被接受，且接受行的 `working_branch` 取自该声明本身；若 plan 只提供 policy 措辞，则仍在任何写入之前以 `coordination.prepare-amendment.invalid-plan` 拒绝，拒绝信息指明缺失的声明、plan 行与受审文件路径——描述性 policy 行不能替代声明。仅测试变更：未改动生产 parser、优先级或拒绝契约。
