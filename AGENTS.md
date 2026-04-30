# Morning Star Harness Maintenance Guide

This repository is maintained as a **harness/configuration project**, not an application repo.
Use this document as the primary maintenance contract for contributors and agents.

## Scope

- Default intent in this workspace: maintain Morning Star harness behavior, docs, and host adapters.
- Do not treat this repo like a product feature/codebase task unless explicitly requested.
- Runtime execution rules for users/agents live in `mstar-*` skills; this file defines **maintenance behavior**.

## Maintenance Goals

- Keep one coherent harness behavior across hosts.
- Keep prompts/rules minimal, explicit, and non-duplicated.
- Prefer stable defaults and small, reviewable changes.
- Preserve user safety boundaries for global config and secrets.

## Core Rules

- **Single source by topic**: keep each rule in one authoritative place; avoid copy-paste rule drift.
- **Execution vs maintenance split**:
  - Skills/role prompts describe runtime behavior.
  - `AGENTS.md` describes repository maintenance policy.
- **Surgical edits**: only change what the task requires; avoid opportunistic refactors.
- **Read before edit**: inspect current content before patching; verify after patching.

## Cursor + OpenCode + Codex Sync Policy

When a change affects shared harness behavior, treat OpenCode, Cursor, and Codex as host surfaces of one system.

- Update shared semantics first (core harness contract), then host-specific adapters.
- Keep host wording consistent on:
  - load order expectations
  - dispatch/delegation boundaries
  - gate/evidence language
- If behavior must diverge by host, document the reason explicitly and keep the divergence minimal.
- For plugin-facing changes, ensure both hosts remain installable and understandable from current docs.
- Do not maintain long host-specific checklists in many files; keep intent centralized and examples lightweight.

## What To Do

- Do align changes with the current harness invariants before editing downstream docs/prompts.
- Do update bilingual docs together when user-facing behavior changes.
- Do keep role shells thin and maintain richer role behavior in role-skill references.
- Do keep commit scope coherent (one concern per commit when possible).
- Do verify any changed command/config snippets are still runnable.

## What Not To Do

- Do not edit user secrets or local credential files.
- Do not silently change security-sensitive defaults.
- Do not introduce parallel “maintenance manuals” inside skill bodies.
- Do not scatter the same rule text across multiple files just for discoverability.
- Do not require manual file-by-file index maintenance when explore/search can discover structure.

## Change Workflow (Lightweight)

1. Clarify the maintenance intent and affected behavior surface.
2. Apply minimal edits in the right canonical layer.
3. Sync host adapters/docs only where behavior or onboarding changed.
4. Run lightweight validation (lint/typecheck/doc link sanity as relevant).
5. Summarize what changed, why, and any intentional host-specific divergence.

## AI Agent Quality Gate

Before opening PRs or proposing "done", an agent must:

1. Confirm the change solves a real, observed maintenance problem (not a theoretical one).
2. Check for duplicate or recently rejected attempts before repeating similar work.
3. Confirm the change belongs in core harness (otherwise recommend a separate plugin/extension path).
4. Show the complete diff to the human partner and get explicit approval.
5. Provide verification evidence for any behavior-shaping changes.

If one of these checks fails, stop and report why.

## Changes Usually Rejected

- Unrelated bundled edits in one PR.
- Speculative fixes without a concrete failure or user impact.
- Project-specific customizations disguised as core behavior.
- Style-only rewrites of behavior-shaping prompts/skills without evaluation evidence.
- Claims that are not supported by code, tests, or reproducible validation.

## Evidence Standard

- Behavior change -> show before/after expectation and at least one concrete verification step.
- Install/config change -> verify snippets are executable and aligned with current docs.
- Prompt/skill change -> explain why the wording change improves outcomes, not only readability.

## Skill Maintenance Essentials

- Keep skills as **runtime SSOT**, not maintenance handbooks.
- Keep `SKILL.md` focused on execution path; move deep detail to `references/` when needed.
- Treat frontmatter `description` as a trigger contract; update it when scenarios change.
- Prefer one coherent skill per workflow unit; avoid over-splitting or giant mixed-scope skills.
- Use default-first guidance (primary path first, exceptions second) to reduce agent ambiguity.
- Preserve role shell minimalism: role binding stays thin; reusable behavior stays in skill references.
- When changing behavior-shaping skill text, require evidence (evals, regressions, or concrete outcomes), not wording preference.

## Skill-Creator Requirement

- For new skills or major skill rewrites, use skill-creator guidance before editing:
  - `~/.agents/skills/skill-creator/SKILL.md`
  - `~/.cursor/skills-cursor/create-skill/SKILL.md`
- Keep trigger quality explicit:
  - `description` must say when to trigger and what outcome it enables.
  - Add/update trigger phrases when scenarios expand.
- If a change alters behavior (not just wording), include evaluation evidence.

## Where To Edit (Minimal Routing)

- Core harness invariants and shared protocol -> `skills/mstar-harness-core/*`
- Plan/status/residual conventions -> `skills/mstar-plan-conventions/*`
- QC baseline and review template -> `skills/mstar-review-qc/*`
- Cross-role coding behavior -> `skills/mstar-coding-behavior/*`
- Superpowers alignment contract -> `skills/mstar-superpowers-align/*`
- Role behavior text -> `skills/mstar-roles/references/*`
- Host adapters:
  - OpenCode -> `.opencode/skills/mstar-host/*`
  - Cursor -> `.cursor/skills/mstar-host/*`
- Codex plugin manifest -> `.codex-plugin/plugin.json`
- Codex marketplace catalog -> `.codex/marketplace.json`
- Maintenance policy (this file) -> `AGENTS.md`

## Skill Sync Rules

- Update shared harness semantics before host adapters.
- Sync bilingual user-facing docs when installation or behavior expectations change.
- Keep cross-host differences explicit and minimal; no silent divergence.
- Avoid duplicating the same maintenance guidance across many runtime files.

## Cursor Routing-Eval Usage Rules

Use `.cursor/skills/mstar-routing-eval/` only for Cursor maintenance and regression work:

- When PM routing logic changes.
- When phase gates or dispatch constraints change.
- When role/prompt/rule updates may affect routing outcomes.

Do not treat routing-eval as a runtime skill for normal implementation tasks.

## Post-Skill-Change Sync Checklist

- [ ] `description` still matches trigger scope and intent.
- [ ] `SKILL.md` stays concise; heavy detail moved to `references/` when needed.
- [ ] Shared semantics and host adapters remain consistent.
- [ ] Cursor routing-eval updated if routing/gate behavior changed.
- [ ] User-facing docs updated in both `README.md` and `README_CN.md` if onboarding changed.
- [ ] Validation evidence included for behavior-shaping changes.
