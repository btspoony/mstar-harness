<div align="center">

### Morning Star — Code Agent Harness Framework

English / [中文](README_CN.md)

<a href="https://github.com/btspoony/mstar-harness">GitHub</a> · <a href="https://github.com/btspoony/mstar-harness/issues">Issues</a>

[![](https://img.shields.io/badge/license-MIT-white?labelColor=black\&style=flat-square)](https://github.com/btspoony/mstar-harness/blob/main/LICENSE)
[![](https://img.shields.io/github/last-commit/btspoony/mstar-harness?color=c4f042\&labelColor=black\&style=flat-square)](https://github.com/btspoony/mstar-harness/commits/main)

</div>

This repository provides the **Morning Star** multi-agent code harness framework.

Core value:

- Start a usable multi-role workflow quickly
- Run with unified `mstar-*` skills instead of scattered rules
- Reuse one core process across OpenCode and Cursor

## Quick Start (Recommended)

1. Clone repository to a stable source path:
   - `git clone https://github.com/btspoony/mstar-harness.git ~/.mstar-harness`
2. Install to target code agents:
   - **Cursor (local plugin directory)**
     - `mkdir -p ~/.cursor/plugins/local`
     - `ln -sfn ~/.mstar-harness ~/.cursor/plugins/local/mstar-harness`
   - **OpenCode (symlink contents, not the whole directory)**
     - `mkdir -p ~/.config/opencode/agents ~/.config/opencode/skills`
     - `ln -sfn ~/.mstar-harness/agents/*.md ~/.config/opencode/agents/`
     - `ln -sfn ~/.mstar-harness/skills ~/.config/opencode/skills`
     - `ln -sfn ~/.mstar-harness/.opencode/skills/* ~/.config/opencode/skills/`

That completes installation.

You can assign different models per agent in `opencode.json`. Refer to `opencode.example.json` for structure and examples; no need to overwrite your existing `opencode.json`.

## Host Entry (OpenCode vs Cursor)

| Host | First thing to do |
|------|-------------------|
| **OpenCode** | Usually auto-injects `AGENTS.md`; then use `.opencode/skills/mstar-host/SKILL.md` for host-specific behavior |
| **Cursor** | Read `AGENTS.md` manually first, then `.cursor-plugin/skills/mstar-host/SKILL.md` |

Recommended sequence for both hosts:

1. `AGENTS.md`
2. Current host `mstar-host` skill
3. `skills/mstar-roles/SKILL.md`
4. Target role `Role reference`

## Role and Skill Overview

### Roles

| Agent ID | Role | Responsibility |
|----------|------|----------------|
| `project-manager` | Project Manager | Routing, assignment, phase progression |
| `product-manager` | Product Manager | Requirements and product-facing docs |
| `architect` | Architect | Architecture and technical contracts |
| `fullstack-dev` / `fullstack-dev-2` | Fullstack Dev | Backend-led implementation / second parallel track |
| `frontend-dev` | Frontend Dev | UI, interaction, frontend performance |
| `qa-engineer` | QA | Testing and acceptance validation |
| `qc-specialist*` | QC Trio | Code quality gate (architecture/security/performance) |
| `ops-engineer` | Ops | Deployment, monitoring, infrastructure |
| `market-expert` | Market Expert | Market and user research |
| `prompt-engineer` | Prompt Engineer | Prompt / skill / rule optimization |

### Core Skills

| Skill | Purpose |
|-------|---------|
| `mstar-harness-core` | Global entry, state machine, gates, invariants |
| `mstar-plan-conventions` | Unified plan/status/residual conventions |
| `mstar-review-qc` | QC review baseline and report template |
| `mstar-coding-behavior` | Cross-role coding behavior baseline |
| `mstar-superpowers-align` | Alignment and conflict handling with Superpowers |
| `mstar-roles` | Role prompt bus (role bodies in `references/`) |
| `mstar-host` (per host) | Host-specific capabilities (OpenCode / Cursor) |

**Morning Star load order:** In any session or task, **read `skills/mstar-harness-core/SKILL.md` before** any other `skills/mstar-*/SKILL.md`. Each non-core skill begins with a **Load order** section that repeats this; on conflict, **`mstar-harness-core` wins**. See `mstar-harness-core/SKILL.md` →「与其它 `mstar-*` skill 的加载契约」.

**Cursor-only maint:** PM routing scenario regression + `Routing Eval Report` live in **`.cursor/skills/mstar-routing-eval/`** (maint-only), while runtime host skills live in **`.cursor-plugin/skills/`**. See `.cursor/rules/repo-maintenance.mdc`.

## Common Flows (Short)

### I want to start a task now

1. Read `AGENTS.md`
2. Let `project-manager` establish context and route
3. Execution roles work via `mstar-roles` + relevant skills
4. Close through QC/QA gates

### I just need rule entry points

- Global entry: `AGENTS.md`
- Core workflow: `skills/mstar-harness-core/SKILL.md`
- Role hub: `skills/mstar-roles/SKILL.md`

## Deeper Docs

- `AGENTS.md`: global entry and index
- `skills/mstar-harness-core/`: core execution rules
- `skills/mstar-roles/`: role content and parameterization
- `skills/mstar-plan-conventions/`: plan and state conventions

> Maintainer workflows, cross-file sync rules, and lint/maintenance checklists are intentionally kept in maintainer rule docs, not in this user-facing README.

## License

This project is licensed under MIT. See [LICENSE](./LICENSE).
