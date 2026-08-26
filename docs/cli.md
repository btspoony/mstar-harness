# mstar-harness CLI Guide

This guide documents the standalone `@mstar-harness/cli` package (command: `mstar-harness`) for OpenCode, Cursor, Codex, ZCode, omp, and dsh bootstrap. Kimi Code uses Kimi TUI `/plugins install` — see [INSTALL.md](../INSTALL.md#kimi).

The package installs two interchangeable binaries: `mstar-harness` (canonical) and the `mstar` short alias — both invoke the same CLI.

> **Caution**: `mstar` is a short alias and a **shared bin namespace** — an unrelated third-party npm package named `mstar` claims the same command name. The alias exists only where `@mstar-harness/cli` is installed: bare `npx mstar …` in an environment without the package resolves via the registry to that other tool, and globally co-installing both packages silently overwrites the `mstar` shim (last install wins). The canonical invocation name stays `mstar-harness` — prefer it in scripts and use the long name whenever a collision is possible.

## Fast Path

Use this sequence for the quickest user flow.

### OpenCode

1) Preview what will change (schema + plugin only; uses OpenCode default models):

- `npx @mstar-harness/cli init --target opencode --dry-run --yes`

2) Apply the setup:

- `npx @mstar-harness/cli init --target opencode --yes`

3) Verify the final config:

- `npx @mstar-harness/cli doctor --target opencode`

Optional advanced: pass `--pm-model` / `--*-models` flags to write explicit `agent.<role>.model` overrides (does **not** call `opencode models`).

### Cursor

1) Install plugin to project (default scope). The CLI maintains `~/.mstar/harness` and clones a **real directory** at `.cursor/plugins/morning-star-harness` (not a symlink — Cursor cannot load symlinked plugin roots):

- `npx @mstar-harness/cli init --target cursor`

2) Verify project install:

- `npx @mstar-harness/cli doctor --target cursor`

### Codex

1) Add Morning Star to the Codex marketplace metadata and link Codex custom agents. The CLI maintains `~/.mstar/harness`:

- `npx @mstar-harness/cli init --target codex --scope global`

2) Install from that marketplace:

- `codex plugin add morning-star-harness --marketplace personal`

3) Verify marketplace metadata and agent symlinks:

- `npx @mstar-harness/cli doctor --target codex`

### Kimi

Kimi is **not** a CLI `--target`. Install via Kimi TUI:

```text
/plugins install https://github.com/btspoony/mstar-harness
/plugins reload
```

See [INSTALL.md](../INSTALL.md#kimi) and **`mstar-host`** → `references/kimi.md` for host behavior (`sessionStart.skill: pm`, `/morning-star-harness:iteration-*`, C5/C5b role-in-prompt).


### omp

1) Link the local harness checkout into omp plugins (user scope):

- `npx @mstar-harness/cli init --target omp --scope global`

2) Verify:

- `npx @mstar-harness/cli doctor --target omp`

Alternate without the CLI:

- `omp plugin install github:btspoony/mstar-harness`
- or `omp plugin link ~/.mstar/harness`

