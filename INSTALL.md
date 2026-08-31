# Morning Star — Installation

> 中文安装说明的叙述性导读见 [README_CN.md](README_CN.md)；本文档为结构化安装参考（英文为主）。

## Prerequisites

- **Node.js** 18+ (for `npx` / `bunx` CLI)
- Target host installed:
  - [OpenCode](https://opencode.ai)
  - [Cursor](https://cursor.com)
  - [Codex](https://github.com/openai/codex) (with `codex` CLI for marketplace install)
  - [Kimi Code CLI](https://www.kimi.com/code/docs/kimi-code-cli/) (for `/plugins install`)
  - [ZCode](https://zcode.z.ai) (for Plugin Management install)
  - [omp (Oh My Pi)](https://omp.sh) (for `omp plugin install` / `omp plugin link`)
  - [dsh (DeepSeek Harness)](https://www.npmjs.com/package/@deepseek-ai/dsh) (for the `dsh` plugin manager; e.g. `npm install -g @deepseek-ai/dsh`)

## Recommended: CLI install

Package: `@mstar-harness/cli` (command: `mstar-harness`).

```bash
npx @mstar-harness/cli init
# or
bunx @mstar-harness/cli init
```

`init` is target-aware and writes baseline config in one flow. `--scope` defaults to `project` when omitted.

### OpenCode

```bash
npx @mstar-harness/cli init --target opencode --yes
npx @mstar-harness/cli doctor --target opencode
```

Non-interactive preview:

```bash
npx @mstar-harness/cli init --target opencode --dry-run --yes
```

### Cursor

Global (recommended for personal use):

```bash
npx @mstar-harness/cli init --target cursor --scope global
```

Project (plugin checkout under `.cursor/plugins/morning-star-harness`, gitignored):

```bash
npx @mstar-harness/cli init --target cursor --scope project
```

Verify:

```bash
npx @mstar-harness/cli doctor --target cursor --scope global
# or --scope project
```

Restart Cursor or run **Developer: Reload Window** after install.

**Layout note:** Cursor does **not** discover symlinked plugin directories. The CLI maintains a shared checkout at `~/.mstar/harness` and a **separate real git checkout** at the Cursor plugin path. See [Install path layout](docs/cli.md#install-path-layout) in [`docs/cli.md`](docs/cli.md).

### Codex

The harness repo ships its own Codex marketplace catalog at `.agents/plugins/marketplace.json` (marketplace name `mstar-repo`, plugin root = repo root). `init --target codex` registers that repo as a git marketplace under the `mstar-repo` name:

Global (custom agents linked from `~/.mstar/harness`):

```bash
npx @mstar-harness/cli init --target codex --scope global
codex plugin add morning-star-harness@mstar-repo
npx @mstar-harness/cli doctor --target codex
```

Project (iteration commands additionally linked under `.agents/skills/`):

```bash
npx @mstar-harness/cli init --target codex --scope project
codex plugin add morning-star-harness@mstar-repo
npx @mstar-harness/cli doctor --target codex --scope project
```

Without the CLI (direct marketplace registration):

```bash
codex plugin marketplace add btspoony/mstar-harness --ref main
codex plugin add morning-star-harness@mstar-repo
```

#### Codex: project vs global scope

| Scope | Iteration commands (`iteration-start`, `iteration-drive`, `iteration-loop`) |
|-------|-------------------------------------------------------------------------------|
| **Project** | Installed as project-local skills under `.agents/skills/<name>/SKILL.md` (symlinked from harness `commands/`; gitignored by CLI) |
| **Global** | **Not** installed (avoids polluting other projects); `init` prints a warning — re-run with `--scope project` to enable |

Full CLI flags, `doctor` checks, and path tables: [`docs/cli.md`](docs/cli.md).

### ZCode

Global marketplace (recommended for personal use):

```bash
npx @mstar-harness/cli init --target zcode --scope global
npx @mstar-harness/cli doctor --target zcode
```

Then in ZCode: **Settings → Plugin Management → Discover** → install **morning-star-harness** from the **mstar-local** marketplace.

Project (plugin checkout under `.zcode/plugin-checkout`, gitignored):

```bash
npx @mstar-harness/cli init --target zcode --scope project
npx @mstar-harness/cli doctor --target zcode --scope project
```

**Layout note:** the CLI registers a `mstar-local` marketplace in `~/.zcode/cli/plugins/known_marketplaces.json` pointing at the **`github:btspoony/mstar-harness`** repo (same source shape ZCode uses for built-in marketplaces). Project scope additionally keeps a real git checkout under `.zcode/plugin-checkout` (gitignored) for local agent-file smoke checks; the registered marketplace always points at the github repo so installs work across machines.

### Kimi

Install the plugin in Kimi TUI (user-scoped — all projects):

```text
/plugins install https://github.com/btspoony/mstar-harness
/plugins reload
```

**Notes:**

- Kimi plugins are **user-scoped** today (no project-level plugin install). Managed copy lives under `$KIMI_CODE_HOME/plugins/managed/`.
- Plugin commands: `/morning-star-harness:iteration-start`, `/morning-star-harness:iteration-drive`, `/morning-star-harness:iteration-loop`.
- New sessions auto-load **`pm`** via `sessionStart.skill`; use `/skill:pm` anytime.
- Project `.agents/skills/` symlinks are **not** required — skills and commands come from the plugin.

### omp

User scope (recommended):

```bash
npx @mstar-harness/cli init --target omp --scope global
npx @mstar-harness/cli doctor --target omp
```

Or install/link directly:

```bash
omp plugin install github:btspoony/mstar-harness
# maintainer / local checkout:
# omp plugin link ~/.mstar/harness
```

Project scope: `npx @mstar-harness/cli init --target omp --scope project`.

**Notes:**

- `omp plugin list` package name is root **`morning-star`**; display name remains **morning-star-harness**.
- Enter PM with `/skill:pm`. Iteration commands: `/iteration-start`, `/iteration-drive`, `/iteration-loop`.
- Host adapter: **`mstar-host`** → `references/omp.md` (`skill://mstar-host/references/omp.md`).

### dsh

One CLI command installs the full dsh capability — the `@mstar-harness/dsh` plugin **plus** the optional `dsh-llm-fallbacks` role-configuration plugin:

```bash
npx @mstar-harness/cli init --target dsh
npx @mstar-harness/cli doctor --target dsh
```

The CLI runs **two independent** `dsh plugin --profile web add` calls (mstar first, then `dsh-llm-fallbacks`) — the two-command install contract, never folded into a patch file. Re-running is idempotent: already-installed rows are skipped (`skipped-existing`), exit 0.

Skip the `dsh-llm-fallbacks` row (`--no-fallbacks` is a dsh-target-only flag — ignored for other targets):

```bash
npx @mstar-harness/cli init --target dsh --no-fallbacks
```

Or run the two plugin-manager commands directly (the same contract the CLI executes):

```bash
dsh plugin --profile web add @mstar-harness/dsh
dsh plugin --profile web add dsh-llm-fallbacks
```

**Notes:**

- `--dry-run` previews the would-run commands without probing installed state or executing anything.
- dsh profiles are machine-global; `--scope` is accepted by the shared interface but has no dsh surface.
- `doctor --target dsh` reports each plugin row as `uninstalled` / `disabled` / `mounted` and exits non-zero when any row is uninstalled or disabled.
- Enter PM with the `pm` skill. Host adapter: **`mstar-host`** → `references/dsh.md` (`skill://mstar-host/references/dsh.md`).

## Manual install

Use when you cannot run the CLI or need to mirror the same layout by hand.

Supported targets: `opencode`, `cursor`, `codex`, `zcode`, `omp`, `dsh` (via the two `dsh plugin --profile web add` commands — see [dsh](#dsh) above). Kimi uses Kimi TUI `/plugins install` (see [Kimi](#kimi) above).

### OpenCode

Add to `opencode.json` (global or project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@mstar-harness/opencode@latest"
  ]
}
```

Restart OpenCode.

The OpenCode plugin resolves **skills and agents only inside `@mstar-harness/opencode`** (not `process.cwd()`). Published builds ship `harness-skills/` and `harness-agents/`. If you work from a **git checkout** of this repo, run **`bun install` / `npm install` at the repo root**, then **`bun run opencode:bundle-assets && bun run dsh:bundle-assets`** once to populate those directories under `packages/opencode/` (and the dsh mirrors).

Detailed OpenCode setup, migration, and troubleshooting: [`packages/opencode/INSTALL.md`](packages/opencode/INSTALL.md).

### Cursor

Recommended equivalent:

```bash
npx @mstar-harness/cli init --target cursor --scope global
```

Manual (same layout the CLI uses; **do not symlink** the Cursor plugin path):

```bash
git clone https://github.com/btspoony/mstar-harness.git ~/.mstar/harness
mkdir -p ~/.cursor/plugins/local
git clone https://github.com/btspoony/mstar-harness.git ~/.cursor/plugins/local/morning-star-harness
```

Restart Cursor or run **Developer: Reload Window**.

**Maintainers** (develop in a separate workspace; refresh after merge):

```bash
cd ~/.cursor/plugins/local/morning-star-harness && git pull --ff-only
# or
npx @mstar-harness/cli init --target cursor --scope global
```

### Codex

Register the repo marketplace directly:

```bash
codex plugin marketplace add btspoony/mstar-harness --ref main
codex plugin add morning-star-harness@mstar-repo
```

Link custom agents (Codex discovers agents from `~/.codex/agents/`):

```bash
git clone https://github.com/btspoony/mstar-harness.git ~/.mstar/harness
mkdir -p ~/.codex/agents
ln -s ~/.mstar/harness/codex/agents/*.toml ~/.codex/agents/
```

Migrating from the legacy personal marketplace: remove the `morning-star-harness` entry from `~/.agents/plugins/marketplace.json`, then install from the repo marketplace (`codex plugin remove morning-star-harness@personal` if previously installed).

Codex plugin source in this repository:

- Manifest: `.codex-plugin/plugin.json`
- Runtime skills: `skills/`
- Custom agents: `codex/agents/`
- Host adapter: **`mstar-host`** → `references/codex.md`

For project-local iteration skills, prefer `npx @mstar-harness/cli init --target codex --scope project` (see [Codex: project vs global scope](#codex-project-vs-global-scope)).

### Kimi

Install via Kimi TUI:

```text
/plugins install https://github.com/btspoony/mstar-harness
/plugins reload
```

Kimi plugin source in this repository:

- Manifest: `.kimi-plugin/plugin.json` (plugin root is repo root; paths `./skills/`, `./commands/`)
- Runtime skills: `skills/`
- Plugin commands: `commands/`
- Host adapter: **`mstar-host`** → `references/kimi.md`

### ZCode

Register the harness as a marketplace (without the CLI). Create `~/.zcode/cli/plugins/marketplaces/mstar-local/marketplace.json`:

```json
{
  "name": "mstar-local",
  "plugins": [
    {
      "name": "morning-star-harness",
      "source": { "source": "github", "repo": "btspoony/mstar-harness", "ref": "main" },
      "description": "Multi-agent code harness framework with unified skills for OpenCode, Cursor, Codex, Kimi Code, and ZCode.",
      "version": "3.5.1",
      "category": "Productivity"
    }
  ]
}
```

Append the marketplace to `~/.zcode/cli/plugins/known_marketplaces.json` (`marketplaces[]`):

```json
{
  "id": "mstar-local",
  "source": { "source": "github", "repo": "btspoony/mstar-harness", "ref": "main" },
  "name": "mstar-local",
  "description": "Morning Star harness marketplace (GitHub source).",
  "addedAt": "1970-01-01T00:00:00.000Z",
  "pluginCount": 1,
  "lastUpdated": "1970-01-01T00:00:00.000Z"
}
```

Then in ZCode **Settings → Plugin Management → Discover** install **morning-star-harness**.

ZCode plugin source in this repository:

- Manifest: `.zcode-plugin/plugin.json` (plugin root is repo root; paths `./skills/`, `./commands/`, `./agents/`)
- Runtime skills: `skills/`
- Plugin commands: `commands/`
- Plugin agents: `agents/`
- Host adapter: **`mstar-host`** → `references/zcode.md`


### omp

User scope (recommended):

```bash
npx @mstar-harness/cli init --target omp --scope global
npx @mstar-harness/cli doctor --target omp
```

Or install/link directly with the omp CLI:

```bash
omp plugin install github:btspoony/mstar-harness
# local checkout / maintainer link:
# omp plugin link ~/.mstar/harness
omp plugin list
```

Project scope:

```bash
npx @mstar-harness/cli init --target omp --scope project
npx @mstar-harness/cli doctor --target omp --scope project
```

**Notes:**

- Plugin package name in `omp plugin list` is root **`morning-star`** (`package.json` name); display name remains **morning-star-harness**.
- Skills/commands are discovered from the linked/installed package root (`skills/`, `commands/`).
- Enter PM with `/skill:pm`. Iteration commands are filename-based: `/iteration-start`, `/iteration-drive`, `/iteration-loop`.
- Host adapter: **`mstar-host`** → `references/omp.md` (`skill://mstar-host/references/omp.md`).

omp plugin source in this repository:

- Markers: `.omp-plugin/plugin.json`, `.claude-plugin/plugin.json` (Claude-compatible discovery)
- Runtime skills: `skills/`
- Plugin commands: `commands/`
- Plugin agents: `agents/` (discovered into live `task.agent` after install/link + reload; prefer `agent: "<role-id>"`, keep C5b skill load — see `omp.md` C5/C5b)

### Agent Plugins (generic)

Install this repo as a portable [Agent Plugins v1.0.0](https://agent-plugins.org) package (no host-specific glue):

```bash
git clone https://github.com/btspoony/mstar-harness.git ~/.mstar/harness
```

Point any Agent Plugins v1.0.0 conformant client at that directory: root `plugin.json` is the portable manifest and `skills/` is the Agent Skills component. Validate:

```bash
npx @mstar-harness/cli plugin validate --root ~/.mstar/harness
```

## Post-install

1. **Enter PM orchestration**
   - OpenCode: start with the `Project Manager` role (`agents/project-manager.md`, typically `agent.project-manager` in `opencode.json`).
   - Cursor / Codex: use `/pm`.
   - Kimi: use `/skill:pm`.
   - ZCode: use `/morning-star-harness:pm` or `/skill:pm` (no session auto-load).
   - omp: use `/skill:pm` (no session auto-load).

2. **Run an iteration** (see [README — Harness Commands](README.md#harness-commands))
   - **Deep / first iteration:** `/iteration-start` (Phase 1 grill-me → auto-continues Phase 2→5; `pause` to stop after Phase 1).
   - **Resume interrupted iteration:** `/iteration-drive` (Phase 2→5 re-entry).
   - **Fast autonomous loop:** `/iteration-loop` (Phase 1→5, optional `direction` + `scale`).

3. **Project knowledge** — bootstrap or refresh via the `mstar-compound-refresh` skill (`references/project-knowledge-bootstrap.md`), not a separate install step.

## Further reading

- CLI reference: [`docs/cli.md`](docs/cli.md)
- OpenCode package install: [`packages/opencode/INSTALL.md`](packages/opencode/INSTALL.md)
- User guide (narrative): [`README.md`](README.md) / [`README_CN.md`](README_CN.md)
