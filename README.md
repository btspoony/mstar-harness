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

## Quick Start

### Cursor Installation

- Local plugin install (direct clone):
  - `mkdir -p ~/.cursor/plugins/local`
  - `git clone https://github.com/btspoony/mstar-harness.git ~/.cursor/plugins/local/mstar-harness`
  - Restart Cursor or run `Developer: Reload Window`

### OpenCode Installation

- Plugin install (recommended):
  - Add plugin config in `opencode.json`:
    ```json
    {
      "plugin": [
        "superpowers@git+https://github.com/obra/superpowers.git",
        "morning-star@git+https://github.com/btspoony/mstar-harness.git"
      ]
    }
    ```
  - Restart OpenCode

That completes installation.

You can assign different models per agent in `opencode.json` without replacing your existing file. For detailed OpenCode setup and migration, see `.opencode/INSTALL.md`.

## Host Entry (OpenCode vs Cursor)

| Host | First thing to do |
|------|-------------------|
| **Cursor** | The plugin-enforced rule `rules/mstar-entry.mdc` loads core first |
| **OpenCode** | The plugin `.opencode/plugins/mstar.ts` injects `.opencode/AGENTS.md` to force core entry |

After core entry, the core flow loads the corresponding host adapter (`mstar-host`) automatically.

From a user perspective, the practical flow is:

1. Install plugin for your host.
2. Start/restart host session.
3. Let Morning Star core + host adapter load automatically.
4. Work with roles as normal.

Recommended PM-first start:

- **OpenCode**: start the conversation with the Project Manager role (primary agent) defined by `agents/project-manager.md`.
- **Cursor**: prefer `/pm` to force-enable the Project Manager role before task orchestration.

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
| `mstar-host` (per host) | Host-specific capabilities (OpenCode / Cursor) |
| `mstar-roles` | Role prompt bus (role bodies in `references/`) |
| `mstar-plan-conventions` | Unified plan/status/residual conventions |
| `mstar-review-qc` | QC review baseline and report template |
| `mstar-coding-behavior` | Cross-role coding behavior baseline |
| `mstar-superpowers-align` | Alignment and conflict handling with Superpowers |

**Morning Star load order:** In any session or task, **read `skills/mstar-harness-core/SKILL.md` before** any other `skills/mstar-*/SKILL.md`. Each non-core skill begins with a **Load order** section that repeats this; on conflict, **`mstar-harness-core` wins**. See `mstar-harness-core/SKILL.md` →「与其它 `mstar-*` skill 的加载契约」.

## License

This project is licensed under MIT. See [LICENSE](./LICENSE).
