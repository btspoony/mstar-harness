<div align="center">

<img src="assets/logo.svg" alt="Morning Star Harness" width="96">

# Morning Star

Code Agent Harness Framework

English / [中文](README_CN.md)

<a href="https://github.com/btspoony/mstar-harness">GitHub</a> · <a href="https://github.com/btspoony/mstar-harness/issues">Issues</a>

[![CI](https://img.shields.io/github/actions/workflow/status/btspoony/mstar-harness/ci.yml?branch=main&style=flat-square&label=CI&labelColor=black)](https://github.com/btspoony/mstar-harness/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)
[![Version](https://img.shields.io/github/v/release/btspoony/mstar-harness?include_prereleases&sort=semver&label=version&style=flat-square&labelColor=black&color=c4f042)](https://github.com/btspoony/mstar-harness/releases)
[![Last commit](https://img.shields.io/github/last-commit/btspoony/mstar-harness?color=c4f042&labelColor=black&style=flat-square)](https://github.com/btspoony/mstar-harness/commits/main)
[![npm cli](https://img.shields.io/npm/v/@mstar-harness/cli?style=flat-square&label=cli&labelColor=black&color=c4f042)](https://www.npmjs.com/package/@mstar-harness/cli)

</div>

This repository provides the **Morning Star** multi-agent code harness framework.

Core value:

- Start a usable multi-role workflow quickly
- Run with unified `mstar-*` skills instead of scattered rules
- Reuse one core process across OpenCode, Cursor, Codex, Kimi Code, and ZCode

Release notes: [CHANGELOG.md](CHANGELOG.md) / [CHANGELOG_CN.md](CHANGELOG_CN.md).

## Quick Start

Recommended install uses the CLI (`@mstar-harness/cli`):

```bash
npx @mstar-harness/cli init
# or: bunx @mstar-harness/cli init
```

Per-target examples:

- OpenCode: `npx @mstar-harness/cli init --target opencode`
- Cursor: `npx @mstar-harness/cli init --target cursor`
- Codex: `npx @mstar-harness/cli init --target codex` then `codex plugin add morning-star-harness --marketplace personal`
- Kimi: in Kimi TUI `/plugins install https://github.com/btspoony/mstar-harness` then `/plugins reload`
- ZCode: `npx @mstar-harness/cli init --target zcode` then install **morning-star-harness** in ZCode → Settings → Plugin Management

`init` provides target-aware guided setup (scopes, path layout, baseline config). Verify with `npx @mstar-harness/cli doctor --target <opencode|cursor|codex|zcode>`.

**Detailed install** (manual steps, path layout, Codex project vs global): [`INSTALL.md`](INSTALL.md). **CLI flags and advanced options:** [`docs/cli.md`](docs/cli.md).

## How to use

- **OpenCode**: start with the `Project Manager` role (`agents/project-manager.md`, typically `agent.project-manager` in `opencode.json`).
- **Cursor**: use `/pm` to force-start with the `Project Manager` role.
- **Codex**: use `/pm` after installing the plugin. Custom agents are linked from `codex/agents/` by the CLI or manual install.
- **Kimi**: install the plugin (`.kimi-plugin/plugin.json`); new sessions auto-load **`pm`** via `sessionStart`. Use `/skill:pm` anytime. Built-in subagents are `coder` / `explore` / `plan` only — role binding is in the Agent prompt (see `mstar-host/references/kimi.md`).
- **ZCode**: install the plugin (`.zcode-plugin/plugin.json`), then use `/morning-star-harness:pm` to start. No session auto-load — enter PM manually each session. Plugin agents are visible in **Settings → Subagents** but are **not** exposed as callable `subagent_type` values (only `general-purpose` / `Explore` are); role binding lives in the Agent prompt (see `mstar-host/references/zcode.md`).

### Harness Commands

Three PM-led iteration entry points. Pick by how much human direction you need:

| Path | When | Flow |
|------|------|------|
| `/iteration-start` → `/iteration-drive` | First iteration, or deep work that needs human direction lock (**grill-me**) before execution | Phase 1 only → Phase 2–5 (execute, close, PR, merge-ready) |
| `/iteration-loop` | Fast autonomous full loop (cloud-agent friendly); optional `direction` + `scale` (S\|M\|L\|XL) | Phase 1→5 continuous with minimal check-ins |

**Phase 2** defaults to a per-plan worktree + lease on the integration branch and `zero-residual` findings cleanup; waive only with explicit `Worktree mode: waived`. Details → `mstar-iteration`, `mstar-branch-worktree`, `mstar-plan-artifacts`.

**Where commands load:**

| Host | Discovery |
|------|-----------|
| **Cursor / OpenCode** | Bundled from this repo's `commands/` (OpenCode: `harness-commands/` in the plugin) |
| **Codex (project install)** | Same three commands as project-local skills: `.agents/skills/<name>/SKILL.md` (CLI symlinks from `commands/`) |
| **Codex (global install)** | Iteration skills are **not** installed — use `--scope project` to avoid polluting other projects |
| **Kimi / ZCode (plugin)** | `/morning-star-harness:iteration-start` etc. from `commands/` via the host plugin manifest |

Project knowledge bootstrap/refresh: `mstar-compound-refresh` skill (`references/project-knowledge-bootstrap.md`).

After install, reload the host (restart OpenCode / Cursor **Developer: Reload Window** / re-open Codex / Kimi `/plugins reload` or `/new` / ZCode reload the plugin).

## Harness Workflow

```mermaid
flowchart TD
    A["PM: entry and intent clarification"] --> B{"PM: spec and context ready"}
    B -->|No| C["PM: clarify and refine requirements"]
    C --> B
    B -->|Yes| D["PM: initialize/load HARNESS_DIR and PLAN_DIR"]
    D --> E{"Iteration scope needed"}
    E -->|Deep / first iteration| F["iteration-start: compass, plans, review chain"]
    E -->|Fast autonomous loop| F2["iteration-loop: Phase 1→5 continuous"]
    F --> G["PM: lock compass and create integration branch"]
    F2 --> G
    G --> H["iteration-drive or loop continues: execute → close → PR → merge-ready"]
    E -->|No| I["PM: select active plan from status.json"]
    H --> I
    I --> J{"Any plan not Done"}
    J -->|Yes| K["PM: dispatch one plan on a feature branch"]
    K --> L["Dev roles: implement and report"]
    L --> M["PM: update plan and status.json"]
    M --> N["QC trio: review gate"]
    N --> O{"QC decision"}
    O -->|Request Changes| K
    O -->|Approve| P{"QA gate"}
    P -->|mandatory| P1["qa-engineer: acceptance verification"]
    P -->|pm-acceptance| P2["PM: acceptance checklist"]
    P1 --> Q{"Residual findings remain"}
    P2 --> Q
    Q -->|Yes| R["PM/QA: register or accept residuals in status.json"]
    R --> S["PM: mark plan Done and merge to integration branch"]
    Q -->|No| S
    S --> T["PM: sync compass plan status"]
    T --> J
    J -->|No| U["iteration-close: close entry checklist"]
    U --> V["PM: compound round and knowledge index"]
    V --> W["PM: update roadmap and compass completed frontmatter"]
    W --> X["PM: close exit checklist and commit"]
    X --> Y["Phase 4: create PR"]
    Y --> Z["Phase 5: merge-ready loop until CI green and reviews resolved"]
```

For single-plan or non-iteration work, use the same per-plan gates (`Prepare → Execute → QC → QA gate → Done`) without the iteration-start / iteration-close wrapper.

## Role and Skill Overview

### Roles

| Agent ID | Role | Responsibility |
|----------|------|----------------|
| `project-manager` | Project Manager | Routing, assignment, phase progression |
| `product-manager` | Product Manager | Requirements, product planning, and market/user research |
| `architect` | Architect | Architecture and technical contracts |
| `fullstack-dev` / `fullstack-dev-2` | Fullstack Dev | Backend-led implementation / second parallel track |
| `frontend-dev` | Frontend Dev | UI, interaction, frontend performance |
| `qa-engineer` | QA | Tiered acceptance validation (dispatched when `QA gate: mandatory`; else PM acceptance) |
| `qc-specialist` / `qc-specialist-2` / `qc-specialist-3` | QC Trio | Code quality gate (architecture/security/performance) |
| `ops-engineer` | Ops | Deployment, monitoring, infrastructure |
| `writing-specialist` | Writing Specialist | Documentation, fiction, copywriting, and script writing |
| `prompt-engineer` | Prompt Engineer | Prompt / skill / rule optimization |

You can assign different models per agent in `opencode.json` without replacing your existing file.

### Core Skills

Load **`mstar-harness-core` first**, then topic skills **on demand** (see `mstar-roles` for per-role lists).

| Skill | Purpose |
|-------|---------|
| `mstar-harness-core` | Global entry, state machine, Task category, skill index |
| `mstar-phase-gates` | Prepare/Execute gates, clarify, hotfix |
| `mstar-iteration` | Iteration lifecycle: Phase 1–5 (start, execute loop, iteration-close, PR delivery, merge-ready loop) |
| `mstar-dispatch-gates` | PM dispatch, Delegation, anti-recursion, parallel invoke |
| `mstar-sdd` | Subagent-driven development: file handoffs, per-task implementer + reviewer, progress ledger |
| `mstar-branch-worktree` | Feature branches, worktrees, QC/QA checkout alignment |
| `mstar-plan-conventions` | `{HARNESS_DIR}` discovery, init, Spec branch summary |
| `mstar-plan-artifacts` | Main plan, review bundles / durable summaries, `status.json`, residuals, Findings cleanup modes, knowledge/iteration indexes, Done compaction |
| `mstar-design-md` | DESIGN.md design-system gate for UI-bearing plans |
| `mstar-review-qc` | PM QC tri orchestration, residual gate, layer boundaries; leaf execution → `mstar-roles/references/qc-specialist/` |
| `mstar-coding-behavior` | Cross-role coding behavior: RCA, test-first checks, review feedback, completion evidence |
| `mstar-compound` | Knowledge crystallization into `{KNOWLEDGE_DIR}` |
| `mstar-compound-refresh` | Knowledge maintenance: refresh, merge, archive, or remove stale docs |
| `mstar-strategy` | STRATEGY.md alignment for long-running direction and decisions |
| `mstar-skill-authoring` | Skill authoring, trigger contracts, progressive disclosure, and behavior-change evidence |
| `mstar-roles` | Role prompt bus + per-role skill load lists |
| `mstar-host` | Host adapter (OpenCode / Cursor / Codex / Kimi); auto-detect + `references/` |
| `pm` | Shared `/pm` or `/skill:pm` shortcut for Cursor, Codex, and Kimi PM entry |

Maintainers: follow [`AGENTS.md`](AGENTS.md) for in-repo maintenance notes and planning; those local artifacts are not part of the published skill tree.

Project plan artifacts default to **`.mstar/`** (`{HARNESS_DIR}`), with existing `.agents/` / `.plans/` / `plans/` layouts still recognized for compatibility.

**Git tracking (default):** process stays local (`plans/`, `iterations/`, `status.json`, `sdd/`, … are gitignored); results are shared (`AGENTS.md`, `knowledge/`, `specs/` under `{HARNESS_DIR}` are tracked). `{SPECS_DIR}` resolves `.mstar/specs/` → `docs/specs/` → repo-root `specs/` (empty dirs skipped; greenfield creates `.mstar/specs/`). Details → `mstar-plan-conventions`.

## License

This project is licensed under MIT. See [LICENSE](./LICENSE).
