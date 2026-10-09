# Runtime reference

Morning Star is an Agent Plugin for harness engineering workflows: a TypeScript **Harness Workflow Engine** (`@mstar-harness/engine`) enforces the machine-checkable part of a multi-agent delivery process, while the `mstar-*` skills carry the judgment part — roles, gates, review verdicts, and direction. This page is the runtime and integration reference for that system: what runs where, how state is stored, and what the CLI and MCP surfaces guarantee.

Read it when you are running Morning Star in your own repository or wiring it into a host. It does not replace:

- **Installation and host setup** — commands, config files, path layouts, manual fallbacks → [`INSTALL.md`](../INSTALL.md).
- **Slash commands** — the seven user entry points and the store CLI walkthrough → [`docs/commands.md`](commands.md).
- **Behaviour rules** — each concern's own skill file. This page maps them and points at them instead of restating them.

## Components

| Piece | What it is |
|-------|------------|
| Harness Workflow Engine | `@mstar-harness/engine` — a TypeScript library with **no binary**. It implements the deterministic, machine-checkable rules: version, path, status, lease, dispatch, iteration, and lint checks. Skills cite it in `Engine check` callouts; engine exports are the machine-checkable mirror of rules the skills state in prose. |
| Harness CLI | `@mstar-harness/cli` — the `mstar-harness` binary, with `mstar` as a short alias. It provides the installer bootstrap (`init`, `doctor`), the command surface, the stdio MCP server, and the offline report draft. |
| Command registry | `@mstar-harness/commands` — one canonical definition per non-installer command. `--help`, refusal text, exit codes, and the MCP tools all derive from these definitions, so the help text and validation use the same definitions. |
| Skills | `skills/` — the `mstar-*` family plus the `pm` entry and the bundled `grill-me` skill. These are the semantic source of truth for lifecycle, gates, roles, dispatch, review, and knowledge; the engine checks a subset of what they state. |
| Entry commands | `commands/*.md` — the slash entries (`/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`, `/amazing-pr-review`, `/amazing-test-audit`, `/amazing-e2e-check`). Each boots `project-manager` in your current session; argument forms and routing → [`docs/commands.md`](commands.md). |
| Role shells | `agents/*.md` — the role identities hosts surface as named subagents (for example `fullstack-dev`, `qc-specialist`). |
| Host plugins | `@mstar-harness/dsh`, `@mstar-harness/omp`, `@mstar-harness/opencode`, plus Cursor, Codex, Kimi, and ZCode packaging. They add skill discovery, session context, and — where the host exposes a refusal channel — engine-backed write gates. |
| Portable package | The repository root `plugin.json` plus `skills/` form an [Agent Plugins v1.0.0](https://agent-plugins.org) package. Validate it with `mstar-harness plugin validate --root <path>`. |

You normally reach the engine through the CLI or a host plugin; it is also published as a library, so an integration can import the same validators directly. The CLI wraps engine functions as thin command handlers, and the MCP server registers the same commands as tools.

## Roles and skills

The role catalogue:

| Agent ID | Responsibility |
|----------|----------------|
| `project-manager` | Routing, assignment, phase progression; owns Done on plan rows |
| `product-manager` | Requirements, product planning, research |
| `architect` | Architecture and technical contracts |
| `fullstack-dev` / `fullstack-dev-2` | Backend-led implementation / second parallel track |
| `frontend-dev` | UI, interaction, frontend performance |
| `qa-engineer` | Acceptance verification when the QA gate is `mandatory` |
| `code-reviewer` | Per-task SDD review; codebase audit runs |
| `qc-specialist` / `qc-specialist-2` / `qc-specialist-3` | Plan QC trio (architecture / security / performance lenses) |
| `ops-engineer` | Deploy, monitoring, infrastructure |
| `writing-specialist` | Documentation, copy, scripts, narrative |
| `prompt-engineer` | Prompt, skill, and rule work |

Where the rules live:

- `mstar-roles` owns role prompts and the **load-selection decision** (its § Load Order). Selection is not repeated here; this page is not a load list.
- `mstar-harness-core` is the global lifecycle and authorization entry: state machine, Done ownership, task categories, and the skill index.
- `mstar-host` owns host detection and per-host entry details, with one reference per host (`dsh`, `omp`, `opencode`, `cursor`, `codex`, `kimi`, `zcode`).

Topic skills, grouped by what they own:

| Skill | Owns |
|-------|------|
| `mstar-harness-core` | Lifecycle state machine, authorization, task categories, skill index |
| `mstar-roles` | Role prompts and load selection |
| `mstar-host` | Host adapters and per-host entry details |
| `mstar-phase-gates` | Prepare/Execute gates, clarify loop, hotfix route |
| `mstar-iteration` | Iteration lifecycle, phases 1–6 |
| `mstar-dispatch-gates` | Dispatch, delegation boundaries, anti-recursion |
| `mstar-sdd` | Subagent-driven per-task implementation and review |
| `mstar-branch-worktree` | Branches, worktrees, QC/QA checkout alignment |
| `mstar-conventions` | Harness paths, discovery, `.mstarc`, plan conventions |
| `mstar-artifacts` | Plans, review bundles, registers, issue severity and lifecycle |
| `mstar-project-governance` | Roadmap content, issue capture, milestone records |
| `mstar-review-qc` | QC seat orchestration, residual handling |
| `mstar-coding-behavior` | Implementation discipline, diagnosis, review practice |
| `mstar-design-md` | DESIGN.md design tokens and the UI plan gate |
| `mstar-compound` / `mstar-compound-refresh` | Knowledge crystallisation and maintenance |
| `mstar-strategy` | `STRATEGY.md` direction |
| `mstar-skill-authoring` | Skill authoring gate |
| `mstar-audit` | Read-only audit variants: codebase, tests, PR review |
| `mstar-e2e` | Explicit E2E, browser, device, and installed-deployment verification |
| `mstar-use-cli` | CLI reference: families, flags, exit and refusal codes |
| `mstar-engine-legacy` | Engine-absent safety archive; conditional contract fallback |
| `pm` | Host-agnostic PM entry shim |

## Storage and persistence

Consumer repositories keep harness state under `{HARNESS_DIR}`, which defaults to `.mstar/` and can be relocated through a repo-local `.mstarc` file. Directory symbols and discovery order are owned by `mstar-conventions`; the defaults are `{PLAN_DIR}` = `plans/`, `{SDD_DIR}` = `sdd/<plan-id>/`, `{ITERATION_DIR}` = `iterations/`, `{WORKFLOW_DIR}` = `workflows/`, `{PROJECT_DIR}` = `projects/`, and `{KNOWLEDGE_DIR}` = `knowledge/`. `{SPECS_DIR}` resolves to the first non-empty of `.mstar/specs/`, `docs/specs/`, or repository-root `specs/`, and defaults to `{HARNESS_DIR}/specs/` when all candidates are absent.

Two persistence layers back that layout:

- **Pre-activation JSON transport.** Before a store is activated, execution and review documents (`status.json`, workflow snapshots, session envelopes, review JSON) are written through a pluggable `ArtifactStore`; the default `FsStore` keeps the conventional `.mstar/` paths. An integration that needs a different backend mounts its own module through `MSTAR_STORE_MODULE`, the `--store` option, or the in-process `setArtifactStore`.
- **Activated store.** After activation, `{HARNESS_DIR}/store.db` (SQLite, native `node:sqlite`) is the authority for issues, catalog rows, roadmap content, and workflow/plan execution state. Retired project registers are migration history with no write path; open follow-ups live as issues in the store. The two layers are not interchangeable, and the store is not a mirror of the JSON files.

Git policy: the canonical `.gitignore` snippet ignores the harness directory wholesale and re-includes the tracked results — `AGENTS.md`, `knowledge/**`, and `specs/**`; the `.mstarc` config file is itself local. Process artifacts stay local to a checkout while knowledge and specs follow Git branches, which is also how a linked worktree shares results without carrying process state. `mstar-harness harness scaffold` creates the harness directory, the initial status file, the default project, and the canonical ignore/`AGENTS.md` files when they are absent.

For administration of an existing store — verified backup before an upgrade, the single default `mstar store upgrade` path for importing legacy state, and restore/export commands — see the store section of [`docs/commands.md`](commands.md) and the `mstar-use-cli` skill.

## CLI contract

The binary is `mstar-harness`; `mstar` is a short alias for the same entry point, and tool output uses the short form in its usage and recovery hints. Both names require the same runtime (see [Runtime and enforcement](#runtime-and-enforcement)).

**Discovery.** Every command carries its contract on the command itself:

```bash
mstar-harness --help                  # top-level command groups
mstar-harness issue --help            # one family
mstar-harness issue close --help      # one command: usage, options, requirements, defaults
mstar-harness schema --command issue.close
mstar-harness schema --family issue
mstar-harness schema ClosureEvidence  # one issue payload type
```

`schema` returns the same facts as data — selectors are `--command <id>`, `--family <name>`, and a positional issue payload type — so an agent can resolve a contract without reading prose. The MCP server exposes the same discovery as `mstar_schema`, and a refusal names its own help route.

**Envelope and exit codes.** Every non-installer command prints one version-1 JSON envelope with `status` `ok`, `refused`, `error`, or `usage`. (`init` is the installer and prints human-readable steps; `mcp` is a long-running stdio server.) Ordinary exits are `0` (ok), `1` (refused), and `2` (usage). A missing SDD task still exits `3`, and spawned children propagate `124`, `127`, and `128+n`. A refusal keeps the engine's own `code`, `message`, and `details`; the envelope adds `helpRoute` and, when a concrete next step exists, `recovery`.

**Input admission.** Missing or malformed input is refused once, with every problem in the same envelope: `details.diagnostics` lists each field with an expected and received fact, plus `details.required` (the minimal required set), `details.defaults`, and the conditional requirement facts. Declared defaults are applied before validation, so a command runs with only its required input. On the CLI, payload field values arrive as JSON strings and are decoded against the declared schema. Write commands that guard concurrency take an explicit `--expect` revision and refuse a stale token instead of overwriting.

**Payload fields in help.** For the issue family, `--help` expands the payload schema field by field, with requiredness and type, from the same registry that validates the call. `mstar-harness issue close --help` renders:

```text
Payload fields: reason (required) (string), references (requiredWhen: resolved) (string[]), scope (requiredWhen: waived) (string), canonicalIssueId (requiredWhen: duplicate or superseded) (string), alignmentRef (requiredWhen: resolved or waived) (string)
```

`requiredWhen` names the dispositions that make a field required, so the help text, the schema command, and the validation refusal use one vocabulary.

**Read-only views.** `mstar-harness dashboard` serves a read-only web UI of the issue store and the execution/roadmap projections on `127.0.0.1` (loopback only, GET only); flags are listed by `mstar-harness dashboard --help`.

Exact families, flags, and refusal codes are owned by the **`mstar-use-cli`** skill; this page only states the contract shape.

## Offline report draft

`mstar-harness report` creates an offline draft for the GitHub issue form. It does not read credentials or files, submit the issue, or make a network request. Supply only the report fields you choose: `title`, `command`, `arguments`, `expected`, `actual`, `reproduction`, `stableCode`, `exitStatus`, `host`, `platform`, and `versionOverrides`. Narrative fields you omit are marked `absent`; unavailable observed versions are `unknown`. Version overrides remain labeled caller-supplied. Each text field is limited to 8192 UTF-8 bytes and all supplied text together to 32768 bytes; `arguments` accepts at most 128 items.

The report reuses a finite redaction set: private-key blocks, AWS access keys, GitHub tokens and PATs, live Stripe keys, Slack tokens, JWTs, `sk-` API keys, credential-like key/value assignments (`password`, `passwd`, `api-key`, `access-token`, `auth-token`, `secret`, or `token`), and four CI/IaC shapes (plaintext GitHub Actions secret environment values, echoed Actions secrets, credential-named Docker `ENV`/`ARG`, and hardcoded Terraform passwords). Redaction counts are distinct matched line/type findings per field, not every occurrence. This finite set cannot guarantee every secret is removed; inspect the draft yourself.

```bash
mstar-harness report --title "Synthetic example" --command "mstar status" \
  --expected "workflow is listed" --actual "workflow is missing" \
  --stable-code "workflow.not-found" --exit-status 1
```

The generated prompt asks you to review it before submission. The CLI prints a version-1 JSON envelope containing `issueUrl`, the review prompt, and `redactions`; MCP exposes the same command as `mstar_report`, with the same field names as an input object. Exact flags and the MCP input shape → [`INSTALL.md` — Report command](../INSTALL.md#report-command).

## MCP

`mstar-harness mcp` runs the stdio MCP server from the same `@mstar-harness/cli` package as the command line. There is no standalone MCP package, committed per-host stdio bundle, or native bridge. The server registers the canonical non-installer commands as tools, named `mstar_<command>` with dots and hyphens replaced by underscores (`issue.close` → `mstar_issue_close`). Tool descriptions and input schemas come from the same registry as `--help`, and a refusal keeps its stable envelope and code, returned as a tool error: explain or resolve the refusal rather than retrying through a different identity or path.

Every host ships a launch configuration for the same server command:

| Host | MCP configuration |
|------|-------------------|
| omp | Plugin `mcp.json` (`mcpServers`) |
| OpenCode | Injected at runtime through the plugin's `config` hook; `packages/opencode/mcp.json` is the matching template |
| Cursor | `.cursor-plugin/mcp.json` (`mcpServers`) |
| Codex | `.codex-plugin/mcp.json` (`mcpServers`, stdio) |
| Kimi | `.kimi-plugin/mcp.json` (`mcpServers`) |
| ZCode | `.zcode-plugin/mcp.json` (`mcpServers`, stdio) |
| dsh | The shipped Cordis profile row `mstar-mcp` (server name `mstar`), which loads `npx -y @mstar-harness/cli mcp` through the `@deepseek-ai/dsh-mcp-client` bridge plugin. The row is inert unless that plugin is present in the profile's dependencies (`dsh plugin --profile web add @deepseek-ai/dsh-mcp-client`); `init` does not install it. |

The JSON configs and OpenCode's hook launch the CLI with `npx @mstar-harness/cli mcp`, so they execute the published bin through its Bun shebang and need **Bun >=1.4.0** on PATH; the explicit `node <CLI bundle> mcp` form needs **Node >=24.18.0**. Install commands and per-host config details → [`INSTALL.md` — Installing the MCP tools](../INSTALL.md#installing-the-mcp-tools).

Context and limits:

- Optional `host` selects a supported host context; it is not a role or authority grant. `sessionId` selects the main conversation session, not a spawned child-agent session, and child-agent attribution is neither required nor performed.
- Existing workflow ownership, path, state-transition, and CAS checks still decide whether a request is allowed; the MCP route does not bypass them.
- MCP-side SDD evidence capture does not fingerprint the runner executable or collect repository/declared-input snapshots, so those records are marked `stable: false`. CLI capture does not have that limitation.
- `mstar-harness doctor --target <host>` reports each host's MCP config as **aligned**, **mismatch**, or **unavailable**. It reads the host configuration (for dsh, the composed profile dump) and checks the runtime floor; it does not start the server, open the issue store, or prove that a host loaded the plugin. An aligned config is not an installed-host success claim.

## Runtime and enforcement

**Runtime floors.** The published `mstar-harness` bin is a Bun shebang script (`#!/usr/bin/env bun`): a normal launch — including `npx` / `bunx`, which fetch the package but still execute that same bin — needs **Bun >=1.4.0** on PATH. An explicit `node node_modules/@mstar-harness/cli/dist/mstar-harness.js <verb>` needs **Node >=24.18.0**. The store uses native `node:sqlite`, which is why the Node floor exists and why there is no fallback for older runtimes. Bun-hosted host plugins run on Bun; a native Node host process is a Node entry. The floors are per-entrypoint, not a demand to install both runtimes. `mstar-harness doctor` checks the runtime that executes it against the matching floor.

**Enforcement is opt-in.** The engine validates in warn-only mode by default. Blocking requires an explicit hard setting: `.mstarc` `enforcement=hard` for a repository, or an iteration compass / Assignment header flag for one unit of work. Priority and rollback are owned by `mstar-conventions` (`soft` in `.mstarc` rolls back a hard compass). Where a host cannot refuse an action, the gate degrades to a warning — it never claims to have blocked.

**What each host can enforce.** dsh and omp plug into the host lifecycle and can return a structured refusal; the ZCode hook blocks the default-branch commit and force-push, and runs the coordination/authority write gate (per-hook detail and its disable switches → [`INSTALL.md` — ZCode](../INSTALL.md#zcode)); OpenCode's plugin API has no refusal channel, so authority protection there is warn-only by documented contract. Host-specific coverage, including which checks run where, lives in the `mstar-host` references. Version drift between the global CLI and an installed host plugin is a known failure source — update the older side (`npm i -g @mstar-harness/cli@latest` for the CLI, or reinstall the plugin).

## Where to look next

| Question | Document |
|----------|----------|
| How do I install it for my host? | [`INSTALL.md`](../INSTALL.md) |
| What do the slash commands do, and how do I upgrade a store? | [`docs/commands.md`](commands.md) |
| Which flags, exit codes, and refusal codes exist? | **`mstar-use-cli`** skill |
| Where do files live, and how do I change the layout? | **`mstar-conventions`** skill |
| How does my host behave, and what does it enforce? | **`mstar-host`** skill and its per-host references |
| What does a term mean in this project? | [`CONCEPTS.md`](../CONCEPTS.md) |
| How does the per-plan / iteration lifecycle run? | [`README.md`](../README.md#iteration) and the **`mstar-iteration`** skill |
| How do I develop the harness itself? | [`AGENTS.md`](../AGENTS.md) |
