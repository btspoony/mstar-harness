---
name: amazing-test-audit
description: Read-only test-suite audit — sweep the existing test surface for junk patterns (assertion-free probes, source restatements, mock-tested mocks, test-only production seams), grade every candidate against the value/retention bar, and report prioritized findings to delete, repair, consolidate, or relocate tests, or to run a whole-subsystem campaign. Use when asked to audit test quality or prune/repair a test suite; not for writing new features, fixing product bugs directly, or routine QA.
agent: project-manager
input: "[scope|subsystem] [quick|deep] [campaign]"
---

# Test-Suite Audit

Run a read-only audit of the repository's existing test surface and write one prioritized review report under `{REVIEW_DIR}`.

**Read-only.** No test edits, no source edits, no state machine, no commits — deletions, assertion repairs, consolidations, and seam removals are reported as findings in the review report at `{REVIEW_DIR}/<date>-codebase-<level>-<round>/`. A baseline test failure is reported as a suspected product bug (`bug` finding), never silently deleted.

Procedure SSOT → **`mstar-audit` SKILL.md**（common core）+ **`references/test-audit.md`**（test-suite 深度方法全量：value bar、authoring gate、junk patterns、retention bar、candidate evidence、discovery lanes、campaign scope）。This command is a thin launcher — every contract lives in the reference.

## Boot

1. `mstar-harness-core`
2. `mstar-audit` → SKILL.md（common core：hard rules、recon、vet、variant dispatch、review report 输出）+ `references/test-audit.md`（§1–§8 深度方法；`campaign` 时加 §9）
3. `mstar-roles` → `references/code-reviewer.md`（执行角色：audit 执行体 Mode B）
4. `mstar-conventions` (path symbols — `{HARNESS_DIR}`, `{REVIEW_DIR}`)
5. `mstar-host` → active host reference (invoke capability for parallel subagents)

## Execute

Execute **`mstar-audit` § test-suite audit end to end**（`references/test-audit.md`）：

1. **Scope first** — parse the input: a subsystem token narrows the sweep to that area; the `campaign` token switches to the whole-subsystem test-surface campaign（§9 — per-test R/F/C/D ledger written under the run directory `{REVIEW_DIR}/<date>-codebase-<level>-<round>/`）; `quick` / `deep` set the effort level（effort table → `references/codebase-audit.md`）. Default: whole-repo sweep. **`quick` and `campaign` are mutually exclusive** — campaign breadth is always every declaration in the subsystem, never hotspot-limited; when both tokens appear, hard-stop and ask the user to drop one (fail-closed, `/iteration-drive` precedent). `deep campaign` is valid but redundant — campaign breadth already implies it.
2. **Recon** — Phase 1 per the SKILL.md common core; the capability inventory must record the repo's own test runner and change-classification gates — the report's verification notes cite them, never this harness's tooling.
3. **Discover** — sweep lanes along production owner boundaries（§6）; small repos sweep directly, large repos fan out read-only `scout` / `explore` seats per lane under Assignment `Delegation: allowed (scout/explore only, read-only)`（Routing 同 `/codebase-audit`; each host keeps its own invoke tool — **no native dsh `workflow` script ships for this entry**, unlike the `/codebase-audit` large-repo fan-out）. A few high-confidence candidates beat a speculative inventory.
4. **Judge** — grade every candidate through the authoring gate + junk patterns + retention bar（§2–§5）; campaign lanes produce the marked ledger. Record the §7 candidate-evidence fields for every deletion or rewrite candidate — a candidate missing a field stays out of the findings table (Needs-verification lead).
5. **Vet** — SKILL.md Phase 3: three-way attack on the head findings, then open every cited test and owner yourself before it makes the table; dispose duplicates, mis-attributions, and by-design cases.
6. **Output** — findings table（`references/finding-format.md`）in the run's review report `README.md`（`mstar audit scaffold`；`--level` / `--round` / `--reviews-dir` / `--dir` 见 help），每条 finding 带 edit shape 与 verification gate（§8）; `campaign` 记录 per-lane findings 批次与 preservation review（§9 step 5）.

Executor: PM dispatches `@code-reviewer`（Mode B）；lanes 扇出经 Assignment `Delegation: allowed (scout/explore only, read-only)`。
