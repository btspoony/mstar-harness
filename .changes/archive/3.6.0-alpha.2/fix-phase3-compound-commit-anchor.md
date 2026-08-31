---
category: Harness
packages: root
---

- Fixed **iteration-close (Phase 3) commit anchor**: the §3.5 close commit is now **branch-anchored and fail-closed** — before any `git add`, PM must verify `git branch --show-current` equals `spec_integration_branch` (from snapshot `branch.integration` / compass); on mismatch STOP and redo tracked writes (`knowledge/`, `specs/`, `CONCEPTS.md`) on the integration checkout, instead of committing compound products onto the control branch (`main`). Engine `iteration gate` branch probes (`--branch` / `--integration` / `--target`) wired into the §3.5 pre-commit verification.

<!-- CN -->
- 修复 **iteration-close（Phase 3）递交锚点**：§3.5 close commit 现为**分支锚定 + fail-closed**——任何 `git add` 之前必须校验 `git branch --show-current` 等于 `spec_integration_branch`（来自 snapshot `branch.integration` / compass）；mismatch 即 STOP，tracked 产物（`knowledge/`、`specs/`、`CONCEPTS.md`）改在集成分支检出上重写，不再把 compound 产物递交到控制分支（如 `main`）。引擎 `iteration gate` 分支探针（`--branch` / `--integration` / `--target`）接入 §3.5 提交前校验。