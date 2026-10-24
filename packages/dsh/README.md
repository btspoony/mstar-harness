# @mstar-harness/dsh

English | [中文](README.zh.md)

![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.3-4B32C3.svg)

[Morning Star](https://github.com/btspoony/mstar-harness) as a first-class dsh (DeepSeek Harness) host — a cordis function plugin that mounts the mstar engine in-process, implements the engine `HostAdapter` (`host: 'dsh'`), guards `{HARNESS_DIR}/status.json` writes (validate + advisory; repair-escape under hard), blocks disallowed subagent dispatches when `Enforcement: hard` is on, lints `SKILL.md` writes under the mounted skill roots, mounts the mstar `skills/` mirror through the dsh skill-filesystem provider (single canonical mount), and appends a durable `mstar-engine` catalog row (persisted-log readers also accept the legacy `mstar-engine-status` identity) to every composed agent step. Boot with a dsh Loader app; everything acts through the seam's refusal/advisory channels, never by patching the tools.

This plugin's runtime requirement comes from the dsh host: the runtime that host provides must expose the native `node:sqlite` module the mstar store requires (the capability the store gate enforces). A Bun-hosted host is not version-gated - `engines.bun` in the workspace manifests declares the development toolchain - and the store's Node version floor applies to Node entrypoints only. Node is not additionally required for this package.

## Usage

How a dsh app consumes the plugin — install paths, configuration, what mounts at boot, and the enforcement semantics.

### Install paths

The package ships as a workspace package (`workspaces: ["packages/*"]`) with the engine bundled into `dist/` at build time (`bun run build`; dist is gitignored). The install path is the **profile bundle**, added to the shipped `web` profile (`dsh --profile web` — the ready-made web app profile, `dsh web`), through the `dsh.bundle.patch` manifest — a patch layer mounted over the dsh-base defaults. The patch also mounts ONE host-neutral MCP server row — the shared `mstar-mcp` connection for the whole host; a deployment that needs a pinned harness root launches it with `mstar mcp --harness <absolute path>` (mount contract: [`bundle/README.md`](bundle/README.md)).

**One-command CLI entry (recommended)** — `npx @mstar-harness/cli init --target dsh` installs the full capability in one go: it runs the two `dsh plugin --profile web add` installs below in order (the mstar bundle first, then `dsh-llm-fallbacks`), and `npx @mstar-harness/cli doctor --target dsh` reports each plugin row as `uninstalled` / `disabled` / `mounted` / `drifted` (`drifted` = the fallbacks row is installed at a version other than the pinned one; `init --target dsh` re-adds the pin, `doctor` exits non-zero until then). It is the same two-command install, orchestrated; `--no-fallbacks` skips the second row (and with it the seeded roles — see What you get below).

**(a) Registry install (published form)** — the npm package carries the built `dist/` (no build step on install):

```sh
dsh plugin --profile web add @mstar-harness/dsh
```

**(b) Local checkout install (dev)** — the package checkout itself, for iterating on the plugin:

```sh
cd <repo>/packages/dsh
dsh plugin --profile web add .
```

`dsh plugin --profile <name> add <spec>` initializes the profile on first use (`web` starts from the shipped template: `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`), forwards `<spec>` to pnpm in the profile directory, and reconciles the profile's `dsh.profile.bundles` layer list from the installed state: any dependency whose package.json declares `dsh.bundle` joins the layer stack. Relative specs (`.`, `file:`/`link:`) anchor to the invoking directory, so `add .` runs from the package checkout; pnpm must be on PATH. A local checkout needs a prior `bun run build` (the `prepare` script is intentionally NOT used — the monorepo builds packages explicitly, matching cli/opencode).

**(c) Optional capability: `dsh-llm-fallbacks` (second command)** — the role-based subagent configuration capability (see LLM fallbacks integration) is a SEPARATE plugin row and must be installed with its own command:

```sh
dsh plugin --profile web add dsh-llm-fallbacks
```

The **two-command install is the contract** — folding a `dsh-llm-fallbacks` row into this bundle's patch is explicitly rejected (roadmap §8.3 F4): the loader has no insert-if-absent semantics, so a same-`id` insert is a `duplicate loader entry id` boot failure (the whole dsh session fails to start), and a different-`id` insert mounts the plugin twice — two `apply()` runs with split fallback state (per-context state stores, double listeners, config-override lottery) for anyone who also installs the package directly. Layer order is the reconcile append order: `dsh-llm-fallbacks` lands **after `dsh-base`/`llm-retry`** (its hard ordering requirement) and after the mstar row. Single-command multi-activation is an upstream feature gap (reconcile dedup or insert-if-absent patch semantics), not actionable from this repo.

**What you get with zero configuration** — with BOTH rows installed (via the CLI entry or the two commands above), the mstar plugin declares the 13 `mode: subagent` mstar role seeds (derived from the bundled `harness-agents/` mirror, `project-manager` excluded) into the fallbacks taxonomy at boot: each seeded role's persona defaults to its mirror `description` plus the mandatory role-loading guidance line, the seeded state stays revertible (the `fallbacks/revert-seed` gateway / the settings rollback button), and the runtime advisory reports missing ids and persona overrides. The seeds mechanism is B4 — the installed-deployment e2e (`tests/install-e2e.spec.ts`) closes the verification loop: a real `init --target dsh` install into a temp `DSH_HOME`, booted from the installed artifacts, asserts all 13 ids present in the effective taxonomy with non-empty personas. Not included: model routing, automatch dispatch, or the dsh TUI.

**Role identity for delegated children needs ONE deployment-side declaration.** dsh 0.2.1 delivers a child's identity by SELECTING an agent preset, so a role-matched delegation selects what `rolePresets` maps that role to. Declare one complete preset per role (`@deepseek-ai/dsh-agent-preset` row whose plugins mount `@deepseek-ai/dsh-persona` with the role's persona text — persona, tools and skills all live in that composition) and list its id in the plugin's `rolePresets`. A role with no mapping keeps the delegating agent's composition — nothing breaks, the child simply carries no role identity. See *Role identity delivery* below.

> **Fresh-publish age window**: pnpm's `minimumReleaseAge` gate can make a `dsh plugin add <spec>` range resolution pick an older published version (without the seeds surface) for up to ~24h after a fresh publish — re-run `npx @mstar-harness/cli init --target dsh` after the window (or pin the version) to converge on the latest surface.

### Headless profile (one-shot runs)

The plugin is not web-bound: it also mounts in the dsh **headless** profile (`dsh --profile headless "<task>"` — the one-shot, no-GUI/no-port mode). The install path is identical, one command:

```sh
dsh plugin --profile headless add @mstar-harness/dsh
```

The shipped headless template auto-initializes on first use (`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`), and the reconcile step appends the mstar row to the bundle stack (`dsh-base → dsh-headless → @mstar-harness/dsh`). Every plugin capability rides a `dsh-base` seam that headless inherits — status/dispatch/lease/worktree gates, the skill mount, the engine-status catalog, the harness-rules system-prompt injection, the three native tools — so the harness is fully live in a one-shot run. **Launch from the repo working directory** (the runner writes `meta.cwd = process.cwd()` and the per-workspace harness-dir probe starts there). The browser client half is web-profile-only and simply does not load.

**Headless usage caveats** (dsh 0.1.0-rc.6 verified):

- **One-shot turn model** — the runner submits the task as one user message and exits when the agent goes idle (`whenIdle()`); it does NOT await `run_in_background` children. Foreground subagent dispatch works (a child session is created and its result reaches the parent); background QC-tri-style parallelism does NOT complete in-process — either dispatch QC seats foreground (serial wall time) or have the agent collect background results with `tool-subagent-control` BEFORE ending the turn.
- **No interaction channel** — `ask_user_question` and approval prompts fail closed when no answerer is available. For unattended runs, keep a restricted permission preset (`workspace-write` with approval `ask`, or `read-only` for inspection) and verify the effective session permissions before starting work. Run only operations allowed within that boundary; if an operation needs approval, stop that operation and use the web profile to obtain it. Do not remove sandbox restrictions to bypass a missing approval channel. Interactive Prepare flows (grill-me) belong on the web profile.
- **Default model resolution** — headless composes no fallbacks row, so an `agent-default-model` settings pin of `FallbacksChain` fails with `NO_ADAPTER` (the web-profile artifact). Point the default model at a real provider, or install `dsh-llm-fallbacks` into the headless profile too (note: on the published dsh 0.1.0-rc.6 the fallbacks settings integration predates the `SettingsProvider.installSection` API, so the virtual adapter does not register — this resolves with dsh ≥ 0.1.2-alpha).
- **Config via the profile user layer** — profile-level `cordis.patch.yml` overrides work as documented (e.g. `enforcement: hard` + `dispatchBinding` on the mstar row); the mstar row's own `config: {}` stays neutral.

### Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `harnessDir` | `string` | repo `.mstarc` `[config] harness_dir`, else per-session workspace probe (`.mstar/` → `.agents/` → `.plans/` → `plans/`, from the session workspace root — **never the launch cwd**) | Explicit harness root; wins over engine probing. **Required for repos whose harness root is not a probed name**; the probe starts from the session workspace root (never the launch cwd) and STOPS there — it never walks above the session workspace, so a harness dir above it (e.g. a global `~/.mstar`) is never adopted. |
| `enforcement` | `'hard' \| 'soft'` | compass, else warn-only | Per-deployment override. Precedence: Config wins; else the Assignment's own `**Enforcement**: hard` header flag (dispatch gate only); else the repo `.mstarc` `[config] enforcement`; else the iteration compass frontmatter; else warn-only. Config / `.mstarc` `soft` are the ONLY local rollbacks — an Assignment-level `soft` does NOT override a hard compass. |
| `dispatchTools` | `string[]` | `['subagent', 'subagent_fork']` | Delegation tool names the dispatch gate matches — the dsh preset's TWO delegation tools, `subagent` and its fork sibling `subagent_fork` (both carry Assignment-shaped `{ description, prompt }` args; a `toolName` config may rename instances). |
| `dispatchBinding` | `string` | unset — the caller is derived from the CALLING session | The dispatching agent's own harness role (the anti-recursion CALLER) — a **ROOT-session identity**. An Assignment whose `Execute as` equals the caller is self-recursion (`dispatch.anti-recursion.self-type`). The field is read ONLY when the calling session is the ROOT session (`session.header.parentSession` absent — in this harness the coordinating agent): there an explicit value (profile patch or settings form) wins verbatim, an explicitly blank value (`''`) fails closed, and an unset value reads as `project-manager` (an identity read, never a guess). A CHILD session — or a session the gate cannot read (the exec-less host `beforeDispatch` hook) — NEVER inherits it: the caller is EMPTY whatever the field says, so every Assignment-shaped dispatch fails closed with `dispatch.anti-recursion.empty-binding`, because a leaf must not dispatch and no configuration may lift that. Live-editable in the dsh plugin configuration form (same volatile path as `roleGate`). A deployment whose coordinator is NOT the root session cannot be served by this field. |
| `roleMap` | `Record<string, string>` | unset | mstar role id (`Execute as`) → dsh-llm-fallbacks role id. A taxonomy bridge for logging + future rule-driven interop ONLY — never consulted by the role-preset channel (see LLM fallbacks integration). |
| `rolePresets` | `Record<string, string>` | unset | mstar role id (`Execute as`) → **deployed agent preset id**; the role-preset channel's only payload source. A role-matched start selects that preset on the activation request (`SubagentStartRequest.agentPreset`), and dsh mounts it as the child's composition — persona (via `@deepseek-ai/dsh-persona`), tools and skills — replaying the selection on resume. The deployment declares one COMPLETE preset per role: a preset is a whole composition, never a persona-only patch. Merge order: a request that already carries `agentPreset` (the delegation tool's configured default, or the model's own `agent_preset` choice) wins AS-IS; otherwise the role is read from the Assignment header and a role with no entry stays silent. An empty/whitespace id fails Config validation at plugin mount. The selection is skipped (one contained debug log, start unaffected) when the provider does not support independent selection (`capabilities.agentPreset` false, or a provider that inherits its parent's conversation) or when the composition mounts no `agentPresets` registry (the web and headless bundles mount `@deepseek-ai/dsh-agent-preset-registry`; the base and SDK bundles do not). Configured ids are validated once per apply — an undeclared id gets one warning instead of surfacing later as a failed start. |
| `roleGate` | `'off' \| 'warn' \| 'hard'` | `'hard'` | Dispatch-role normalization at the subagent start seam (see *Role identity delivery*). An explicit declaration — an `Execute as:` / `Act as:` / `Role:` field line, or a backticked/bold already-declared role id, both IN THE ASSIGNMENT HEADER — is rewritten into the canonical `Execute as: <role>` header before the preset merge, so both role consumers bind it. `hard` refuses a start with NO reliable declaration, a start naming two or more DISTINCT roles (the message names the cause and the ids, the exact fix, and the escape hatch), a role field that IS present but unusable (empty, or not a lowercase role id — the message names the raw value and the accepted shape), and a canonical declaration that exists only inside a fenced code block (the header read is fence-unaware and the seam still binds that quote); `warn` logs ONE advisory per apply and starts unchanged; `off` skips the refusal only — a single explicit declaration is STILL normalized. Exemptions are judged at the child's EFFECTIVE start directory (an absolute `cwd` as-is, a relative one resolved against the parent's CURRENT directory — the working-directory projection the runtime itself resolves against, not the immutable `header.cwd` — and an omitted one inherited from it): a directory that resolves no `{HARNESS_DIR}` passes silently, as do prompts that already declare a usable role, requests carrying `agentPreset`, and unknown providers. This is one of the plugin's TWO LIVE-editable settings fields (`roleGate` and `dispatchBinding`): saving a different mode in the dsh plugin configuration form writes the profile patch and takes effect on the NEXT subagent start (no reload); every other field in this table is read once at apply and needs a reload. |
| `skillRoots` | `string[]` | unset (no custom-root registration) | Additional skill roots registered with the dsh skill-filesystem provider (`customSkillDirs` semantics — scanned before user roots). Dev-time: the mirror `<repo-root>/skills` absolute path. |
| `bundledSkillDir` | `string` | packaged `harness-skills/` mirror (package-relative) | Bundled skill root registered with the dsh skill-filesystem provider (`bundledSkillDir` semantics — scanned last, trusted). Defaults to the package's OWN `harness-skills/` mirror (synced by `bundle-assets`; gitignored) — package-relative, NOT cwd-anchored. An explicit value wins. |
| `catalogTtlMs` | `number` | `60000` | Pre-step catalog cache refresh interval (ms): how often the per-workspace unified `mstar-engine` catalog row (iteration gate + workspace-state digest) re-reads the store.db execution authority / the compass / the knowledge index. The hot path is a timestamp compare + cache hit between refreshes; a mid-session plan/compass/residual change lands within one interval. |
| `workflowGate` | `'off' \| 'warn' \| 'ask' \| 'hard'` | `'warn'` | Workflow/ralph gate mode (see Gates → Workflow / ralph gate). `off` = pass-through with no verdict row; `warn` = advisory-only; `ask` = first-seen names route through the approval waterfall (P-c); `hard` = policy violations veto before any child starts. Default `warn` changes NO hard behavior — the gate is advisory-only unless the deployment opts into `ask`/`hard`. |
| `workflowNames` | `string[]` | unset | Workflow name allowlist (P-a): `meta.name` values treated as KNOWN by the gate. Empty or absent ⇒ **every** name is unknown (documented — the gate is NOT "allow all" by omission). Ralph calls carry no `meta.name` — P-a never applies to them. Recommended for the mstar read-only fan-out path: `['mstar-qc-tri', 'mstar-audit-fanout', 'mstar-pr-seats']`. |

**Recommended operator overlay.** The three recommended `workflowNames` above cover the mstar read-only fan-out path (plan QC tri, large-repo `/codebase-audit`, `/amazing-pr-review deep`); listing them is an operator overlay in the profile layer, never an mstar default. With the shipped empty list every name is *unknown*, which under the default `workflowGate: 'warn'` is one `workflow.name.unknown` advisory the run survives. A production deployment that also wants unknown names vetoed sets `workflowGate: 'hard'`; the shipped default stays `'warn'`.

`bundledSkillDir` defaults to the package's OWN `harness-skills/` mirror (see Skills mount) — an explicit Config value still wins. A relative override remains **cwd-anchored** (skill-filesystem `join()` semantics against the dsh process cwd), so deployments overriding the default should pass an **absolute path in the profile layer** (see `bundle/README.md`).

### Composed row set

The profile bundle composes the following rows — the registry rows come from the `@deepseek-ai/dsh-base` layer, and this bundle's patch inserts the `mstar` row over them with neutral defaults (the row set the full-app e2e fixture boots):

```yaml
- name: '@deepseek-ai/dsh-skill'   # skill registry (ctx.skills) — dsh-base row
- name: '@deepseek-ai/dsh-tools'   # tool registry (ctx.tools) — dsh-base row
- name: '@deepseek-ai/dsh-commands' # command registry (ctx.commands) — dsh-base row
- name: '@mstar-harness/dsh'       # this bundle's patch insert (config: {} — plugin defaults apply)
```

The registry rows mount before the plugin so `ctx.skills` / `ctx.tools` / `ctx.commands` exist when the mstar gates, seam tools, and bundled commands register.

### What the plugin does when mounted

