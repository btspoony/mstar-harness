<div align="center">

<img src="assets/logo.svg" alt="Morning Star Harness" width="96">

# [Morning Star](https://github.com/btspoony/mstar-harness)

Harness Workflow Engine · Agent Plugin

English / [中文](README_CN.md)

<a href="https://github.com/btspoony/mstar-harness">GitHub</a> · <a href="https://github.com/btspoony/mstar-harness/issues">Issues</a>

[![CI](https://img.shields.io/github/actions/workflow/status/btspoony/mstar-harness/ci.yml?branch=main&style=flat-square&label=CI&labelColor=black)](https://github.com/btspoony/mstar-harness/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)
[![Version](https://img.shields.io/github/v/release/btspoony/mstar-harness?include_prereleases&sort=semver&label=version&style=flat-square&labelColor=black&color=c4f042)](https://github.com/btspoony/mstar-harness/releases)
[![Last commit](https://img.shields.io/github/last-commit/btspoony/mstar-harness?color=c4f042&labelColor=black&style=flat-square)](https://github.com/btspoony/mstar-harness/commits/main)
[![dshfind](https://dshfind.com/api/badge/btspoony/mstar-harness?lang=en)](https://dshfind.com/zh/plugins/btspoony/mstar-harness?ref=badge)
[![Greptile: The War on Bugs](https://www.greptile.com/badge.svg)](https://www.greptile.com/?utm_source=oss_badge&utm_medium=readme&utm_campaign=greptile_for_open_source)

</div>

**Morning Star** is an Agent Plugin for harness engineering workflows: a TypeScript **Harness Workflow Engine** (`@mstar-harness/engine`) enforces deterministic workflow gates, while `mstar-*` judgment skills drive multi-agent code delivery.

- **Deterministic gates, enforced by a TS engine** — path/status/lease/dispatch/sdd/iteration/lint gates run in `@mstar-harness/engine`, not as prompt suggestions
- **Judgment stays in `mstar-*` skills** — skills remain the single source of truth (SSOT) for roles, gates, and workflow judgment
- **One engine across hosts** — the same engine + skills power dsh (DeepSeek Harness), omp, OpenCode, Cursor, Kimi Code, ZCode, and Codex
- **Agent Plugin packaging** — one-command install; portable across any Agent Plugins v1.0.0 client
- **Recommended host** (best → usable): **dsh = omp ≥ OpenCode ≥ Cursor > Kimi = ZCode > Codex**

**What ships**

| Component | What it is |
|-----------|------------|
| Harness Workflow Engine | `@mstar-harness/engine` — TS enforcement of deterministic workflow gates |
| mstar CLI | `@mstar-harness/cli` — installer bootstrap + `mstar` workflow verbs |
| `mstar-*` skills | Role, gate, and workflow judgment (single source of truth) |
| Host adapters | dsh, omp, OpenCode, Cursor, Kimi Code, ZCode, Codex |

Release notes: [CHANGELOG.md](CHANGELOG.md) / [CHANGELOG_CN.md](CHANGELOG_CN.md).

## Install

| Host | Command |
|------|---------|
| dsh (DeepSeek Harness) | `npx @mstar-harness/cli init --target dsh`<br>(one CLI command that runs two **independent** `dsh plugin --profile web add` installs:<br>`@mstar-harness/dsh` + `dsh-llm-fallbacks`; `--no-fallbacks` skips the latter)<br>or `dsh plugin --profile web add @mstar-harness/dsh`<br>+ `dsh plugin --profile web add dsh-llm-fallbacks` |
| omp | `npx @mstar-harness/cli init --target omp`<br>(links `~/.mstar/harness`)<br>or `omp plugin install github:btspoony/mstar-harness` |
| OpenCode | `npx @mstar-harness/cli init --target opencode` |
| Cursor | `npx @mstar-harness/cli init --target cursor` |
| Kimi | Kimi TUI: `/plugins install https://github.com/btspoony/mstar-harness`<br>→ `/plugins reload` |
| ZCode | `npx @mstar-harness/cli init --target zcode`<br>then install **morning-star-harness** in ZCode → Settings → Plugin Management |
| Codex | `npx @mstar-harness/cli init --target codex`<br>then `codex plugin add morning-star-harness --marketplace personal` |
| Generic (Agent Plugins v1) | point any Agent Plugins v1.0.0 conformant client at this repo root<br>(`plugin.json` + `skills/` are the portable package) |

### Engine gate checks (Recommended)

```bash
npm i -g @mstar-harness/cli
```

Puts the `mstar-harness` binary (short alias `mstar`) on PATH, so the engine-check commands the skills cite (`mstar status validate`, `mstar dispatch validate`, `mstar iteration gate`, …) actually run.

Without a global install the harness still works and those checks stay advisory. Set `enforcement: hard` in an iteration compass to make dispatch preflights fail-fast.

> **Caution**: `mstar` is a short alias and a **shared bin namespace** — an unrelated third-party npm package named `mstar` claims the same command name. The alias exists only where `@mstar-harness/cli` is installed: bare `npx mstar …` without the package resolves via the registry to that other tool, and globally co-installing both packages silently overwrites the `mstar` shim (last install wins). The canonical invocation name stays `mstar-harness` — use the long name on any conflict.

### Verify

`npx @mstar-harness/cli doctor --target <opencode\|cursor\|codex\|zcode\|omp\|dsh>`.

The repo ships a portable **Agent Plugins v1.0.0** manifest (`plugin.json`) at its root; `skills/` is the Agent Skills component — verify it with `npx @mstar-harness/cli plugin validate`.

Manual install / path layout: [`INSTALL.md`](INSTALL.md). CLI flags: [`docs/cli.md`](docs/cli.md).

## Use

Three entry shapes: **without iteration** (single plan / hotfix), **with iteration** (multi-plan Phase 1–5), or **audit & review** (read-only: discover what to do, or decide whether a change ships).

### General (without iteration)

Enter PM, then run the per-plan cycle: `Prepare → Execute → QC → QA gate → Done`.

| Host | Enter PM |
|------|----------|
| dsh (DeepSeek Harness) | `pm` skill (via the mstar skill provider; no auto-load) |
| omp | `/skill:pm` each session (no auto-load) |
| OpenCode | `agent.project-manager` (`agents/project-manager.md`) |
| Cursor | `/pm` |
| Kimi | session auto-loads `pm`; or `/skill:pm` |
| ZCode | `/morning-star-harness:pm` each session (no auto-load) |
| Codex | `/pm` |

### Iteration

| Command | When |
|---------|------|
| `/iteration-start [direction] [pause]` | Start a new iteration: Phase 1 (interactive grill-me), then auto-continue Phase 2→5.<br>`direction` — optional hint (still interactive).<br>`pause` — stop after Phase 1; resume with `/iteration-drive`. |
| `/iteration-drive` | Resume Phase 2→5 on an already-locked iteration. |
| `/iteration-loop [direction] [scale]` | Full Phase 1→5 autonomous (no grill-me).<br>`direction` — optional free text.<br>`scale` — `S` / `M` / `L` / `XL` (default `M`). |

### Audit & review

Two read-only, advisory commands under one roof — they never edit source; findings can become plans for Prepare → Execute. SSOT → `mstar-audit` (variants: `codebase-audit`, `pr`).

| Command | When |
|---------|------|
| `/codebase-audit [keywords]` | Read-only survey of what's worth doing — prioritized, ready-to-execute plans; narrow it with category focus (`bug`, `security`, `perf`, `tech-debt`, …) when you want a targeted pass. |
| `/pr-deep-review [pr\|branch\|scope]` | Deep pre-merge review of a PR / branch / diff → one verdict (`ship it` / `needs fixes` / `blocked`) and every finding, posted to GitHub when a PR number is given. |

## Harness Workflow

```mermaid
flowchart TD
    A["PM: entry and intent clarification"] --> B{"PM: spec and context ready"}
    B -->|No| C["PM: clarify and refine requirements"]
    C --> B
    B -->|Yes| D["PM: initialize/load HARNESS_DIR and PLAN_DIR"]
    D --> E{"Iteration scope needed"}
    E -->|Deep / first iteration| F["iteration-start: grill-me → compass → review → lock"]
    E -->|Fast autonomous loop| F2["iteration-loop: Phase 1→5 continuous"]
    F --> G["PM: lock compass and create integration branch"]
    F2 --> G
    G --> H["Phase 2→5: execute → close → PR → merge-ready"]
    E -->|No| I["PM: select active plan from workflow snapshot"]
    H --> I
    I --> J{"Any plan not Done"}
    J -->|Yes| K["PM: dispatch one plan on a feature branch"]
    K --> L["Dev roles: implement and report"]
    L --> M["PM: update plan and workflow snapshot"]
    M --> N["QC trio: review gate"]
    N --> O{"QC decision"}
    O -->|Request Changes| K
    O -->|Approve| P{"QA gate"}
    P -->|mandatory| P1["qa-engineer: acceptance verification"]
    P -->|pm-acceptance| P2["PM: acceptance checklist"]
    P1 --> Q{"Residual findings remain"}
    P2 --> Q
    Q -->|Yes| R["PM/QA: register or accept residuals in project register"]
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

Without iteration: same per-plan gates, no `iteration-start` / `iteration-close` wrapper.

## Roles and skills

| Agent ID | Responsibility |
|----------|----------------|
| `project-manager` | Routing, assignment, phase progression |
| `product-manager` | Requirements, product planning, research |
| `architect` | Architecture and technical contracts |
| `fullstack-dev` / `fullstack-dev-2` | Backend-led implement / second parallel track |
| `frontend-dev` | UI, interaction, frontend performance |
| `qa-engineer` | Acceptance when `QA gate: mandatory` |
| `code-reviewer` | SDD per-task review; codebase audit (`audit` category) |
| `qc-specialist` / `-2` / `-3` | QC trio |
| `ops-engineer` | Deploy, monitoring, infrastructure |
| `writing-specialist` | Docs, fiction, copy, scripts |
| `prompt-engineer` | Prompt / skill / rule work |

Load **`mstar-harness-core` first**, then topic skills on demand (`mstar-roles`).

| Skill | Purpose |
|-------|---------|
| `mstar-harness-core` | Entry, state machine, Task category, skill index |
| `mstar-phase-gates` | Prepare/Execute, clarify, hotfix |
| `mstar-iteration` | Phase 1–5 iteration lifecycle |
| `mstar-dispatch-gates` | Dispatch, Delegation, anti-recursion |
| `mstar-sdd` | Subagent-driven development |
| `mstar-branch-worktree` | Branches, worktrees, QC/QA checkout |
| `mstar-conventions` | `{HARNESS_DIR}` discovery / init |
| `mstar-artifacts` | Plans, `status.json`, residuals, Findings cleanup |
| `mstar-project-governance` | Roadmap authoring + residual register lifecycle, `_default` fallback |
| `mstar-design-md` | DESIGN.md gate for UI plans |
| `mstar-review-qc` | PM QC tri orchestration |
| `mstar-coding-behavior` | RCA, test-first, review feedback, evidence |
| `mstar-compound` / `mstar-compound-refresh` | Knowledge crystallize / maintain |
| `mstar-strategy` | `STRATEGY.md` alignment |
| `mstar-skill-authoring` | General skill authoring (SkillsBench gate) |
| `mstar-audit` | Read-only codebase audit → prioritized improvement plans |
| `mstar-roles` | Role prompts + load lists |
| `mstar-host` | Host adapters (dsh / omp / OpenCode / Cursor / Kimi / ZCode / Codex) |
| `pm` | `/pm` / `/skill:pm` / host PM entry |

Consumer plans default to **`.mstar/`**. Process artifacts (`plans/`, `iterations/`, `status.json`, `workflows/`, `projects/`, `sdd/`, …) are gitignored; tracked results: `{HARNESS_DIR}/AGENTS.md`, `knowledge/`, `specs/`. Specs resolve `.mstar/specs/` → `docs/specs/` → repo-root `specs/`. Repos with a non-default layout can declare every harness directory symbol in a gitignored **`.mstarc`** (`[config]` keys `harness_dir` / `plan_dir` / `sdd_dir` / `iteration_dir` / `knowledge_dir` / `specs_dir` / `workflow_dir` / `project_dir` — honored above probing). Details → `mstar-conventions`.

Maintainers: [`AGENTS.md`](AGENTS.md).

## License

MIT. See [LICENSE](./LICENSE).
