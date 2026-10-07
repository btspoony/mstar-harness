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


[![npm: cli](https://img.shields.io/npm/dt/@mstar-harness/cli?style=flat-square&labelColor=black&color=c4f042&label=npm%3A%20cli)](https://www.npmjs.com/package/@mstar-harness/cli)
[![npm: dsh](https://img.shields.io/npm/dt/@mstar-harness/dsh?style=flat-square&labelColor=black&color=c4f042&label=npm%3A%20dsh)](https://www.npmjs.com/package/@mstar-harness/dsh)
[![npm: omp](https://img.shields.io/npm/dt/@mstar-harness/omp?style=flat-square&labelColor=black&color=c4f042&label=npm%3A%20omp)](https://www.npmjs.com/package/@mstar-harness/omp)
[![npm: opencode](https://img.shields.io/npm/dt/@mstar-harness/opencode?style=flat-square&labelColor=black&color=c4f042&label=npm%3A%20opencode)](https://www.npmjs.com/package/@mstar-harness/opencode)
</div>

**Morning Star / 晨星** is an Agent Plugin for harness engineering workflows: a TypeScript **Harness Workflow Engine** (`@mstar-harness/engine`) enforces deterministic workflow gates, while `mstar-*` judgment skills drive multi-agent code delivery.

- **Deterministic gates, enforced by a TS engine** — path/status/lease/dispatch/sdd/iteration/lint gates run in `@mstar-harness/engine`, not as prompt suggestions
- **Judgment stays in `mstar-*` skills** — skills remain the single source of truth (SSOT) for roles, gates, and workflow judgment
- **One engine across hosts** — the same engine + skills power dsh (DeepSeek Harness), omp, OpenCode, Cursor, Kimi Code, ZCode, and Codex
- **Agent Plugin packaging** — one-command install; portable across any Agent Plugins v1.0.0 client
- **Pluggable JSON persistence (pre-activation fallback)** — coordination docs (`status.json`, workflow snapshots, review envelopes) persist through an `ArtifactStore`; the default `FsStore` keeps the existing `.mstar/` paths, and integrations mount their own store via `MSTAR_STORE_MODULE` / `--store` / in-process `setArtifactStore`
- **Store authority vs JSON transport** — after activation, `{HARNESS_DIR}/store.db` (SQLite) is the issue, catalog, roadmap, and workflow/plan execution authority; `ArtifactStore` retains pre-activation execution JSON (`status.json`, snapshots) and review JSON. The retired project registers are migration history with no write path; open items are issues in the store. They are not the same store.
- **Recommended host** (best → usable): **dsh = omp ≥ ZCode = OpenCode = Cursor > Kimi > Codex**

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
| omp | `npx @mstar-harness/cli init --target omp`<br>(links `~/.mstar/harness/packages/omp`)<br>or `omp plugin install @mstar-harness/omp` |
| OpenCode | `npx @mstar-harness/cli init --target opencode` |
| Cursor | `npx @mstar-harness/cli init --target cursor` |
| Kimi | Kimi TUI: `/plugins install https://github.com/btspoony/mstar-harness`<br>→ `/plugins reload` |
| ZCode | `npx @mstar-harness/cli init --target zcode`<br>then install **morning-star-harness** in ZCode → Settings → Plugin Management |
| Codex | `npx @mstar-harness/cli init --target codex`<br>then `codex plugin add morning-star-harness@mstar-repo` (repo-bundled marketplace) |
| Generic (Agent Plugins v1) | point any Agent Plugins v1.0.0 conformant client at this repo root<br>(`plugin.json` + `skills/` are the portable package) |

> CLI commands in this section run the published bin through its Bun shebang: `npx` / `bunx` / `npm i -g` all need **Bun >=1.4.0** on PATH. Node-only machine: `npm install @mstar-harness/cli`, then `node node_modules/@mstar-harness/cli/dist/mstar-harness.js <verb>` (see **Runtime floors**).

### Engine gate checks (Recommended)

```bash
npm i -g @mstar-harness/cli
```

Puts the `mstar-harness` binary (short alias `mstar`) on PATH, so the engine-check commands the skills cite (`mstar status validate`, `mstar dispatch validate`, `mstar iteration gate`, …) actually run.

`init` now auto-installs the matching-version CLI globally after a successful run — pass `--no-global-cli` to opt out.

Without a global install the harness still works and those checks stay advisory. Set `enforcement: hard` in an iteration compass to make dispatch preflights fail-fast.

> **Caution**: `mstar` is a short alias and a **shared bin namespace** — an unrelated third-party npm package named `mstar` claims the same command name. The alias exists only where `@mstar-harness/cli` is installed: bare `npx mstar …` without the package resolves via the registry to that other tool, and globally co-installing both packages silently overwrites the `mstar` shim (last install wins). The canonical invocation name stays `mstar-harness` — use the long name on any conflict.

### Verify

`npx @mstar-harness/cli doctor --target <opencode|cursor|codex|zcode|omp|dsh|kimi>` checks the selected target; Codex also accepts `--scope <global|project>`. MCP package health is reported as aligned, mismatch, or unavailable. Doctor reads package metadata/executable and checks runtime floor; it does not open the issue store. See [MCP host install paths](#mcp-host-install-paths).

Codex agent-link repair and named-role verification: [Codex installation](INSTALL.md#codex).

The repo ships a portable **Agent Plugins v1.0.0** manifest (`plugin.json`) at its root; `skills/` is the Agent Skills component — verify it with `npx @mstar-harness/cli plugin validate`.

Manual install / path layout: [`INSTALL.md`](INSTALL.md). CLI flags: the **`mstar-use-cli`** skill.

### Runtime floors (entrypoint, not “install both”)

The published CLI keeps a Bun shebang (`#!/usr/bin/env bun`). Normal launch of `mstar-harness` / the dist file uses **Bun >=1.4.0**. An explicit `node <CLI bundle>` uses **Node >=24.18.0**. `npx` / `bunx` fetch the package but still execute that same Bun-shebang bin, so they need **Bun >=1.4.0** on PATH as well — a package runner is not a runtime; on a Node-only machine install the package and run the bundle under Node (`node node_modules/@mstar-harness/cli/dist/mstar-harness.js <verb>`). Bun-hosted plugins need Bun; native Node entries need Node. Do not treat those floors as a demand to install both runtimes on every machine. This README does not prove packaged compatibility or store activation.

## Use

Three entry shapes: **without iteration** (single plan / hotfix), **with iteration** (multi-plan Phase 1–5), or **audit, review & verification** (discover work, assess changes, or run requested E2E checks).

Full command reference: [`docs/commands.md`](docs/commands.md).

### General (without iteration)

Enter PM, then run the per-plan cycle: `Prepare → Execute → QC → QA gate → Done`.

| Host | Enter PM |
|------|----------|
| dsh (DeepSeek Harness) | `pm` skill (via the mstar skill provider; no auto-load) |
| omp | `/skill:pm` each session (no auto-load) |
| OpenCode | `agent.project-manager` (OpenCode-only shell, `packages/opencode/agents/project-manager.md`) |
| Cursor | `/pm` |
| Kimi | session auto-loads `pm`; or `/skill:pm` |
| ZCode | `/morning-star-harness:pm` each session (no auto-load) |
| Codex | `/pm` |

### Iteration

| Command | When |
|---------|------|
| `/iteration-start [direction] [pause]` | Start a new iteration: Phase 1 (interactive grill-me), then auto-continue Phase 2→6.<br>`direction` — optional hint (still interactive).<br>`pause` — stop after Phase 1; resume with `/iteration-drive`. |
| `/iteration-drive` | Resume Phase 2→6 on an already-locked iteration. |
| `/iteration-loop [direction] [scale]` | Full Phase 1→6 autonomous (no grill-me).<br>`direction` — optional free text.<br>`scale` — `S` / `M` / `L` / `XL` (default `M`). |

### Direct plan coordination

One primary coordinator drives all rows of its selected workflow through ordinary `mstar plan prepare`, `progress` and `complete`. Leaf tasks retain normal SDD, isolated worktrees, QC tri and QA gates. Configuration is revisable; defaults are mandatory QA and allow-residual cleanup, with no sealed Assignment or per-row bind.

`/iteration-drive` accepts no arguments. Unsupported scoped/extra arguments are rejected before boot; they never start the whole iteration instead. Independent terminal PMs and ownership-transfer completion are removed.

Completion keeps three distinct obligations: iteration rows prove the actual serial integration merge and leave parent delivery intact; standalone development proves its registered source and continues through compound/PR/verified-merge/close; standalone report-only consumes explicit policy fulfilment recorded before Done, then evidence-backed close without invented Git/PR.

Flags, JSON and recovery → `mstar-use-cli/references/plan-and-workflow.md`; recipe → [`docs/commands.md`](docs/commands.md#iteration-drive).

### Audit, review & verification

The audit and review commands are read-only and advisory; findings can become plans for Prepare → Execute. SSOT → `mstar-audit` (variants: `codebase-audit`, `tests`, `pr`).

| Command | When |
|---------|------|
| `/codebase-audit [keywords]` | Read-only survey of what's worth doing — prioritized, ready-to-execute plans; narrow it with category focus (`bug`, `security`, `perf`, `tech-debt`, …) when you want a targeted pass. |
| `/amazing-pr-review [pr\|branch\|scope] [quick\|default\|deep]` | Deep pre-merge review of a PR / branch / diff at three strengths — `quick` (single-pass, 1 seat) / `default` (no-flag landing tier, reduced seats) / `deep` (full three-stage pipeline) — one verdict (`ship it` / `needs fixes` / `blocked`) and every finding, posted to GitHub by the command's main agent at Stage 3 synthesis when a PR number is given. `deep` runs the full three-stage pipeline (collect → domain review → main-agent synthesis; one verdict / one GitHub Review); `default` / `quick` are lighter single/dual-seat passes. Multi-PR input → first PR only; remaining PRs queued as audit todos (next session); suggest one session per PR. |
| `/amazing-test-audit [scope\|subsystem] [quick\|deep] [campaign]` | Read-only audit of the existing test surface — junk-pattern sweep, value/retention grading, and prioritized plans to delete, repair, consolidate or relocate tests; `campaign` marks every declaration of one subsystem in an R/F/C/D ledger first. |
| `/amazing-e2e-check [environment/device] [scenarios]` | Execute explicitly requested browser/device/installed-deployment scenarios through `mstar-e2e` in a separate workflow; never a routine iteration QA gate. |

### Local dashboard

`mstar dashboard` serves a **read-only** web UI of the issue store and the execution/roadmap projections on `127.0.0.1` — loopback only, with no bind-address option. It covers the issue list and detail with recorded history, the workflow / iteration / roadmap views, and one cumulative captured-vs-retired issue-flow chart. The dashboard never mutates anything; make changes with the CLI (`mstar issue …`, `mstar catalog …`) and stop the server with Ctrl-C.

```
mstar dashboard            # prints the resolved URL after the server is listening
mstar dashboard --help     # --port / --open / --project
```

### Command contract

Non-installer commands are generated from one canonical definition in `@mstar-harness/commands`. `mstar init` remains the installer and is not a generated command. Success, refusal, and usage each print a version-1 JSON envelope; ordinary exits are 0, 1, and 2. A missing SDD task still exits 3, and child processes still propagate 124, 127, and 128+n. Examples below are synthetic. This README does not claim an installed-host, browser, or live-service run.

```text
mstar schema CaptureInput
mstar host detect --signals question
```

### Offline report draft

`mstar report` creates an offline draft for the GitHub issue form; it does not read credentials or files, submit the issue, or make a network request. Supply only the report fields you choose: `title`, `command`, `arguments`, `expected`, `actual`, `reproduction`, `stableCode`, `exitStatus`, `host`, `platform`, and `versionOverrides`. Narrative fields you omit are marked `absent`; unavailable observed versions are `unknown`. Version overrides remain labeled caller-supplied. Each text field is limited to 8192 UTF-8 bytes and all supplied text together to 32768 bytes; `arguments` accepts at most 128 items.

The report reuses a finite redaction set: private-key blocks, AWS access keys, GitHub tokens and PATs, live Stripe keys, Slack tokens, JWTs, `sk-` API keys, credential-like key/value assignments (`password`, `passwd`, `api-key`, `access-token`, `auth-token`, `secret`, or `token`), and four CI/IaC shapes (plaintext GitHub Actions secret environment values, echoed Actions secrets, credential-named Docker `ENV`/`ARG`, and hardcoded Terraform passwords). Redaction counts are distinct matched line/type findings per field, not every occurrence. This finite set cannot guarantee every secret is removed; inspect the draft yourself.

```bash
mstar report --title "Synthetic example" --command "mstar status" \
  --expected "workflow is listed" --actual "workflow is missing" \
  --stable-code "workflow.not-found" --exit-status 1
```

The generated prompt asks you to review it before submission. For CLI and MCP details, see [report command usage](INSTALL.md#report-command).

### MCP runtime

`mstar mcp` runs the stdio MCP server from the same `@mstar-harness/cli` package as the command-line interface. It registers the canonical non-installer commands as MCP tools (names use the `mstar_` prefix and replace command dots and hyphens with underscores). There is no standalone `@mstar-harness/mcp` package, per-host bundle, or native bridge.

Six host configurations launch the CLI with `npx @mstar-harness/cli mcp`; DSH’s Cordis YAML launch row remains follow-up work. This requires a published CLI version that contains the `mcp` command; until that release is published, `npx` may resolve an older CLI that does not recognize it. Node.js >=24.18.0 is required by the CLI and engine.

```json
{
  "mcpServers": {
    "morning-star": {
      "command": "npx",
      "args": ["@mstar-harness/cli", "mcp"]
    }
  }
}
```

`sessionId` selects the main conversation session, not a spawned child-agent session. An optional `host` selects a supported host context; it is not a role or authority grant. Existing shared-handler workflow ownership, path, state-transition, and CAS checks still decide whether a request is allowed. A refusal keeps its stable command envelope and code (and is returned as an MCP tool error); callers should explain or resolve that refusal, not retry through a different identity or path. This documents the package contract, not an installed-host run.

Examples are synthetic; this README does not claim an installed-host, browser, or live-service run.
MCP-captured SDD evidence records are `stable:false`; collector parity with the CLI remains a documented cross-plan residual.

### MCP host install paths

The six JSON-backed host configs and OpenCode's plugin `config` hook launch the CLI with `npx @mstar-harness/cli mcp`; DSH's Cordis YAML launch row is a follow-up. `npx` may download the CLI package at launch, so the CLI version containing `mcp` must be published first:

| Host | MCP config | Runtime |
|------|------------|---------|
| omp | Plugin `mcp.json` | Node.js >=24.18.0 |
| OpenCode | `packages/opencode/mcp.json` template; the plugin injects `mcp` into OpenCode config at load | Node.js >=24.18.0 |
| dsh | Cordis profile YAML MCP launch row — follow-up (no JSON config in this package) | Not configured |
| Cursor | `.cursor-plugin/mcp.json` | Node.js >=24.18.0 |
| Codex | `.codex-plugin/mcp.json` | Node.js >=24.18.0 |
| Kimi | `.kimi-plugin/mcp.json` | Node.js >=24.18.0 |
| ZCode | `.zcode-plugin/mcp.json` | Node.js >=24.18.0 |

For exact install commands and configuration details, see [INSTALL.md](INSTALL.md#installing-the-mcp-tools). The target-specific artifacts are also described in [`mstar-host` references](skills/mstar-host/SKILL.md).

`doctor --target <host>` reports MCP config status as **aligned**, **mismatch**, or **unavailable**; an aligned config is not an installed-host success claim. Doctor checks the configured CLI launch and Node.js floor; it does **not** start the server or open the issue store. MCP context keeps the shared contract: optional `host` selects validated host context, `sessionId` is the main conversation session, and child-agent attribution is neither required nor performed. Development unit/component/integration evidence is distinct from installed-host/live verification, which requires a separately authorized activity and is not claimed here.
OpenCode's plugin adds the MCP server through its dynamic config hook; its packaged `mcp.json` is a reference template, not a static user `opencode.json` requirement. DSH uses a Cordis YAML plugin row; its npx launch row is a separately tracked host-wiring follow-up and `doctor --target dsh` currently reports unavailable.

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
    E -->|No| I["PM: select active plan from ACTIVE store.db execution authority"]
    H --> I
    I --> J{"Any plan not Done"}
    J -->|Yes| K["PM: dispatch one plan on a feature branch"]
    K --> L["Dev roles: implement and report"]
    L --> M["PM: update plan document and execution state through ACTIVE store.db authority"]
    M --> N["QC trio: review gate"]
    N --> O{"QC decision"}
    O -->|Request Changes| K
    O -->|Approve| P{"QA gate"}
    P -->|mandatory| P1["qa-engineer: acceptance verification"]
    P -->|pm-acceptance| P2["PM: acceptance checklist"]
    P1 --> Q{"Residual findings remain"}
    P2 --> Q
    Q -->|Yes| R["PM: capture confirmed findings as issues in {HARNESS_DIR}/store.db"]
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
| `mstar-artifacts` | Plans, `status.json`, issue capture pointers, Findings cleanup |
| `mstar-project-governance` | Roadmap authoring + issue capture contract, register migration history, `_default` fallback |
| `mstar-design-md` | DESIGN.md gate for UI plans |
| `mstar-review-qc` | PM QC tri orchestration |
| `mstar-coding-behavior` | RCA, test-first, review feedback, evidence |
| `mstar-compound` / `mstar-compound-refresh` | Knowledge crystallize / maintain |
| `mstar-strategy` | `STRATEGY.md` alignment |
| `mstar-skill-authoring` | General skill authoring (SkillsBench gate) |
| `mstar-audit` | Read-only codebase audit → prioritized improvement plans |
| `mstar-e2e` | Explicit standalone E2E, browser, device, and installed-deployment verification |
| `mstar-roles` | Role prompts + load lists |
| `mstar-host` | Host adapters (dsh / omp / OpenCode / Cursor / Kimi / ZCode / Codex) |
| `pm` | `/pm` / `/skill:pm` / host PM entry |

Consumer plans default to **`.mstar/`**. Process artifacts (`plans/`, `iterations/`, `status.json`, `workflows/`, `projects/`, `sdd/`, …) are gitignored; tracked results: `{HARNESS_DIR}/AGENTS.md`, `knowledge/`, `specs/`. Specs resolve `.mstar/specs/` → `docs/specs/` → repo-root `specs/`. Repos with a non-default layout can declare every harness directory symbol in a gitignored **`.mstarc`** (`[config]` keys `harness_dir` / `plan_dir` / `sdd_dir` / `iteration_dir` / `knowledge_dir` / `specs_dir` / `workflow_dir` / `project_dir` — honored above probing). Details → `mstar-conventions`.

Maintainers: [`AGENTS.md`](AGENTS.md).

## License

MIT. See [LICENSE](./LICENSE).
