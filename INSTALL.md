# Morning Star — Installation

> 中文安装说明的叙述性导读见 [README_CN.md](README_CN.md)；本文档为结构化安装参考（英文为主）。

## Prerequisites

- **CLI launch vs Node invocation** — the published `mstar-harness` binary is a Bun shebang script (`#!/usr/bin/env bun`): normal launch needs **Bun >=1.4.0** on PATH. Explicit `node dist/mstar-harness.js` needs **Node >=24.18.0**. A package runner is **not** a runtime: `npx` / `bunx` fetch the package and then execute that same Bun-shebang bin, so they need **Bun >=1.4.0** on PATH as well; a Node-only machine uses the explicit `node` invocation instead ([Recommended: CLI install](#recommended-cli-install)). Do not install both runtimes solely because this document lists both entrypoints. Bun-hosted host plugins (dsh, omp, OpenCode build) need Bun `>=1.4.0`; a native Node host process is a Node entry, not an extra Bun demand.
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

Both commands execute the published bin through its `#!/usr/bin/env bun` shebang, so **Bun >=1.4.0 must already be on PATH** — the package runner fetches the package, it does not supply the runtime. On a Node-only machine, install the package and run the same entrypoint with Node instead (floor **Node >=24.18.0**); this form replaces every `npx @mstar-harness/cli …` command in this document, with identical verbs and flags:

```bash
npm install @mstar-harness/cli
node node_modules/@mstar-harness/cli/dist/mstar-harness.js init
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

**Layout note:** Cursor does **not** discover symlinked plugin directories. The CLI maintains a shared checkout at `~/.mstar/harness` and a **separate real git checkout** at the Cursor plugin path. See [Install path layout](#install-path-layout).

### Codex

The harness repo ships its own Codex marketplace catalog at `.agents/plugins/marketplace.json` (marketplace name `mstar-repo`, plugin root = repo root). `init --target codex` registers that repo as a git marketplace under the `mstar-repo` name:

Global (custom agent TOMLs copied from `~/.mstar/harness` as regular files):

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

Custom agent TOMLs must be regular files: Codex can discover a symlinked role but fail to load it when invoked. Re-run `init` with the installed scope to repair legacy links; see [agent refresh behavior](#codex-agent-files). After `doctor` passes, ask Codex to use `fullstack-dev` for a short read-only task and confirm that the named subagent actually starts.

#### Codex: project vs global scope

| Scope | Iteration commands (`iteration-start`, `iteration-drive`, `iteration-loop`) |
|-------|-------------------------------------------------------------------------------|
| **Project** | Installed as project-local skills under `.agents/skills/<name>/SKILL.md` (symlinked from harness `commands/`; gitignored by CLI) |
| **Global** | **Not** installed (avoids polluting other projects); `init` prints a warning — re-run with `--scope project` to enable |

#### Codex: agent files

Re-run `init --target codex --scope global` (or `project`) to install from the current `~/.mstar/harness/codex/agents/` source. Identical bytes are left untouched. A differing regular file is backed up as `<role>.toml.<uuid>.bak` before atomic replacement; a legacy symlink to the expected harness source is replaced without writing through it. Unrelated symlinks, non-file destinations, and a symlinked agent directory are refused.

`init` does not pull an existing source checkout: refresh that checkout first when upgrading agent definitions, then re-run `init`. Project iteration skill symlinks are unchanged. After `doctor --target codex --scope <global|project>` passes, have Codex invoke a named role (for example, `fullstack-dev` on a short read-only task) and confirm that it starts; role discovery alone is insufficient.

Full CLI flags: the **`mstar-use-cli`** skill. `doctor` checks and the path tables: each target's own section above and [Install path layout](#install-path-layout) below.

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

The repo itself ships the marketplace catalog ZCode looks for when refreshing a `github` source: `.claude-plugin/marketplace.json` (probed first), with root `marketplace.json` as fallback. The CLI-written local snapshot is a bootstrap so **Discover** works before the first refresh; after a successful refresh ZCode replaces it with the repo manifest.

The marketplace entry carries `icon` + `displayName`, so the plugin card shows the Morning Star icon after a marketplace refresh or reinstall.

**ZCode hooks (bundled):** the plugin ships `hooks/hooks.json` with three gates:

- **SessionStart** — in a harness-managed workspace (`.mstar/` discovered per `mstar-conventions`), injects a one-line context: harness dir, `status.json` summary, and the `mstar-harness-core` load pointer. Silent no-op outside harness workspaces.
- **PreToolUse (Bash)** — deterministic backstop for `mstar-branch-worktree`: blocks `git commit` on the default protected branch (override per command with `MSTAR_ALLOW_DEFAULT_BRANCH_COMMIT=1`, or per SessionStart note) and bare `git push --force` (use `--force-with-lease=<branch>:<oid>`). Disable with `MSTAR_BRANCH_GUARD=off`.
- **PreToolUse (Write|Edit)** — engine-backed coordination-write gate: in repos with opt-in hard enforcement (`.mstarc`/compass), blocks writes to harness coordination documents (`status.json`, workflow snapshots) with an actionable reason; soft-enforced and non-harness writes pass silently. Independently of that enforcement axis it **always** refuses the issue-authority invariants — a direct write to the issue/catalog store (`{HARNESS_DIR}/store.db`, `-wal`, `-shm`), a write to a retired project register while the store is the active authority, and an unreadable authority (below-floor runtime, missing `node:sqlite`, corrupt or busy store), which fails closed. Disable with `MSTAR_WRITE_GATE=off`.

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
omp plugin install @mstar-harness/omp
# maintainer / local checkout (needs a local build first):
# omp plugin link ~/.mstar/harness/packages/omp
#   (run `bun install && bun run engine:build && bun run --cwd packages/omp build` in the checkout)
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

The CLI runs **two independent** `dsh plugin --profile web add` calls (mstar first, then `dsh-llm-fallbacks`) — the two-command install contract, never folded into a patch file. Re-running is idempotent: already-installed rows are skipped (`skipped-existing`), exit 0. The one version-aware exception is a `dsh-llm-fallbacks` row installed at a version other than the pinned one: `init` re-adds the pinned spec (a registry install + profile write; a failed re-add exits non-zero), which also replaces a local `link:`/`file:` fallbacks checkout — pass `--no-fallbacks` to leave such a profile untouched.

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
- `doctor --target dsh` reports each plugin row as `uninstalled` / `disabled` / `mounted` / `drifted` and exits non-zero when any row is uninstalled or disabled, or when the `dsh-llm-fallbacks` row is `drifted` (profile install ≠ the pinned version; the note names both versions and `init --target dsh` repairs it).
- Enter PM with the `pm` skill. Host adapter: **`mstar-host`** → `references/dsh.md` (`skill://mstar-host/references/dsh.md`).

## Install path layout

Cursor **does not discover symlinked plugin directories**. Use real directories at the plugin paths below.

| Path | Host | Layout | Notes |
| --- | --- | --- | --- |
| `~/.mstar/harness` | Codex (agent `.toml` source), OpenCode dev bundle | git checkout | Codex agent `.toml` files are **copied as regular files** from here into `~/.codex/agents/`; the Codex marketplace itself is git-sourced (`btspoony/mstar-harness`) |
| `~/.cursor/plugins/local/morning-star-harness` | Cursor global plugin | **git checkout (real dir)** | **Not** a symlink to `~/.mstar/harness`; `init` clones or `git pull`s here |
| `.cursor/plugins/morning-star-harness` | Cursor project plugin | **git checkout (real dir)** | gitignored; same clone/pull behavior as global |

`init --target cursor` maintains **two** checkouts: `~/.mstar/harness` (shared with Codex) and the Cursor plugin path (independent clone, kept in sync via `git pull` on each init).

**Maintainers** editing this repository in a separate workspace should refresh the Cursor plugin checkout after merging:

```bash
cd ~/.cursor/plugins/local/morning-star-harness && git pull --ff-only
```

Or re-run `npx @mstar-harness/cli init --target cursor --scope global`.

## Installing the MCP tools

All seven hosts launch the CLI with `npx @mstar-harness/cli mcp`: six JSON-backed host configs (OpenCode's is injected through its plugin `config` hook rather than read as a static file) plus DSH's shipped Cordis profile row (see the dsh row below). The `npx` form executes the published bin through its Bun shebang, so it needs **Bun >=1.4.0** on PATH; the explicit `node <CLI bundle> mcp` form needs **Node >=24.18.0** ([Prerequisites](#prerequisites)).

| Host | Native install | MCP configuration |
|------|----------------|-------------------|
| omp | `omp plugin install @mstar-harness/omp` (or `npx @mstar-harness/cli init --target omp --scope global`) | Plugin `mcp.json` runs `command: "npx"` with args `["@mstar-harness/cli", "mcp"]`. |
| OpenCode | Install `@mstar-harness/opencode` using the OpenCode plugin entry in `opencode.json` (see [OpenCode manual install](#opencode)). | The plugin dynamically injects the official `mcp` config from its `config` hook; `packages/opencode/mcp.json` is the matching template, not a separate static config requirement. Supported `@opencode-ai/plugin` pin: **1.4.8**. |
| dsh | `dsh plugin --profile web add @mstar-harness/dsh` (or `npx @mstar-harness/cli init --target dsh`). The optional `dsh-llm-fallbacks` plugin is separate. | DSH ships a Cordis profile row (`mstar-mcp`, server name `mstar`) that launches `npx -y @mstar-harness/cli mcp` through the `@deepseek-ai/dsh-mcp-client` bridge plugin; the row is inert unless that plugin is installed in the profile (`dsh plugin --profile web add @deepseek-ai/dsh-mcp-client`). |
| Cursor | Install the Morning Star plugin (see [Cursor](#cursor)). | `.cursor-plugin/mcp.json` runs `command: "npx"` with args `["@mstar-harness/cli", "mcp"]`. |
| Codex | `codex plugin marketplace add btspoony/mstar-harness --ref main`, then `codex plugin add morning-star-harness@mstar-repo` (or use `init --target codex`). | `.codex-plugin/mcp.json` runs `command: "npx"` with args `["@mstar-harness/cli", "mcp"]`. |
| Kimi | Kimi TUI: `/plugins install https://github.com/btspoony/mstar-harness`, then `/plugins reload`. | `.kimi-plugin/mcp.json` runs `command: "npx"` with args `["@mstar-harness/cli", "mcp"]`. |
| ZCode | Install **morning-star-harness** from the `mstar-local` marketplace (see [ZCode](#zcode)). | `.zcode-plugin/mcp.json` runs `command: "npx"` with args `["@mstar-harness/cli", "mcp"]`. |

There is no separate MCP package, committed per-host stdio bundle, or native bridge.

The MCP context contract is host-neutral: optional `host` selects context validated against existing supported-host definitions; it is not a role or authority grant. `sessionId` denotes the main conversation session. The interface neither requires nor provides per-call child-agent attribution; existing shared-handler workflow ownership, path, state-transition, and CAS checks remain authoritative.

Use `npx @mstar-harness/cli doctor --target <opencode|cursor|codex|zcode|omp|dsh|kimi>` to inspect the selected target (Codex also supports `--scope <global|project>`). **Aligned** means the host's MCP config launches the CLI subcommand with the expected arguments; **mismatch** means those launch settings or the detected runtime (Bun / Node.js floor) differ; **unavailable** means the MCP config is missing or unreadable. Doctor does not spawn the MCP server, open `store.db`, refresh an installed plugin, or prove that the host loaded it.
OpenCode's package plugin injects the server definition at runtime; DSH's row ships in its bundle patch and loads through the `@deepseek-ai/dsh-mcp-client` bridge plugin. The six JSON-backed configs and the OpenCode dynamic hook use host-native shapes.

Development evidence is the targeted unit/component/integration evidence for the CLI server and host config. Installed-host, browser, device, and live-service verification is a separate authorized activity, not a development acceptance gate; these instructions do not claim such a run.

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

Install custom agents as regular files (also safely replaces legacy harness symlinks):

```bash
npx @mstar-harness/cli init --target codex --scope global
npx @mstar-harness/cli doctor --target codex --scope global
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

The repo is directly discoverable: when ZCode refreshes a `github`-source marketplace it probes `.claude-plugin/marketplace.json` first (root `marketplace.json` as fallback), and this repo ships both. Adding the repo from **Plugin Management → marketplaces** is enough — no manual files needed.

To register it by hand (without the CLI) instead, create `~/.zcode/cli/plugins/marketplaces/mstar-local/marketplace.json`:

```json
{
  "name": "mstar-local",
  "plugins": [
    {
      "name": "morning-star-harness",
      "source": { "source": "github", "repo": "btspoony/mstar-harness", "ref": "main" },
      "displayName": "Morning Star Harness",
      "icon": "https://raw.githubusercontent.com/btspoony/mstar-harness/main/assets/icon.png",
      "description": "Multi-agent code harness framework with unified skills for OpenCode, Cursor, Codex, Kimi Code, and ZCode.",
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
- Plugin hooks: `hooks/` (`hooks.json` + `session-context.mjs` + `git-guard.mjs`; see [ZCode](#zcode) install section)
- Host adapter: **`mstar-host`** → `references/zcode.md`


### omp

User scope (recommended):

```bash
npx @mstar-harness/cli init --target omp --scope global
npx @mstar-harness/cli doctor --target omp
```

Or install/link directly with the omp CLI:

```bash
omp plugin install @mstar-harness/omp
# local checkout / maintainer link (needs a local build first):
# omp plugin link ~/.mstar/harness/packages/omp
#   (run `bun install && bun run engine:build && bun run --cwd packages/omp build` in the checkout)
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
   - OpenCode: start with the `Project Manager` role (`packages/opencode/agents/project-manager.md`, typically `agent.project-manager` in `opencode.json`; OpenCode-only — other hosts use the `pm` skill).
   - Cursor / Codex: use `/pm`.
   - Kimi: use `/skill:pm`.
   - ZCode: use `/morning-star-harness:pm` or `/skill:pm` (no session auto-load).
   - omp: use `/skill:pm` (no session auto-load).

2. **Run an iteration** (see [README — Iteration](README.md#iteration))
   - **Deep / first iteration:** `/iteration-start` (Phase 1 grill-me → auto-continues Phase 2→6; `pause` to stop after Phase 1).
   - **Resume interrupted iteration:** `/iteration-drive` (Phase 2→6 re-entry).
   - **Fast autonomous loop:** `/iteration-loop` (Phase 1→6, optional `direction` + `scale`).

3. **Project knowledge** — bootstrap or refresh via the `mstar-compound-refresh` skill (`references/project-knowledge-bootstrap.md`), not a separate install step.

## Report command

`mstar report` generates an offline, redacted issue-report draft. It accepts only explicitly supplied report fields; it does not read credentials, environment variables, files, shell history, or transcripts, and it never submits the issue or makes a network request. Omitted narrative values appear as `absent`; unavailable observed versions appear as `unknown`. Review the generated draft yourself before using it.

CLI example (all values are synthetic):

```bash
mstar report \
  --title "Synthetic example" \
  --command "mstar status" \
  --arguments '["--workflow","wf-synthetic"]' \
  --expected "workflow is listed" \
  --actual "workflow is missing" \
  --stable-code "workflow.not-found" \
  --exit-status 1
```

The CLI prints a version-1 JSON envelope containing `issueUrl`, the review prompt, and `redactions` (field plus count). `--arguments` takes JSON string or string-array input; `--version-overrides` takes a JSON object. MCP exposes the same command as `mstar_report`, with the same field names as an input object, for example:

```json
{
  "title": "Synthetic example",
  "command": "mstar status",
  "arguments": ["--workflow", "wf-synthetic"],
  "expected": "workflow is listed",
  "actual": "workflow is missing",
  "stableCode": "workflow.not-found",
  "exitStatus": 1
}
```

Redaction uses a finite pattern set; its count is distinct matched line/type findings per field, not every occurrence, and is not a guarantee that every secret was removed. See [Runtime reference — Offline report draft](docs/runtime-reference.md#offline-report-draft) for the pattern categories and privacy details. These examples document the command contract, not an installed-host or live-service run.

## Further reading

- CLI reference: the **`mstar-use-cli`** skill (`skill://mstar-use-cli`)
- OpenCode package install: [`packages/opencode/INSTALL.md`](packages/opencode/INSTALL.md)
- User guide (narrative): [`README.md`](README.md) / [`README_CN.md`](README_CN.md)