- **Status gate** — `fs/write-intent` + `fs/edit-intent` listeners validate the v3 coordination-document target set — the v2 root `{HARNESS_DIR}/status.json`, `workflows/<id>/snapshot.json` and `projects/<id>/residuals.json` — each with its matching engine validator (`validateStatus` = v2 root / `validateWorkflowSnapshot` / `validateProjectRegister`, the P2-fixed `harnessDocKindOfTarget` shape), plus the snapshot-target `findingsCleanupGate` extension per plan row that configures a mode (residuals read from the project registers).
- **Dispatch gate** — a `tools/pre-execute` listener on the delegation tool(s) validates subagent Assignment text through the engine's single `composeDispatchGate` composition (field gate, anti-recursion precheck, default-branch gate — opencode/omp/CLI parity, so violation codes are identical by construction) plus the dsh lease gate and worktree L1/L2 checks.
- **Skill-authoring lint** — `SKILL.md` writes under the configured skill roots run the engine skill-authoring lints (`lintFrontmatter` + `lintFiveQuestion`).
- **Seam lints** — `DESIGN.md` / review-report (`{REVIEW_DIR}` = `{HARNESS_DIR}/reviews/`) / knowledge-doc / roles-dir writes under the harness get their artifact-specific engine lints.
- **Model-facing tools** — exactly **three** tools register on `ctx.tools`, and only for what the MCP surface cannot do: **`mstar_plan_bind`** (the durable-slot producer — the only writer of the dsh-local `executionBinding` slot and its adoption receipt), **`mstar_audit_validate`** (the review-report credential scan, which no `mstar_audit` action publishes) and **`mstar_execution_clear`** (no shared `execution.clear` command exists). Every other runtime capability rides the MCP families, one tool per family with an `action` argument. Store-level commands (`store.*`) are the exception on purpose: they move the whole store, so they stay CLI-only and their family members are published with `transport: "cli"`. The membership rule and each tool's unique contribution: § Native command surface.
- **Bundled commands** — `ctx.commands` registrations for `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit` (from the packaged `harness-commands/` mirror; each declares a frontmatter `input` hint so the web client claims `/name ` and waits for the user's follow-up args instead of executing immediately; handlers steer the command body + user args into the receiving agent).
- **Native execution binding path** — the durable execution binding is adopted automatically by a successful native `mstar_plan_bind` (both bind arms, each after the engine's read-only C1 session resume succeeds) and cleared on demand with the `mstar_execution_clear` tool: identity comes from `exec.agent.id` (no parameters, nothing model-choosable), the clear preserves the session's own user selection and exclusion floor, and an unbound session or an unreadable binding record gets a named refusal with its recovery instead of a silent write. There is no slash command on this path — to bind or clear an execution session an operator uses exactly these two native tools.
- **Pre-step catalog row** — an advisory `agent/pre-step` listener appends ONE unified `mstar-engine` catalog message carrying ONE delta line (`workflow` / non-Done `plans` / `branch` anchors / phase `gate` verdict when a steering compass resolved) plus the `workflow warning` disclosure when the selection carries one. The residuals rollup, branch policy, spec-integration anchor, row scopes, knowledge digest, compass direction and agent-flow ledger are payload-only (panel + engine authorities) — § Engine-status catalog. Emission is change-driven per session+workspace — first emission, then only when the rendered row or the panel-relevant payload changes; the start of a turn is never a trigger, and a workspace with no resolved `{HARNESS_DIR}` composes no row. The build behind it shares one in-memory TTL cache (`catalogTtlMs`, default 60 s); the newest per-session emission persists in the control-root `store.db` (`dsh_status_emissions`), not a file cache.

### Enforcement semantics

Warn-only by default: gate violations log and emit advisory events (`mstar/status-gate`, `mstar/dispatch-gate`, `mstar/skill-lint`, seam advisories) and the action proceeds. `Enforcement: hard` — from the iteration compass frontmatter, the Assignment header, or the plugin Config (`enforcement: hard`) — escalates violations to a **real veto/deny** through the cordis refusal channels: subagent dispatch returns `PreToolDecision { kind: 'deny', reason }` without delegating; status/skill-lint writes are never hard-vetoed because the intent waterfall is content-blind — an already-invalid document is allowed as a **repair escape** (`hard: true, repair: true` advisory) so the repairing write can land. Config `soft` is the only local rollback; hard gates are never a global default.

## Gates

### Status gate

`fs/write-intent` + `fs/edit-intent` listeners (registered `prepend` so they run before dsh-fs-policy) gate writes to the v3 harness coordination-document target set — the v2 root `status.json`, `workflows/<id>/snapshot.json` and `projects/<id>/residuals.json` — each validated by its matching engine validator (`harnessDocKindOfTarget` classification; the snapshot kind additionally runs the `findingsCleanupGate` extension per plan row that configures a mode, over the project registers), against the current on-disk document (parsed exactly once — no TOCTOU double read). The gate **never throws**: every decision surfaces as the `mstar/status-gate` advisory and the intent waterfall is delegated via `next()`. Warn mode (default) logs + emits on violations. Hard mode allows an **already-invalid** document as a **repair escape** (error-level log + advisory with `hard: true, repair: true`) — the intent waterfall carries no incoming content, so a hard veto on an invalid document would deadlock the very write that repairs it. Unexpected internal errors degrade to allow in BOTH modes with a `degraded: true` advisory (error-containment envelope); the corrupting write itself cannot be vetoed on this seam (see Known Limitations).

### Dispatch gate

`tools/pre-execute` listener on the delegation tool(s): parses the payload's Assignment text and runs the engine's SINGLE dispatch-gate composition (`composeDispatchGate` — shape guard, `validateAssignmentFields`, `antiRecursionPrecheck`, default-branch gate, header-region enforcement; the same composition the opencode/omp/CLI bindings use, so violation codes are identical by construction) over the header region, plus the dsh-side worktree L1/L2 checks and the lease gate. The refusal channel is `PreToolDecision { kind: 'deny', reason }` returned **without** calling `next()`; warn mode logs, emits `mstar/dispatch-gate`, and delegates. Non-Assignment prompts and non-delegation tools are inert. Engine failures degrade to allow in both modes **observably**: the catch path emits the plugin-owned advisory with `degraded: true` + an error log, so a hard deployment can detect a dead control instead of a silent pass. Registered `prepend` so an earlier-mounted decision can never…

### Lease gate

Additive beyond the opencode fields: writable Assignment dispatch with Execution mode: sdd or an InProgress row compares Worktree path/Working branch to authoritative row metadata.worktree_path/metadata.working_branch, never a holder or per-row lease. Missing recorded scope is lease.dispatch.unverifiable (STOP before writable dispatch). Missing/unreadable authority/status/snapshot/row still produces lease.dispatch.unverifiable or lease.dispatch.unreadable; warn is advisory, hard denies. Worktree/branch mismatches retain lease.dispatch.worktree-mismatch/branch-mismatch; holder-mismatch is removed. Read-only roles skip it; other non-SDD/non-InProgress dispatch remains degrade-allow. Reads stay in assignmentHeaderRegion.

### Skill lint gate

`fs/write-intent` listener scoped to `SKILL.md` files under the configured skill roots runs the engine skill-authoring lints (`lintFrontmatter` + `lintFiveQuestion` — the CLI `mstar skill lint` combination) on the pre-write on-disk document. The slot is **content-blind** (the intent waterfall carries only `(target, actor)`), so: missing file = first create = pass; clean on-disk doc = silent pass; violations in warn mode = advisory + delegate; violations in hard mode = **repair escape** — the document is ALREADY invalid, so this write may BE the repair (error-level log + `hard: true, repair: true` advisory with the enforced `hardBlocked` verdict). Enforcement resolves like the other gates (Config override, else the iteration compass, else warn-only). The gate never throws; read failures and unexpected errors degrade to allow with a `degraded: true` advisory. The typed hard veto (`SkillLintVetoError`, code `skill-lint.veto`) lives on the incoming-document branch (`lintSkillWrite`) — see Known Limitations for its current wiring.

### Workflow / ralph gate

A `tools/pre-execute` branch (BEFORE the subagent prompt branch) gates the **`workflow`** and **`ralph`** tool calls — the remaining model-reachable fan-out that carries no Assignment text. It matches the FIXED tool names (`workflow` / `ralph`); a renamed `workflow` instance is out of scope (the name guard is the fixed default). Non-workflow tools are untouched — the subagent branch owns them, semantics unchanged.

Four-tier workflowGate remains independent of Enforcement: off/warn/ask/hard. P-b checks recorded writable scope first, then P-a names and P-c first-seen approval; no per-row holder qualification.

| Policy | `off` | `warn` (default) | `ask` | `hard` |
| --- | --- | --- | --- | --- |
| **P-b**: an InProgress row lacks metadata.worktree_path/metadata.working_branch | allow (off) | warn/advisory, workflow.lease.uncovered | warn/advisory; ask is for names only | deny before child start, workflow.lease.uncovered, naming row |
| **P-a**: workflow name ∈ `workflowNames` (non-empty list) | allow (short-circuit) | allow — no advisory (P-a passes under every mode) | allow — no ask | allow |
| **P-a**: workflow name unknown (empty/absent list ⇒ **every** name unknown) | allow (short-circuit) | **warn** — allowed + advisory (`workflow.name.unknown`) + one warn | **ask** (first-seen) → `{kind:'ask'}`; the cached decision (allow/deny) is reused afterwards — never a re-ask for a resolved name | **deny** — veto before any child starts (`workflow.name.unknown`), reason names the name |
| **ralph** (no `meta.name` — no allowlist identity) | allow (short-circuit) | allow — P-a/P-c NEVER apply | allow — P-a/P-c NEVER apply | allow — P-a/P-c NEVER apply; P-b still applies (deny when uncovered) |

**Default-`warn` rationale.** `warn` is the default so the gate **never surprises a deployment into a hard block**: it is advisory-only unless the operator opts into `ask` (human ask channel) or `hard` (veto). An empty/absent `workflowNames` makes every name unknown — the gate is **not** "allow all" by omission, but the default mode turns that into an advisory, not a block.

**Interaction with `Enforcement: hard`.** The workflow gate's mode is its OWN Config knob — the cross-cutting `Enforcement: hard` resolution (compass / Assignment header / Config `enforcement`) does **NOT** escalate `workflowGate`. A hard-enforcement deployment still runs the workflow gate in its configured mode (default `warn` = advisory-only) unless it also sets `workflowGate: 'ask'` or `'hard'`; conversely `workflowGate: 'hard'` vetoes regardless of the cross-cutting resolution. The two must not be confused: the workflow gate closes the "ungated fan-out under Enforcement: hard" gap **only when the deployment opts its mode in**.

**Fail-open edges (documented, never crash a compliant call).** (1) Malformed args — a `workflow` call without a non-empty string `meta.name` (after control-char normalization), or a `ralph` call without a string `objective` → pass-through + ONE warn under **every** mode (hard included), and NO verdict row (no policy verdict was produced). A name that is only control characters normalizes to empty → malformed. (2) Unreadable `status.json` — the P-b status read through the contained resolver path throws → P-b is degraded for that call only with ONE warn; P-a/P-c (name-based, no status dependency) still run. The gate NEVER throws: every read is structural.

**Verdict ledger rows.** Every gated call records ONE durable `workflow-verdict` row in the agent-flow ledger (the P2 ledger plan's record path, fully contained — a failing ledger write never reaches the gate): `tool` (`workflow` | `ralph`), `workflow` (normalized `meta.name`) or `objective`, `mode` (never `off` — off short-circuits before the policy), and the verdict vocabulary **`ok` / `advisory` / `denied` / `ask`** (the `ask` verdict is the extension: a first-seen ask is itself a gated call, so its row carries `ask` until the approval waterfall resolves it — "one ledger row per gated call"). Violation codes come from the verdict, never guessed: `workflow.name.unknown` (P-a) vs `workflow.lease.uncovered` (P-b). Fail-open paths (malformed args / unreadable status) record nothing; calls with no resolved harness dir skip the row (same silent no-op as the dispatch record path).

**P-c answer-observation seam.** The gate cannot observe the ask outcome — the tool registry's `serviceAsk` consumes the approval result internally. The **run-start observation IS the answer seam**: an ALLOWED ask executes the call → the durable `tool-workflow/run-start` session event lands in the parent session log → the workflow-ledger consumer records the W-B2 `workflow-run` row AND caches `allow` for the run's name into the apply-scoped `WorkflowAskCache`. A DENIED answer produces no run → no observation → the next same-name call under `ask` **re-asks** (fail-closed — no grant evidence, never an invented allow). Cache keys are the **normalized** (ASCII control chars stripped) **uncapped** name at BOTH seams — the gate composes `meta.name` and the observation records `runName` through the SAME `normalizeWorkflowName`, so a control-char name (`au\u0000dit`) can never wedge the cache (asks once, observes under the same key), and a >1024-char name still keys on the full name (the ledger ROW display name is capped separately; the identity axis is never truncated). The cache is apply-scoped — a fresh apply (HMR reload) starts empty, so an unresolved first-seen re-asks per call until an observation (or an explicit `record()`) lands. A throwing cache record degrades the observation with one warn — the ledger row is already appended, the run is never affected.

**P-b preemption:** missing recorded source scope on an InProgress row precedes name policy and applies to ralph. Configure actual source facts through ordinary prepare before writable dispatch; no per-row recovery/lease claim. Warn/ask remains advisory-only, hard vetoes.

## LLM fallbacks integration

The optional `dsh-llm-fallbacks` plugin (installed with the second command — see Install paths) powers **role-based subagent configuration** — the role seeds and the adoption advisory; role identity delivery itself rides the NATIVE subagent preset channel (independent of fallbacks, see below). The mstar plugin carries **zero runtime AND zero type references** to the package — `src/` has no import of it (runtime or type); the consumed service surface is mirrored by the local structural types in `src/gates/fallbacks-structural.ts`, and the package itself is a **dev-time-only dependency** of the mstar plugin (type mirroring + the real-package test harness). `dist/` names the package only in ONE string literal — the probe's loader-entry match — never an import or a type reference; the interop is a decision-point **capability probe**, never a module-internals read.

### Capability probe

Two views over the mounted state (point-in-time reads at decision points, no cache — loader mounts entries concurrently):

- `fallbacksService(ctx)` — the named cordis service (`ctx.get('llm-fallbacks')`) while the plugin is applied; `undefined` during HMR/fiber-swap windows even when the loader entry lives (the entry is declarative and outlives a fiber swap).
- `fallbacksMounted(ctx)` — capability view, **service-first with a loader-entries fallback**: the loader entry named `dsh-llm-fallbacks` is present, enabled (respecting `entry.disabled` and group rows), and has a live fiber.

Distinct states: **mounted** (service applied — full capability), **unmounted** (no entry: the fallbacks plugin was not installed — the mstar capability degrades, never breaks), **disabled** (entry present but disabled/grouped — capability off), and the HMR window (entry lives, service absent — the loader fallback covers it).

### Role identity delivery (native subagent preset channel)

Role identity is delivered by SELECTING a deployed agent preset: the plugin intercepts the `ctx.subagents` service READ through the cordis `internal/get` waterfall — the framework's documented service-read interception hook — and wraps the runtime value so a role-matched `startActivation(spec)` merges `spec.request.agentPreset` BEFORE the child is composed. `startActivation` is the ONE start surface in dsh 0.2.1 (one-shot and continuable children alike), and the preset owns the child's whole composition (persona, tools, skills); dsh records the selection in the child's log and replays it on resume. The underlying `SubagentRuntime` object is never mutated (no monkey-patching), and the wrapping listener is fiber-scoped (an HMR re-apply unwinds and restores it, re-binding the fresh Config). Persona delivery rides dsh 0.2.1's design, not a private section: `SubagentStartRequest.persona` and the `start`/`startContinuable` pair were REMOVED upstream, and `tool-subagent` rejects a `persona` config with "configure persona and tool plugins in an Agent Preset and select it with agentPreset (spawn only)".

**Capability gate**: an independent selection requires a provider whose `SubagentCapabilities.agentPreset` is true and whose `inheritsParentContext` is false — the same pair upstream's `tool-subagent` asserts ("provider does not support independent agent preset selection"). The `agentPresets` registry must also be mounted: without it dsh fails loud `PRESET_UNAVAILABLE`, so the channel skips the selection with ONE debug log (latched per apply) and the start proceeds unchanged. Gate misses never fail a dispatch.

**Deployment-owned compositions**: mstar owns only the role → preset SELECTION. Every preset a role names is declared by the deployment (`@deepseek-ai/dsh-agent-preset` rows, typically mounting `@deepseek-ai/dsh-persona` with the role's persona text, mirroring upstream's own `standard`/`minimal` presets); mstar ships no generated presets because a preset is a complete composition — built from rows mstar does not own.

**Normalize first, refuse last (`roleGate`)**: the same wrapper normalizes an explicit role declaration BEFORE the preset merge — a `Role: \`fullstack-dev\`` line, an `Act as:` value (after trimming one leading `@`, quotes or backticks), or a backticked/bold token that is an already-declared role id (`rolePresets` keys ∪ the packaged `harness-agents/` shell stems) — all read in the Assignment header — is rewritten into the canonical `Execute as: <role>` header, and the rewritten prompt is what the inner consumer and the runtime receive. Both candidate tiers are header-scoped and read the fence-masked text: a role id quoted in a body sentence or a fenced example is never a candidate (so pasted prose or a template cannot arm a role), while a canonical declaration the header parser reaches ONLY inside a fence is refused under `hard` instead of passing silently — the header read is fence-unaware and the seam binds that quote. Every `Execute as` field line in the header is repaired and its label normalized, because the parsers bind the LAST field line case-sensitively; two or more DISTINCT candidates are ambiguous and are never guessed — that refusal names the ids and says exactly one declaration is required (free prose, "You are an architect doing…", is never mined). Only a start with no reliable declaration (or an ambiguous, fenced, or present-but-unusable one — empty value, or not a lowercase role id) is refused (`hard`, the default), and the message names the actual cause and raw value, the exact fix and the mode-appropriate recovery: the `hard` refusal offers `roleGate: warn|off`, while the `warn` advisory only suggests `roleGate: off` (it already proceeded). A non-harness project — judged at the child's EFFECTIVE start directory (an absolute `cwd` as-is, a relative one resolved against the parent's CURRENT directory, an omitted one inherited from it, exactly the way the runtime's own `resolveDirectory` picks it, so the base is the working-directory projection rather than the immutable `header.cwd`) — is exempt, as are prompts that already carry a usable `Execute as`, requests carrying `agentPreset`, and unknown providers (the service fails its own way). `off` skips only the refusal; a single explicit declaration is still normalized.

**`roleGate` and `dispatchBinding` are editable from the plugin configuration UI** — both are `volatile` schema nodes read through the Loader's live reference, so a settings save writes the profile patch and applies without a remount.

**Anti-recursion binding (`dispatchBinding`) is a ROOT-session identity, never inherited** — the caller is derived from the CALLING session, and the field is read only there. A ROOT session (`session.header.parentSession` absent) IS the harness's coordinating agent: an explicit binding (profile patch or settings form) wins verbatim, an explicitly blank one still fails closed, and without an explicit value it reads as `project-manager` — an identity read, never a guess. A CHILD session (any `parentSession`) never inherits the binding: the caller stays EMPTY whatever the field says, so every Assignment-shaped dispatch fails closed with `dispatch.anti-recursion.empty-binding` — exactly the pre-default behaviour, because a leaf must not dispatch. A session the gate cannot read (the exec-less host `beforeDispatch` hook) falls back to EMPTY too, never to the coordinator and never to the configured value. The declared or derived caller is still a real comparison: an `Execute as` equal to it is refused as self-recursion (`dispatch.anti-recursion.self-type`), and the explicitly blank state logs one warn at apply pointing at the plugin settings form. **A deployment whose coordinating agent is not the root session cannot be served by this field.**

**Seam probe (fail-loud)**: the channel probes the cordis `internal/get` seam once per apply (temporary canary listener + one controlled proxied `ctx.subagents` read — never `ctx.get`); a missing or unrecognized seam logs ONE warn — `role persona channel not installed — cordis 'internal/get' seam missing or unrecognized (role presets will not be selected for subagent starts)` + ` (reason: seam-absent | wrap-skipped)` — instead of failing silently. A healthy boot produces NO warn (the locked outcome table): on today's composition the apply ctx does not resolve `subagents`, so each apply emits one no-warn `service-absent` debug — cordis resolves the service in dispatch scopes, where reads are intercepted per read; probe-internal errors degrade fail-open (one debug). `wrap-skipped` is pinned but not reachable from the shipped apply wiring — it fires where `subagents` is resolvable at apply, a path covered by the harness pins. The seam name is pinned by the dedicated probe family `tests/persona-seam-probe.spec.ts` (via the exported `PERSONA_SEAM_EVENT` constant); the installed-artifact assertion arms once the release carrying the probe publishes (surface-vintage guard in `tests/install-e2e.spec.ts`).

### Role seeds + adoption advisory

When the optional `dsh-llm-fallbacks` capability is **mounted** (the second install command — see Install paths), the mstar plugin **zero-config declares the 13 `mode: subagent` mstar role seeds** into the fallbacks seed registry: persona = the `harness-agents/` mirror `description` (verbatim) + one mandatory-load guide line (`Load mstar-roles (references/<role-id>.md) first — identity comes before skills; load topic skills only when the Assignment activates them via its Skill presets field.`); a persona carrying the `{{...}}` interpolation hazard is skipped + warned, never declared. The declaration **merge-preserves the currently-seeded non-mstar ids** from the readback — e.g. the 5 upstream preset roles the upstream package self-declares at its own apply: upstream `declare` REPLACES the whole registry, so without preservation a mstar-only batch would strip preset ids of their seeded annotations (rows remain, unseeded). The declaration re-fires idempotently on every fallbacks (re-)apply (HMR/fiber swap) — never from a one-shot latch — so either boot order (presets first or mstar first) converges to the same 18-id fully-seeded registry. Boot-time convergence is a bounded retry: the provider's seed write channel binds one macrotask after its apply, so a first-attempt reject with `seeds: settings service is unavailable` inside that apply window is retried (3 attempts across the provider's apply window) and a transient reject converges on its own; only if every attempt ultimately fails does the declaration log exactly one terminal error, while the advisory's decision-point re-declare stays available as the retry path. **No manual `roles.list` edit is required.**

A warn-only advisory pass (logger `mstar/fallbacks-advisory`) runs **once per apply** — attempted at apply and, when the fallbacks row mounts after `dsh` (the loader mounts entries concurrently), once at the first `subagent/start` decision point. With the service present, the pass FIRST awaits the idempotent re-declare (closing the boot race) then reads the EFFECTIVE state (`getEffectiveRoles`) and reports, bounded to **at most one warn per category**:

- **missing mstar roles** — an mstar id with no effective row (one warn listing them; the id set is derived from the `harness-agents/` mirror — never hardcoded; no mirror → the check is skipped with one debug);
- **persona overrides** — an mstar role whose row persona differs from the seed default (one warn naming them + the revert entry: the `fallbacks/revert-seed` gateway / the fallbacks settings-card rollback button — the operator override is retained until reverted);
- **empty personas** — rows with a missing/blank persona, only when non-seeded or overridden-empty (one warn naming them);
- **legacy keys** — `chains`, `roles.default`, `roles.list[].label`/`.description`, dangling `roles.rules[].role` references, via the applied service's own `detectLegacyKeys` (one warn citing its semantics);
- **declare skips/conflicts** — local skips (`interpolation` / `no-persona`) + upstream skips/conflicts (code `persona-source` — operator override retained) merge into ONE warn; seeded-at-default is silent (one debug naming the ids).

On the loader-fallback path (no service) the structural `roles.list` read is preserved (missing ids / empty personas; no revert entry — no seeds surface; the legacy-keys check is skipped — never reimplemented). A row config that is absent or not an object, or an unreadable `roles.list`, skips the pass with one debug log. The advisory **never writes the fallbacks config** — the only write path is the idempotent seeds re-declare through the released seeds surface (no-delta → no settings write upstream) — never throws, and is **not invoked when fallbacks is unmounted**: it is a signal, not a gate.

### Config surface

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `roleMap` | `Record<string, string>` | unset | mstar role id → fallbacks role id. **Taxonomy bridge** for logging + future rule-driven interop only — unused by the role-preset channel by design. |
| `rolePresets` | `Record<string, string>` | unset | mstar role id → deployed agent preset id; the channel's only payload source (the selected preset owns the child's persona, tools and skills). |

## Service

`apply` constructs `ctx.dshMstar` (engine-backed: `validateStatus`, `validateResidual`, `findingsCleanupGate`, `resolveCompassEnforcement`, `resolveHarnessDir`, `readHarnessVersion`, `applyEnforcement`). Layering: the P1 gates are co-located engine wrappers in this package importing the engine directly (same plugin, engine bundled at build time); `ctx.dshMstar` is the composition/test façade for inject consumers; the host adapter (below) is the host-facing facade. The engine is the single grammar for both paths. The companion entry `@mstar-harness/dsh/invariant` reserves package ownership with a documented no-op installer.

## Host adapter

The plugin implements the engine `HostAdapter` contract (`host: 'dsh'`) as `DshHostAdapter`, exposed as the `ctx.dshHostAdapter` service. Detection: the engine `detectHost` maps the dsh delegation tool name — `ToolSignal` **`subagent`** (the model-facing dsh subagent tool) — to `'dsh'`, evaluated after omp and before kimi/zcode/codex; hybrid sessions lose to earlier rows by fixed order. The adapter routes through the SAME validation cores as the in-plugin gates (one code path): `beforeStatusWrite(path, doc)` validates the incoming document when the host provides it, else the on-disk fallback (missing file = first create = pass); `beforeDispatch(assignment)` runs the field + branch + anti-recursion gate with the enforced `hardBlocked` verdict (the lease gate stays listener-side — it binds the ToolExecution session context the hook does not carry); `beforeMerge(lease)` is a thin wrapper over the engine `validateIntegrationMergeLease` (the reservation write into `status.json` is a P3 seam). `log` defaults to the dsh ctx logger `mstar/host-adapter`.

The frozen skill-root form for dsh (engine `resolveSkillRoot('dsh', …)`) is **`$DSH_BUNDLED_SKILL_DIR/<name>[/<rel>]`** — the resolver defines the canonical form used by skill-relative path resolvers (`resolveAssetPath`); it does NOT mount the directory. Mounting is the plugin's job (next section).

## Skills mount

The mstar skills mount through the dsh skill-filesystem provider as a **single canonical mount**: the plugin registers its configured roots as one provider (`providerName: 'mstar'`, `includeDefaultRoots: false` — isolated, it must never see the host app's own project/user skills), and the engine form above is the shared skill-root contract. Two Config paths populate it:

| Path | Mechanism | When |
| --- | --- | --- |
| Bundled default | `bundledSkillDir` defaults to the package's OWN `harness-skills/` mirror — the repo-root `skills/` (19 `mstar-*` + `pm`) synced by `bundle-assets` at build time (gitignored), resolved **package-relative** (not cwd-anchored — works from any launch cwd) | Published package / any deployment without an override |
| Custom roots | `skillRoots` / explicit `bundledSkillDir` → skill-filesystem `customSkillDirs` / `bundledSkillDir` entries (explicit values win) | Local development / tests / deployments with a different mirror |

The packaged mirror is a **single canonical mount**: skill content lives once in the repo-root `skills/` mirror and is synced into the package (like opencode's `harness-skills/`), so mstar skills stay standalone-usable everywhere. No double-loading: the opencode plugin ships the same skills in its own package, so dsh must mount them ONLY through this single skill-filesystem path.

Dev-time reality: the `@deepseek-ai/dsh-skill-filesystem` runtime is a peer-stub (contract-mirroring registration, no file watcher), so the mount is verified through real composition against the stub + the actual mirror `skills/` frontmatter (engine `lintSkillFrontmatter`); real-runtime composition (real seam packages, watcher, `$DSH_BUNDLED_SKILL_DIR` env flow) is the deployment target, not covered by this package's suite.

## Commands

The plugin registers the bundled mstar commands (omp/opencode parity surface) on `ctx.commands`: `harness-commands/*.md` — the repo-root `commands/` mirror (`iteration-start`, `iteration-drive`, `iteration-loop`, `codebase-audit`) synced by `bundle-assets` at build time (gitignored). Each registration reads the command's `name`/`description`/`input` frontmatter; a declared `input` hint is advertised as `input.hint`, which flips the dsh web client's decision table from detached bare execution to a leadingInput **claim** — the menu pick inserts `/name ` into the composer (command-colored token, the hint as ghost text) and the line submits only on Enter, so the user can type follow-up args (the `/plan` / `/goal` / `/advisor` interaction). The handler **steers the command body into the receiving agent as a USER-source message** (the dsh-plan-mode command precedent — `source: { kind: 'user' }`, so the model treats the body as a task to execute, not injected context; the dsh-commands "explicitly schedule model-visible work through the receiving Agent" path), appending the user's typed args as a `## User input` section when present, and returns a success result. Registration is deferred with `ctx.inject(['commands'], …)` — the same optional-unit pattern as the tools — so the plugin boots without the commands service; an absent mirror (no `bundle-assets` run) registers nothing.

## Native command surface

The writable mstar command surface on this host is the **MCP route**: ONE shared `mstar-mcp` connection for the whole host (the bundle row — § Shared MCP connection), publishing one tool per command family (`mcp__mstar__mstar_<family>` with an `action` argument). That connection carries **no identity of its own**, but the shipped row opts in with `--trust-caller-session-id`, so an operation that needs a session identity passes `sessionId` on it (a connection launched without the flag publishes no selector and refuses one). The three dsh-native tools below are reserved for what this MCP surface cannot do — plugin-local state it cannot write, or a capability it does not publish — and there the identity is `exec.agent.id`.

**The membership rule** — memorize it instead of a list: a command is a dsh-native tool only when it

1. **produces a dsh-local durable record the MCP route cannot write**, or
2. **exposes a capability the MCP surface does not publish at all**.

Exactly **three** tools satisfy the rule today:

- **`mstar_plan_bind`** — rule 1. It binds the engine coordinator row *and* persists this plugin's own durable state: the session's `executionBinding` slot in the control root's `store.db` plus the in-process adoption receipt the workflow-ledger attribution resolver and `mstar_execution_clear` read. Shape: the shared `plan.bind` parameters mirrored mechanically from the published schema (identity from `exec.agent.id`), engine refusals returned verbatim, a known leaf seat refused fail-closed before admission. The MCP `action: "bind"` route binds the engine row and stops there — the two routes are **not** equivalent.
- **`mstar_audit_validate`** — rule 2. The review-report credential scan (`mstar-audit` Hard Rule 4, the validator behind `mstar audit scaffold`); the `mstar_audit` family publishes `scaffold` / `secret-scan` / `supply-chain`, none of which validates an existing report file.
- **`mstar_execution_clear`** — rule 2. It clears that same dsh-local `executionBinding` slot, and there is no shared `execution.clear` command for the MCP route to carry. No parameters at all: identity comes from `exec.agent.id`, so only the caller's own binding is reachable and the user's workflow selection plus exclusion floor are preserved; a known leaf seat is refused fail-closed before the store read. Its refusals (`execution.clear.no-harness` / `no-binding` / `store-refused`) name the cause and the recovery.

Every other runtime command is MCP — `store.*` commands are CLI-only and are not published here — and a former `mstar_<family>_<action>` tool name is not resurrected by an alias: call the family with its `action`, and read a family's real actions and fields with `mcp__mstar__mstar_schema` (`family: <name>`, or `command: <command-id>` for one leaf contract). Identity, admission and the fail-closed leaf-seat refusal on this surface follow the ADR `docs/adr/dsh-native-identity-channels.md`.

**The leaf seat refuses CLASSES, not a command list.** A call is refused for a leaf only when it would establish or replace a coordinator seat (bind or complete a plan, recover a session, launch a child under the caller's verified live binding), or write workflow-scope delivery, lifecycle, adoption or coordinator-ledger state — the two classes the CLI `mstar mcp --seat` help names. The set is derived once in `packages/commands/src/coordinator-seat.ts` (the CLI server's `--seat leaf` filter) and mirrored by `packages/dsh/src/gates/coordinator-seat.ts` for this host's `tools/pre-execute` guard, so it follows the command layer instead of drifting command by command: a new `workflow`-family action is refused for a leaf the moment it is published, and any other new seat command is added once in `coordinator-seat.ts` so both guards follow. The plan-row work a leaf does run — `plan.prepare` / `plan.progress` / `issue.*` / `sdd.*` — is not refused here.

### Shared MCP connection (declared control root)

The bundle patch inserts ONE `mstar-mcp` row, and that row is the whole MCP channel for the host: the plugin registers no MCP client of its own, no per-agent mount exists, and a subagent shares the one connection its parent already has. A per-agent instance could not be given per-call arguments anyway (`PreToolDecision` has no argument-rewrite arm), so it would buy no capability — only one Node process per agent.

**The control root is DECLARED, never inferred.** It resolves in one ordered rule, and the launch cwd is never a candidate — that directory is the HOST's, it says nothing about which workspace a caller belongs to, and adopting it would root writes on an unrelated project:

1. the connection pin — `mstar mcp --harness <absolute path>`, else a non-blank `MSTAR_HARNESS_DIR` in the server environment;
2. otherwise the root the admitted CALL names through the tool's `harness` field (an absolute path; a relative selector is refused with the same named cause, because the launch directory never anchors a caller's root);
3. a null root for the commands whose contract reads none — `harness.scaffold` (establishing a root is its own operation) and the root-free class (`schema`, `path.resolve`, `host.*`, `doctor`, and the read-only validators such as `lint` / `skill.lint` / `qc.validate-report`), which only answer from explicit inputs and therefore never resolve an implicit harness path;
4. otherwise the call is refused with `[mcp.control-root-unresolved]`, naming the cause and every recovery — the two launcher recoveries apply to every command, while the per-call `harness` selector is tool-dependent (a command that does not publish the field cannot accept it).

A pin beats a per-call `harness`, so a caller can never root a call on a workspace the launcher did not declare; the root the call actually used also anchors the invocation workspace at its parent directory, so cwd-derived paths land under that harness rather than the launch cwd. On an **unpinned** connection the root SELECTOR a command DECLARES is **REQUIRED** on every tool whose root is not otherwise fixed — `harness` where the command names its root through that field, `controlRoot` for `sdd.workspace` — so a model cannot omit the one fact the resolution needs and `tools/list` never advertises as optional a field the resolver refuses to do without. A relative path argument of a read-only validator (`review.seats`, `worktree.qc-alignment`, `lint`, `skill.lint`, `roles.validate`, `design-md.validate`, `compound.validate`, `dispatch.validate`, `qc.validate-report`) resolves against the DECLARED workspace, so `--workspace /caller` reads `/caller`'s files instead of the host checkout's; with no declared workspace a relative one is refused.

**No connection identity of its own; the shipped row trusts a caller-declared `sessionId`.** The shared connection carries none, and the MCP-only identity wiring is gone: no `--identity-env`, no declared-identity lock, no selector stripping and no connection-wide default session id. The per-call `sessionId` selector is published only on a connection whose launcher opted in with `mstar mcp --trust-caller-session-id`; the shipped row passes it, and a connection launched without it refuses a supplied id with `mcp.caller-identity-unavailable`. On an opted-in connection the value is a bearer identity: `executionContextFor` turns it into `context.caller`, the engine resolves the caller's OWN coordinator binding from it, so knowing a live session id is enough to act as that session — while authorization stays that binding row plus the optional `--expect` CAS token. An operation that needs a session identity runs on **this** connection by passing `sessionId` — `plan progress`, `plan complete`, `workflow register/evidence/phase`, `session recover`, `workflow-note.append` included. The three dsh-native tools listed above are reserved for what this MCP surface cannot do, and there identity is `exec.agent.id` — a host fact, never a model-supplied field. A connection launched without the flag has no caller-declared channel, so there the route is a native tool or the CLI.

## Engine seam mapping

Every engine module attaches to a dsh surface — delivered except the lint module's plan/tdd fs gates (deferred; see Known Limitations):

| Engine module | dsh seam | Status |
|---|---|---|
| core (applyEnforcement, GateResult/Severity) | cross-cutting veto/reject | delivered (P1) |
| path (resolveHarnessDir) | harness-dir probing + `{HARNESS_DIR}/status.json` target matching | delivered (P1) |
| status (validateStatus, validateResidual, findingsCleanupGate) | `fs/write-intent` + `fs/edit-intent` on status.json | delivered (P1) |
| lease (verifyPlanExecutionLease, validateIntegrationMergeLease) | exec lease: `tools/pre-execute` (inside the dispatch gate); merge lease: `HostAdapter.beforeMerge` | delivered (P1 exec / P3 merge) |
| dispatch (composeDispatchGate, isReadOnlyAssignmentRole, parseAssignmentFields) | `tools/pre-execute` on the subagent tool (`PreToolDecision.deny` to block); `agent/pre-step` advisory | delivered (P1) |
| host (resolveSkillRoot, HostAdapter) | engine host.ts detection row + plugin adapter (`host: 'dsh'`) | delivered (P2) |
| skill-authoring (lintFrontmatter, lintFiveQuestion) | skill-filesystem roots + `fs/write-intent` on SKILL.md | delivered (P2) |
| lint (lintSkillFrontmatter, planQualityBar, assertSddTddTriple) | not wired — plan/tdd fs gates are a deferral; `lintSkillFrontmatter` runs only in the skills-mount test suite | deferred |
| agent catalog | producer-owned `mstar-engine` catalog source (the anchor) + `dsh_status_emissions` (model-visible ⟺ logged); the panel reads the store, not the emission | delivered (P2) |
| sdd (sddWorkspace, taskBrief) | MCP family `mstar_sdd` (`workspace` / `task-brief`) — no dsh-native wrapper | delivered (P3) |
| iteration (evaluatePhaseGate, parseCompassFrontmatter) | `agent/pre-step` + iteration gate | delivered (P3) |
| worktree (l1PreDispatchCheck, l2PreDispatchCheck) | `tools/pre-execute` L1/L2 (inside the dispatch gate) | delivered (P3) |
| design-md / audit / compound / roles | `fs/write-intent` seams + the one native `mstar_audit_validate`; the rest are MCP families | delivered (P3) |

## Engine-status catalog

An advisory `agent/pre-step` waterfall listener appends ONE **`mstar-engine`** catalog MessageSource to a composed step **when the row is emitted** — the producer-owned `mstar-engine` kind, exactly `{ kind: 'mstar-engine', form: 'catalog' }` and **no other member** (the dsh producer-owned source contract): the model-visible `<mstar_engine_status>` block is a **projection** of the payload (`renderEngineStatusCatalog`) and renders ONE **delta line** — `workflow: <id> (<kind>) | plans: <non-Done rows> | branch: <base> → <target> | gate: <verdict> (<transition>)` — carrying the selected lifecycle, its non-Done plan rows, the resolved branch anchors and, when a steering compass gated the iteration, the phase-gate verdict (a `FAIL` carries its violation codes; a bare verdict would name no cause). Everything else the payload carries is deliberately **NOT** in the row: the **residuals** rollup and its detail rows, the **branch policy**, the **spec-integration** anchor, each plan row's **row scope** (a recorded scope, never an ownership claim or a lease), the **knowledge** digest, the compass **direction**, the **agent-flow** ledger, the former iteration/transition history and the watermark trio. Those facts stay in `MstarEngineStatusPayload` (the row's own source) and in the engine authorities behind them — `mstar status`, `mstar roadmap show`, `mstar plan show`, the compass document, `{KNOWLEDGE_DIR}` and `dsh_status_emissions` — so the row is a change notice, never the authority. The **watermark is payload-only**: **mstar version** (plugin own manifest; the single-version invariant pins the bundled engine to the same version), **harness dir** (resolved `{HARNESS_DIR}`, `none` when absent) and **enforcement** (compass mode, `soft` / `hard (compass)`) stay in `MstarEngineStatusPayload` — the panel meta dock renders version + harness dir — and stay model-visible once in the always-on system prompt (`mstar:engine-status` digest + `mstar:harness-rules`), so the row never repeats them. **Fallback composition:** while no prompt registration is CONFIRMED live — the host provides no `system-prompt` service, the asynchronous registration fails (a `true` return only means the inject child was scheduled), or a live registration is disposed — the listener's per-step `showWatermark` predicate makes the row re-render the trio itself, so the version / harness dir / enforcement facts are never lost (a registration that lands later simply stops the fallback). The listener calls `next()` first and builds on the delegated decision — it never vetoes a step and never replaces the composed messages. When no lifecycle is selected the row renders `workflow selection: ERROR (<code>) <message>` in place of the state lines (those aggregates are empty by construction and must not read as "no plans"), and that message no longer points at a retired `status.json` path — it names the cause and the real recovery commands, `mstar workflow register` for a plan or `mstar iteration register` for an iteration (selecting an already-registered lifecycle for this session is the other way out of that state). Model-visible ⟺ logged: the persisted source carries no facts — the row is the durable **anchor** and the exact emitted payload is persisted per session as the newest row of the control-root `store.db` table `dsh_status_emissions` at this same emission, so the session log plus that store reconstruct the row without re-parsing the block (dsh packages/AGENTS.md). dsh session-format V4 refuses the retired `{ kind: 'plugin', plugin }` wrapper at message admission, so nothing but the producer-owned kind is ever written there. **Anchor kind (renamed, with read compat)**: the emitted kind is `mstar-engine` (the pre-rename identity was `mstar-engine-status`); rows emitted by released builds persist the old `plugin` wrapper in their V3 session logs, and the dsh V3→V4 migration lifts it to `plugin:mstar-engine` (or `plugin:mstar-engine-status` for the pre-rename identity), which a released-build log may still carry — the persisted row is the model-visible ANCHOR, and the panel no longer reads it: the workflow panel's data path is the store-backed `mstar/panelSnapshot` (see § Web client plugin), so the emission reader this package used to serve (`mstar/engineStatus`) is retired and only the picker's `mstar/selectWorkflow` write remains on that gateway. The panel half reaches the host over the host's shared `/api` typert gateway: the **host gateway owns the route** (a plugin cannot register one; a plain `connection.rpc.handle` channel mounts through `webServer` on the calling fiber and would pend this row's boot — the mechanism this package deliberately does not use) and this package contributes its descriptors through an optional `ctx.typert.register(...)` child. **Trust boundary, stated plainly:** the endpoints authenticate nothing of their own — the transport fence (host/origin + browser auth) establishes only that the caller is a page this host served, so *possession of a `(sessionId, cwd)` pair plus reachability of the local `/api` gateway is the capability*. An answer is scoped to the REQUEST: the lookup is keyed by the asserted id, the session is resolved SERVER-side, and the asserted `cwd` must equal both the resolved session cwd and the record the answer describes — so one session's request can never be served another session's data. The payload is a workspace digest (version, harness dir, enforcement, plan/residual/row-scope counters) that the panel's own session transcript already exposes; it is not treated as a secret, and the distinct `unavailable` reasons make the endpoint a weak session-existence oracle for a caller who already holds the id. Fiber disposal removes the listener (HMR-safe).

Emission is **change-driven, not turn-driven**: per session+workspace the row is appended on the first emission, then only when its rendered text or the panel-relevant payload projection changed (the projection normalizes the store revision, because the emission's own store write advances it — comparing raw payloads would read that side effect as a change and re-emit every step) — a 20-step turn shows the catalog once, not 20 times, and a 20-turn unchanged session no longer accumulates an identical copy per turn. The start of a turn is never a trigger, so **no resolved `{HARNESS_DIR}` means no row at all** (the block would be an empty wrapper) and the panel shows its `waiting` state. Two consequences are worth stating: the emitted block is a **projection** of the payload (the watermark trio is not rendered, see above), and the persisted payload is written at this same gate — so the panel's stored emission is **the last payload the model saw**, whose freshness footer `turn` / `at` mean *last emission*, not current turn; whenever nothing is emitted the stored row is still the current state. One explicit re-anchor path remains: a picker commit evicts that session's digest, so the next step re-emits even when the text is unchanged. **Known limitation:** the row is not periodically re-anchored, so after host-side context compaction it may be absent until the next change — the always-on system-prompt digest still carries the version, the active workflow and its non-Done plans. The source shares ONE per-workspace cache entry, built at boot for an explicit `harnessDir` (else on the workspace's first pre-step) and TTL-refreshed (`catalogTtlMs`, default 60 s) — the hot path is a timestamp compare + Map lookup between refreshes, and a mid-session plan/compass/residual change lands within one interval.

## Agent-flow ledger

The agent-flow ledger lives in the existing control-root `store.db` host domain, not a workflow JSONL file. Catalog and panel windows are bounded read projections; they do not prune stored events. Before ACTIVE authority, native dsh session logging continues and authority persistence reports unavailable/degraded with supported `store init` / `store upgrade` recovery, never fake success or a legacy-file fallback. Actual dispatch and settle evidence remains advisory and try/catch-contained: an unavailable ledger never blocks a dispatch or settle.

- **Record identity** — verified native workflow events retain `{sessionId, streamId, seq}` and `wfe1:<kind>:<sessionId>:<streamId>:<seq>`. The stream incarnation derives from the durable native session header, never the store epoch or file mtime. Live tool-call rows may carry `wfc1:<sessionId>:<callId>:<kind>` for correlation when both IDs are known; missing IDs are not fabricated, and live rows may repeat.
- **Dispatch** — one row per Assignment-shaped dispatch, recording the dispatch identity: `role` (normalized at the write boundary — trimmed, with ONE leading `@` stripped, so `@explore` and `explore` are one actor, not two), `planId`, the Assignment `Task N` tag as `taskId`, `taskCategory`, and the verdict.
- **Settle** — recorded ONLY for a REAL paired completion. A foreground call settles in the `tools/post-execute` listener; a `{ kind: 'background', jobId }` result is paired on the registry **`jobId`** (a jobs-registry key, never a child session id) and settles when `ctx.inject(['jobs'])` → `jobs.events.subscribe` emits the terminal `settled` event (`completed → ok` / `killed → denied` / `failed → error`, `durationMs` when available). Every paired settle carries the dispatch identity (the `Task N` tag stays `taskId`; `taskRef` is reserved for the registry job id and rides on a background settle only) plus an OPTIONAL `childId` — a foreground `runId`, or a background child id the catalog join already supplied. A missing or oversized optional id omits the FIELD only: the real completion still records, and an id is never truncated or re-keyed. Unpaired payloads record NOTHING — never a fabricated settle.
- **`subagent-link` (nonterminal)** — the child session ID is observed from the parent-owned `subagent/catalog` event and joined within the dispatch's apply-scoped call window. It records identity, not completion; no `outcome`, `verdict` or `paired` marker is fabricated. Missing catalog evidence leaves no link row.
- **Native storage** — events, accepted source identities, monotone scan bounds, session bindings and newest status emissions use `dsh_ledger_events`, `dsh_accepted_identities`, `dsh_scan_bounds`, `dsh_session_bindings` and `dsh_status_emissions`. No shared JSONL tail/index/cursor/cache authority, file compaction, freeze or lock remains. Legacy file bytes are retained as read-only one-time upgrade inputs/history.

### Workflow rows

The same ledger records **workflow / ralph fan-out runs** from durable `tool-workflow/*` events in the calling parent's native session log, not in-memory `workflow/*` emits. Cold scans and the live `session/event` listener consume verified source positions. Event append, accepted-identity/digest check and scan-bound advance commit together in one native transaction.

| `tool-workflow/*` event | Ledger row | Fields |
| --- | --- | --- |
| `run-start` | `workflow-run` | `runId`, `name`, `agent?` (the carrying parent session id) |
| `agent-start` | `workflow-agent` | `runId`, `seq` (1-based member sequence), `label`, `phase?`, `childId` |
| `run-end` | `workflow-run-end` | `runId`, `stopReason` (`completed` / `cancelled` / `error`) |

`tool-workflow/agent-end` is upstream member bookkeeping with **no ledger kind** (member `outcome` is intentionally not persisted). Optional fields stay omitted when absent. Existing display-field length caps and identity-size validation remain: oversized display values truncate with a marker, while oversized `runId` / `childId` skips the row rather than creating identity collisions. Read-window limits are projections, not storage truncation.

A FOURTH kind, **`workflow-verdict`**, is written by the workflow/ralph GATE (not this consumer) — one row per gated call (`tool`, `workflow`/`objective`, `mode`, verdict `ok`/`advisory`/`denied`/`ask`, violation `code`) — see Gates → Workflow / ralph gate. Display identity fields (`workflow` / `objective`) carry the same 1024-char cap; the verdict's violation code is never guessed (P-a `workflow.name.unknown` vs P-b `workflow.lease.uncovered`).

**Accepted source replay.** Verified native workflow event IDs are accepted once through the database identity/digest domain, including cold/live overlap and plugin restarts; different bytes under an accepted ID refuse without overwriting it. Scan bounds are monotone within a verified stream incarnation. A session with an unreadable header records no accepted event rather than inventing an incarnation. Constructor-seeded sessions are scanned on `session/created`; fork scans start after `inheritedEventCount`, preserving parent attribution. Live dispatch/settle/link/verdict rows may repeat: correlation IDs do not make them accepted-operation authority. Missing, staged, corrupt or schema-refused authority remains unavailable; a true addressed no-row status answer stays distinct and preserves native refusal causes/recovery.

**childId linkage + member counts.** The `workflow-agent` row preserves the published member's `childId` (the child session id); the run's display `name` lives on the `workflow-run` row only, and the panel resolves it for agent/end rows via the window lookup (same `runId` — a member row itself carries no name). The panel attaches the member COUNT to the `workflow-run` row (the window's `workflow-agent` rows for that `runId`; window-bound — members truncated out of the ≤50-event window are honestly absent, never a 0 guess).

**Depth advisory (observe-time).** On `agent-start`, the consumer resolves the child session via `sessions.get(childId)` and warns when its `header.delegationDepth` is ≥ 2 — ONCE per run (per-runId latch), logger `mstar/workflow-ledger`. Observe-time only, **never a refusal path**: a throwing child read degrades the advisory, never the row or the run.

**No-behavior-change guarantee.** The consumer is observe-only: ZERO gating — every read and append is try/catch-contained; a failing ledger write never crashes or alters a workflow run; a throwing session read logs one warn and the pass continues. The `sessions` service is read STRUCTURALLY via `ctx.get('sessions')` — no runtime dependency on `@deepseek-ai/dsh-session`.

**Mount-order note.** The consumer activates only when the `sessions` service is available at apply — the **dsh-session row must mount BEFORE the mstar row** (the standard `web` profile order does). A composition where dsh-session mounts after the plugin (or is absent) degrades **silently**: ONE debug log (`sessions service absent — workflow-ledger consumer disabled`) and no rows are recorded — never an error, never a broken run.

**Panel visibility.** The three workflow rows render in the **事件记录 (Event Log) tab**'s single merged flow through the existing event-row chrome (no redesign): the summary identity is the run NAME (agent/end rows resolve it via the window lookup; fallback runId → 「未知」), the detail body adds four workflow fields — run-id / name / members / stop-reason (missing → 「—」) — and the expected/settled seats render 「—」 (a workflow row is not a role dispatch — no settle pairing exists, same precedent as settle rows). Unknown kind strings render as GENERIC rows (verbatim kind, no workflow fields) — never dropped, never guessed. The catalog summary counts workflow rows as a DISTINCT `workflow` bucket (`by role: workflow N` in the model-facing line) — never folded into dispatch-role counts.

## Web client plugin (workflow panel)

The package ships a browser client half for the dsh **web** profile, discovered
automatically on the already-installed `mstar` bundle row (package.json
`dsh.client` declaration + `exports["./client"]` → `dist/client.js` — the
upstream web `dsh.client` discovery scans loader entries and resolves each
client's `exports["./client"]` into the boot graph) — **no separate profile
layer or install step** (spec §6.1). The web app serves the bundle at
`/plugins/@mstar-harness/dsh/client.js` and loads it through the
closure-factory loader handoff (`window.__ModuleLoader__.load({ id, factory })`).

The client entry registers the panel as a **right-Sidebar page tab type**
through the public two-stage seat contract: `ctx.sidebarRightTabs.register(definition)`
with `id: '@mstar-harness/dsh'`, `kind: 'mstar-workflow'` (a page type — no
`patterns`/`canOpen`/`priority`, opened by kind), a locale-following `title()`
thunk, and exactly one **guide-page capsule** (`order: 20`, description + the
MStar glyph icon) — picking the capsule opens the panel in that pane's slot
(replacing the guide tab, expanding the column), and a second pick focuses the
existing tab (the host's page dedup rule) — no auto-open, no duplicate surface.
The old **`conversation.view`** view-ring tab is **removed** (a migration, not
a second surface): the sidebar tab replaces the conversation-area tab. The
body and its chip title register as keyed seats under the same id
(`sidebar.right.pane.tab` + `sidebar.right.pane.tab.title`; the chip is the
glyph + a title captured at open time — it does not follow a mid-session
locale switch). The body renders **nothing** while `tab.visible === false`
(collapsed column or a sibling pane tab active — no projection, no DOM), and
the selected section lives in the entry's slot store keyed by the tab record,
so it survives the docked body's unmount. Labels come from the `mstar-panel`
locale namespace: **"Morning Star Workflow"** (en) / **"晨星工作流"** (zh).

The panel renders the **control-root `store.db`**, not the model's last
emission. The host half composes five engine dashboard views — `workflow-detail`,
`iteration-detail`, `roadmap`, `issues`, `projects` — **sequentially** (the
store read layer may refresh projections, so two views never overlap) into one
`PanelSnapshot`, served on `/api/mstar/panelSnapshot`; the browser half polls it
while the tab is visible. The retired `mstar/engineStatus` read method is gone —
the `mstar` gateway keeps only the picker's durable write
(`mstar/selectWorkflow`).

**Poll contract** (`panel-snapshot-client.ts`): 5 s while the tab is visible, at
most **one** request in flight (a slow answer never stacks a queue), a 5 s
deadline per request, the last good snapshot kept on screen while a refresh is
out (no flicker), an immediate refetch on a new connection generation, and
nothing at all while the tab is not visible. The deadline is a real
cancellation: the carrier's `AbortSignal` reaches the host read, which checks it
before every view, so a timed-out request stops paying for store reads and
projection captures instead of completing unpaid.

**The client sends `{ sessionId, cwd }` and nothing else.** The workflow (the
session's durable picker record, falling back to the store's single ACTIVE
lifecycle), the iteration and the project (`_default`, else the single
registered project) are resolved SERVER-side on every read. An asserted id is
still accepted and still shape-validated, but the harness root always comes from
the resolved session.

**Three states per view, never a flattened empty**: `ok` (the authority
answered — `data: null` still means "nothing here"), `not-applicable` (nothing
was read: no target resolved) and `unavailable` (the read failed, carrying the
store's own message verbatim). The whole snapshot is `unavailable` only when no
view reached the authority. A workspace with no resolvable `{HARNESS_DIR}` is the
separate `no-harness` kind — an inactive workspace, not a store failure, so the
panel renders its own copy instead of a wire token.

**Two freshness domains, both disclosed**: `PanelSnapshot.at` is the store-read
instant; `PanelSnapshot.retained.at` is when the catalog payload was BUILT. The
three `retained` facts — the iteration gate, the knowledge digest and the
resolved workflow selection — are the ones no dashboard DTO owns, and the panel
REUSES them from the apply-scoped catalog cache (the pre-step's own entry, key
and TTL) instead of re-deriving them. The freshness footer therefore prints both
(`snapshot HH:MM:SS` and, when the cache answered, `catalog facts HH:MM:SS`), so
a catalog fact that is older than the snapshot is visible rather than implied.

The **narrow-column layout** is a single flex column bound to the sidebar
pane's definite height with exactly three zones — the **section nav**
(任务迭代 / 项目路线图 / 事件记录, flex: none), the panel-owned **single scroll
body** (`[data-mstar-scroll]` — the ONLY `overflow-y` element in the panel; no
element scrolls horizontally; `data-mstar-graph` rides it), and the pinned
**meta dock** (version + harness dir; never scrolls). The workspace-state
digest (plans ≤5 time-desc + `+N more`, open residual findings ≤10 with
severity chips, policy with **enforcement first** then push / worktree /
control worktree, leases, knowledge, direction) sits IN FLOW at the end of
the scroll body — the fixed 300px sibling column and its nested scroller are
gone — and the freshness footer closes it. The host composer-overlay opt-in is
no longer needed (the sidebar pane body is a definite-height box) and the
obsolete viewport media queries are deleted: the shell carries
`container-type: inline-size` and the width rules are **container queries** —
below 480px container width the padding and group gap tighten (compact rhythm at
the 300px floor); at ≥720px the shared group grid spreads to two columns
(`repeat(auto-fit, minmax(280px, 1fr))`) — the only structural change any
width makes (one DOM, one tree; no JS layout measurement). Missing fields
degrade to explicit empty/last-known states (muted, never orange warn boxes);
`waiting` keeps the muted hint; no harness renders the centered inactive-state
card that activates automatically on detection.

The three sections stack in the single scroll body. **任务迭代** renders the
iteration head (collapsed summary when inactive) + the **vertical** 5-step
stepper (one row per step — badge · phase · chip · reserved verdict seat; the
four-state `current` / `next` / `done` / `idle` machine preserved: every step
BEFORE the current one projects `done`「已完成」, `next` is the single forward
target, `idle` is schema-only; Step 1 is the current step while the steering
compass is `status: active` — no PASS/FAIL badge — and Step 5 can never be
current) + the branch panel (iteration base / target / spec integration,
rendered only while active) + the plan board as **five stacked status
groups** in constant order — Todo / InProgress / InReview / Done / the merged
「受阻/未知」/「Blocked / Unknown」column — with every `data-kanban-column` /
`data-kanban-arrow` / `data-kanban-count` anchor preserved; each group caps
its rendered rows at `PLAN_CAP` with the clickable 「更多」/「收起」 expander
(`data-kanban-more`) unfolding the full column (the projection keeps ALL plan
rows — the cap is a render concern, never a discard) — then the project
rollup. **项目路线图** renders the project authority's direction, goals and
milestone↔issue membership (`data-roadmap-*` anchors, the project authority's
revision + content hash in its header) and distinguishes FOUR absence states —
no project resolved, no roadmap row, no milestones, read unavailable — each on
its own anchor, so an empty roadmap never looks like a failed read. **事件记录**
renders **ONE** time-descending flow mixing dispatch / settle / violation rows
(the former two partitions are a single merged flow — no partition-owned
scrollers) — every row an expandable native `<details>` carrying the full
catalog fields (a missing field renders 「—」, never a guessed value; the
workflow-run rows keep their name / member-count / stop-reason fields), and an
unreadable ledger is a different state from an empty one. The workflow picker
(「工作流选择」) is never optimistic: a commit posts to `mstar/selectWorkflow`,
lands as this session's `pending` → `selected` / `failed` state, and the
selection it renders comes from the next snapshot's `retained.selection` (the
host rebuilds that from the same durable binding). The **iteration info section
is shared by the tasks AND roadmap pages** — one `IterationInfoSection`
component. Projection is the pure `projectGraph(snapshot)` function (schema
constants strictly separated from catalog evidence; never throws).

**Dependency**: the panel's client bundle carries **no graph library** — the
`@xyflow/react` devDependency (previously inlined into `dist/client.js` at
build time) was removed with the react-flow rendering layer, and the
plain-`.css` text loader whose only consumer was
`@xyflow/react/dist/style.css` is gone too (`CLIENT_EXTERNALS`
is unchanged — react / react-dom and the `@deepseek-ai/dsh-client-*` platform
modules stay external). The build script asserts the removal end to end: the
emitted bundle must contain **no `xyflow`/`reactflow` markers**, zero
`@deepseek-ai/*` value imports, and **no `import.meta` / ESM statements** —
the web loader executes plugin bundles as classic `<script>`s, where a
literal `import.meta` is a parse-time SyntaxError (a zustand v4
`import.meta.env` read is defined away at build; see the iteration
install-verification guide §6). Current bundle size: **143,686 B
raw / 28,890 B gzip** (re-measure per the iteration install-verification
guide — the bundle shrank to ~85 KB when react-flow was removed and grew
back with the agents page's entity rendering, then again with the
emphasis-tier styling).

Install / verify (the client half rides the same bundle-row install as the
server half):

```sh
cd <repo>/packages/dsh
bun run build               # dist/client.js (closure-factory CJS) + dist/client.d.ts
# corepack machines (repo root declares packageManager: bun): prefix with COREPACK_ENABLE_PROJECT_SPEC=0
dsh plugin --profile web add <abs packages/dsh path>   # same profile bundle install
dsh web                     # boot → /plugins/@mstar-harness/dsh/client.js served
```

Verified locally (install-verification guide): the boot graph contains the
client entry (`@mstar-harness/dsh` with the declared inject faces), the
`/plugins/<id>/client.js` route serves the exact built bundle (rev = content
sha1), and the browser handoff materializes the plugin entry (`inject` +
`apply` + CSS injection under classic-script semantics) — see the
`install-verification.md` guide of the panel-beautify iteration (local harness root).

**Known Limitations** (this iteration): the iteration stepper's Step 1
(iteration-start) IS the current step while the steering compass is
`status: active` (Phase 1 in flight — catalog `compassStatus` field), carrying
NO PASS/FAIL badge (Phase 1 has no gate verdict); Step 5 (merge-ready) can
never be the **current** step —
the engine phase gate only evaluates Phase 2→3→4 (merge-ready is never a gate
transition); it renders `next` only while Step 4 (pr-delivery) is current, idle
otherwise;
the current step follows the TTL-refreshed `compassStatus` — up to one catalog
interval (60 s) behind a mid-session `active`→`locked` flip (bounded,
documented staleness, never a wrong verdict);
a store read happens every 5 s while the tab is visible (five sequential
dashboard views on the host; a collapsed tab reads nothing); a cold or expired
catalog cache makes the panel REBUILD the payload — the pre-step's own rule,
TTL-bounded, so at most once a minute per open panel — and that build may
refresh projections, which is why the retained read runs AFTER the five views
and never beside them; the retained facts can therefore lag the store read by up
to one catalog interval (60 s), which `retained.at` discloses instead of hiding;
the engine-status emission still writes `dsh_status_emissions` on change (the
model-visible anchor), and a resumed session shows the anchor again on its first
composed step after an app restart — the digest is in-memory — and thereafter
only when the row changed); the sidebar chip title is captured at open time (a
mid-session locale switch does not flip it — accepted for glyph parity with
first-party chips); a docked body renders nothing while the column is
collapsed or another pane tab is active (`tab.visible === false` — no
projection, no DOM, zero per-snapshot cost while hidden). Panel acceptance is
dual-track: in-loop browser harness
verification against the rebuilt bundle plus user-restart final GUI acceptance —
rerun steps in the install-verification guide §8.

## Development

Commands (from `packages/dsh`): the coverage gate is per-file 100% on `src/` (dsh testing policy); the build bun-bundles the src entries into `dist/` (engine + schemastery inlined; `@deepseek-ai/cordis` and the runtime seam imports — `@deepseek-ai/dsh-skill-filesystem`, `@deepseek-ai/dsh-tools` (`defineTool`), `@deepseek-ai/dsh-llm` — external), runs `build-client` (`scripts/build-client-bundle.ts` — the closure-factory CJS browser bundle per spec §6.2, `dist/client.js`) and emits tsc declarations.

```sh
bun test --coverage
bunx tsc --noEmit
bun run build
```

`bun run test` builds the client bundle first (the `pretest` hook runs
`build-client` — the manifest-contract suite asserts `dist/client.js` exists);
a direct `bun test` on a fresh checkout fails with a `bun run build` hint
instead of a bare assertion.

The dev-time seam surfaces (types, event shapes, runtimes) are the REAL `@deepseek-ai/dsh-*` packages, installed from the public npm registry (`registry.npmjs.org`, no root `.npmrc` needed — bun auto-installs peers by default).

## Model Experience

### Request surface and condition

#### What the model sees

A composed step carries one `mstar-engine` catalog user message (the `<mstar_engine_status>` block — see the Engine-status catalog section) **when the row is emitted**: on the first emission and on change, never on the mere start of a turn, and never at all in a workspace with no resolved `{HARNESS_DIR}`. The block is a projection of the payload, so the version / harness dir / enforcement watermark is not repeated in it — the always-on system prompt already carries those (a composition without the `system-prompt` service falls back to the row carrying the trio itself). Gate decisions add: the dispatch veto as the registry-materialized `PreToolDecision { kind: 'deny', reason }` error; the status gate as the `mstar/status-gate` advisory (warn pass, hard-mode repair escape, or degraded allow); the dispatch gate as the `mstar/dispatch-gate` advisory (warn pass or degraded); the skill lint gate as the `mstar/skill-lint` advisory (warn pass, hard-mode repair escape, or degraded allow). Every model-visible row is reconstructable from the session log (catalog-form sources + advisory events).

**Leaf delivery discipline (PM 2026-08-12):** leaf subagents hand back their Completion Report in the **final (closing) message**, not via the `report` tool — the dsh tool-subagent-report default `reportDelivery: quiet` routes a report into the parent's next-step queue, where it strands when the parent's turn has ended (no step boundary follows). The closing message is the guaranteed delivery channel; reserve `report` for mid-turn findings that change what the parent should do next (SSOT: `skills/mstar-host/references/dsh.md` → PM dispatch).

#### Token effect

The catalog appends one fixed, stable user message **when the row is emitted** (small constant block — no growth with session length: the per-session emission digest suppresses an unchanged row, so a long idle session accumulates no copies). Veto and advisory text exists only when a gate fires.

#### KV Cache effect

The catalog row is appended at the END of the composed step messages, after delegation — the request prefix (system prompt + prior messages) is untouched, so prefix cache state is neither created nor invalidated by the plugin; an emitted row is byte-identical for an unchanged workspace, and an unchanged row is not re-appended at all (change-driven emission). Tool-error text varies per violation but never participates in the request prefix.

## Known Limitations and Deferred Work

- **Dev-time seams resolve from the npm registry** — the `@deepseek-ai/dsh-*` seams are peerDependencies only (the host provides them at runtime); dev-time typecheck/tests/build resolve them from the public npm registry (`registry.npmjs.org`, no root `.npmrc` needed — bun auto-installs peers by default). **All runtime seam imports are externalized at build time** (`--external @deepseek-ai/cordis / @deepseek-ai/dsh-skill-filesystem / @deepseek-ai/dsh-tools / @deepseek-ai/dsh-llm` — the published `dist/` imports them instead of inlining); the gates are exercised through the exact `ctx.waterfall` dispatch the real registry/fs tools perform. The suite runs against the REAL seam packages from the npm registry — no committed `peer-stubs/` stand-ins, no local link farm.
- **Anti-recursion binding is a ROOT-session identity, never inherited** — dsh exposes no per-agent role on the tool-execution context, so `dispatchBinding` declares the dispatching ROOT session's role (live-editable in the plugin configuration form); unset, the root session reads as `project-manager`. A child session — and a session the gate cannot read — is EMPTY and fails closed whatever the field says, so a leaf cannot dispatch itself into the coordinator seat by configuration. An Assignment with a different `Execute as` cannot be caught as self-recursion, multi-role dispatchers need per-instance plugins, and a coordinator that is not the root session cannot be served by this field (it is read only for a root caller). The unreadable-session path (the exec-less `beforeDispatch` host hook) is reachable ONLY from a host hook that supplies no calling session — in-repo, only tests drive it — while every production dispatch carries its calling agent through the `tools/pre-execute` listener, so the refusal never fires on a production dispatch path; an embedder that wires such a hook must resolve a session before dispatching, since this field is not its recovery. The root read trusts `session.header.parentSession`: a host provider that does not stamp a child's parent would be read as root and receive the coordinator identity.
- **Lease gate diverges from opencode by design** — opencode's `beforeDispatch` runs no lease checks; the dsh lease gate is additive (`lease.dispatch.*` codes) and fires only for writable SDD/InProgress dispatches, so parity covers the field set, not the lease surface.
- **Shared engine composition adopted** — the dispatch gate core is the engine's single `composeDispatchGate` (opencode/omp/CLI parity, so field/branch/anti-recursion violation codes are identical by construction), and the compass frontmatter parser is the engine's shared `parseCompassFrontmatter` (no local fork — nothing left to drift). Both run over the dsh header-region slice; the lease + worktree L1/L2 checks stay dsh-side additions on top.
- **Engine single-version pin** — `@mstar-harness/engine` is an exact `2.1.1` devDependency bundled into `dist/` (never a runtime dependency); `readHarnessVersion()` reads the dsh package manifest next to the bundle — `2.1.1`, equal to the pinned engine by the single-version invariant.
- **Schemastery empty-array materialization** — an omitted optional ARRAY Config key materializes as `[]`; the dispatch keys preserve omission via `.default(undefined)`, and any future optional array key must do the same.
- **Payload boundary** — the dispatch gate validates the delegation payload (Assignment text), not the child's runtime behavior; post-publish observation via `subagent/start` remains an option if model-visible child activity needs surfacing.
- **Status gate is content-blind by seam design** — the `fs/write-intent`/`fs/edit-intent` waterfall carries only `(target, actor)`, never the incoming content, so the write that FIRST corrupts a valid `status.json` passes in BOTH modes (the gate validates the pre-write document only). Hard mode therefore never vetoes status writes: an already-invalid document is allowed as a **repair escape** (error-level advisory with `hard: true, repair: true`) so the repairing write can land. Recovery path: repair the document in place (the gate allows it) or delete `status.json` and let the harness re-create it; monitor hard-mode deployments for `repair: true` advisories.
- **Missing `status.json` lease behavior** — on sdd writable dispatches a missing status file surfaces `lease.dispatch.unverifiable` (advisory in warn, deny under hard); non-SDD dispatches carry no lease obligation and keep the silent degrade-allow.
- **Gate matching follows `displayPath`** — the status gate matches on the resolved `displayPath` of the fs target. A backend reporting workspace-relative paths, a symlinked harness dir, or remote/URI targets never match and the gate is inert for them (no false positives); use absolute local paths for gated harness writes.
- **design-md seam scope is global basename matching** — `isSeamTarget('design-md')` matches any `DESIGN.md` / `DESIGN.dark.md` on the filesystem, regardless of the resolved `{HARNESS_DIR}` / repo root. A write to an unrelated project's DESIGN.md that does not follow the mstar token format therefore logs an error-level repair-escape advisory under hard mode (`hard: true, repair: true`) outside the harness — a noisy false-positive surface (the write is never blocked). Deliberate ("the artifact is the file itself, wherever the design lives"); containing the scope to the repo root when a harness dir resolves is a possible follow-up.
- **audit seam scope needs a resolved `{HARNESS_DIR}` to stay tight** — the scope is markdown under the resolved `{REVIEW_DIR}` (`{HARNESS_DIR}/reviews/`, `.mstarc` `review_dir` aware); with NO resolvable harness dir (an event carrying no session workspace, no configured `harnessDir`) the seam falls back to matching a `reviews` path segment, so an unrelated tree's `reviews/**.md` gets the credential scan on write. Advisory-only, never blocking, and the credential scan is the seam's whole contract — the review surface carries no plan Status block.
- **skill-lint × roles-seam double-fire on `<root>/mstar-roles/SKILL.md`** — when a configured skill root contains the `mstar-roles` dir (the repo-root mirror case in dev, and the bundled mirror in the published form), one write to `mstar-roles/SKILL.md` fires BOTH the skill-authoring lint gate and the roles seam gate (two advisories / two repair-escape logs in hard). Both validators legitimately apply — the double-lint is advisory-only, not a correctness break; the "scopes are disjoint" property holds among the four seams only, not across the skill gate.
- **Content-blind skill-lint blind spots** — the `fs/write-intent` slot carries only `(target, actor)`: first-create incoming content is not linted, and valid→invalid overwrites are not detected on the listener path (it lints the pre-write on-disk document only). Warn/hard advisories surface pre-existing on-disk violations only — the same class of limitation as the status gate.
- **Explicit relative `bundledSkillDir` overrides are cwd-anchored** — skill-filesystem resolves a relative bundled root with plain `join()` semantics against the dsh **process cwd** at boot. The plugin's DEFAULT bundled root is the package's OWN `harness-skills/` mirror resolved package-relative (NOT cwd-anchored — works from any launch cwd); only an explicit RELATIVE override inherits the cwd anchoring, so deployments overriding the default should pass an **absolute path in the profile layer** (see `bundle/README.md`).
- **Bundled mirror is a build-time sync** — `harness-skills/` + `harness-commands/` are produced by `bundle-assets` at build time (repo-root `skills/` + `commands/` mirrors; gitignored). A checkout where `bundle-assets` has not run mounts no bundled skills and registers no commands (the default mount is inert, not an error).
- **Profile-bundle install into the `web` profile: registry and local checkout** — `dsh plugin --profile web add @mstar-harness/dsh` (registry) and `add <local checkout>` are the supported paths; both run through the same pnpm + reconcile mechanism (the reconcile step joins `@mstar-harness/dsh` to `dsh.profile.bundles`). A local checkout needs a prior `bun run build` — the package has no `prepare` script (the monorepo builds packages explicitly), so an unbuilt checkout installs an empty `dist/`.
- **`lintSkillWrite` typed veto not production-wired** — the incoming-document hard veto (`SkillLintVetoError`, code `skill-lint.veto`) is exported and test-covered, but has no production caller yet: the engine `HostAdapter` has no content-carrying skill-write hook (only `beforeStatusWrite`/`beforeDispatch`/`beforeMerge`), and the fs intent slot is content-blind. Wiring lands with a future content-carrying hook; until then the listener path enforces only via the repair-escape advisory (never a veto).
- **CLI host-signal list tracks the engine union** — the CLI `hostSignals` list (`packages/commands/src/families/local.ts`) accepts the same tokens as the engine `ToolSignal` union, including `subagent` and the Agent Teams carriers `spawn_teammate` / `team_task_create`; `mstar host detect --signals subagent` therefore resolves `dsh` instead of rejecting, and an unknown token still returns the usage envelope.
- **Entry is a module index over `src/gates/*`** — `src/index.ts` exposes named exports from the gate modules and retains the plugin manifest, the single cordis augmentation point, command registration, and `apply()` startup wiring. There is no frozen export-count contract. The entry must remain named-export-only because the dsh Loader discards namespace metadata when a default export is present; the service export also carries the `ctx.dshMstar` type augmentation to consumers.
- **Engine dsh rows are upstreaming-destined** — the dsh changes to engine `host.ts` (`DetectResult`, `ToolSignal`, `resolveSkillRoot`) live in the mstar-workflow engine mirror and are intended for a user-authorized upstream PR into mstar-harness; the `mstar-host` skill mirror (§ Detect / § Resolve loaded skill root / `references/dsh.md`) updates with it.
- **Iteration stepper: Step 1 is compass-driven, Step 5 is schema-driven** — the workflow panel's Step 1 (iteration-start) is the current step while the steering compass is `status: active` (Phase 1 in flight — no gate verdict, so no PASS/FAIL badge); Step 5 (merge-ready) is a schema constant the engine gate never lights as current (transition covers Phase 2→3→4 only), so it always renders idle — recorded in the iteration guide, not a defect. The full panel-limitation list lives in the Web client plugin section.
- **`dsh-llm-fallbacks` is an optional dev-time-only dependency** — dsh natively covers subagent customization, so fallbacks is strictly optional: `src/` carries zero imports of it (runtime and type — the consumed surface is the local structural mirror `fallbacks-structural.ts`, kept in sync by the probe's exact-keys drift gate plus the `typecheck:tests` real → view assignability check), `package.json` carries it only under `devDependencies` (type mirroring + the real-package test harness), and `dist/` carries no import and no type reference (only ONE string literal naming the package — the probe's loader-entry match; the advisory logs say `fallbacks`). Activation is a SEPARATE explicit install (two-command contract), never transitive; there is no `--external` guard anymore — a future value import must re-add a runtime dependency by design.
- **Role→model override NOT delivered this batch** — routing a role to a fallbacks `model` (or persona via fallbacks rules) would require rewriting the child's `agentOptions` on the start request, but start-request options are caller-controlled (tool-subagent's own Config; the call's `cwd`/`description`/`prompt` plus the optional preset/route fields, deep-frozen). Awaits upstream `fallbacks-explicit-role-tool` or the N-B1 systemPrompt adoption (roadmap §10.4).
- **Role identity is delivered by preset selection** — a role-matched `startActivation` sets `SubagentStartRequest.agentPreset`, and the selected preset COMPOSES the child (persona via `@deepseek-ai/dsh-persona`, tools, skills); the selection is recorded in the child's log and replayed on resume. dsh 0.2.1 removed the per-start `persona` slot and the `start`/`startContinuable` pair, so there is no persona-only merge any more and no `mstar:role-persona` system-prompt section: the deployment declares one complete preset per role.
- **Role-preset selection is fallbacks-independent** — `dsh-llm-fallbacks` only routes LLM failures; it is never required for role identity. Unmounted → the same preset is selected with the single delivery debug log. Providers that do not support independent selection (`capabilities.agentPreset` false, or `inheritsParentContext`) and compositions without the `agentPresets` registry skip the selection with one contained debug log — a start is never failed by the channel for either.
- **Fork gating is default-only; explicit `dispatchTools` can omit `subagent_fork`** — a custom `dispatchTools` list overrides the default wholesale (pre-existing rename pattern), so a deployment that declares its own list must include `subagent_fork` to keep fork dispatches gated.
- **A preset's persona text is rendered by dsh** — `@deepseek-ai/dsh-persona` supplies `deployment:persona-prefix`/`-suffix` templates, and dsh's strict `{{variable}}` interpolation throws on a `{{` paired with a later `}}` (unknown/malformed/undefined reference) at child prompt assembly. That constraint now belongs to whoever authors the preset (mstar passes the id through verbatim); the bundled `harness-agents/` personas only feed the fallbacks seeds surface, which warns + skips a hazardous default instead of throwing.
- **Seed re-convergence after a fallbacks HMR re-mount is bounded by the seeded-only preservation design** — the seed registry is per-apply in-memory state, so a fiber swap (HMR / settings edit) drops it and both declarers re-declare from scratch. The mstar re-declare merge-preserves ONLY ids that are already seeded (seeded-only by design), so in the preset-last commit ordering the preset rows' seeded annotations are not restored by the re-declare — they recover at the NEXT fallbacks apply (the upstream preset self-declare re-seeds them). The advisory one-shot latch re-arms when the `llm-fallbacks` service disappears (an inject teardown), so the next decision point re-converges the mstar side; the preset side is a documented transient of the seeded-only preservation design.
- **Advisory skip reason `no-persona` also covers extraction failures** — a mirror default rejected at extraction (e.g. a `{{...}}` interpolation hazard) surfaces in the consolidated declare-outcome line as `no-persona` (extraction returns no usable persona before the hazard gate runs); per-id extraction diagnostics stay on the debug channel (`mstar/fallbacks-advisory` / `mstar/fallbacks-seeds`).
