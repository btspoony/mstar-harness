---
category: Harness
packages: root
---

- **Remediated three lint backlogs** covering roughly 480 sites across Rule #341 refusal recoveries, help reachability, and frozen-invariant hash-gate structure.
- **Made the gates enforceable:** refusal-quality and help-reachability now pass with empty allowlists, and the hash-gates CI step blocks on violations. Hash-gates reports 3 authorized gates and 11 replay-allowed sites separately from violations.
- **Defined explicit marker semantics:** `// reachability: manual — <reason>` records a site-specific manual recovery only when its reason is non-empty; `// hash-gate: authorized — <reason>` authorizes the adjacent invariant gate only with a non-empty rationale. These markers classify their own sites and do not suppress sibling findings.
- No machine-local store identifiers were added to tracked content.

<!-- CN -->
- **完成三类 lint 积压整改**，覆盖约 480 个位置：Rule #341 拒绝恢复、帮助可达性，以及冻结不变量 hash-gate 结构。
- **使门禁真正生效：** refusal-quality 与 help-reachability 现以空 allowlist 通过；hash-gates CI 步骤现会阻断违规。hash-gates 将 3 个已授权门禁和 11 个允许重放的位置与违规项分别报告。
- **明确标记语义：** `// reachability: manual — <reason>` 仅在理由非空时标记该单一位置的人工恢复；`// hash-gate: authorized — <reason>` 仅在理由非空时授权相邻的不变量门禁。标记只分类其自身位置，不会屏蔽相邻位置的发现。
- 跟踪内容未加入任何机器本地 store 标识符。
