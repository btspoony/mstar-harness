# STRATEGY.md — Project Strategy Document

`STRATEGY.md` at `<repo-root>/STRATEGY.md` is the project's upstream anchor: a concise declaration of what the project is, where it is going, and which principles govern decisions. Brainstorm, specify and plan phases read it as grounding so strategic choices flow into every feature; without it each plan is decided in isolation and misses the larger context.

**Storage SSOT**: `mstar-conventions/references/artifact-storage-paths.md` — `<repo-root>/STRATEGY.md`, beside `.git/` and `AGENTS.md`. Never under `{HARNESS_DIR}`, `docs/` or any subdirectory.

This file owns the artifact. The flow that produces it — survey, interview, draft/review, and the absent/stale/current handling — is `references/project-knowledge-bootstrap.md` Phase 2.

## Shape

A good strategy document is opinionated and concise — it fits in one screen of reading, with each required section held to 1–3 sentences.

| Section | Required | What it must contain |
|---------|----------|----------------------|
| `## Vision` | yes | 1–2 sentences: what the project aims to become |
| `## What we build` | yes | Core product, users, use cases |
| `## What we don't build` | yes | Explicit non-goals — as important as goals |
| `## Guiding Principles` | yes | The principles that guide every technical decision |
| `## Technology Direction` | yes | Key technology choices and their rationale |
| `## Decision Log` | yes | Major past decisions with context — why, not just what |
| `## Current Focus` | optional | What the team is working on now |
| `## Risks & Mitigations` | optional | Known strategic risks |
| `## Competitive Context` | optional | What alternatives exist and how this project differs |

## Validation

> **Engine check (when available):** run `mstar lint <STRATEGY.md>` (or `import { lintStrategySections } from "@mstar-harness/engine"` in a host hook) to check the six required sections in § Shape. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

A document missing any required section is not a finished Phase 2 — fix it before the bootstrap reports its result.

## Interview

Ask these five questions one at a time; each answer fills one required section.

1. "What is the one-sentence vision for this project?"
2. "Who are the primary users and what do they need most?"
3. "What are you explicitly NOT building? What's out of scope permanently?"
4. "What 2-3 principles should guide every technical decision?"
5. "What technology bets have you made, and why?"

## Maintenance

Review triggers: after a major architectural decision, when a plan introduces a new technology stack, or quarterly (PM-scheduled).

Update rules: be decisive about direction changes (replace the old direction, never keep it alongside the new); log decisions with their context (why, not just what); keep it current — a stale strategy is worse than no strategy.

## Not to do

- Do not write it as a novel — it must be scannable
- Do not include implementation details or file paths
- Do not create it without PM/architect input (ask the interview questions)
- Do not keep outdated strategy as "historical reference" — git preserves it
- Do not conflate strategy (direction) with conventions (how-to)

## STRATEGY.md vs other docs

| Document | Purpose | Audience |
|----------|---------|----------|
| `STRATEGY.md` | Product/technical direction, principles, decisions | PM, architect, all implementers |
| `AGENTS.md` | Repo maintenance policy, conventions | Contributors and agents |
| `CONCEPTS.md` | Domain vocabulary | Anyone reading/writing project docs |
| Plans in `{PLAN_DIR}/` | Feature-level implementation plan | Implementers, reviewers |
