# Morning Star — Installation

> 中文安装说明的叙述性导读见 [README_CN.md](README_CN.md)；本文档为结构化安装参考（英文为主）。

## Prerequisites

- **Node.js** 18+ (for `npx` / `bunx` CLI)
- Target host installed:
  - [OpenCode](https://opencode.ai)
  - [Cursor](https://cursor.com)
  - [Codex](https://github.com/openai/codex) (with `codex` CLI for marketplace install)
  - [Kimi Code CLI](https://www.kimi.com/code/docs/kimi-code-cli/) (for `/plugins install`)

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

Global marketplace + custom agents:

```bash
npx @mstar-harness/cli init --target codex --scope global
codex plugin add morning-star-harness --marketplace personal
npx @mstar-harness/cli doctor --target codex
```

Project marketplace + custom agents:

```bash
npx @mstar-harness/cli init --target codex --scope project
codex plugin add morning-star-harness --marketplace personal
npx @mstar-harness/cli doctor --target codex --scope project
```

#### Codex: project vs global scope

| Scope | Iteration commands (`iteration-start`, `iteration-drive`, `iteration-loop`) |
|-------|-------------------------------------------------------------------------------|
| **Project** | Installed as project-local skills under `.agents/skills/<name>/SKILL.md` (symlinked from harness `commands/`; gitignored by CLI) |
| **Global** | **Not** installed (avoids polluting other projects); `init` prints a warning — re-run with `--scope project` to enable |

Full CLI flags, `doctor` checks, and path tables: [`docs/cli.md`](docs/cli.md).

### Kimi

Prepare harness checkout and (for project scope) iteration skill links:

```bash
npx @mstar-harness/cli init --target kimi --scope project
npx @mstar-harness/cli doctor --target kimi --scope project
```

Install the plugin in Kimi TUI (user-scoped — all projects):

```text
/plugins install ~/.mstar/harness
/plugins reload
```

Or from GitHub: `/plugins install https://github.com/btspoony/mstar-harness`

**Notes:**

- Kimi plugins are **user-scoped** today (no project-level plugin install). Managed copy lives under `$KIMI_CODE_HOME/plugins/managed/`.
- Plugin commands: `/morning-star-harness:iteration-start`, `/morning-star-harness:iteration-drive`, `/morning-star-harness:iteration-loop`.
- Project scope also symlinks iteration commands into `.agents/skills/<name>/SKILL.md` for `/skill:<name>` (gitignored). Global scope skips `.agents/skills/` iteration links (same pollution rule as Codex).

## Manual install

Use when you cannot run the CLI or need to mirror the same layout by hand.

Supported targets: `opencode`, `cursor`, `codex`, `kimi`.

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

The OpenCode plugin resolves **skills and agents only inside `@mstar-harness/opencode`** (not `process.cwd()`). Published builds ship `harness-skills/` and `harness-agents/`. If you work from a **git checkout** of this repo, run **`bun install` / `npm install` at the repo root** so `postinstall` runs `opencode:bundle-assets` and populates those directories under `packages/opencode/`.

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

Personal marketplace (without the CLI):

```bash
git clone https://github.com/btspoony/mstar-harness.git ~/.mstar/harness
```

Create or update `~/.agents/plugins/marketplace.json`:

```json
{
  "name": "personal",
  "interface": {
    "displayName": "Personal"
  },
  "plugins": [
    {
      "name": "morning-star-harness",
      "source": {
        "source": "local",
        "path": "./.mstar/harness"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

Install and link agents:

```bash
codex plugin add morning-star-harness --marketplace personal
mkdir -p ~/.codex/agents
ln -s ~/.mstar/harness/codex/agents/*.toml ~/.codex/agents/
```

Codex plugin source in this repository:

- Manifest: `.codex-plugin/plugin.json`
- Runtime skills: `skills/`
- Custom agents: `codex/agents/`
- Host adapter: `skills/mstar-host/references/codex.md`

For project-local iteration skills, prefer `npx @mstar-harness/cli init --target codex --scope project` (see [Codex: project vs global scope](#codex-project-vs-global-scope)).

### Kimi

Clone or refresh harness checkout:

```bash
git clone https://github.com/btspoony/mstar-harness.git ~/.mstar/harness
```

Install via Kimi TUI:

```text
/plugins install ~/.mstar/harness
/plugins reload
```

Kimi plugin source in this repository:

- Manifest: `kimi.plugin.json` (wins over `.kimi-plugin/plugin.json`)
- Runtime skills: `skills/`
- Plugin commands: `commands/`
- Host adapter: `skills/mstar-host/references/kimi.md`

For project-local iteration skills (`/skill:iteration-*`), prefer `npx @mstar-harness/cli init --target kimi --scope project`.

## Post-install

1. **Enter PM orchestration**
   - OpenCode: start with the `Project Manager` role (`agents/project-manager.md`, typically `agent.project-manager` in `opencode.json`).
   - Cursor / Codex: use `/pm`.
   - Kimi: use `/skill:pm`.

2. **Run an iteration** (see [README — Harness Commands](README.md#harness-commands))
   - **Deep / first iteration:** `/iteration-start` (Phase 1) → `/iteration-drive` (Phase 2–5).
   - **Fast autonomous loop:** `/iteration-loop` (Phase 1→5, optional `direction` + `scale`).

3. **Project knowledge** — bootstrap or refresh via the `mstar-compound-refresh` skill (`references/project-knowledge-bootstrap.md`), not a separate install step.

## Further reading

- CLI reference: [`docs/cli.md`](docs/cli.md)
- OpenCode package install: [`packages/opencode/INSTALL.md`](packages/opencode/INSTALL.md)
- User guide (narrative): [`README.md`](README.md) / [`README_CN.md`](README_CN.md)
