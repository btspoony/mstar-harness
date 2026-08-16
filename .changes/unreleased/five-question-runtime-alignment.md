---
packages: engine, cli, root
---

- **Five-question lint runtime mode**: `lintFiveQuestion(body, mode?)` now supports `mode: "runtime"` (default `"authoring"`, non-breaking) with a locked `RUNTIME_HEADING_ALIASES` table — heading synonyms (e.g. `process`/`playbook` for Workflow, `硬规则`/`门禁` for Decision Rules, `output format`/`证据` for Evidence, `dependencies`/`关系` for References) that count as the canonical sections for shipped topic skills. `mstar skill lint` selects runtime mode for `mstar-*` skill dirs except `mstar-skill-authoring` (always authoring/strict); `mstar-harness-core` prints an explicit **exempt** row for the five-question checklist. Greenfield (authoring) lint still demands canonical headings.
- **Runtime corpus alignment**: 15 shipped `mstar-*` topic skills gained minimal annotations/thin sections (Evidence ×13, Workflow ×9, References ×6, plus `mstar-host`'s load-order/decision-rules gaps) derived from existing material — every runtime skill now passes runtime-mode five-question lint; `mstar-audit` needed zero edits. `skills/mstar-skill-authoring/SKILL.md` documents the alias map (runtime-mode semantics stay SSOT: aliases exempt mechanical lint, not content).

<!-- CN -->
- **五问 lint 运行时模式**：`lintFiveQuestion(body, mode?)` 新增 `mode: "runtime"`（默认 `"authoring"`，非破坏）与锁定别名表 `RUNTIME_HEADING_ALIASES` —— 标题同义词（如 Workflow→`process`/`playbook`、Decision Rules→`硬规则`/`门禁`、Evidence→`output format`/`证据`、References→`dependencies`/`关系`）对已发布专题 skill 计为对应 canonical 章节。`mstar skill lint` 对 `mstar-*` 目录选 runtime 模式（`mstar-skill-authoring` 恒为 authoring/strict）；`mstar-harness-core` 打印显式 **exempt** 行。Greenfield（authoring）lint 仍要求 canonical 标题。
- **运行时语料对齐**：15 个已发布 `mstar-*` 专题 skill 增加最小标注/薄章节（Evidence ×13、Workflow ×9、References ×6，另补 `mstar-host` 的 load-order/decision-rules 缺口），内容均取自既有素材 —— 全部运行时 skill 通过 runtime 模式五问 lint；`mstar-audit` 零改动。`skills/mstar-skill-authoring/SKILL.md` 记录别名表（运行时语义仍为 SSOT：别名豁免机械 lint，不豁免内容）。
