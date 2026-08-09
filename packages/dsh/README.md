# @mstar-harness/dsh

English | [中文](README.zh.md)

[Morning Star](https://github.com/btspoony/mstar-harness) as a first-class dsh (DeepSeek Harness) host — a cordis function plugin that mounts the mstar engine in-process, implements the engine `HostAdapter` (`host: 'dsh'`), guards `{HARNESS_DIR}/status.json` writes (validate + advisory; repair-escape under hard), blocks disallowed subagent dispatches when `Enforcement: hard` is on, lints `SKILL.md` writes under the mounted skill roots, mounts the mstar `skills/` mirror through the dsh skill-local provider (single canonical mount), and appends a durable `mstar-engine-status` catalog row to every composed agent step. Boot with a dsh Loader app; everything acts through the seam's refusal/advisory channels, never by patching the tools.

## Usage

How a dsh app consumes the plugin — install paths, configuration, what mounts at boot, and the enforcement semantics.

### Install paths

The package ships as a workspace package (`workspaces: ["packages/*"]`) with the engine bundled into `dist/` at build time (`bun run build`; dist is gitignored). The only install path is the **profile bundle**, added to the shipped `web` profile (`dsh --profile web` — the ready-made web app profile, `dsh web`), through the `dsh.bundle.patch` manifest — a patch layer mounted over the dsh-base defaults — in two spec forms:

**(a) Local checkout install** — the package checkout itself (local-only — no npm publish yet):

```sh
cd <repo>/packages/dsh
dsh plugin --profile web add .
```

**(b) Repo URL install** — the git repo hosting the package, pnpm `path:` spec selecting the monorepo subdirectory:

```sh
dsh plugin --profile web add git+https://github.com/dsh-external/mstar-workflow.git#path:/packages/dsh
```

`dsh plugin --profile <name> add <spec>` initializes the profile on first use (`web` starts from the shipped template: `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`), forwards `<spec>` to pnpm in the profile directory, and reconciles the profile's `dsh.profile.bundles` layer list from the installed state: any dependency whose package.json declares `dsh.bundle` joins the layer stack. Relative specs (`.`, `file:`/`link:`) anchor to the invoking directory, so `add .` runs from the package checkout; pnpm must be on PATH. Git-hosted specs build on install via the package `prepare` script (`bun run build` → `dist/`), which pnpm ≥10 blocks until allowed — the first `add` fails with pnpm's `allowBuilds` hint; add the printed key under `allowBuilds` in the profile's `pnpm-workspace.yaml`, then re-run. Details, layer position, and the shipped defaults live in [`bundle/README.md`](bundle/README.md) — the local checkout is **verified**; the repo-URL form runs through the same pnpm + reconcile mechanism. `cordis` and the `@deepseek-ai/dsh-*` seams are peerDependencies — the composed dsh app provides them.

### Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `harnessDir` | `string` | per-session workspace probe (`.mstar/` → `.agents/` → `.plans/` → `plans/`, from the session workspace root — **never the launch cwd**) | Explicit harness root; wins over engine probing. **Required for repos whose harness root is not a probed name** — e.g. this mstar-workflow repo itself uses `.harness/` (maintenance root, deliberately NOT probed); without the override the probe walks up from the session workspace to a global `~/.mstar` or an unrelated `.agents/`. |
| `enforcement` | `'hard' \| 'soft'` | compass, else warn-only | Per-deployment override. Precedence: Config wins; else the Assignment's own `**Enforcement**: hard` header flag (dispatch gate only); else the iteration compass frontmatter; else warn-only. Config `soft` is the ONLY local rollback — an Assignment-level `soft` does NOT override a hard compass. |
| `dispatchTools` | `string[]` | `['subagent']` | Delegation tool names the dispatch gate matches (the dsh subagent tool's `toolName` may rename instances). |
| `dispatchBinding` | `string` | unset (precheck skipped) | The dispatching agent's own harness role; an Assignment whose `Execute as` equals it is self-recursion. |
| `skillRoots` | `string[]` | unset (no custom-root registration) | Additional skill roots registered with the dsh skill-local provider (`customSkillDirs` semantics — scanned before user roots). Dev-time: the mirror `<repo-root>/skills` absolute path. |
| `bundledSkillDir` | `string` | packaged `harness-skills/` mirror (package-relative) | Bundled skill root registered with the dsh skill-local provider (`bundledSkillDir` semantics — scanned last, trusted). Defaults to the package's OWN `harness-skills/` mirror (synced by `bundle-assets`; gitignored) — package-relative, NOT cwd-anchored. An explicit value wins. |

`bundledSkillDir` defaults to the package's OWN `harness-skills/` mirror (see Skills mount) — an explicit Config value still wins. A relative override remains **cwd-anchored** (skill-local `join()` semantics against the dsh process cwd), so deployments overriding the default should pass an **absolute path in the profile layer** (see `bundle/README.md`).

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

- **Status gate** — `fs/write-intent` + `fs/edit-intent` listeners validate `{HARNESS_DIR}/status.json` writes (engine `validateStatus` + per-plan `findingsCleanupGate` over the pre-write document).
- **Dispatch gate** — a `tools/pre-execute` listener on the delegation tool(s) validates subagent Assignment text through the engine's single `composeDispatchGate` composition (field gate, anti-recursion precheck, default-branch gate — opencode/omp/CLI parity, so violation codes are identical by construction) plus the dsh lease gate and worktree L1/L2 checks.
- **Skill-authoring lint** — `SKILL.md` writes under the configured skill roots run the engine skill-authoring lints (`lintFrontmatter` + `lintFiveQuestion`).
- **Seam lints** — `DESIGN.md` / audit-plan / knowledge-doc / roles-dir writes under the harness get their artifact-specific engine lints.
- **Model-facing tools** — `mstar_sdd_workspace`, `mstar_sdd_task_brief`, `mstar_iteration_gate`, `mstar_design_md_validate`, `mstar_audit_validate`, `mstar_compound_validate`, `mstar_roles_validate` register on `ctx.tools`.
- **Bundled commands** — `ctx.commands` registrations for `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit` (from the packaged `harness-commands/` mirror; handlers steer the command body into the receiving agent).
- **Pre-step catalog rows** — every composed agent step appends the `mstar-engine-status` watermark (engine/plugin version, harness dir, enforcement) and, when a steering iteration compass resolves, the `mstar-iteration-gate` row.

### Enforcement semantics

Warn-only by default: gate violations log and emit advisory events (`mstar/status-gate`, `mstar/dispatch-gate`, `mstar/skill-lint`, seam advisories) and the action proceeds. `Enforcement: hard` — from the iteration compass frontmatter, the Assignment header, or the plugin Config (`enforcement: hard`) — escalates violations to a **real veto/deny** through the cordis refusal channels: subagent dispatch returns `PreToolDecision { kind: 'deny', reason }` without delegating; status/skill-lint writes are never hard-vetoed because the intent waterfall is content-blind — an already-invalid document is allowed as a **repair escape** (`hard: true, repair: true` advisory) so the repairing write can land. Config `soft` is the only local rollback; hard gates are never a global default.

## Gates

### Status gate

`fs/write-intent` + `fs/edit-intent` listeners (registered `prepend` so they run before dsh-fs-policy) gate writes to `{HARNESS_DIR}/status.json`: `validateStatus` + per-plan `findingsCleanupGate` over the current on-disk document (parsed exactly once — no TOCTOU double read). The gate **never throws**: every decision surfaces as the `mstar/status-gate` advisory and the intent waterfall is delegated via `next()`. Warn mode (default) logs + emits on violations. Hard mode allows an **already-invalid** document as a **repair escape** (error-level log + advisory with `hard: true, repair: true`) — the intent waterfall carries no incoming content, so a hard veto on an invalid document would deadlock the very write that repairs it. Unexpected internal errors degrade to allow in BOTH modes with a `degraded: true` advisory (error-containment envelope); the corrupting write itself cannot be vetoed on this seam (see Known Limitations).

### Dispatch gate

`tools/pre-execute` listener on the delegation tool(s): parses the payload's Assignment text and runs the engine's SINGLE dispatch-gate composition (`composeDispatchGate` — shape guard, `validateAssignmentFields`, `antiRecursionPrecheck`, default-branch gate, header-region enforcement; the same composition the opencode/omp/CLI bindings use, so violation codes are identical by construction) over the header region, plus the dsh-side worktree L1/L2 checks and the lease gate. The refusal channel is `PreToolDecision { kind: 'deny', reason }` returned **without** calling `next()`; warn mode logs, emits `mstar/dispatch-gate`, and delegates. Non-Assignment prompts and non-delegation tools are inert. Engine failures degrade to allow in both modes **observably**: the catch path emits the plugin-owned advisory with `degraded: true` + an error log, so a hard deployment can detect a dead control instead of a silent pass. Registered `prepend` so an earlier-mounted decision can never…

### Lease gate

Additive beyond the opencode field set: for writable dispatches whose Assignment declares `Execution mode: sdd` or whose plan row is `InProgress`, `verifyPlanExecutionLease` + dispatch-context comparisons (`holder`, `worktree_path`, `working_branch`) run against `{HARNESS_DIR}/status.json`. Violations use the dsh-side `lease.dispatch.*` namespace; read-only roles skip the check entirely. A **missing** `status.json` on an sdd dispatch is NOT a silent fail-open: it surfaces `lease.dispatch.unverifiable` (advisory in warn, deny under hard) — the execution_lease cannot be confirmed without the status file. Non-SDD dispatches keep the degrade-allow (no lease obligation). All Assignment field reads are scoped to the engine `assignmentHeaderRegion` (body-quoted examples never leak into header fields).

### Skill lint gate

`fs/write-intent` listener scoped to `SKILL.md` files under the configured skill roots runs the engine skill-authoring lints (`lintFrontmatter` + `lintFiveQuestion` — the CLI `mstar skill lint` combination) on the pre-write on-disk document. The slot is **content-blind** (the intent waterfall carries only `(target, actor)`), so: missing file = first create = pass; clean on-disk doc = silent pass; violations in warn mode = advisory + delegate; violations in hard mode = **repair escape** — the document is ALREADY invalid, so this write may BE the repair (error-level log + `hard: true, repair: true` advisory with the enforced `hardBlocked` verdict). Enforcement resolves like the other gates (Config override, else the iteration compass, else warn-only). The gate never throws; read failures and unexpected errors degrade to allow with a `degraded: true` advisory. The typed hard veto (`SkillLintVetoError`, code `skill-lint.veto`) lives on the incoming-document branch (`lintSkillWrite`) — see Known Limitations for its current wiring.

## Service

`apply` constructs `ctx.dshMstar` (engine-backed: `validateStatus`, `validateResidual`, `findingsCleanupGate`, `resolveCompassEnforcement`, `resolveHarnessDir`, `readHarnessVersion`, `applyEnforcement`). Layering: the P1 gates are co-located engine wrappers in this package importing the engine directly (same plugin, engine bundled at build time); `ctx.dshMstar` is the composition/test façade for inject consumers; the host adapter (below) is the host-facing facade. The engine is the single grammar for both paths. The companion entry `@mstar-harness/dsh/invariant` reserves package ownership with a documented no-op installer.

## Host adapter

The plugin implements the engine `HostAdapter` contract (`host: 'dsh'`) as `DshHostAdapter`, exposed as the `ctx.dshHostAdapter` service. Detection: the engine `detectHost` maps the dsh delegation tool name — `ToolSignal` **`subagent`** (the model-facing dsh subagent tool) — to `'dsh'`, evaluated after omp and before kimi/zcode/codex; hybrid sessions lose to earlier rows by fixed order. The adapter routes through the SAME validation cores as the in-plugin gates (one code path): `beforeStatusWrite(path, doc)` validates the incoming document when the host provides it, else the on-disk fallback (missing file = first create = pass); `beforeDispatch(assignment)` runs the field + branch + anti-recursion gate with the enforced `hardBlocked` verdict (the lease gate stays listener-side — it binds the ToolExecution session context the hook does not carry); `beforeMerge(lease)` is a thin wrapper over the engine `validateIntegrationMergeLease` (the reservation write into `status.json` is a P3 seam). `log` defaults to the dsh ctx logger `mstar/host-adapter`.

The frozen skill-root form for dsh (engine `resolveSkillRoot('dsh', …)`) is **`$DSH_BUNDLED_SKILL_DIR/<name>[/<rel>]`** — the resolver defines the canonical form used by skill-relative path resolvers (`resolveAssetPath`); it does NOT mount the directory. Mounting is the plugin's job (next section).

## Skills mount

The mstar skills mount through the dsh skill-local provider as a **single canonical mount**: the plugin registers its configured roots as one provider (`providerName: 'mstar'`, `includeDefaultRoots: false` — isolated, it must never see the host app's own project/user skills), and the engine form above is the shared skill-root contract. Two Config paths populate it:

| Path | Mechanism | When |
| --- | --- | --- |
| Bundled default | `bundledSkillDir` defaults to the package's OWN `harness-skills/` mirror — the repo-root `skills/` (19 `mstar-*` + `pm`) synced by `bundle-assets` at build/postinstall (gitignored), resolved **package-relative** (not cwd-anchored — works from any launch cwd) | Published package / any deployment without an override |
| Custom roots | `skillRoots` / explicit `bundledSkillDir` → skill-local `customSkillDirs` / `bundledSkillDir` entries (explicit values win) | Local development / tests / deployments with a different mirror |

The packaged mirror is a **single canonical mount**: skill content lives once in the repo-root `skills/` mirror and is synced into the package (like opencode's `harness-skills/`), so mstar skills stay standalone-usable everywhere. No double-loading: the opencode plugin ships the same skills in its own package, so dsh must mount them ONLY through this single skill-local path.

Dev-time reality: the `@deepseek-ai/dsh-skill-local` runtime is a peer-stub (contract-mirroring registration, no file watcher), so the mount is verified through real composition against the stub + the actual mirror `skills/` frontmatter (engine `lintSkillFrontmatter`); real-runtime composition (real seam packages, watcher, `$DSH_BUNDLED_SKILL_DIR` env flow) is the deployment target, not covered by this package's suite.

## Commands

The plugin registers the bundled mstar commands (omp/opencode parity surface) on `ctx.commands`: `harness-commands/*.md` — the repo-root `commands/` mirror (`iteration-start`, `iteration-drive`, `iteration-loop`, `codebase-audit`) synced by `bundle-assets` at build/postinstall (gitignored). Each registration reads the command's `name`/`description` frontmatter; the handler **steers the command body into the receiving agent as a USER-source message** (the dsh-plan-mode command precedent — `source: { kind: 'user' }`, so the model treats the body as a task to execute, not injected context; the dsh-commands "explicitly schedule model-visible work through the receiving Agent" path), returning a success result. Registration is deferred with `ctx.inject(['commands'], …)` — the same optional-unit pattern as the tools — so the plugin boots without the commands service; an absent mirror (no `bundle-assets` run) registers nothing.

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
| skill-authoring (lintFrontmatter, lintFiveQuestion) | skill-local roots + `fs/write-intent` on SKILL.md | delivered (P2) |
| lint (lintSkillFrontmatter, planQualityBar, assertSddTddTriple) | not wired — plan/tdd fs gates are a deferral; `lintSkillFrontmatter` runs only in the skills-mount test suite | deferred |
| agent catalog | MessageSourceMap `mstar-engine-status` (model-visible ⟺ logged) | delivered (P2) |
| sdd (sddWorkspace, taskBrief) | `defineTool` wrappers registered on `ctx.tools` | delivered (P3) |
| iteration (evaluatePhaseGate, parseCompassFrontmatter) | `agent/pre-step` + iteration gate | delivered (P3) |
| worktree (l1PreDispatchCheck, l2PreDispatchCheck) | `tools/pre-execute` L1/L2 (inside the dispatch gate) | delivered (P3) |
| design-md / audit / compound / roles | `fs/write-intent` + `defineTool` wrappers on `ctx.tools` | delivered (P3) |

## Engine-status catalog

An advisory `agent/pre-step` waterfall listener appends one **`mstar-engine-status`** catalog MessageSource to every composed step (the `kind`/`form: 'catalog'` contract, mirroring the dsh tool-skill precedent): the model-visible `<mstar_engine_status>` block renders the watermark fields — **engine version** (`readHarnessVersion`), **plugin version** (own manifest, single-version invariant), **harness dir** (resolved `{HARNESS_DIR}`, `none` when absent), and **enforcement** (compass mode, `soft` / `hard (compass)`). The listener calls `next()` first and builds on the delegated decision — it never vetoes a step and never replaces the composed messages. Model-visible ⟺ logged: the durable `catalog`-form source records the facts it published beside the model-facing prose, so the session log reconstructs the row without re-parsing the block (dsh packages/AGENTS.md). Fiber disposal removes the listener (HMR-safe; per-session digest dedup against the real session log is a P3 item — `simplify:` marker in code).

## Development

Commands (from `packages/dsh`): the coverage gate is per-file 100% on `src/` (dsh testing policy); the build bun-bundles the src entries into `dist/` (engine + schemastery inlined; `cordis` and the runtime seam imports — `@deepseek-ai/dsh-skill-local`, `@deepseek-ai/dsh-tools` (`defineTool`), `@deepseek-ai/dsh-llm` — external) and emits tsc declarations.

```sh
bun test --coverage
bunx tsc --noEmit
bun run build
```

The dev-time seam surfaces (types, event shapes) mirror a pinned dsh-private snapshot through `peer-stubs/`; re-sync the stubs when the dsh-private baseline moves.

## Model Experience

### Request surface and condition

#### What the model sees

Every composed step carries one `mstar-engine-status` catalog user message (the `<mstar_engine_status>` watermark block — see the Engine-status catalog section). Gate decisions add: the dispatch veto as the registry-materialized `PreToolDecision { kind: 'deny', reason }` error; the status gate as the `mstar/status-gate` advisory (warn pass, hard-mode repair escape, or degraded allow); the dispatch gate as the `mstar/dispatch-gate` advisory (warn pass or degraded); the skill lint gate as the `mstar/skill-lint` advisory (warn pass, hard-mode repair escape, or degraded allow). Every model-visible row is reconstructable from the session log (catalog-form sources + advisory events).

#### Token effect

The catalog appends one fixed, stable user message per composed step (small constant block — no growth with session length beyond one row per step; per-session digest dedup is a P3 item). Veto and advisory text exists only when a gate fires.

#### KV Cache effect

The catalog row is appended at the END of the composed step messages, after delegation — the request prefix (system prompt + prior messages) is untouched, so prefix cache state is neither created nor invalidated by the plugin; the trailing row is byte-identical across steps. Tool-error text varies per violation but never participates in the request prefix.

## Known Limitations and Deferred Work

- **Dev-time peer stubs** — the `@deepseek-ai/dsh-*` seams split into (a) **type-only / placeholder stubs** (`dsh-fs`, `dsh-agent`, `dsh-invariants`) exposing the seam types/peer names only, and (b) **functional composition stubs** (`dsh-skill`, `dsh-skill-local`, `dsh-tools` (`defineTool`), `dsh-commands`, `dsh-llm`) carrying minimal dev-time runtimes (`simplify:` markers; pinned to a dsh-private snapshot) so composition, waterfalls, the catalog message factory, the bundled-command registrations, and the v2 seam tools actually run in tests. **All runtime seam imports are externalized at build time** (`--external cordis / @deepseek-ai/dsh-skill-local / @deepseek-ai/dsh-tools / @deepseek-ai/dsh-llm` — the published `dist/` imports them instead of inlining the stand-in code); the gates are exercised through the exact `ctx.waterfall` dispatch the real registry/fs tools perform. Swapping in the real seam packages for the plugin's own suite is NOT planned — a composed app with real seams is the deployment target (this package's suite deliberately runs the pinned stubs for hermetic composition tests).
- **Anti-recursion binding is Config-declared** — dsh exposes no per-agent role on the tool-execution context, so `dispatchBinding` declares one deployment-wide role; an Assignment with a different `Execute as` cannot be caught as self-recursion, and multi-role dispatchers need per-instance plugins.
- **Lease gate diverges from opencode by design** — opencode's `beforeDispatch` runs no lease checks; the dsh lease gate is additive (`lease.dispatch.*` codes) and fires only for writable SDD/InProgress dispatches, so parity covers the field set, not the lease surface.
- **Shared engine composition adopted** — the dispatch gate core is the engine's single `composeDispatchGate` (opencode/omp/CLI parity, so field/branch/anti-recursion violation codes are identical by construction), and the compass frontmatter parser is the engine's shared `parseCompassFrontmatter` (no local fork — nothing left to drift). Both run over the dsh header-region slice; the lease + worktree L1/L2 checks stay dsh-side additions on top.
- **Engine single-version pin** — `@mstar-harness/engine` is an exact `2.0.4` devDependency bundled into `dist/` (never a runtime dependency); `readHarnessVersion()` reads the dsh package manifest next to the bundle, which stays `2.0.4` by the single-version invariant.
- **Schemastery empty-array materialization** — an omitted optional ARRAY Config key materializes as `[]`; the dispatch keys preserve omission via `.default(undefined)`, and any future optional array key must do the same.
- **Payload boundary** — the dispatch gate validates the delegation payload (Assignment text), not the child's runtime behavior; post-publish observation via `subagent/start` remains an option if model-visible child activity needs surfacing.
- **Status gate is content-blind by seam design** — the `fs/write-intent`/`fs/edit-intent` waterfall carries only `(target, actor)`, never the incoming content, so the write that FIRST corrupts a valid `status.json` passes in BOTH modes (the gate validates the pre-write document only). Hard mode therefore never vetoes status writes: an already-invalid document is allowed as a **repair escape** (error-level advisory with `hard: true, repair: true`) so the repairing write can land. Recovery path: repair the document in place (the gate allows it) or delete `status.json` and let the harness re-create it; monitor hard-mode deployments for `repair: true` advisories.
- **Missing `status.json` lease behavior** — on sdd writable dispatches a missing status file surfaces `lease.dispatch.unverifiable` (advisory in warn, deny under hard); non-SDD dispatches carry no lease obligation and keep the silent degrade-allow.
- **Gate matching follows `displayPath`** — the status gate matches on the resolved `displayPath` of the fs target. A backend reporting workspace-relative paths, a symlinked harness dir, or remote/URI targets never match and the gate is inert for them (no false positives); use absolute local paths for gated harness writes.
- **design-md seam scope is global basename matching** — `isSeamTarget('design-md')` matches any `DESIGN.md` / `DESIGN.dark.md` on the filesystem, regardless of the resolved `{HARNESS_DIR}` / repo root. A write to an unrelated project's DESIGN.md that does not follow the mstar token format therefore logs an error-level repair-escape advisory under hard mode (`hard: true, repair: true`) outside the harness — a noisy false-positive surface (the write is never blocked). Deliberate ("the artifact is the file itself, wherever the design lives"); containing the scope to the repo root when a harness dir resolves is a possible follow-up.
- **audit seam scope matches any `plans/audit-*` segment at any depth** — `isAuditPlanTarget` scans all path segments, so a tree unrelated to mstar (e.g. a dependency or sibling project with a `plans/audit-*` layout) gets mstar audit Status-block + secret lints on write. Same class as the design-md scope (advisory-only, never blocking); the layout is mstar-audit's documented Phase 4 shape, so the match is intentional.
- **skill-lint × roles-seam double-fire on `<root>/mstar-roles/SKILL.md`** — when a configured skill root contains the `mstar-roles` dir (the repo-root mirror case in dev, and the bundled mirror in the published form), one write to `mstar-roles/SKILL.md` fires BOTH the skill-authoring lint gate and the roles seam gate (two advisories / two repair-escape logs in hard). Both validators legitimately apply — the double-lint is advisory-only, not a correctness break; the "scopes are disjoint" property holds among the four seams only, not across the skill gate.
- **Content-blind skill-lint blind spots** — the `fs/write-intent` slot carries only `(target, actor)`: first-create incoming content is not linted, and valid→invalid overwrites are not detected on the listener path (it lints the pre-write on-disk document only). Warn/hard advisories surface pre-existing on-disk violations only — the same class of limitation as the status gate.
- **Explicit relative `bundledSkillDir` overrides are cwd-anchored** — skill-local resolves a relative bundled root with plain `join()` semantics against the dsh **process cwd** at boot. The plugin's DEFAULT bundled root is the package's OWN `harness-skills/` mirror resolved package-relative (NOT cwd-anchored — works from any launch cwd); only an explicit RELATIVE override inherits the cwd anchoring, so deployments overriding the default should pass an **absolute path in the profile layer** (see `bundle/README.md`).
- **Bundled mirror is a build-time sync** — `harness-skills/` + `harness-commands/` are produced by `bundle-assets` at build/postinstall (repo-root `skills/` + `commands/` mirrors; gitignored). A checkout where `bundle-assets` has not run mounts no bundled skills and registers no commands (the default mount is inert, not an error).
- **Profile-bundle install into the `web` profile: local checkout and repo URL, no registry path** — `dsh plugin --profile web add <local checkout>` is verified, and the repo-URL form (`add git+https://github.com/dsh-external/mstar-workflow.git#path:/packages/dsh`) runs through the same pnpm + reconcile mechanism and was verified against the real remote (pnpm resolves the `path:` spec, the reconcile step joins `@mstar-harness/dsh` to `dsh.profile.bundles`); no public-registry install is offered yet. Git-hosted installs build via the package `prepare` script, which pnpm ≥10 blocks until allowed — the `allowBuilds` key must be added to the profile's `pnpm-workspace.yaml` (the first `add` fails with pnpm's hint, then succeeds on re-run).
- **`lintSkillWrite` typed veto not production-wired** — the incoming-document hard veto (`SkillLintVetoError`, code `skill-lint.veto`) is exported and test-covered, but has no production caller yet: the engine `HostAdapter` has no content-carrying skill-write hook (only `beforeStatusWrite`/`beforeDispatch`/`beforeMerge`), and the fs intent slot is content-blind. Wiring lands with a future content-carrying hook; until then the listener path enforces only via the repair-escape advisory (never a veto).
- **CLI `HOST_SIGNALS` lacks the `subagent` token** — the engine `ToolSignal` union includes it and `detectHost` handles it, but `packages/cli` `HOST_SIGNALS` is not updated yet, so `mstar host detect --signals subagent` would reject until the CLI list is updated on upstreaming.
- **Entry `src/index.ts` stays monolithic** — the module-split is deferred: the 2600+ line entry ships as-is because a split at this point would destabilize a reviewed, fully-tested surface for zero behavioral gain; the split remains a follow-up.
- **Engine dsh rows are upstreaming-destined** — the dsh changes to engine `host.ts` (`DetectResult`, `ToolSignal`, `resolveSkillRoot`) live in the mstar-workflow engine mirror and are intended for a user-authorized upstream PR into mstar-harness; the `mstar-host` skill mirror (§ Detect / § Resolve loaded skill root / `references/dsh.md`) updates with it.
