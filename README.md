<div align="center">

<img src="assets/logo.svg" alt="Morning Star Harness" width="96">

# [Morning Star](https://github.com/btspoony/mstar-harness)

Plan, implement, review, verify, merge — a delivery process for agent coding hosts.

English / [中文](README_CN.md)

<a href="https://github.com/btspoony/mstar-harness">GitHub</a> · <a href="https://github.com/btspoony/mstar-harness/issues">Issues</a>

[![CI](https://img.shields.io/github/actions/workflow/status/btspoony/mstar-harness/ci.yml?branch=main&style=flat-square&label=CI&labelColor=black)](https://github.com/btspoony/mstar-harness/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)
[![Version](https://img.shields.io/github/v/release/btspoony/mstar-harness?include_prereleases&sort=semver&label=version&style=flat-square&labelColor=black&color=c4f042)](https://github.com/btspoony/mstar-harness/releases)

</div>

Morning Star is a plugin for agent coding hosts: dsh, omp, OpenCode, Cursor, Kimi Code, ZCode, and Codex. It turns a request into a delivery process instead of a chat — a `project-manager` agent clarifies the work and keeps a plan, specialist agents implement it, and independent review and acceptance passes run before anything is called done. The mechanically checkable parts of that process (workflow state, branches, gates) are implemented by the shipped TypeScript engine; judgment (direction, role choice, review verdicts) stays with the `mstar-*` skills — plain Markdown you can read and change.

**Why use it**

- **The same loop for every request** — plan, implement, review, verify: a small fix and a multi-plan iteration go through the same stages, and work can be paused and resumed without losing its trail.
- **Specialists instead of one long prompt** — a PM orchestrates; separate roles own requirements, architecture, implementation, QC, acceptance, audits, and ops, each with a narrow brief.
- **A trail you can audit** — plans, findings, review reports, and decisions are recorded under the harness directory in your repo, not just in the chat.
- **Boundaries are explicit** — the workflow opens pull requests and stops at merge-ready; merging stays your call. Audits read and report, and anything that touches a real environment needs your explicit authorization.

## Install

Prerequisites: the CLI launches through **Bun >=1.4.0** — `npx` / `bunx` fetch the package but still need Bun on `PATH`; on a Node-only machine, install the package and run it with **Node >=24.18.0** (`node node_modules/@mstar-harness/cli/dist/mstar-harness.js <verb>`).

| Host | Install |
|------|---------|
| dsh (DeepSeek Harness) | `npx @mstar-harness/cli init --target dsh` — needs the `dsh` CLI on `PATH`; installs the plugin plus LLM fallbacks (`--no-fallbacks` skips the second) |
| omp | `npx @mstar-harness/cli init --target omp` — uses the `omp` CLI when present, otherwise falls back to `omp plugin install @mstar-harness/omp` |
| OpenCode | `npx @mstar-harness/cli init --target opencode` |
| Cursor | `npx @mstar-harness/cli init --target cursor` — creates a real plugin checkout, so `git` is required |
| Kimi Code | Kimi TUI: `/plugins install https://github.com/btspoony/mstar-harness`, then `/plugins reload` |
| ZCode | `npx @mstar-harness/cli init --target zcode`, then install **morning-star-harness** from Settings → Plugin Management |
| Codex | `npx @mstar-harness/cli init --target codex` — needs the `codex` CLI; registers the repo marketplace and adds `morning-star-harness@mstar-repo` |
| Any Agent Plugins v1.0.0 client | point it at this repo root — `plugin.json` plus `skills/` is the portable package |

`init` writes project-scoped config by default (`--scope global` installs host-wide; Codex's global scope skips the seven slash-command skills), and after a successful run it installs the matching `@mstar-harness/cli` version globally — pass `--no-global-cli` to skip that. Check the result with `npx @mstar-harness/cli doctor --target <host>`; it also reports MCP configuration as `aligned`, `mismatch`, or `unavailable`.

The published binary is `mstar-harness`. The short alias `mstar` exists only where this package is installed, and an unrelated npm package claims the same name — use the long form when in doubt. Manual installs, path layout, and host notes: [`INSTALL.md`](INSTALL.md).

## Use

Enter the PM once per session, then describe the work in your own words; the PM runs the process in that session.

| Host | Enter PM |
|------|----------|
| dsh | `pm` skill |
| omp | `/skill:pm` |
| OpenCode | `Project Manager` agent, or `/pm` |
| Cursor | `/pm` |
| Kimi | auto-loads in a session, or `/skill:pm` |
| ZCode | `/morning-star-harness:pm` |
| Codex | `/pm` |

### Single task (no iteration)

Give the PM a concrete request — for example, *"Add rate limiting to the public API and cover it with tests."* The PM clarifies the gaps, writes a plan, runs the work on a feature branch, and drives it through implement → independent QC review → acceptance → done. Confirmed problems that are not fixed in this round are captured as issues instead of being dropped. You review the result and merge.

### Iteration

| Command | What it does |
|---------|--------------|
| `/iteration-start [direction] [pause]` | Phase 1: an interactive direction lock (grill-me) that produces the iteration's compass and plans, then continues automatically through execution, close, pull request, and merge-ready. `pause` stops after Phase 1; continue with `/iteration-drive`. |
| `/iteration-drive` | Resume or advance an already locked iteration. Takes no arguments. |
| `/iteration-loop [direction] [scale]` | The same lifecycle end to end without the interactive phase. `scale` (`S` / `M` / `L` / `XL`) caps how many plans the iteration takes on. |

An iteration ends only after its post-merge close: a closed phase, an open pull request, or a merged pull request is not completion by itself. Command spelling differs per host — some hosts require a plugin prefix, and Codex installs the command skills at project scope only; argument forms and per-host details are in [`docs/commands.md`](docs/commands.md).

### Audit, review & verification

| Command | What it does |
|---------|--------------|
| `/codebase-audit [keywords]` | Read-only survey that produces prioritized, ready-to-execute improvement plans; narrow it with a category focus (`bug`, `security`, `perf`, `tech-debt`, …). |
| `/amazing-pr-review [pr\|branch] [quick\|default\|deep]` | Pre-merge review of a PR or branch at three strengths, ending in one verdict — `ship it`, `needs fixes`, or `blocked`. |
| `/amazing-test-audit [scope] [quick\|deep] [campaign]` | Read-only audit of the test surface → plans to delete, repair, consolidate, or relocate tests. |
| `/amazing-e2e-check [environment] [scenarios]` | Runs browser, device, or installed-deployment scenarios you explicitly asked for, in a separate workflow. |

The audit commands read and report; they do not edit your code. Two boundaries to know: `/amazing-pr-review` posts its findings to GitHub as a comment review when you give it a pull-request number — it never approves, requests changes, or merges — and `/amazing-e2e-check` runs only when you ask for it, with steps that touch a real environment requiring explicit authorization.

## Workflow

1. **Clarify and plan.** The PM turns the request into a written plan — scope, tasks, acceptance — and, for an iteration, locks the direction with you first.
2. **Implement on a branch.** Work happens on feature branches, and each task goes to the role that fits it.
3. **Review and verify independently.** Per-task review, then a plan-level QC review, then acceptance by QA or the PM: separate passes with their own evidence, not a re-read of the implementer's summary.
4. **Close out with evidence.** Confirmed findings become tracked issues or fixes; a plan is completed only with its verification evidence, and the workflow's pull request reaches merge-ready.
5. **Merge.** Merging is a separate authorization — request it explicitly, or merge yourself. After the merge, the workflow verifies the result and closes.

The engine checks the mechanically checkable parts of this process — workflow state transitions, branch and worktree alignment, dispatch preconditions, plan and issue bookkeeping. These checks are advisory by default: they report problems, and a project or iteration can opt into blocking enforcement with `enforcement: hard`; whether a violation can actually block depends on the host. Process state (plans, workflow records, findings, review reports) lives in the harness directory, `.mstar/` by default, which is gitignored.

## Roles and skills

A **project-manager** runs your session and dispatches the specialists: requirements and architecture, backend and frontend implementation, QC review, acceptance, codebase and PR audits, operations, and writing. Their instructions are the `mstar-*` skills — readable Markdown that is also the single source of truth for the process — and `@mstar-harness/engine` implements the checkable half of what they declare. Nothing needs to be loaded or read by hand to use the harness: enter the PM and describe the task.

## Command line

The `mstar-harness` CLI covers what you do outside a session: issues, roadmap, workflow state, checks, the dashboard, and MCP.

- **Ask the command itself.** `--help` shows the input a command expects; for issue write verbs it lists each payload field with its type and whether it is required or only required for a particular disposition. A usage refusal tells you what it found wrong, the help route to read, and how to recover.
- **Output is JSON**, so scripts and agents can parse it; exit codes are `0` success, `1` refused, `2` usage, and `3` for a missing SDD task.

```text
mstar-harness --help                        # command families
mstar-harness issue close --help            # options and payload fields for one verb
mstar-harness schema --command issue.close  # the same contract as machine-readable JSON
```

- `mstar-harness dashboard` serves a read-only web view of issues and workflow state on `127.0.0.1` (Ctrl-C to stop).
- `mstar-harness report` drafts an offline, redacted GitHub issue report for you to review before posting.
- `mstar-harness mcp` serves the same command set over stdio MCP from the same package; every host ships a launch configuration (dsh's needs the `@deepseek-ai/dsh-mcp-client` bridge plugin in its profile).

Host wiring, the issue and roadmap command families, and the details behind these surfaces are in [`docs/runtime-reference.md`](docs/runtime-reference.md).

## Documentation

- [`docs/runtime-reference.md`](docs/runtime-reference.md) — components, storage layout, roles and skills, CLI and MCP reference.
- [`INSTALL.md`](INSTALL.md) — install and verification per host, plus the `report` command in detail.
- [`docs/commands.md`](docs/commands.md) — the seven slash commands: arguments, when to use, owning skill.
- [`CONCEPTS.md`](CONCEPTS.md) — the vocabulary the harness uses across skills and docs.
- Release notes: [`CHANGELOG.md`](CHANGELOG.md) / [`CHANGELOG_CN.md`](CHANGELOG_CN.md). CLI flags: the **`mstar-use-cli`** skill.
- Maintainers: [`AGENTS.md`](AGENTS.md).

## License

MIT. See [LICENSE](./LICENSE).
