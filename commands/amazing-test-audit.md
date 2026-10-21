---
name: amazing-test-audit
description: "Read-only test-suite audit — junk patterns, value/retention bars, prioritized delete/repair/consolidate findings, or a whole-subsystem campaign. Use to prune or repair a test suite; not for writing tests, product fixes, or routine QA."
agent: project-manager
input: "[scope|subsystem] [quick|deep] [campaign]"
---

# Test-Suite Audit

A read-only audit of the repository's existing test surface, reported as one prioritized review report under `{REVIEW_DIR}`. No test or source edits, no state machine, no commits: deletions, assertion repairs, consolidations and seam removals are findings, and a baseline failure is reported as a suspected product bug (`bug` finding), never silently deleted.

**Procedure SSOT** → `mstar-audit` SKILL.md (common core) + `references/test-audit.md` (test-suite method §1–§9; `campaign` adds §9's ledger).

## Boot

1. `mstar-harness-core`
2. `mstar-audit` → SKILL.md + `references/test-audit.md`
3. `mstar-conventions` (path symbols) · `mstar-host` → active host reference (invoke capability)

## Execute

Execute **`mstar-audit` § test-suite audit end to end** (`references/test-audit.md`). Input tokens: a `scope|subsystem` narrows the sweep; `quick` / `deep` set the effort level (`references/codebase-audit.md` effort table); `campaign` switches to the whole-subsystem campaign; no token means a whole-repo sweep. `quick` + `campaign` are mutually exclusive — hard-stop and ask the user to drop one.

PM dispatches `@code-reviewer` (`Task category: audit`); lane fan-out stays read-only `scout` / `explore` under the Assignment's delegation grant.
