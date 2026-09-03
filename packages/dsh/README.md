# @mstar-harness/dsh

English | [中文](README.zh.md)

![dsh](https://img.shields.io/badge/dsh-0.1.2--rc.1-4B32C3.svg)

[Morning Star](https://github.com/btspoony/mstar-harness) as a first-class dsh (DeepSeek Harness) host — a cordis function plugin that mounts the mstar engine in-process, implements the engine `HostAdapter` (`host: 'dsh'`), guards `{HARNESS_DIR}/status.json` writes (validate + advisory; repair-escape under hard), blocks disallowed subagent dispatches when `Enforcement: hard` is on, lints `SKILL.md` writes under the mounted skill roots, mounts the mstar `skills/` mirror through the dsh skill-filesystem provider (single canonical mount), and appends a durable `mstar-engine-status` catalog row to every composed agent step. Boot with a dsh Loader app; everything acts through the seam's refusal/advisory channels, never by patching the tools.

## Usage

How a dsh app consumes the plugin — install paths, configuration, what mounts at boot, and the enforcement semantics.

### Install paths

The package ships as a workspace package (`workspaces: ["packages/*"]`) with the engine bundled into `dist/` at build time (`bun run build`; dist is gitignored). The install path is the **profile bundle**, added to the shipped `web` profile (`dsh --profile web` — the ready-made web app profile, `dsh web`), through the `dsh.bundle.patch` manifest — a patch layer mounted over the dsh-base defaults:

**One-command CLI entry (recommended)** — `npx @mstar-harness/cli init --target dsh` installs the full capability in one go: it runs the two `dsh plugin --profile web add` installs below in order (the mstar bundle first, then `dsh-llm-fallbacks`), and `npx @mstar-harness/cli doctor --target dsh` reports each plugin row as `uninstalled` / `disabled` / `mounted`. It is the same two-command install, orchestrated; `--no-fallbacks` skips the second row (and with it the seeded roles — see What you get below).

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

**What you get with zero configuration** — with BOTH rows installed (via the CLI entry or the two commands above), the mstar plugin declares the 13 `mode: subagent` mstar role seeds (derived from the bundled `harness-agents/` mirror, `project-manager` excluded) into the fallbacks taxonomy at boot: each seeded role's persona defaults to its mirror `description` plus the mandatory role-loading guidance line, the seeded state stays revertible (the `fallbacks/revert-seed` gateway / the settings rollback button), and the runtime advisory reports missing ids and persona overrides. The seeds mechanism is B4 (delivered iter-20260816-dsh-seeds-bridges) — the installed-deployment e2e (`tests/install-e2e.spec.ts`) closes the verification loop: a real `init --target dsh` install into a temp `DSH_HOME`, booted from the installed artifacts, asserts all 13 ids present in the effective taxonomy with non-empty personas. Not included: model routing, automatch dispatch, or the dsh TUI.

> **Fresh-publish age window**: pnpm's `minimumReleaseAge` gate can make a `dsh plugin add <spec>` range resolution pick an older published version (without the seeds surface) for up to ~24h after a fresh publish — re-run `npx @mstar-harness/cli init --target dsh` after the window (or pin the version) to converge on the latest surface.

### Headless profile (one-shot runs)

The plugin is not web-bound: it also mounts in the dsh **headless** profile (`dsh --profile headless "<task>"` — the one-shot, no-GUI/no-port mode). The install path is identical, one command:

```sh
dsh plugin --profile headless add @mstar-harness/dsh
```

The shipped headless template auto-initializes on first use (`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`), and the reconcile step appends the mstar row to the bundle stack (`dsh-base → dsh-headless → @mstar-harness/dsh`). Every plugin capability rides a `dsh-base` seam that headless inherits — status/dispatch/lease/worktree gates, the skill mount, the engine-status catalog, the harness-rules system-prompt injection, the 7 model-facing tools — so the harness is fully live in a one-shot run. **Launch from the repo working directory** (the runner writes `meta.cwd = process.cwd()` and the per-workspace harness-dir probe starts there). The browser client half is web-profile-only and simply does not load.

**Headless usage caveats** (dsh 0.1.0-rc.6 verified):

- **One-shot turn model** — the runner submits the task as one user message and exits when the agent goes idle (`whenIdle()`); it does NOT await `run_in_background` children. Foreground subagent dispatch works (a child session is created and its result reaches the parent); background QC-tri-style parallelism does NOT complete in-process — either dispatch QC seats foreground (serial wall time) or have the agent collect background results with `tool-subagent-control` BEFORE ending the turn.
- **No interaction channel** — `ask_user_question` and approval prompts fail closed (there is no answerer). Use `DSH_PERMISSION_MODE=danger-full-access` for unattended runs (sandbox `danger-full-access` + approval `never`); interactive Prepare flows (grill-me) belong on the web profile.
- **Default model resolution** — headless composes no fallbacks row, so an `agent-default-model` settings pin of `FallbacksChain` fails with `NO_ADAPTER` (the web-profile artifact). Point the default model at a real provider, or install `dsh-llm-fallbacks` into the headless profile too (note: on the published dsh 0.1.0-rc.6 the fallbacks settings integration predates the `SettingsProvider.installSection` API, so the virtual adapter does not register — this resolves with dsh ≥ 0.1.2-alpha).
- **Config via the profile user layer** — profile-level `cordis.patch.yml` overrides work as documented (e.g. `enforcement: hard` + `dispatchBinding` on the mstar row); the mstar row's own `config: {}` stays neutral.

### Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `harnessDir` | `string` | repo `.mstarc` `[config] harness_dir`, else per-session workspace probe (`.mstar/` → `.agents/` → `.plans/` → `plans/`, from the session workspace root — **never the launch cwd**) | Explicit harness root; wins over engine probing. **Required for repos whose harness root is not a probed name**; the probe starts from the session workspace root (never the launch cwd) and STOPS there — it never walks above the session workspace, so a harness dir above it (e.g. a global `~/.mstar`) is never adopted. |
| `enforcement` | `'hard' \| 'soft'` | compass, else warn-only | Per-deployment override. Precedence: Config wins; else the Assignment's own `**Enforcement**: hard` header flag (dispatch gate only); else the repo `.mstarc` `[config] enforcement`; else the iteration compass frontmatter; else warn-only. Config / `.mstarc` `soft` are the ONLY local rollbacks — an Assignment-level `soft` does NOT override a hard compass. |
| `dispatchTools` | `string[]` | `['subagent', 'subagent_fork']` | Delegation tool names the dispatch gate matches — the dsh preset's TWO delegation tools, `subagent` and its fork sibling `subagent_fork` (both carry Assignment-shaped `{ description, prompt }` args; a `toolName` config may rename instances). |
| `dispatchBinding` | `string` | unset → fail-closed `empty-binding` under hard | The dispatching agent's own harness role (the anti-recursion CALLER); an Assignment whose `Execute as` equals it is self-recursion. |
| `roleMap` | `Record<string, string>` | unset | mstar role id (`Execute as`) → dsh-llm-fallbacks role id. A taxonomy bridge for logging + future rule-driven interop ONLY — never consulted by the persona channel (see LLM fallbacks integration). |
| `rolePersonas` | `Record<string, string>` | unset (bundled mirror default) | mstar role id (`Execute as`) → persona text; the native subagent persona channel's **override** source — a role-matched start (one-shot `start` or the opt-in continuable `startContinuable`) merges the persona into the native request `persona` slot (the child embodies the role persona INSTEAD OF the deployment persona; persisted + reapplied on resume); when unset for a role, the bundled `harness-agents/` mirror default is used (see LLM fallbacks integration). |
| `skillRoots` | `string[]` | unset (no custom-root registration) | Additional skill roots registered with the dsh skill-filesystem provider (`customSkillDirs` semantics — scanned before user roots). Dev-time: the mirror `<repo-root>/skills` absolute path. |
| `bundledSkillDir` | `string` | packaged `harness-skills/` mirror (package-relative) | Bundled skill root registered with the dsh skill-filesystem provider (`bundledSkillDir` semantics — scanned last, trusted). Defaults to the package's OWN `harness-skills/` mirror (synced by `bundle-assets`; gitignored) — package-relative, NOT cwd-anchored. An explicit value wins. |
| `catalogTtlMs` | `number` | `60000` | Pre-step catalog cache refresh interval (ms): how often the per-workspace unified `mstar-engine-status` catalog row (watermark + iteration gate + workspace-state digest) re-reads `status.json` / the compass / the knowledge index. The hot path is a timestamp compare + cache hit between refreshes; a mid-session plan/compass/residual change lands within one interval. |
| `workflowGate` | `'off' \| 'warn' \| 'ask' \| 'hard'` | `'warn'` | Workflow/ralph gate mode (see Gates → Workflow / ralph gate). `off` = pass-through with no verdict row; `warn` = advisory-only; `ask` = first-seen names route through the approval waterfall (P-c); `hard` = policy violations veto before any child starts. Default `warn` changes NO hard behavior — the gate is advisory-only unless the deployment opts into `ask`/`hard`. |
| `workflowNames` | `string[]` | unset | Workflow name allowlist (P-a): `meta.name` values treated as KNOWN by the gate. Empty or absent ⇒ **every** name is unknown (documented — the gate is NOT "allow all" by omission). Ralph calls carry no `meta.name` — P-a never applies to them. |

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
- **Seam lints** — `DESIGN.md` / audit-plan / knowledge-doc / roles-dir writes under the harness get their artifact-specific engine lints.
- **Model-facing tools** — `mstar_sdd_workspace`, `mstar_sdd_task_brief`, `mstar_iteration_gate`, `mstar_design_md_validate`, `mstar_audit_validate`, `mstar_compound_validate`, `mstar_roles_validate` register on `ctx.tools`. The `mstar_iteration_gate` mirror takes the v3 input `snapshot_path` (`{HARNESS_DIR}/workflows/<id>/snapshot.json` — mirror of `mstar iteration gate --workflow <id>`; the old `status_path` root input is gone with the v1 read path).
- **Bundled commands** — `ctx.commands` registrations for `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit` (from the packaged `harness-commands/` mirror; each declares a frontmatter `input` hint so the web client claims `/name ` and waits for the user's follow-up args instead of executing immediately; handlers steer the command body + user args into the receiving agent).
- **Pre-step catalog row** — every composed agent step appends ONE unified `mstar-engine-status` catalog message: the watermark (unified mstar version, harness dir, enforcement), the iteration phase-gate section (when a steering compass resolves) and the workspace-state digest (plan registry, open residuals, branch/policy anchors, active leases, knowledge digest, compass direction — when the workspace has a `status.json`). The row is digest-gated (injected once per turn, re-injected only when it changed) and shares one TTL-cached per-workspace build (`catalogTtlMs`, default 60 s).

### Enforcement semantics

Warn-only by default: gate violations log and emit advisory events (`mstar/status-gate`, `mstar/dispatch-gate`, `mstar/skill-lint`, seam advisories) and the action proceeds. `Enforcement: hard` — from the iteration compass frontmatter, the Assignment header, or the plugin Config (`enforcement: hard`) — escalates violations to a **real veto/deny** through the cordis refusal channels: subagent dispatch returns `PreToolDecision { kind: 'deny', reason }` without delegating; status/skill-lint writes are never hard-vetoed because the intent waterfall is content-blind — an already-invalid document is allowed as a **repair escape** (`hard: true, repair: true` advisory) so the repairing write can land. Config `soft` is the only local rollback; hard gates are never a global default.

## Gates

### Status gate

`fs/write-intent` + `fs/edit-intent` listeners (registered `prepend` so they run before dsh-fs-policy) gate writes to the v3 harness coordination-document target set — the v2 root `status.json`, `workflows/<id>/snapshot.json` and `projects/<id>/residuals.json` — each validated by its matching engine validator (`harnessDocKindOfTarget` classification; the snapshot kind additionally runs the `findingsCleanupGate` extension per plan row that configures a mode, over the project registers), against the current on-disk document (parsed exactly once — no TOCTOU double read). The gate **never throws**: every decision surfaces as the `mstar/status-gate` advisory and the intent waterfall is delegated via `next()`. Warn mode (default) logs + emits on violations. Hard mode allows an **already-invalid** document as a **repair escape** (error-level log + advisory with `hard: true, repair: true`) — the intent waterfall carries no incoming content, so a hard veto on an invalid document would deadlock the very write that repairs it. Unexpected internal errors degrade to allow in BOTH modes with a `degraded: true` advisory (error-containment envelope); the corrupting write itself cannot be vetoed on this seam (see Known Limitations).

### Dispatch gate

`tools/pre-execute` listener on the delegation tool(s): parses the payload's Assignment text and runs the engine's SINGLE dispatch-gate composition (`composeDispatchGate` — shape guard, `validateAssignmentFields`, `antiRecursionPrecheck`, default-branch gate, header-region enforcement; the same composition the opencode/omp/CLI bindings use, so violation codes are identical by construction) over the header region, plus the dsh-side worktree L1/L2 checks and the lease gate. The refusal channel is `PreToolDecision { kind: 'deny', reason }` returned **without** calling `next()`; warn mode logs, emits `mstar/dispatch-gate`, and delegates. Non-Assignment prompts and non-delegation tools are inert. Engine failures degrade to allow in both modes **observably**: the catch path emits the plugin-owned advisory with `degraded: true` + an error log, so a hard deployment can detect a dead control instead of a silent pass. Registered `prepend` so an earlier-mounted decision can never…

### Lease gate

Additive beyond the opencode field set: for writable dispatches whose Assignment declares `Execution mode: sdd` or whose plan row is `InProgress`, `verifyPlanExecutionLease` + dispatch-context comparisons (`holder`, `worktree_path`, `working_branch`) run against the ACTIVE workflow snapshot's plan rows (`workflows/<id>/snapshot.json` — the v3 lease home; the root v2 `status.json` supplies the active `workflows[]`). Violations use the dsh-side `lease.dispatch.*` namespace; read-only roles skip the check entirely. A **missing** `status.json` on an sdd dispatch is NOT a silent fail-open: it surfaces `lease.dispatch.unverifiable` (advisory in warn, deny under hard) — the execution_lease cannot be confirmed without the status file. Non-SDD dispatches keep the degrade-allow (no lease obligation). All Assignment field reads are scoped to the engine `assignmentHeaderRegion` (body-quoted examples never leak into header fields).

### Skill lint gate

`fs/write-intent` listener scoped to `SKILL.md` files under the configured skill roots runs the engine skill-authoring lints (`lintFrontmatter` + `lintFiveQuestion` — the CLI `mstar skill lint` combination) on the pre-write on-disk document. The slot is **content-blind** (the intent waterfall carries only `(target, actor)`), so: missing file = first create = pass; clean on-disk doc = silent pass; violations in warn mode = advisory + delegate; violations in hard mode = **repair escape** — the document is ALREADY invalid, so this write may BE the repair (error-level log + `hard: true, repair: true` advisory with the enforced `hardBlocked` verdict). Enforcement resolves like the other gates (Config override, else the iteration compass, else warn-only). The gate never throws; read failures and unexpected errors degrade to allow with a `degraded: true` advisory. The typed hard veto (`SkillLintVetoError`, code `skill-lint.veto`) lives on the incoming-document branch (`lintSkillWrite`) — see Known Limitations for its current wiring.

### Workflow / ralph gate

A `tools/pre-execute` branch (BEFORE the subagent prompt branch) gates the **`workflow`** and **`ralph`** tool calls — the remaining model-reachable fan-out that carries no Assignment text. It matches the FIXED tool names (`workflow` / `ralph`); a renamed `workflow` instance is out of scope (the name guard is the fixed default). Non-workflow tools are untouched — the subagent branch owns them, semantics unchanged.

**Four-tier mode** (Config `workflowGate`, default `warn`): `off` (pass-through, no verdict row), `warn` (advisory-only), `ask` (first-seen names route through dsh's approval waterfall — `{kind:'ask'}`, fail-closed upstream; this gate invents no answerer), `hard` (policy violations veto before any child starts). The policy is the SINGLE decision point — P-b lease attribution runs FIRST and preempts P-a/P-c, then the P-a name allowlist, then P-c first-seen ask.

| Policy | `off` | `warn` (default) | `ask` | `hard` |
| --- | --- | --- | --- | --- |
| **P-b**: workspace has an `InProgress` plan without `execution_lease` coverage | allow (gate short-circuits `off`) | **warn** — allowed + advisory (`workflow.lease.uncovered`) + one warn | **warn** — allowed + advisory + one warn (the ask channel is for first-seen NAMES, never the workspace red line) | **deny** — veto before any child starts (`workflow.lease.uncovered`), reason cites the plan id |
| **P-a**: workflow name ∈ `workflowNames` (non-empty list) | allow (short-circuit) | allow — no advisory (P-a passes under every mode) | allow — no ask | allow |
| **P-a**: workflow name unknown (empty/absent list ⇒ **every** name unknown) | allow (short-circuit) | **warn** — allowed + advisory (`workflow.name.unknown`) + one warn | **ask** (first-seen) → `{kind:'ask'}`; the cached decision (allow/deny) is reused afterwards — never a re-ask for a resolved name | **deny** — veto before any child starts (`workflow.name.unknown`), reason names the name |
| **ralph** (no `meta.name` — no allowlist identity) | allow (short-circuit) | allow — P-a/P-c NEVER apply | allow — P-a/P-c NEVER apply | allow — P-a/P-c NEVER apply; P-b still applies (deny when uncovered) |

**Default-`warn` rationale.** `warn` is the default so the gate **never surprises a deployment into a hard block**: it is advisory-only unless the operator opts into `ask` (human ask channel) or `hard` (veto). An empty/absent `workflowNames` makes every name unknown — the gate is **not** "allow all" by omission, but the default mode turns that into an advisory, not a block.

**Interaction with `Enforcement: hard`.** The workflow gate's mode is its OWN Config knob — the cross-cutting `Enforcement: hard` resolution (compass / Assignment header / Config `enforcement`) does **NOT** escalate `workflowGate`. A hard-enforcement deployment still runs the workflow gate in its configured mode (default `warn` = advisory-only) unless it also sets `workflowGate: 'ask'` or `'hard'`; conversely `workflowGate: 'hard'` vetoes regardless of the cross-cutting resolution. The two must not be confused: the workflow gate closes the "ungated fan-out under Enforcement: hard" gap **only when the deployment opts its mode in**.

**Fail-open edges (documented, never crash a compliant call).** (1) Malformed args — a `workflow` call without a non-empty string `meta.name` (after control-char normalization), or a `ralph` call without a string `objective` → pass-through + ONE warn under **every** mode (hard included), and NO verdict row (no policy verdict was produced). A name that is only control characters normalizes to empty → malformed. (2) Unreadable `status.json` — the P-b status read through the contained resolver path throws → P-b is degraded for that call only with ONE warn; P-a/P-c (name-based, no status dependency) still run. The gate NEVER throws: every read is structural.

**Verdict ledger rows.** Every gated call records ONE durable `workflow-verdict` row in the agent-flow ledger (the P2 ledger plan's record path, fully contained — a failing ledger write never reaches the gate): `tool` (`workflow` | `ralph`), `workflow` (normalized `meta.name`) or `objective`, `mode` (never `off` — off short-circuits before the policy), and the verdict vocabulary **`ok` / `advisory` / `denied` / `ask`** (the `ask` verdict is the extension: a first-seen ask is itself a gated call, so its row carries `ask` until the approval waterfall resolves it — "one ledger row per gated call"). Violation codes come from the verdict, never guessed: `workflow.name.unknown` (P-a) vs `workflow.lease.uncovered` (P-b). Fail-open paths (malformed args / unreadable status) record nothing; calls with no resolved harness dir skip the row (same silent no-op as the dispatch record path).

**P-c answer-observation seam.** The gate cannot observe the ask outcome — the tool registry's `serviceAsk` consumes the approval result internally. The **run-start observation IS the answer seam**: an ALLOWED ask executes the call → the durable `tool-workflow/run-start` session event lands in the parent session log → the workflow-ledger consumer records the W-B2 `workflow-run` row AND caches `allow` for the run's name into the apply-scoped `WorkflowAskCache`. A DENIED answer produces no run → no observation → the next same-name call under `ask` **re-asks** (fail-closed — no grant evidence, never an invented allow). Cache keys are the **normalized** (ASCII control chars stripped) **uncapped** name at BOTH seams — the gate composes `meta.name` and the observation records `runName` through the SAME `normalizeWorkflowName`, so a control-char name (`au\u0000dit`) can never wedge the cache (asks once, observes under the same key), and a >1024-char name still keys on the full name (the ledger ROW display name is capped separately; the identity axis is never truncated). The cache is apply-scoped — a fresh apply (HMR reload) starts empty, so an unresolved first-seen re-asks per call until an observation (or an explicit `record()`) lands. A throwing cache record degrades the observation with one warn — the ledger row is already appended, the run is never affected.

**P-b preemption.** The lease red line runs FIRST: an uncovered `InProgress` plan in the calling workspace means NO writable fan-out should start children until the plan is recovered — independent of the workflow name (the same red line as the Assignment-keyed lease gate), and it applies to ralph too. Under `warn`/`ask` it is advisory-only (allowed + one warn); the ask channel never substitutes for the workspace red line.

## LLM fallbacks integration

The optional `dsh-llm-fallbacks` plugin (installed with the second command — see Install paths) powers **role-based subagent configuration** — the role seeds and the adoption advisory; role persona delivery itself rides dsh's NATIVE subagent persona channel (independent of fallbacks, see below). The mstar plugin carries **zero runtime AND zero type references** to the package — `src/` has no import of it (runtime or type); the consumed service surface is mirrored by the local structural types in `src/gates/fallbacks-structural.ts`, and the package itself is a **dev-time-only dependency** of the mstar plugin (type mirroring + the real-package test harness). `dist/` names the package only in ONE string literal — the probe's loader-entry match — never an import or a type reference; the interop is a decision-point **capability probe**, never a module-internals read.

### Capability probe

Two views over the mounted state (point-in-time reads at decision points, no cache — loader mounts entries concurrently):

- `fallbacksService(ctx)` — the named cordis service (`ctx.get('llm-fallbacks')`) while the plugin is applied; `undefined` during HMR/fiber-swap windows even when the loader entry lives (the entry is declarative and outlives a fiber swap).
- `fallbacksMounted(ctx)` — capability view, **service-first with a loader-entries fallback**: the loader entry named `dsh-llm-fallbacks` is present, enabled (respecting `entry.disabled` and group rows), and has a live fiber.

Distinct states: **mounted** (service applied — full capability), **unmounted** (no entry: the fallbacks plugin was not installed — the mstar capability degrades, never breaks), **disabled** (entry present but disabled/grouped — capability off), and the HMR window (entry lives, service absent — the loader fallback covers it).

### Role persona delivery (native subagent persona channel)

Persona delivery rides dsh's NATIVE `SubagentStartRequest.persona` slot (`@deepseek-ai/dsh-subagent`): the plugin intercepts the `ctx.subagents` service READ through the cordis `internal/get` waterfall — the framework's documented service-read interception hook — and wraps the runtime value so a role-matched start merges the persona into the request BEFORE the child is composed — on BOTH start surfaces: the one-shot `start` AND the opt-in continuable `startContinuable` (tool-subagent `backgroundMode: 'continuable'`; its `ContinuableStartSpec.request` carries the same `persona` slot). The underlying `SubagentRuntime` object is never mutated (no monkey-patching), and the wrapping listener is fiber-scoped (an HMR re-apply unwinds and restores it, re-binding the fresh Config). Native semantics: the request persona registers the scoped `deployment:persona` section (order 0) on the child, SHADOWING the deployment persona for that child alone — the child EMBODIES the role persona instead of coexisting with it — is persisted in the child descriptor, and is reapplied on resume. Role identity uses the SAME engine Assignment header grammar as the dispatch gate. Persona lookup is the single `personaFor` chain — `rolePersonas[executeAs]` → bundled mirror default → skip — **never gated on `roleMap` or on the fallbacks mounted state** (persona delivery is fallbacks-independent). An explicit request persona (tool-subagent's own `Config.persona`) wins over the role persona — caller intent is never overridden.

**Capability gate (per surface)**: one-shot `SubagentRuntime.start` REJECTS a persona request for a provider without the native `persona` capability (fail loud, no silent degradation — out-of-process providers ship without it), so the channel checks `getProvider(name).capabilities.persona` FIRST on that surface. The continuable surface is gated by the NATIVE continuable contract instead — `SubagentCapabilities` is documented as ONE-SHOT-scoped and continuable children are composed by the continuation manager itself, gated by `provider.prepareContinuable`; the channel checks that, skipping the merge for providers without continuable support (the native start fails loud on its own — the persona is never logged as delivered for a start that would reject). Either way the merge is skipped with one contained debug log and the start proceeds unchanged — never a failed dispatch.

**Zero-config defaults**: when `rolePersonas` has no entry for a role, the persona comes from the bundled `harness-agents/` mirror — the repo-root `agents/` shells synced by `bundle-assets` at build (shipped in the published tarball; package-relative resolution, so the bundle works from any launch cwd). The shell file stem is the role id; the default is its frontmatter `description` block scalar. A shell is eligible when its frontmatter `mode` is absent or `subagent` — the `primary` shell (`project-manager`) is never offered as a subagent persona default. A default whose description carries the interpolation hazard (`{{` paired with a later `}}`) is warned + skipped at extraction (never a boot throw); a shell edit (mtime change) re-extracts on the next decision-point read. With the mirror absent (`bundle-assets` not run) lookups are config-only, and a config miss logs one debug per apply.

### Role seeds + adoption advisory

When the optional `dsh-llm-fallbacks` capability is **mounted** (the second install command — see Install paths), the mstar plugin **zero-config declares the 13 `mode: subagent` mstar role seeds** into the fallbacks seed registry: persona = the `harness-agents/` mirror `description` (verbatim) + one mandatory-load guide line (`Load mstar-roles (references/<role-id>.md) first — identity comes before skills; load topic skills only when the Assignment activates them via its Skill presets field.`); a persona carrying the `{{...}}` interpolation hazard is skipped + warned, never declared. The declaration **merge-preserves the currently-seeded non-mstar ids** from the readback — e.g. the 7 omp-style preset roles the upstream package self-declares at its own apply: upstream `declare` REPLACES the whole registry, so without preservation a mstar-only batch would strip preset ids of their seeded annotations (rows remain, unseeded). The declaration re-fires idempotently on every fallbacks (re-)apply (HMR/fiber swap) — never from a one-shot latch — so either boot order (presets first or mstar first) converges to the same 20-id fully-seeded registry.

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
| `roleMap` | `Record<string, string>` | unset | mstar role id → fallbacks role id. **Taxonomy bridge** for logging + future rule-driven interop only — unused by the persona channel by design (persona delivery is `rolePersonas`/mirror-sourced). |
| `rolePersonas` | `Record<string, string>` | unset (bundled mirror default) | mstar role id → persona text; the persona channel's **override** source — a mirror default is used when a role has no entry. |

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
| agent catalog | MessageSourceMap `mstar-engine-status` (model-visible ⟺ logged) | delivered (P2) |
| sdd (sddWorkspace, taskBrief) | `defineTool` wrappers registered on `ctx.tools` | delivered (P3) |
| iteration (evaluatePhaseGate, parseCompassFrontmatter) | `agent/pre-step` + iteration gate | delivered (P3) |
| worktree (l1PreDispatchCheck, l2PreDispatchCheck) | `tools/pre-execute` L1/L2 (inside the dispatch gate) | delivered (P3) |
| design-md / audit / compound / roles | `fs/write-intent` + `defineTool` wrappers on `ctx.tools` | delivered (P3) |

## Engine-status catalog

An advisory `agent/pre-step` waterfall listener appends ONE **`mstar-engine-status`** catalog MessageSource to every composed step (the `kind`/`form: 'catalog'` contract, mirroring the dsh tool-skill precedent): the model-visible `<mstar_engine_status>` block renders the watermark fields — **mstar version** (plugin own manifest; the single-version invariant pins the bundled engine to the same version), **harness dir** (resolved `{HARNESS_DIR}`, `none` when absent), and **enforcement** (compass mode, `soft` / `hard (compass)`) — plus the **iteration phase-gate section** (when a steering compass + `status.json` resolve: iteration id, transition, all-plans-done, gate verdict + violation codes — the `mstar iteration gate` tool result shape) and the **workspace-state digest section** (when the workspace has a `status.json`): **plans** (`id(status)` registry), **residuals** (open counts by severity), **branch** (base → target, spec integration), **policy** (push policy, worktree mode, control root), **leases** (active plan execution leases: holder + worktree), **knowledge** (knowledge-index doc count + categories) and **direction** (the steering compass's problem-statement one-liner). The listener calls `next()` first and builds on the delegated decision — it never vetoes a step and never replaces the composed messages. Model-visible ⟺ logged: the durable `catalog`-form source records the facts it published beside the model-facing prose, so the session log reconstructs the row without re-parsing the block (dsh packages/AGENTS.md). Fiber disposal removes the listener (HMR-safe).

The row is **digest-gated**: per agent+workspace it is injected once per turn and re-injected only when its rendered text changed — a 20-step turn shows the catalog once, not 20 times. The source shares ONE per-workspace cache entry, built at boot for an explicit `harnessDir` (else on the workspace's first pre-step) and TTL-refreshed (`catalogTtlMs`, default 60 s) — the hot path is a timestamp compare + Map lookup between refreshes, and a mid-session plan/compass/residual change lands within one interval.

## Agent-flow ledger (workflow rows)

The agent-flow ledger — `{HARNESS_DIR}/agent-flow.jsonl`, the same JSONL the catalog's `state.agentFlow` evidence reads — also records **workflow / ralph fan-out runs**: a session-event consumer (logger `mstar/workflow-ledger`, registered at apply) maps the FOUR durable `tool-workflow/*` session events into three new ledger kinds. Source of record is the **durable session events** appended into the CALLING PARENT session's log (top-level runs only — nested transport calls record nothing upstream), **not** the in-memory `workflow/*` emits (roadmap §10.4 N4): the session log is the replayable truth, so the consumer covers it with a **cold scan at apply** (constructor-seeded events never hit the firehose — `firstLiveSeq`) plus a live **`session/event` firehose** listener, deduped by ONE **durable per-session watermark** — the session-log `seq` position — persisted to `{HARNESS_DIR}/workflow-ledger-cursors.json` (a small bounded sidecar next to the ledger, written atomically temp-file + rename).

| `tool-workflow/*` event | Ledger row | Fields |
| --- | --- | --- |
| `run-start` | `workflow-run` | `runId`, `name`, `agent?` (the carrying parent session id) |
| `agent-start` | `workflow-agent` | `runId`, `seq` (1-based member sequence), `label`, `phase?`, `childId` |
| `run-end` | `workflow-run-end` | `runId`, `stopReason` (`completed` / `cancelled` / `error`) |

`tool-workflow/agent-end` is upstream member bookkeeping with **no ledger kind** (the member `outcome` is intentionally not persisted) and is filtered out. Optional fields (`agent` / `phase`) are omitted from the serialized line when absent (lossless-JSON discipline); the three kinds share the ledger's `AGENT_FLOW_MAX_EVENTS` truncation + size gate, and malformed lines narrow to `undefined` on read (never re-serialized). Display fields (`name` / `label` / `phase`) are length-capped deterministically at the boundary (`WORKFLOW_LEDGER_MAX_NAME_LENGTH` 1024, `WORKFLOW_LEDGER_MAX_LABEL_LENGTH` 512 — oversized values truncate with a `…` marker); id-sized fields (`runId` / `childId`, cap 512) SKIP the row when oversized — never truncated into collisions.

A FOURTH kind, **`workflow-verdict`**, is written by the workflow/ralph GATE (not this consumer) — one row per gated call (`tool`, `workflow`/`objective`, `mode`, verdict `ok`/`advisory`/`denied`/`ask`, violation `code`) — see Gates → Workflow / ralph gate. Display identity fields (`workflow` / `objective`) carry the same 1024-char cap; the verdict's violation code is never guessed (P-a `workflow.name.unknown` vs P-b `workflow.lease.uncovered`).

**Dedupe + replay scope.** The durable watermark is the dedupe mechanism: **one row per `(runId, kind, seq)`** across cold+live overlap AND across plugin **re-applies / restarts** — a re-registration consults the persisted watermark instead of starting with empty cursors. A session **created after apply** with a constructor-seeded log (resumed / forked conversation — its seeds never publish on the firehose) is cold-scanned **once** on the upstream `session/created` event, and the watermark keeps that backfill idempotent too. The watermark sidecar is bounded (per-harness session cap, eviction preferring sessions no longer live) and fully contained: an unreadable/unwritable watermark degrades to in-memory-only with one warn — a restart then re-records (honest under-dedupe, never data loss, never gating).

**childId linkage + member counts.** The `workflow-agent` row preserves the published member's `childId` (the child session id); the run's display `name` lives on the `workflow-run` row only, and the panel resolves it for agent/end rows via the window lookup (same `runId` — a member row itself carries no name). The panel attaches the member COUNT to the `workflow-run` row (the window's `workflow-agent` rows for that `runId`; window-bound — members truncated out of the ≤50-event window are honestly absent, never a 0 guess).

**Depth advisory (observe-time).** On `agent-start`, the consumer resolves the child session via `sessions.get(childId)` and warns when its `header.delegationDepth` is ≥ 2 — ONCE per run (per-runId latch), logger `mstar/workflow-ledger`. Observe-time only, **never a refusal path**: a throwing child read degrades the advisory, never the row or the run.

**No-behavior-change guarantee.** The consumer is observe-only: ZERO gating — every read and append is try/catch-contained; a failing ledger write never crashes or alters a workflow run; a throwing session read logs one warn and the pass continues. The `sessions` service is read STRUCTURALLY via `ctx.get('sessions')` — no runtime dependency on `@deepseek-ai/dsh-session`.

**Mount-order note.** The consumer activates only when the `sessions` service is available at apply — the **dsh-session row must mount BEFORE the mstar row** (the standard `web` profile order does). A composition where dsh-session mounts after the plugin (or is absent) degrades **silently**: ONE debug log (`sessions service absent — workflow-ledger consumer disabled`) and no rows are recorded — never an error, never a broken run.

**Panel visibility.** The three workflow rows render in the **事件记录 (Event Log) tab**'s Agent 流转事件 partition through the existing event-row chrome (no redesign): the summary identity is the run NAME (agent/end rows resolve it via the window lookup; fallback runId → 「未知」), the detail body adds four workflow fields — run-id / name / members / stop-reason (missing → 「—」) — and the expected/settled seats render 「—」 (a workflow row is not a role dispatch — no settle pairing exists, same precedent as settle rows). Unknown kind strings render as GENERIC rows (verbatim kind, no workflow fields) — never dropped, never guessed. The catalog summary counts workflow rows as a DISTINCT `workflow` bucket (`by role: workflow N` in the model-facing line) — never folded into dispatch-role counts.

## Web client plugin (workflow panel)

The package ships a browser client half for the dsh **web** profile, discovered
automatically on the already-installed `mstar` bundle row (package.json
`dsh.client` declaration + `exports["./client"]` → `dist/client.js` — the
upstream web `dsh.client` discovery scans loader entries and resolves each
client's `exports["./client"]` into the boot graph) — **no separate profile
layer or install step** (spec §6.1). The web app serves the bundle at
`/plugins/@mstar-harness/dsh/client.js` and loads it through the
closure-factory loader handoff (`window.__ModuleLoader__.load({ id, factory })`).

The client entry registers a **`conversation.view`** view-ring tab
(`id: 'mstar-workflow'`, `order: 20` — the trajectory precedent shape), labeled
**"MStar Workflow"** (en) / **"MStar 工作流"** (zh) through the `mstar-panel`
locale namespace. The panel is the **MStar Workflow layout**: a fixed 300px
right sidebar — plans (≤5, time-desc, `+N more`), open residual findings (≤10,
severity chips, overflow hint), policy (**enforcement first**, then push /
worktree / control worktree), leases, knowledge, direction — over a bottom
**fixed meta dock** (version + harness dir; small muted, does not scroll with
the sidebar digest; the former header row was removed), an **HTML/CSS zone
dashboard** as the main body, and a freshness footer (`last-updated
HH:MM:SS` + the catalog-re-emission refresh note). The branches block moved
out of the sidebar to the iteration zone (plan `20260810-panel-canvas-zones`).
Below 860px the sidebar stacks under the main area.

The canvas is a pure render of the latest `mstar-engine-status` catalog row
(from the `useSession` snapshot — refresh follows the snapshot, no polling):
the page fills the Tab (no page-level scrolling — the zone container is the
only scroll body) and the **zone dashboard** (replacing the react-flow cyclic
graph, plan `20260810-panel-canvas-zones`) lays out three zones — the
**iteration zone** (Step 1–5 as 5 equal full-width unit blocks with pure-number
badges + an `N/5` summary — no 步骤/Step wording, plan `20260811-panel-f2-quickfix`;
active-highlight / inactive dimmed states; the steps carry a FOUR-STATE machine —
`current` / `next` / `done` / `idle` (plan `20260812-panel-f5-iteration-zone-fix`
Task 1): every step BEFORE the current one projects `done`「已完成」(completed —
a finished Step 1 must not read as idle while Step 2 is current), `next` is the
single forward target, `idle` is schema-only — and the branch panel: iteration
base / target / spec integration, rendered only while active; the expanded
head is a LEFT-RIGHT SPLIT — branches (small left half, WIDTH-CAPPED —
`flex: 0 1 260px` + `max-width: 280px`, never stretches with the container; the
<860px column stack resets to content height) + steps (large right half,
`flex: 1 1 0` absorbing the remaining width) via `data-iteration-head-split`,
stacking on narrow widths, and NO
branch panel when there is no active iteration; the current step follows the
steering compass: `compassStatus: 'active'` (Phase 1 in flight) → Step 1
(iteration-start) is CURRENT with verdict `unknown` — no PASS/FAIL badge —
plan `20260811-panel-f4-iteration-zone`); the **iteration info section is
SHARED by the tasks AND agents tabs** (plan `20260812-panel-f5-design-system`
Task 8, user round-4 decision #4 — one `IterationInfoSection` component,
both tabs render the same `view.iteration` block: summary + steps +
branches); the **tasks zone** (5-column
kanban: Todo / InProgress / InReview / Done / `blocked-unknown` — the
Blocked state and the former unknown catch-all fold into ONE merged column
titled「受阻/未知」/「Blocked / Unknown」, plan `20260813-panel-quick-fixes`
Task 1 — with count badges; every column caps its rendered rows at
`PLAN_CAP` and shows a clickable 「更多」/「收起」 expand button
(`data-kanban-more` anchor) unfolding the full column — the projection
keeps ALL plan rows, the cap is a render concern never a discard) and the **agent-execution zone** (the four EXPECTED_ROLE_FLOW stage/phase
columns — review-edit-chain → sdd-implement → qc-tri → qa-gate (the
terminal stage; the former `sdd-task-review` stage is removed, its SDD L2
reviewer is now the pipeline role `code-reviewer`, v2.1.1) — a strict
FOUR-column layout with NO standalone unknown column (plan
`20260812-panel-f5-design-system` Task 5, user 2026-08-12 round-2 decision —
the former rightmost unknown column of plan `20260812-panel-f5-agent-layout`
is superseded): the `general` bucket sinks into an **unknown sub-partition
at the bottom of the `qa-gate` column** (a `data-sub-bucket="unknown"`
caption row 「unknown / 未匹配角色」 after the last qa-gate card, then the
general cards; the standalone on-demand column was already removed in the
agent-layout plan); `explore` is removed — no card, no column. The `sdd-implement`
column splits into **sub-buckets** by the projected `entity.bucket` (never
a render guess): the **implementor** partition above — flow roles in the
stage's original order (fullstack-dev / fullstack-dev-2 / frontend-dev),
then the on-demand roles (ops-engineer / prompt-engineer, carrying the
**on-demand badge** — no standalone on-demand column) — and the
**sdd-reviewer** partition below (code-reviewer, the SDD L2 task reviewer),
with implementor / sdd-reviewer caption labels; `zone: 'on-demand'` entities
live in the implementor partition, `zone: 'general'` entities render in the
qa-gate column's bottom unknown sub-partition. The agent canvas is laid out
in **TWO side-by-side Phase groups** (plan `20260812-panel-f5-design-system`
Task 8, user 2026-08-12 round-4 decision; side-by-side layout per plan
`20260813-panel-agent-canvas-legend-layout` Task 2): the **Phase 1 group on
the LEFT** (review-edit-chain — the sequential Review & Edit chain:
product-manager → architect → writing-specialist) and the **Phase 2 group on
the RIGHT** (sdd-implement → qc-tri → qa-gate — the iterative plan loop),
top-aligned (all group label rows share the same `y = PAD_Y`), each with its
group label row; the **Phase-2 label annotates the CURRENT PLAN** — the
first InProgress `state.plans[]` row (`data-canvas-group-plan`, projected
`activePlanId`; `+N more` when several plans run in parallel, muted
「无进行中 plan」 when none). The subagent **entity cards** aggregate **by role** from actual
dispatch evidence — the same role across sessions folds into one card ×N,
and every off-roster dispatch (the former `generalPurpose` SDD reviewer,
`scout`, anonymous `role === ''`) folds into the single `general` bucket
entity (the card is role-titled — the role id; the agent session id / task
tag ride the record line, never the title) — role chip / status point / ×N
count; running entities carry the
business glow-pulse highlight (on the ROUNDED `.card-body` — the card is a
single rounded element, no square outline overlay, plan
`20260812-panel-f5-design-system` Task 5), un-evidenced stages render the dashed
"待执行" pending placeholder with their expected role chips, un-evidenced
KNOWN_AGENTS members render dashed idle cards (the full 14-role roster is
never hidden), and the header
shows the `N executing · M pending` summary; cards carry the projected
**emphasis tier** (plan `20260812-panel-f5-design-system` Task 4, design
doc §3): `emphasis: 'current' | 'next' | 'off' | null` — the iteration's
current-phase roles render at **100%** chrome intensity, later-phase
expected roles at **75%**, already-passed / stage-less (on-demand, general)
roles at **45%**, and `null` (no iteration / unresolved transition) applies
NO override — always a chrome **alpha mix** (`--mstar-canvas-emphasis-*`
tokens; never a whole-card `opacity`, so the status point + running glow
stay opaque). Settled entities get a **standalone GREEN DONE FRAME + green ✓**
(plan `20260812-panel-f5-design-system` Task 8 — user round-4 feedback #1/#3:
`data-agent-done="true"`, a full-strength success border + 1px ring on the
rounded card body + the ✓ in the status point) **ONLY when `emphasis ≠ 'off'`**
— an off-tier role (already-passed / stage-less on-demand + general) renders
the muted dot instead and NEVER shows the completion marker. The agent
canvas filters dispatch evidence to the **current iteration's plans only**
(plan `20260813-panel-quick-fixes` Task 2): the steering compass
`iterationId` when active, else the nearest iteration from the catalog
`plans[].iterationRefs` (most-recent plan by 8-digit id date prefix +
doneAt); provably cross-iteration events produce no entity/edge — the
roster keeps its idle cards, and plan-less / unknown-plan / standalone
dispatches are never hidden. Status honesty (Task 2): `advisory` is no
longer terminal — a soft-enforcement dispatch falls through to its paired
settle (green ✓ when a settle exists, `running` when none), `denied` stays
terminal, and the advisory verdict still renders in the event log. The
canvas legend sits BELOW the viewport (Task 3, moved from above). Edges — plan `20260812-panel-f5-design-system` Task 5 (design
doc §2): the `expected` stage skeleton arrows AND the ANIMATED **next** edge
(the former `@keyframes agent-dash-flow` dash-flow arrow of plan
`20260810-panel-agent-flow-zone`) are **REMOVED** — flow order is implied
by the fixed column order + column labels, the current position by the
running card glow + status point — leaving TWO semantic kinds: the
evidence-driven **`actual` handoff** edges (same-plan ts-adjacent dispatch
entity-key pairs, `general` endpoints filtered, ≤1 per entity pair) drawn as
**bezier `C` curves** anchored to card **ports** — 4 fixed edge-midpoint
ports (north / south / east / west; static-invisible, hover-revealed as
small dots) with the arrow tip pulled back to a **10px standoff** off the
port — the arrow follows the line's local tangent at the anchor (**H1**),
and no line's stroke or arrow crosses any text (**H2**: standoff + side-gap
routing, design doc §2.0/§2.5/§2.6; tightened in plan
`20260813-panel-quick-fixes` Task 3 — same-column vertical flows whose
center-x line would cross an in-between card body reroute into the column's
LEFT side gap (forward AND reverse), and reverse horizontal beziers keep
direction-aware control points BETWEEN the endpoints, never bulging into
the adjacent column) — plus the **bidirectional supervise
line** (plan `20260812-panel-f5-agent-layout` Task 1/2) — one static
design-knowledge sub-bucket edge inside the `sdd-implement` column
(implementor ↔ sdd-reviewer — the mstar-sdd mutual-supervision contract),
now anchored at the **side-gap vertical anchor** (`x = card right edge +
18px`, vertical bezier flow, arrows along the vertical tangent — design doc
§2.5/§2.7); dim dashed by default, lit business SOLID when the projected
`evidenced` flag is true — evidence-driven lighting, never a fabricated
activation) — with the
agent-flow event strip migrated into the **事件记录 (Event Log) tab** — a
non-canvas log page (spec F1.5, plan `20260811-panel-event-log`): two
partitions (**Agent 流转事件** / **违规记录**), every row an expandable
native `<details>` carrying the full catalog fields (a missing field renders
「—」, never a guessed value), muted empty states — the two partitions
render SIDE BY SIDE in a locked-height two-column grid
(`repeat(2, minmax(0, 1fr))` — the page never scrolls as a whole; each
partition pins its title and owns an internal `overflow-y` scroll on its
row list; plan `20260813-panel-quick-fixes` Task 4 root-caused the
whole-page scroll — the panel root opts into the host
`data-conversation-composer-overlay` (the host's full-height opt-in), so
`height:100%` resolves and `.rowList`'s `overflow-y: auto` scrolls INSIDE
the partition (the host page no longer scrolls), with bottom clearance
reserving the floating composer via the host-published
`--dsh-composer-height`), falling back to two stacked 50/50 locked rows below 1200px (the
`data-event-log-*` anchors unchanged, plan `20260811-panel-f3-agent-general`)
— the canvas-corner
**`AgentEventDock`** is REMOVED with the page (无双份日志, spec §5; the
fixed footer bar — zone legend + gate summary + violations — died with the
WorkflowCanvas zone dashboard in the tabs-shell plan; the footer that
remains is the freshness marker). Empty branches (spec §2, plan
`20260812-panel-f5-agent-layout` Task 3): waiting keeps the muted hint, and
NO harness renders a **centered inactive-state card** — folder icon + 「No
Morning Star harness detected」 title + hint copy (the detail panel stays
inactive — no tabs, no sidebar — and activates automatically once a harness
is detected; the `data-mstar-empty="no-harness"` anchor stays on the title,
`data-mstar-graph` on the main container). Below 1200px the zones stack vertically. Projection is the pure
`projectGraph(source)` function (schema constants strictly separated from
catalog evidence; never throws; missing fields degrade to explicit
empty/last-known states — muted empty states, never orange warn boxes)
producing a data-only `ZoneView`; `WorkflowCanvas` renders it as plain
HTML/CSS.

**Dependency**: the zone dashboard carries **no graph library** — the
`@xyflow/react` devDependency (previously inlined into `dist/client.js` at
build time) was removed with the react-flow rendering layer (plan
`20260810-panel-canvas-zones`), and the plain-`.css` text loader whose only
consumer was `@xyflow/react/dist/style.css` is gone too (`CLIENT_EXTERNALS`
is unchanged — react / react-dom and the `@deepseek-ai/dsh-client-*` platform
modules stay external). The build script asserts the removal end to end: the
emitted bundle must contain **no `xyflow`/`reactflow` markers**, zero
`@deepseek-ai/*` value imports, and **no `import.meta` / ESM statements** —
the web loader executes plugin bundles as classic `<script>`s, where a
literal `import.meta` is a parse-time SyntaxError (a zustand v4
`import.meta.env` read is defined away at build; see the iteration
install-verification guide §6). Bundle size at this plan's wrap-up: **145,159 B
raw / 29,460 B gzip** (re-measure per the iteration install-verification
guide — the bundle shrank to ~85 KB when react-flow was removed and grew
back with the agent-execution zone's entity rendering, then again with the
F5 emphasis tiers + edge rework).

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
the agent-entity status derivation pairs a PAIRED settle exactly by its
dispatch identity (agent, role, planId, taskId — QC-tri N=3 settles land on
their own cards), and an unpaired dispatch stays running (no paired settle,
never faked); the current-iteration filter with NO steering compass infers
the iteration from plan ids (8-digit date prefix) + doneAt — a
deterministic, documented heuristic, and only provably cross-iteration
events are dropped; no historical
back-scan of a resumed long log (the server re-emits the row at every turn's
first step, digest-gated); no custom top-level slot (the `conversation.view`
tab is the only session-level panel seat available without dsh-private layout
changes — spec §1). Panel acceptance is dual-track: in-loop browser harness
verification against the rebuilt bundle (see iteration guides
`iter-20260810-panel-zones/guides/`) plus user-restart final GUI acceptance —
rerun steps in the install-verification guide §8. R1 (browser observation)
closed and archived 2026-08-10.

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

Every composed step carries one `mstar-engine-status` catalog user message (the `<mstar_engine_status>` watermark block — see the Engine-status catalog section). Gate decisions add: the dispatch veto as the registry-materialized `PreToolDecision { kind: 'deny', reason }` error; the status gate as the `mstar/status-gate` advisory (warn pass, hard-mode repair escape, or degraded allow); the dispatch gate as the `mstar/dispatch-gate` advisory (warn pass or degraded); the skill lint gate as the `mstar/skill-lint` advisory (warn pass, hard-mode repair escape, or degraded allow). Every model-visible row is reconstructable from the session log (catalog-form sources + advisory events).

**Leaf delivery discipline (PM 2026-08-12):** leaf subagents hand back their Completion Report in the **final (closing) message**, not via the `report` tool — the dsh tool-subagent-report default `reportDelivery: quiet` routes a report into the parent's next-step queue, where it strands when the parent's turn has ended (no step boundary follows). The closing message is the guaranteed delivery channel; reserve `report` for mid-turn findings that change what the parent should do next (SSOT: `skills/mstar-host/references/dsh.md` → PM dispatch).

#### Token effect

The catalog appends one fixed, stable user message per composed step (small constant block — no growth with session length beyond one row per step; per-session digest dedup is a P3 item). Veto and advisory text exists only when a gate fires.

#### KV Cache effect

The catalog row is appended at the END of the composed step messages, after delegation — the request prefix (system prompt + prior messages) is untouched, so prefix cache state is neither created nor invalidated by the plugin; the trailing row is byte-identical across steps. Tool-error text varies per violation but never participates in the request prefix.

## Known Limitations and Deferred Work

- **Dev-time seams resolve from the npm registry** — the `@deepseek-ai/dsh-*` seams are peerDependencies only (the host provides them at runtime); dev-time typecheck/tests/build resolve them from the public npm registry (`registry.npmjs.org`, no root `.npmrc` needed — bun auto-installs peers by default). **All runtime seam imports are externalized at build time** (`--external @deepseek-ai/cordis / @deepseek-ai/dsh-skill-filesystem / @deepseek-ai/dsh-tools / @deepseek-ai/dsh-llm` — the published `dist/` imports them instead of inlining); the gates are exercised through the exact `ctx.waterfall` dispatch the real registry/fs tools perform. The suite runs against the REAL seam packages from the npm registry — no committed `peer-stubs/` stand-ins, no local link farm.
- **Anti-recursion binding is Config-declared** — dsh exposes no per-agent role on the tool-execution context, so `dispatchBinding` declares one deployment-wide role; an Assignment with a different `Execute as` cannot be caught as self-recursion, and multi-role dispatchers need per-instance plugins.
- **Lease gate diverges from opencode by design** — opencode's `beforeDispatch` runs no lease checks; the dsh lease gate is additive (`lease.dispatch.*` codes) and fires only for writable SDD/InProgress dispatches, so parity covers the field set, not the lease surface.
- **Shared engine composition adopted** — the dispatch gate core is the engine's single `composeDispatchGate` (opencode/omp/CLI parity, so field/branch/anti-recursion violation codes are identical by construction), and the compass frontmatter parser is the engine's shared `parseCompassFrontmatter` (no local fork — nothing left to drift). Both run over the dsh header-region slice; the lease + worktree L1/L2 checks stay dsh-side additions on top.
- **Engine single-version pin** — `@mstar-harness/engine` is an exact `2.1.1` devDependency bundled into `dist/` (never a runtime dependency); `readHarnessVersion()` reads the dsh package manifest next to the bundle — `2.1.1`, equal to the pinned engine by the single-version invariant.
- **Schemastery empty-array materialization** — an omitted optional ARRAY Config key materializes as `[]`; the dispatch keys preserve omission via `.default(undefined)`, and any future optional array key must do the same.
- **Payload boundary** — the dispatch gate validates the delegation payload (Assignment text), not the child's runtime behavior; post-publish observation via `subagent/start` remains an option if model-visible child activity needs surfacing.
- **Status gate is content-blind by seam design** — the `fs/write-intent`/`fs/edit-intent` waterfall carries only `(target, actor)`, never the incoming content, so the write that FIRST corrupts a valid `status.json` passes in BOTH modes (the gate validates the pre-write document only). Hard mode therefore never vetoes status writes: an already-invalid document is allowed as a **repair escape** (error-level advisory with `hard: true, repair: true`) so the repairing write can land. Recovery path: repair the document in place (the gate allows it) or delete `status.json` and let the harness re-create it; monitor hard-mode deployments for `repair: true` advisories.
- **Missing `status.json` lease behavior** — on sdd writable dispatches a missing status file surfaces `lease.dispatch.unverifiable` (advisory in warn, deny under hard); non-SDD dispatches carry no lease obligation and keep the silent degrade-allow.
- **Gate matching follows `displayPath`** — the status gate matches on the resolved `displayPath` of the fs target. A backend reporting workspace-relative paths, a symlinked harness dir, or remote/URI targets never match and the gate is inert for them (no false positives); use absolute local paths for gated harness writes.
- **design-md seam scope is global basename matching** — `isSeamTarget('design-md')` matches any `DESIGN.md` / `DESIGN.dark.md` on the filesystem, regardless of the resolved `{HARNESS_DIR}` / repo root. A write to an unrelated project's DESIGN.md that does not follow the mstar token format therefore logs an error-level repair-escape advisory under hard mode (`hard: true, repair: true`) outside the harness — a noisy false-positive surface (the write is never blocked). Deliberate ("the artifact is the file itself, wherever the design lives"); containing the scope to the repo root when a harness dir resolves is a possible follow-up.
- **audit seam scope matches any `plans/audit-*` segment at any depth** — `isAuditPlanTarget` scans all path segments, so a tree unrelated to mstar (e.g. a dependency or sibling project with a `plans/audit-*` layout) gets mstar audit Status-block + secret lints on write. Same class as the design-md scope (advisory-only, never blocking); the layout is mstar-audit's documented Phase 4 shape, so the match is intentional.
- **skill-lint × roles-seam double-fire on `<root>/mstar-roles/SKILL.md`** — when a configured skill root contains the `mstar-roles` dir (the repo-root mirror case in dev, and the bundled mirror in the published form), one write to `mstar-roles/SKILL.md` fires BOTH the skill-authoring lint gate and the roles seam gate (two advisories / two repair-escape logs in hard). Both validators legitimately apply — the double-lint is advisory-only, not a correctness break; the "scopes are disjoint" property holds among the four seams only, not across the skill gate.
- **Content-blind skill-lint blind spots** — the `fs/write-intent` slot carries only `(target, actor)`: first-create incoming content is not linted, and valid→invalid overwrites are not detected on the listener path (it lints the pre-write on-disk document only). Warn/hard advisories surface pre-existing on-disk violations only — the same class of limitation as the status gate.
- **Explicit relative `bundledSkillDir` overrides are cwd-anchored** — skill-filesystem resolves a relative bundled root with plain `join()` semantics against the dsh **process cwd** at boot. The plugin's DEFAULT bundled root is the package's OWN `harness-skills/` mirror resolved package-relative (NOT cwd-anchored — works from any launch cwd); only an explicit RELATIVE override inherits the cwd anchoring, so deployments overriding the default should pass an **absolute path in the profile layer** (see `bundle/README.md`).
- **Bundled mirror is a build-time sync** — `harness-skills/` + `harness-commands/` are produced by `bundle-assets` at build time (repo-root `skills/` + `commands/` mirrors; gitignored). A checkout where `bundle-assets` has not run mounts no bundled skills and registers no commands (the default mount is inert, not an error).
- **Profile-bundle install into the `web` profile: registry and local checkout** — `dsh plugin --profile web add @mstar-harness/dsh` (registry) and `add <local checkout>` are the supported paths; both run through the same pnpm + reconcile mechanism (the reconcile step joins `@mstar-harness/dsh` to `dsh.profile.bundles`). A local checkout needs a prior `bun run build` — the package has no `prepare` script (the monorepo builds packages explicitly), so an unbuilt checkout installs an empty `dist/`.
- **`lintSkillWrite` typed veto not production-wired** — the incoming-document hard veto (`SkillLintVetoError`, code `skill-lint.veto`) is exported and test-covered, but has no production caller yet: the engine `HostAdapter` has no content-carrying skill-write hook (only `beforeStatusWrite`/`beforeDispatch`/`beforeMerge`), and the fs intent slot is content-blind. Wiring lands with a future content-carrying hook; until then the listener path enforces only via the repair-escape advisory (never a veto).
- **CLI `HOST_SIGNALS` lacks the `subagent` token** — the engine `ToolSignal` union includes it and `detectHost` handles it, but `packages/cli` `HOST_SIGNALS` is not updated yet, so `mstar host detect --signals subagent` would reject until the CLI list is updated on upstreaming.
- **Entry is a module index over `src/gates/*`** — the split shipped: `src/index.ts` re-exports the frozen 56-name export surface (31 value + 25 type-only names; `Config` counts once) from the gate modules (`_shared` / `status` / `skill-lint` / `seams` / `dispatch` / `catalog` / `tools` / `adapter`) and keeps the plugin manifest, the single cordis augmentation point, the command registration, and the `apply()` startup wiring. The surface is frozen by `tests/export-surface.spec.ts` — the runtime value-export set plus, under `typecheck:tests` (`bunx tsc --noEmit -p tests/tsconfig.json`), the value-namespace identity and the per-name type-only probes.
- **Engine dsh rows are upstreaming-destined** — the dsh changes to engine `host.ts` (`DetectResult`, `ToolSignal`, `resolveSkillRoot`) live in the mstar-workflow engine mirror and are intended for a user-authorized upstream PR into mstar-harness; the `mstar-host` skill mirror (§ Detect / § Resolve loaded skill root / `references/dsh.md`) updates with it.
- **Iteration stepper: Step 1 is compass-driven, Step 5 is schema-driven** — the zone dashboard's Step 1 (iteration-start) is the current step while the steering compass is `status: active` (Phase 1 in flight — no gate verdict, so no PASS/FAIL badge); Step 5 (merge-ready) is a schema constant the engine gate never lights as current (transition covers Phase 2→3→4 only), so it always renders idle — recorded in the iteration guide, not a defect. The full panel-limitation list lives in the Web client plugin section.
- **`dsh-llm-fallbacks` is an optional dev-time-only dependency** — dsh natively covers subagent customization, so fallbacks is strictly optional: `src/` carries zero imports of it (runtime and type — the consumed surface is the local structural mirror `fallbacks-structural.ts`, kept in sync by the probe's exact-keys drift gate plus the `typecheck:tests` real → view assignability check), `package.json` carries it only under `devDependencies` (type mirroring + the real-package test harness), and `dist/` carries no import and no type reference (only ONE string literal naming the package — the probe's loader-entry match; the advisory logs say `fallbacks`). Activation is a SEPARATE explicit install (two-command contract), never transitive; there is no `--external` guard anymore — a future value import must re-add a runtime dependency by design.
- **Role→model override NOT delivered this batch** — routing a role to a fallbacks `model` (or persona via fallbacks rules) would require rewriting the child's `agentOptions` on the start request, but start-request options are caller-controlled (tool-subagent's own Config; call args are `description`/`prompt`/`run_in_background` only, deep-frozen). Awaits upstream `fallbacks-explicit-role-tool` or the N-B1 systemPrompt adoption (roadmap §10.4).
- **Persona delivery is dsh-native — no additive section** — the role persona merges into `SubagentStartRequest.persona` (one-shot `start` AND the opt-in continuable `startContinuable`) and SHADOWS the deployment persona for role-matched children (child embodies the role; persisted + reapplied on resume). There is NO `mstar:role-persona` system-prompt section anymore (plan 20260831-dsh-alpha2-optional-fallbacks).
- **Persona injection is fallbacks-independent** — `dsh-llm-fallbacks` only routes LLM failures; it is never required for persona delivery. Unmounted → the same persona lands via the native channel with the single delivery debug log (AC-4). One-shot starts for providers without the native `persona` capability (out-of-process) skip the persona with one contained debug log; continuable starts for providers without `prepareContinuable` skip it the same way (the native start fails loud on its own) — the start is never failed by the channel for either.
- **Fork gating is default-only; explicit `dispatchTools` can omit `subagent_fork`** — a custom `dispatchTools` list overrides the default wholesale (pre-existing rename pattern), so a deployment that declares its own list must include `subagent_fork` to keep fork dispatches gated.
- **Persona values must not contain `{{...}}`** — dsh system-prompt renders persona text with strict `{{variable}}` interpolation and throws on a `{{` paired with a later `}}` (unknown/malformed/undefined reference), which would break child prompt assembly for every role-matched dispatch. The Config schema rejects such `rolePersonas` values at plugin mount with a clear error; the escape rule is single braces or rewording (a lone `{{` with no later `}}` renders as literal prose).
- **Seed re-convergence after a fallbacks HMR re-mount is bounded by the seeded-only preservation design** — the seed registry is per-apply in-memory state, so a fiber swap (HMR / settings edit) drops it and both declarers re-declare from scratch. The mstar re-declare merge-preserves ONLY ids that are already seeded (seeded-only by design), so in the preset-last commit ordering the preset rows' seeded annotations are not restored by the re-declare — they recover at the NEXT fallbacks apply (the upstream preset self-declare re-seeds them). The advisory one-shot latch re-arms when the `llm-fallbacks` service disappears (an inject teardown), so the next decision point re-converges the mstar side; the preset side is a documented transient of the seeded-only preservation design.
- **Advisory skip reason `no-persona` also covers extraction failures** — a mirror default rejected at extraction (e.g. a `{{...}}` interpolation hazard) surfaces in the consolidated declare-outcome line as `no-persona` (extraction returns no usable persona before the hazard gate runs); per-id extraction diagnostics stay on the debug channel (`mstar/fallbacks-advisory` / `mstar/fallbacks-seeds`).
