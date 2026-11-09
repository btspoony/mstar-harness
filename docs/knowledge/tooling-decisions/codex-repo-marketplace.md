---
module: packages/cli
date: 2026-09-01
problem_type: tooling_decision
category: tooling-decisions
severity: medium
applies_when:
  - registering a Codex plugin marketplace from a repo
  - maintaining the codex install flow in @mstar-harness/cli
  - debugging "marketplace root does not contain a supported manifest"
tags:
  - codex
  - marketplace
  - plugin
  - install
  - cli
  - repo-marketplace
---

# Codex repo-bundled marketplace (discovery semantics, git-source registration, release ordering)

## Context

The harness repo ships a portable Agent Plugins package at its root (`.codex-plugin/plugin.json` + `skills/`). The CLI's codex install flow previously wrote a **personal marketplace** entry into `~/.agents/plugins/marketplace.json` (name `personal`, `source: local`, path pointing at a CLI-maintained `~/.mstar/harness` checkout). The user asked whether the repo could instead ship its own marketplace catalog at `.agents/plugins/marketplace.json` so the CLI stops maintaining personal JSON. Verified on codex-cli 0.144.1 (2026-08-31) and cut over (PR #172).

## Guidance

- **Repo marketplace file**: `.agents/plugins/marketplace.json` at the repo root. `name` is the marketplace name users type in `codex plugin add <plugin>@<name>` (chose `mstar-repo`). The plugin entry uses `source: { source: "local", path: "./" }` when the plugin root **is** the repo root — codex resolves `path` relative to the marketplace root and reads the plugin version from the plugin root's `.codex-plugin/plugin.json`.
- **Codex CLI does NOT auto-discover repo marketplaces from the CWD.** Only `~/.agents/plugins/marketplace.json` (implicit `personal` marketplace, root = home) is discovered without registration. A repo marketplace must be registered once: `codex plugin marketplace add <owner/repo> --ref main` (or a local path / full `.git` URL). Git sources are cloned by codex into its own snapshot cache (`~/.codex/.tmp/marketplaces/`); refresh with `codex plugin marketplace upgrade`.
- **`--ref` is only accepted for git sources** — passing it with a local path errors (`--ref is only supported for git marketplace sources`). The full `.git` URL form (`https://github.com/owner/repo.git --ref <ref>`) is a valid git source and resolves the marketplace name from the repo's file.
- **Marketplace name resolution**: for git/local sources the registered name comes from the marketplace file's `name` field, not the source path. `codex plugin marketplace remove <name>` uses the resolved name (a raw `owner/repo` string is rejected as an invalid name).
- **Idempotency**: re-adding an already-configured marketplace is a no-op (`alreadyAdded: true`, exit 0) — the CLI checks `codex plugin marketplace list --json` first and skips.
- **Install**: `codex plugin add morning-star-harness@mstar-repo` copies the plugin into `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`. Codex discovers custom agents only from `~/.codex/agents/` (not from plugin packages) — agent `.toml` symlinks from the shared `~/.mstar/harness` checkout remain a separate CLI step.
- **CLI adapter shape** (packages/cli/src/adapters/codex.ts): fail-loud probe for the `codex` binary (`codex --version`, install hint on absence — same pattern as the dsh adapter); `init` runs `codex plugin marketplace add <REPO_URL> --ref main`; `doctor` validates via `codex plugin marketplace list --json` + `codex plugin list --json`; a legacy `personal` entry in `~/.agents/plugins/marketplace.json` is a migration **note**, not an error.

## Why This Matters

The personal-marketplace flow required the CLI to write and validate a user-owned JSON file and maintain a local checkout as the plugin source. The repo-bundled marketplace makes the repo self-describing: any codex user can register it with one command, and the CLI's codex adapter shrinks to probing + delegating to the codex CLI. The discovery semantics are non-obvious (no CWD auto-discovery; name from file; `--ref` git-only) — future install work must not assume repo marketplaces are picked up implicitly.

## When to Apply

- Adding or changing any Codex marketplace registration in this repo or consumer projects.
- Debugging `invalid marketplace file ... marketplace root does not contain a supported manifest` — check whether the marketplace file exists on the **remote** ref codex clones (see release ordering below).
- Extending the codex adapter in `@mstar-harness/cli`.

## Examples

### Register + install (git source)

```
codex plugin marketplace add btspoony/mstar-harness --ref main
codex plugin add morning-star-harness@mstar-repo
```

### Release ordering dependency (the trap)

`codex plugin marketplace add <git URL>` clones the **remote** repo and validates the marketplace file in the clone. Before the `.agents/plugins/marketplace.json` lands on the remote `main`, registration fails with `marketplace root does not contain a supported manifest` — the staging clone sits at the last published commit. This is codex's own validation, not a CLI bug; the CLI change and the marketplace file must ship together (merge → release), and old CLI versions keep working via the legacy personal flow in the meantime.

Cross-links: `tooling-decisions/dsh-cli-install-surface-orchestration.md` (sibling install-surface probe discipline) · `conventions/dsh-plugin-authoring.md` (bundle distribution).
