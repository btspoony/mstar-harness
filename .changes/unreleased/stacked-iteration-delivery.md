---
category: Breaking
packages: root
---

- **Iterations deliver as a stack:** an iteration is now delivered as a chain of stacked PRs opened during execution and merged bottom-up, each targeting its live predecessor; `branch.integration` is never a PR head, and the final close-delta layer opens only for a nonempty close delta.
- **One delivery procedure for both callers:** PR publication through merge authorization, and the post-merge closure, are shared project-manager references extended by the iteration stack rules rather than an iteration-only path.
- **No stage names after close:** the prompt surface no longer names numbered stages after iteration-close; the post-merge procedure is called Workflow Close Out, and the delivered projection (the compass marker, the roadmap row and the milestone rollup) is written only after whole-chain proof.

<!-- CN -->
- **迭代以堆叠 PR 交付**：迭代现以执行期间开启的堆叠 PR 链交付，自下而上逐层合并，每个 PR 以其实时前驱为 base；`branch.integration` 从不作 PR head，仅在有非空 close delta 时才开最后的 close-delta layer。
- **两条路线共用一条交付程序**：从发布到 merge 授权、以及合并后的关闭，都是共享的项目经理参考文件，由迭代的堆叠规则扩展，而非迭代专属路径。
- **close 之后不再使用阶段名**：prompt 面不再命名 iteration-close 之后的编号阶段；合并后的程序称 Workflow Close Out，`delivered` 投影（compass 标记、roadmap 行、milestone 汇总）只在整链证明之后写入。
