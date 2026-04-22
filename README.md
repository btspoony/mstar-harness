# Morning Star — Code Agent Harness (OpenCode / Cursor)

Other languages: [简体中文](./README_CN.md)

This repository contains the **Morning Star** multi-agent harness configuration for code agents. It is organized as a virtual team: one primary agent (`project-manager`) coordinates specialized subagents.

Execution rules are centralized in **`mstar-*` skills**. Roles load the required skills before work, instead of relying on scattered prose docs.

## Entry Points

| Host | Entry |
|------|-------|
| **OpenCode** | Root `AGENTS.md` is auto-loaded each session; host-specific behavior is in `.opencode/skills/mstar-host/SKILL.md` |
| **Cursor** | Read root `AGENTS.md` manually, then `.cursor/skills/mstar-host/SKILL.md`; project-level rules take priority |

## Morning Star Skill Layout

This repo uses a **single global entry** (`AGENTS.md`) plus a structured skill knowledge base under `skills/mstar-*/`.

> Paths below are relative to `~/.config/opencode/`. Runtime cwd is your project repo. In role/skill content, prefer **skill-name references** (for example, `mstar-harness-core` skill) instead of hard-coded absolute paths. The global config repo remains read-only for agents unless the user explicitly requests edits.

Core files:

- `AGENTS.md` — global Morning Star entry (priority, invariants, skill index, guardrails)
- `agents/*.md` — minimal role shells (frontmatter + `mstar-roles` binding/parameters)

Skill set:

| Skill | Scope |
|-------|-------|
| `skills/mstar-harness-core/` | State machine, Spec-Driven phase gates, task categories, explore boundaries, git branch/worktree guards, QC-QA alignment, dispatch anti-interference, escalation triggers, shared Context7 protocol |
| `skills/mstar-plan-conventions/` | `{HARNESS_DIR}` / `{PLAN_DIR}` discovery, `status.json` SSOT, residual lifecycle, notes, reports naming, QC trigger timing, done profiles, agent-oriented effort sizing |
| `skills/mstar-review-qc/` | QC baseline: workflow, checklist, report template, risk checks, gate policy, CI gate, residual tracking |
| `skills/mstar-routing-eval/` | PM routing regression and prompt/rule iteration evaluation |
| `skills/mstar-coding-behavior/` | Cross-role coding principles |
| `skills/mstar-superpowers-align/` | Morning Star × Superpowers alignment and conflict resolution |
| `skills/mstar-roles/` | Role prompt hub (full role content in `references/`, shell bindings in `agents/*.md`) |
| `.opencode/skills/mstar-host/` | OpenCode host adapter |
| `.cursor/skills/mstar-host/` | Cursor host adapter |

Recommended order:

1. Read `AGENTS.md`
2. Read current host `mstar-host` skill
3. Read `skills/mstar-roles/SKILL.md`
4. Read role reference mapped from `agents/<role>.md`

## Plan Management Mode

The harness supports projects with or without a plan directory:

- **Directory discovery**: prefer `.agents/` (`{HARNESS_DIR}`) + `.agents/plans/` (`{PLAN_DIR}`), fallback to legacy `.plans/` or `plans/`
- **Low-intrusion default**: create only when needed
- **Git**: track harness/plan dirs by default for reproducible handoff
- **No-plan projects**: workflow can still run via conversation + completion reports

See `skills/mstar-plan-conventions/SKILL.md` for full details.

## Overview

- Follows [OpenCode config](https://opencode.ai) conventions
- Role prompt files map to `agent` entries in `opencode.json`
- Default primary agent: `project-manager`
- Supports product, architecture, development, QA, QC, ops, market, and prompt-engineering roles
- Default phase-gate workflow: `specify -> clarify -> plan -> tasks -> implement`

## Agent Roles

| Agent ID | Role | Mode | Purpose |
|----------|------|------|---------|
| `project-manager` | Project Manager | primary | Coordination and progress |
| `product-manager` | Product Manager | subagent | Requirements and product docs |
| `architect` | Architect | subagent | Architecture and technical docs |
| `fullstack-dev` | Fullstack Dev | subagent | Backend-led implementation |
| `fullstack-dev-2` | Fullstack Dev #2 | subagent | Parallel implementation track |
| `frontend-dev` | Frontend Dev | subagent | UI, interaction, frontend performance |
| `qa-engineer` | QA Engineer | subagent | Test planning and execution |
| `qc-specialist` | QC Reviewer #1 | subagent | Architecture/maintainability focus |
| `qc-specialist-2` | QC Reviewer #2 | subagent | Security/correctness focus |
| `qc-specialist-3` | QC Reviewer #3 | subagent | Performance/reliability focus |
| `ops-engineer` | Ops Engineer | subagent | Deployment and infrastructure |
| `market-expert` | Market Expert | subagent | Market and user research |
| `prompt-engineer` | Prompt Engineer | subagent | Prompt/skills/rules maintenance |

## QC Three-Reviewer Baseline

By default, code changes go through parallel QC by:

- `qc-specialist`
- `qc-specialist-2`
- `qc-specialist-3`

Hotfixes may use a single-review fast path.

Shared baseline/report template is defined in `skills/mstar-review-qc/SKILL.md`, with PM producing a consolidated gate decision.

## Optional Plugins

### Superpowers

Example:

```json
"plugin": ["superpowers@git+https://github.com/obra/superpowers.git"]
```

Alignment rules live in `skills/mstar-superpowers-align/SKILL.md`.

### OpenViking Memory

When enabled under `plugins/`, agents can use `memsearch`, `memread`, and `membrowse`. Session commit is handled automatically by plugin settings.

## Quick Config Bootstrap

Use the provided template:

```bash
cp opencode.example.json opencode.json
```

Then fill provider credentials using `{env:...}` / `{file:...}` placeholders.

### Key Config Notes

- `default_agent`: entry primary agent (`project-manager`)
- `plugin`: plugin list (set `[]` if not needed)
- `agent`: per-role model/mode mapping
- `model`: use `provider-id/model-id`

## Markdown Lint

Run:

```bash
npx -y markdownlint-cli2
```

Current baseline covers:

- `README.md`
- `agents/*.md`
- `skills/mstar-*/**/*.md`
- `.opencode/skills/mstar-*/**/*.md`
- `.cursor/skills/mstar-*/**/*.md`

## Install to OpenCode

Repository:

- [https://github.com/btspoony/mstar-harness](https://github.com/btspoony/mstar-harness)

Steps:

1. (Optional) Backup existing config:
   - `mv ~/.config/opencode ~/.config/opencode.backup.$(date +%Y%m%d-%H%M%S)`
2. Clone:
   - `git clone https://github.com/btspoony/mstar-harness.git ~/.config/opencode`
3. Install local dependencies if needed:
   - `cd ~/.config/opencode && npm install`
4. Create local config:
   - `cp opencode.example.json opencode.json`
5. Configure secrets with env/file placeholders
6. Restart OpenCode (or reload config)

## Security Notes

- Never hardcode real API keys in `opencode.json`
- Never commit plain-text secrets (`.env`, `.env.local`, credential files)
- Share `opencode.example.json`, not private local `opencode.json`
- Rotate keys immediately if leakage is suspected

## License

This project is licensed under MIT. See `LICENSE`.