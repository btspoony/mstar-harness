---
category: Added
packages: root
---

- **`/codebase-comment-cleanup` entry.** New slash command that triages every code comment into delete / ADR / issue / keep-with-shape, batched through a development seat with independent QC and PM Acceptance, and closes on a measured `unclassified-comment net change`.
- **Comment triage reference.** `mstar-coding-behavior/references/comment-cleanup.md` maps tautology, excuse, stale and decision record onto the existing Drift / License / Substitute failure modes; a confirmed Excuse is captured per `mstar-project-governance` § Issue capture before its comment goes, and an ADR home is required only for a decision that must outlive the change.

<!-- CN -->
- **`/codebase-comment-cleanup` 入口。** 新的斜杠命令，把每条代码注释归入 删除 / ADR / issue / 保留并定型 四类，按批次交给 dev 席执行、独立 QC 复核、PM Acceptance 收口，并以实测的 `unclassified-comment net change` 收尾。
- **注释分诊参考。** `mstar-coding-behavior/references/comment-cleanup.md` 把 Tautology / Excuse / Stale / Decision Record 映射到既有的 Drift / License / Substitute 失效模式；已确认的 Excuse 在删除注释前按 `mstar-project-governance` § Issue capture 捕获，只有需要跨变更留存的决策才要求 ADR 归属。