See [INSTALL.md](../INSTALL.md#omp) and **`mstar-host`** → `references/omp.md` for host behavior (`/skill:pm`, filename `/iteration-*` commands, live-schema role `task.agent` preference + C5b skill load).


## Install

Use one of the following:

- `npx @mstar-harness/cli --help`
- `bunx @mstar-harness/cli --help`

Tip: If your network/npm mirror is slow, you can run the same commands with `bunx`.

## User Commands

### `mstar-harness init`

Interactive bootstrap:

- `npx @mstar-harness/cli init`
- `bunx @mstar-harness/cli init`

`--scope` defaults to `project` when omitted.

OpenCode non-interactive bootstrap (fast path — no model prompts):

- `npx @mstar-harness/cli init --yes --target opencode --scope project`

Dry-run preview (no file write):

- `npx @mstar-harness/cli init --dry-run --scope project --output .tmp/opencode.json --yes`

Optional role-model overrides (advanced; skips live model discovery):

- `npx @mstar-harness/cli init --yes --target opencode --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5 --dev-models openai/gpt-5.3-codex --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5`

Cursor install:

- Global install (git checkout at `~/.cursor/plugins/local/morning-star-harness`; shared Codex/OpenCode checkout at `~/.mstar/harness`):
  - `npx @mstar-harness/cli init --target cursor --scope global`
- Project install (git checkout at `.cursor/plugins/morning-star-harness`; the CLI adds it to `.gitignore`):
  - `npx @mstar-harness/cli init --target cursor --scope project`

Codex install:

- Global personal marketplace + custom agents:
  - `npx @mstar-harness/cli init --target codex --scope global`
- Project marketplace + custom agents:
  - `npx @mstar-harness/cli init --target codex --scope project`
- Then install the plugin:
  - `codex plugin add morning-star-harness --marketplace personal`
- Runtime host behavior after install:
  - `/pm` enters the shared PM flow.
  - Codex custom agents are linked from `~/.mstar/harness/codex/agents/*.toml`.
  - **Project scope only:** `iteration-start`, `iteration-drive`, and `iteration-loop` are installed as project-local skills under `.agents/skills/<name>/SKILL.md` (symlinked to `~/.mstar/harness/commands/<name>.md`); the CLI gitignores those paths.
  - **Global scope:** iteration skills are **not** installed (avoids polluting other projects); `init` prints a warning — re-run with `--scope project` to enable them.
  - Codex-specific clarify, dispatch, sandbox, and tool-discovery rules live in **`mstar-host`** → `references/codex.md`.

Kimi: not a CLI target — use `/plugins install` in Kimi TUI (see [INSTALL.md](../INSTALL.md#kimi)).

### dsh (DeepSeek Harness)

`init --target dsh` installs the full dsh capability in one command — the `@mstar-harness/dsh` plugin **plus** the optional `dsh-llm-fallbacks` role-configuration plugin:

- `npx @mstar-harness/cli init --target dsh`
- `npx @mstar-harness/cli doctor --target dsh`

The CLI runs **two independent** `dsh plugin --profile web add` calls (mstar first, then `dsh-llm-fallbacks`) — the two-command install contract, never folded into a patch file. Re-running is idempotent (already-installed rows are skipped, exit 0); `--dry-run` previews the would-run commands without probing installed state or executing anything.

Skip the `dsh-llm-fallbacks` row (`--no-fallbacks` is a dsh-target-only flag — ignored for other targets):

- `npx @mstar-harness/cli init --target dsh --no-fallbacks`

Or run the two plugin-manager commands directly (the same contract the CLI executes):

```sh
dsh plugin --profile web add @mstar-harness/dsh
dsh plugin --profile web add dsh-llm-fallbacks
# or, from a local checkout:
cd <repo>/packages/dsh && dsh plugin --profile web add .
```
`dsh web` then boots the harness: in-process engine gates (status/dispatch/lease/worktree/seams), the bundled `mstar-*` skills mount, and the bundled slash commands (`/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`, `/pr-deep-review`). Host behavior (tools, gates, enforcement, PM dispatch) → **`mstar-host`** → `references/dsh.md`; package docs → [`packages/dsh/README.md`](../packages/dsh/README.md).

### `mstar-harness doctor`

Check an existing config:

- `npx @mstar-harness/cli doctor --target opencode --scope project`
- `npx @mstar-harness/cli doctor --output ./opencode.json`
- `npx @mstar-harness/cli doctor --target cursor --scope global`
- `npx @mstar-harness/cli doctor --target cursor --scope project`
- `npx @mstar-harness/cli doctor --target codex`
- `npx @mstar-harness/cli doctor --target dsh`

If validation fails, `doctor` exits with a non-zero status code. For the dsh target, each plugin row is reported as `uninstalled` / `disabled` / `mounted`; rows that are uninstalled or disabled are issues (exit 1), `mounted` is healthy.

### `mstar-harness plugin validate`

Validate a plugin package against the [Agent Plugins v1.0.0](https://agent-plugins.org/specification) portable format. The root `plugin.json` is checked against the closed manifest schema (required `$schema` and `name`, metadata types, plugin name rules, `extensions`), `mcp.json` per §7.2.1 if present (closed `$schema` + `mcpServers`, stdio/streamable-http/sse server variants, `env`/`cwd`/`url`/`headers` rules), and `skills/` discovery per §6.1 (immediate child directories with `SKILL.md`; frontmatter `name` must equal the directory name and `description` must be non-empty). No schemas are fetched at runtime. Without `--root`, the command starts at the project root and walks up to the nearest ancestor containing `plugin.json`; use `--root` for an unambiguous target.

- `npx @mstar-harness/cli plugin validate`
- `npx @mstar-harness/cli plugin validate --root /path/to/plugin`

Exit codes:

- `0` — conformant: prints `OK <root>: Agent Plugins v1.0.0 conformant`
- `1` — non-conformant: prints one error line per finding, prefixed with `plugin.json:` / `mcp.json:` / `skills:`

Non-fatal findings are reported separately: an unknown top-level field, a non-object `extensions` field, or a non-object `extensions.<namespace>` entry is reported and ignored (validation continues), and a `skills/` child directory without `SKILL.md` prints a yellow warning without failing validation. Non-conforming skills are skipped the same way (§7.1): a `SKILL.md` with missing or invalid frontmatter, a `name` that does not match its directory or violates Agent Skills name rules, or a missing `description` prints a `skills:` warning and that skill is skipped while validation of the remaining components continues.

### `mstar-harness roles validate`

Maintainer/dev check for the mstar-roles skill layout (the engine check cited in the `mstar-roles` skill): validates the role mapping / parameter tables in `skills/mstar-roles/SKILL.md` against the on-disk `references/*.md` files, and lints the load-order declarations across every sibling `mstar-*` skill. A thin mirror of the engine `validateRoleMapping` + `lintLoadOrder` checks (unreadable sibling `SKILL.md` files are skipped best-effort).

- `npx @mstar-harness/cli roles validate`
- `npx @mstar-harness/cli roles validate --roles-dir skills/mstar-roles --skills-dir skills`

Without flags, `--roles-dir` defaults to `skills/mstar-roles` and `--skills-dir` to its parent (`skills`), both resolved against the project root.

Exit codes:

- `0` — OK: prints `roles validate (mapping): OK` and `roles validate (load order): OK`, then the summary `roles validate: OK` with the violation, sibling-skill-scanned, and load-order-checked counts (the load-order count excludes `mstar-harness-core`, exempt by design)
- `1` — violations: prints a FAIL header plus one violation row per mapping / load-order violation on stderr (same stream split as the other `printChecklist` commands); the `roles validate: FAIL (N violations, …)` summary line stays on stdout

## Maintainer Commands

Engine-backed harness checks for maintainers (thin wrappers — business logic lives in `@mstar-harness/engine`). Each command mirrors an engine validator that skill engine-check callouts cite; exit codes follow the CLI convention (0 = OK, 1 = violations/data errors, 2 = usage).

### `mstar-harness status tech-debt`

Print the residual tech-debt rollup (`total_open` / `by_severity` / `by_target` / `by_plan`) aggregated over every `{PROJECT_DIR}/<id>/residuals.json` project register — a thin mirror of the engine `techDebtRollup` check cited in `mstar-artifacts` (`references/status-and-residuals.md`). v3 hard cutover: the project register is the source of truth — there is no stored-summary drift check, the output is informational (exit 0).

- `npx @mstar-harness/cli status tech-debt`
- `npx @mstar-harness/cli status tech-debt path/to/projects`

Without a path argument the command uses the resolved `{PROJECT_DIR}`.

Exit codes:

- `0` — prints the computed rollup + the informational note (registers empty → zero rollup)
- `1` — project dir not found or resolution failed

### `mstar-harness status findings-cleanup`

Enforce a plan's `Findings cleanup` mode on its project-register residuals — a thin mirror of the engine `findingsCleanupGate` check cited in `mstar-artifacts`. The register (`projects/<id>/residuals.json`) entries are keyed by plan id — the snapshot plan linkage. Mode resolution: explicit `--mode zero-residual|allow-residual`, else the `allow-residual` default (plans without register entries pass trivially).

- `npx @mstar-harness/cli status findings-cleanup <plan-id> --harness <path>`
- `npx @mstar-harness/cli status findings-cleanup <plan-id> --project acme --mode zero-residual`

`--harness` defaults to the resolved `{HARNESS_DIR}`; `--project` defaults to `_default`.

Exit codes:

- `0` — OK: no open-residual violations under the resolved mode
- `1` — violations: prints one `findings.*` row per violating open residual on stderr

### `mstar-harness migrate`

Migrate a v1 `{HARNESS_DIR}` status.json tree to the v2 schema — a thin wrapper over the engine `migrateHarnessTree` / `applyMigratePlan` (P1 Task 6). One-shot hard cutover: v1 root is **archived** to `archived/status.v1.json` (never deleted without that copy), each lifecycle (iteration compass + standalone plan row) becomes `workflows/<id>/snapshot.json` (+ `notes.jsonl` ledgers), residuals become the `projects/<id>/residuals.json` register, `metadata.program_roadmap` seeds `projects/<id>/roadmap.md`, and the root `status.json` is replaced by the v2 root (the commit point, last step). Re-run on a v2 tree is an idempotent no-op.

- `npx @mstar-harness/cli migrate`
- `npx @mstar-harness/cli migrate --dry-run [--path <root>] [--json]`

`--path` is the **harness root** (the dir containing `status.json`); it defaults to the resolved `{HARNESS_DIR}` (auto-discovery from the cwd, like every other command; falls back to the cwd for a bare harness-root directory without a `.mstar/` marker). `--dry-run` prints the ordered step plan (source → destination), runs the apply-time validators (`validateWorkflowSnapshot` / `validateProjectRegister`) **read-only** on the planned documents and surfaces any violations as `warning:` lines — an apply-time rejection is visible before any write — and writes nothing. `--json` emits the machine-readable shape on stdout.

Exit codes:

- `0` — OK, or idempotent no-op (`status.json` already at schema version 2)
- `1` — plan-invalid: no/unrecognized v1 `status.json`, unliftable or duplicate `plans[]` rows, unsafe ids
- `2` — apply-failure: the executor threw mid-apply; the v1 root stays intact for a re-run (fix the blocker and re-run — the deterministic plan converges)

### `mstar-harness lease verify-integration`

Verify the workflow snapshot's top-level `integration_merge_lease` object when present — a thin mirror of the engine `validateIntegrationMergeLease` check cited in `mstar-artifacts` / `mstar-iteration`. Distinct from `mstar-harness lease verify` (the plan-level `execution_lease` on a snapshot plan row): this is the serial integration-merge lease.

- `npx @mstar-harness/cli lease verify-integration --workflow <id> --harness <path>`

`--harness` defaults to the resolved `{HARNESS_DIR}`.

Exit codes:

- `0` — OK: no `integration_merge_lease` (unclaimed) or a valid lease (prints the holder)
- `1` — invalid lease: missing/invalid `holder` / `claimed_at` / `plan_id` / `source_branch` / `target_branch`, or a `null`/tombstone object
- `2` — usage: missing `--workflow`

### `mstar-harness worktree qc-alignment`

Assert the QC/QA alignment fields (`plan_id` / `Review range` / `Diff basis`) are byte-identical across the given Assignment files — a thin mirror of the engine `assertQcAlignment` check cited in `mstar-branch-worktree`.

- `npx @mstar-harness/cli worktree qc-alignment qc1.md qc2.md qc3.md qa.md`

Each file is parsed for the three header fields (bold or plain forms; `Review range` and `Diff basis` accepted either as separate labels or via the canonical combined `**Review range / Diff basis**:` label, whose value fills both fields). Exit codes:

- `0` — OK: all three fields byte-identical across every file
- `1` — mismatch: prints `qc.alignment.mismatch` per differing field, or `qc.alignment.field.missing` when a file lacks a required field
- `2` — usage: no assignment files given

### `mstar-harness host skill-root`

Resolve the loaded skill root for a host — a thin mirror of the engine `resolveSkillRoot` check cited in `mstar-host` (table at "Resolve loaded skill root").

- `npx @mstar-harness/cli host skill-root --host opencode --skill mstar-roles`
- `npx @mstar-harness/cli host skill-root --host cursor --skill mstar-roles --rel references/opencode.md`

Exit codes:

- `0` — prints the canonical skill-root string (e.g. `harness-skills/mstar-roles`); `pi` prints the deferred-resolution notice in yellow
- `1` — missing required `--host` / `--skill` option (commander default)
- `2` — usage: unknown `--host` id, or an empty `--skill` value

## Harness Slash Commands (not CLI subcommands)

`/codebase-audit`, `/pr-deep-review`, and the `/iteration-*` commands ship with the harness plugin (`commands/*.md`), not the `mstar-harness` CLI binary. Host availability: dsh / omp / OpenCode / Cursor load them from the plugin; Kimi / ZCode expose `/morning-star-harness:<name>`; Codex installs them as project-local skills (`--scope project`). See the command-loading table in [README.md](../README.md#codebase-audit).
### `/pr-deep-review`

Deep, evidence-first review of a pull request / branch / diff before merge → one verdict (`ship it` / `needs fixes` / `blocked`). Worktree-isolated and read-only; findings that can fix become self-contained plans (`{PLAN_DIR}/audit-<YYYY-MM-DD>/`) for the normal Prepare → Execute flow. When a PR number exists, the command's main agent posts a mandatory GitHub Review (`COMMENT` event) with line comments on findings at Stage 3 synthesis — SSOT → `mstar-audit` `pr` variant → `references/pr-review.md`. A single PR runs the three-stage pipeline (collect → domain review → main-agent synthesis — `references/pr-review.md` § Review pipeline). Multi-PR input reviews only the first PR; remaining PRs are queued as audit todos for the next session — one session = one PR (§ Batch sibling PRs).

The verdict is computed from the finding tally; `score_pct` is display-only feedback and never overrides it (→ `references/pr-review.md` § Tally and derived score).

### `/codebase-audit`

```text
/codebase-audit [simplify]
```

| Token | Meaning | Default |
|---|---|---|
| `quick` / `deep` | Effort level: `quick` = hotspot-only (0–1 subagents, top ~6 HIGH-confidence findings); `deep` = whole repo, every package (≤8 subagents, one per category) | `standard` (hotspot-weighted, key packages, ≤4 subagents) |
| `<category>` | Category focus — recon, then that category only: `bug`, `security`, `perf`, `tests`, `tech-debt`, `migration`, `dx`, `docs`, `direction` (plan `Category` field values) | all nine |
| `branch` | Current-branch changes only (since merge-base with the default branch); findings tagged `introduced` / `pre-existing` | full codebase |
| `next` / `roadmap` | Direction category only, in depth — 4–6 grounded suggestions → design/spike plans | — |
| `simplify` | DEBT-focused deep pass: dead / duplicated / speculative / over-built / added-then-removed / hand-rolled-where-a-dependency-exists surfaces, proved or rejected via consumer classification; findings use category `tech-debt` (finding code `DEBT`); tiny-real items land in "considered and rejected", never inline TODOs | — |

Examples: `/codebase-audit`, `/codebase-audit deep security`, `/codebase-audit branch`, `/codebase-audit simplify`. Full workflow SSOT → **`mstar-audit`** skill.

## What `init` Ensures

OpenCode `init` enforces these baseline requirements in `opencode.json`:

- `"$schema": "https://opencode.ai/config.json"`
- `plugin` contains `@mstar-harness/opencode@latest` (legacy `morning-star@git+…` lines for `btspoony/mstar-harness` are stripped on init, including URLs without `.git`, `ssh://`, or `#tag`)
- Role models are **not** required — OpenCode defaults apply unless you pass optional `--*-model` flags

Cursor and Codex `init` ensure a maintained local checkout exists at `~/.mstar/harness`. Codex then creates agent symlinks from that checkout. Cursor clones a **separate real git checkout** at the plugin path (see [Install path layout](#install-path-layout)).

Cursor `init`:

- global: `git clone` / `git pull` at `~/.cursor/plugins/local/morning-star-harness`
- project: `git clone` / `git pull` at `.cursor/plugins/morning-star-harness`, `.gitignore` entry for the plugin directory, and harness **process** gitignore entries for `.mstar/` and legacy `.agents/` (`archived/`, `iterations/`, `plans/`, `sdd/`, `notes.json`, `status.json`). Harness **results** (`knowledge/`, `specs/`, `AGENTS.md`) are not added automatically.

Codex `init` writes or updates marketplace metadata with a local-source entry:

- `name`: `morning-star-harness`
- `source.source`: `local`
- `source.path`: `./.mstar/harness` for global scope, `./.codex/plugins/mstar-harness` for project scope
- `policy.installation`: `AVAILABLE`
- `policy.authentication`: `ON_INSTALL`

Codex `init` also links all `codex/agents/*.toml` files into `~/.codex/agents/` for global scope or `.codex/agents/` for project scope. Project scope also links `.codex/plugins/mstar-harness -> ~/.mstar/harness`, adds `.codex/plugins/mstar-harness` plus `.codex/agents/*.toml` to `.gitignore`, appends the same harness **process** gitignore set as Cursor project `init` (see above), and symlinks `iteration-start` / `iteration-drive` / `iteration-loop` into `.agents/skills/<name>/SKILL.md` from `~/.mstar/harness/commands/<name>.md` (also gitignored). Global scope skips iteration skills and prints a pollution-avoidance warning.

dsh `init` runs the two `dsh plugin --profile web add` calls (`@mstar-harness/dsh` then `dsh-llm-fallbacks`) in the fixed `web` profile — idempotent (already-installed rows skipped), fail-loud when the `dsh` binary is missing, and `--no-fallbacks` skips the fallbacks row.

## What `doctor` Checks

- Same schema and presence of **either** `@mstar-harness/opencode…` **or** a recognized legacy `morning-star@git+…` line (so existing git-based configs still pass).
- Missing per-role `agent.<role>.model` is a **yellow recommendation** only (OpenCode defaults are OK).
- If only legacy git is present, or legacy and npm are both listed, `doctor` prints **yellow recommendations** and still exits 0; run `init` to normalize to `@mstar-harness/opencode@latest`.
- For Cursor, `doctor` checks the maintained `~/.mstar/harness` checkout, that the Cursor plugin path is a **real git directory** (not a symlink), that `agents/*.md` files use Cursor-first frontmatter, and (project scope) all harness **process** `.gitignore` entries listed under Cursor `init`.
- For Codex, `doctor` checks the local marketplace entry, the maintained `~/.mstar/harness` checkout, and custom-agent symlinks. Project scope also validates iteration skill symlinks under `.agents/skills/` and harness **process** `.gitignore` entries.

## Install path layout

Cursor **does not discover symlinked plugin directories**. Use real directories at the plugin paths below.

| Path | Host | Layout | Notes |
| --- | --- | --- | --- |
| `~/.mstar/harness` | Codex (marketplace `local` source), OpenCode dev bundle | git checkout | Codex agent `.toml` files are **symlinked** from here into `~/.codex/agents/` |
| `~/.cursor/plugins/local/morning-star-harness` | Cursor global plugin | **git checkout (real dir)** | **Not** a symlink to `~/.mstar/harness`; `init` clones or `git pull`s here |
| `.cursor/plugins/morning-star-harness` | Cursor project plugin | **git checkout (real dir)** | gitignored; same clone/pull behavior as global |

`init --target cursor` maintains **two** checkouts: `~/.mstar/harness` (shared with Codex) and the Cursor plugin path (independent clone, kept in sync via `git pull` on each init).

**Maintainers** editing this repository in a separate workspace should refresh the Cursor plugin checkout after merging:

```bash
cd ~/.cursor/plugins/local/morning-star-harness && git pull --ff-only
```

Or re-run `npx @mstar-harness/cli init --target cursor --scope global`.

## Options Reference

### Shared

- `--output <path>`: explicit config path (absolute or relative to project root)

### `init` options

- `--yes`: non-interactive mode
- `--target <opencode|cursor|codex|zcode|omp|dsh>`
- `--scope <global|project>` (default: `project`)
- `--dry-run`
- `--no-fallbacks`: skip installing the `dsh-llm-fallbacks` plugin row (dsh target only; ignored for other targets)
- `--pm-model <model>` (optional advanced override)
- `--strategic-models <a,b,c>` (optional)
- `--dev-models <a,b,c>` (optional)
- `--qc-models <a,b,c>` (optional)
- `--other-models <a,b,c>` (optional)

### `doctor` options

- `--target <agent>`
- `--scope <global|project>`
- `--output <path>`

### `plugin validate` options

- `--root <path>`: plugin root directory to validate (default: nearest ancestor of the project root that contains `plugin.json`)

## Development (Repository)

These are for contributors developing this repository:

- `bun run cli:dev -- --help`
- `bun run cli:build`

### Target Adapter Architecture

The CLI uses a target adapter layer so new code agents can be added without rewriting `init`/`doctor`.

- Adapter registry: `packages/cli/src/adapters/index.ts`
- OpenCode adapter: `packages/cli/src/adapters/opencode.ts`
- Cursor adapter: `packages/cli/src/adapters/cursor.ts`
- Codex adapter: `packages/cli/src/adapters/codex.ts`
- Shared contracts: `packages/cli/src/types.ts`

To add a new agent target, implement a new adapter with:

- config path resolution (`resolveConfigPath`) **or** install flow (`runInstallInit` / `runInstallDoctor`)
- init mutation (`mutateConfigForInit`) for config-mode targets
- doctor validation (`validateConfig`)
- optional model discovery (`getAvailableModels`) — OpenCode default init does **not** use this (avoids hanging on `opencode models`)
