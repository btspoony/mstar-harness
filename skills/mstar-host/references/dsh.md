# dsh host reference

Load when **`mstar-host`** detection resolves **dsh** (DeepSeek Harness — session
has the **`subagent`** model-facing delegation tool, the `@deepseek-ai/dsh`
cordis plugin stack; `@mstar-harness/dsh` mounted via the `web` profile bundle
or a custom profile).

## dsh-only context

- Plugin markers: **`@mstar-harness/dsh`** (cordis function plugin) + the
  **profile bundle** (`dsh.bundle.patch` manifest) installed into the `web`
  profile via `dsh plugin --profile web add <spec>`. The composed app rows:
  `@deepseek-ai/dsh-skill` (skill registry), `@deepseek-ai/dsh-tools` (tool
  registry), `@deepseek-ai/dsh-commands` (command registry), then the `mstar`
  row.
- Runtime skills: the plugin mounts the packaged **`harness-skills/`** mirror
  (repo `skills/`, synced by `bundle-assets`) through the dsh skill-local
  provider as a **single canonical mount** (`providerName: mstar`). Skills are
  loadable by **name** via `ctx.skills`; the canonical skill-root form is
  `$DSH_BUNDLED_SKILL_DIR/<name>[/<rel>]`.
- Plugin commands: the plugin registers the bundled **`harness-commands/`**
  mirror as slash commands on `ctx.commands` — **`/iteration-start`**,
  **`/iteration-drive`**, **`/iteration-loop`**, **`/codebase-audit`**. Each
  command steers its command body into the receiving agent as a USER-source
  message (the mstar workflow prompt — the model executes it as a task, not
  injected context), returning a success result.
- **No `sessionStart.skill`** — enter PM manually via the `pm` skill (the
  `mstar-roles` load path), then **Read next** → `mstar-harness-core` →
  `project-manager.md`.
- Model-facing tools: the plugin registers **`mstar_sdd_workspace`**,
  **`mstar_sdd_task_brief`**, **`mstar_iteration_gate`**, and the seam
  validators **`mstar_design_md_validate`** / **`mstar_audit_validate`** /
  **`mstar_compound_validate`** / **`mstar_roles_validate`** on `ctx.tools`.
- Web client plugin (workflow panel): the same `mstar` bundle row carries a
  browser client half (`dshClient` + `exports["./client"]`) discovered
  automatically by `ClientModuleHostService` — no separate profile layer or
  install step. It registers a **`conversation.view`** view-ring tab
  (`id: 'mstar-workflow'`, `order: 20`) labeled **"MStar 工作流" / "MStar
  Workflow"** rendering the latest `mstar-engine-status` catalog row as the
  **MStar Workflow layout** — header (version / harness dir / enforcement
  evenly spread), right sidebar (plans / residuals / knowledge / leases /
  branches+policy / direction), and a **react-flow cyclic workflow graph**
  (phase ring + plan state machine, current-phase highlight, legend, zoom/pan;
  pure `projectGraph` projection, never throws, explicit degraded states);
  refresh follows the session snapshot, no polling. Bundle served at
  `/plugins/@mstar-harness/dsh/client.js` (closure-factory CJS; `@xyflow/react`
  inlined; build asserts no `import.meta` / ESM statements — the loader runs
  plugin bundles as classic scripts). **Known limitations**: the graph's
  Phase 1/5 nodes are schema-only (the engine phase gate never emits their
  transitions); the loop edge is planning semantics; no historical back-scan
  of resumed long logs; no custom top-level slot (the `conversation.view` tab
  is the only session-level panel seat without dsh-private layout changes);
  no-session → shell hero (strict-session view ring); browser UI observation
  is the user-restart acceptance. See
  `.mstar/iterations/iter-20260809-mstar-panel-beautify/guides/install-verification.md`
  for the verified install run.

## Skill loading

1. On entry: invoke **`pm`** (skill name via the mstar provider) → **Read
   next** loads `mstar-harness-core`, then `mstar-roles` →
   `project-manager.md` when PM is active.
2. Read `mstar-host` and this dsh reference.
3. Load `mstar-roles` and the active role reference.
4. Load topic skills on demand per the role reference (skill **names** —
   never app-cwd `skills/<name>/…`).

## Tools map

| dsh tool | Harness use |
|----------|-------------|
| **`subagent`** | Primary dispatch — the model-facing delegation tool the dispatch gate matches (default `toolName`; a renamed instance must be declared via Config `dispatchTools`) |
| **`mstar_iteration_gate`** | Evaluate the iteration phase gate in-app (`evaluatePhaseGate` — `mstar iteration gate` parity) |
| **`mstar_sdd_workspace`** / **`mstar_sdd_task_brief`** | SDD workspace resolve + task brief extraction (`mstar sdd …` parity) |
| **`mstar_*_validate`** | On-demand seam validators (design-md / audit / compound / roles) |
| **bash / read / write / edit / grep / glob / web_search** | Standard agent tools — evidence per `mstar-coding-behavior` |

### `subagent` dispatch shape

The dsh `subagent` tool is the delegation channel (schema rendered by
`@deepseek-ai/dsh-tool-subagent`; `provider`-bound, default toolName
`subagent`). Dispatch an Assignment the same way as other agent-tool hosts:
the dispatch gate validates the **Assignment header region** (`## Assignment`
+ `**Execute as**` / `**Delegation**` / `**Task category**` / `**Working
branch**` / `**Branch policy**` fields — engine `composeDispatchGate`, same
violation codes as opencode/omp/CLI).

Envelope-first discipline applies: put the header fields at the top of the
Assignment body — the dsh dispatch gate reads only the header region, so
body-quoted examples never leak into header fields.

## Gates and enforcement

The plugin wires the engine gates on dsh seams (all in-process):

| Gate | Seam | Hard-mode channel |
|------|------|-------------------|
| Status gate | `fs/write-intent` + `fs/edit-intent` on `{HARNESS_DIR}/status.json` | repair-escape advisory (never vetoes the repairing write) |
| Dispatch gate | `tools/pre-execute` on the `subagent` tool | `PreToolDecision { kind: 'deny', reason }` |
| Lease gate | inside the dispatch gate (SDD / InProgress dispatches) | deny under hard |
| Worktree L1/L2 | inside the dispatch gate | deny under hard |
| Skill-authoring lint | `fs/write-intent` on `SKILL.md` under mounted roots | repair-escape advisory |
| Seam lints | `fs/write-intent` on DESIGN.md / audit / compound / roles | repair-escape advisory |

**Enforcement semantics**: warn-only by default. `Enforcement: hard` —
resolved from the plugin Config (`enforcement: hard`), the Assignment header
flag, or the iteration compass frontmatter — escalates dispatch violations to
a real veto; status/skill-lint writes are never hard-vetoed because the intent
waterfall is content-blind (an already-invalid document is allowed as a
repair escape). Config `soft` is the only local rollback. Hard gates are never
a global default.

Every composed agent step carries ONE **`<mstar_engine_status>`** catalog
message: the watermark (unified mstar version, harness dir, enforcement),
the iteration phase-gate section when a steering compass resolved, and the
workspace-state digest section (plan registry, open residuals,
branch/policy anchors, active leases, knowledge digest, compass direction)
when the workspace has a `status.json`. The row is digest-gated (once per
turn, re-injected only when it changed) over one per-workspace TTL-cached
build (`catalogTtlMs`, default 60 s).

## PM dispatch

Harness **dispatch** on dsh = a `subagent` tool call with the full Assignment
text (role binding in the prompt — `Execute as` / `Act as` + skill load;
there is no separate `agent` field, the Assignment body IS the prompt). **N
assignees = N `subagent` calls = N independent delegations** (dispatch-gate
口径: one assistant message carries all N invokes — the gate counts each
dispatched Assignment). Paste-only Assignment without an invoke is **not**
dispatch.

**Execution: concurrent via background dispatch.** The `subagent` tool does
**not** declare `isConcurrencySafe` → fail-closed `exclusive` classification,
so same-message invokes are issued one-at-a-time (the next invoke starts only
after the previous one settles). Foreground invokes (no `run_in_background`)
settle only when the child completes → end-to-end serial (wall ≈ N× single
seat). **Background invokes (`run_in_background: true`) settle at task start
(task id returned) and their child agents run CONCURRENTLY in background
tasks** — for N≥2 dispatch (QC tri-review) use `run_in_background: true`:
parallel execution, wall ≈ single seat (not N×). **Future path (upstream
suggestion, not editable from this repo):** dsh-private declares
`isConcurrencySafe: () => true` on the tool-subagent so same-message
foreground invokes can also run concurrently — needs dsh maintainer
evaluation (roadmap §7e).

### QC default

- **`Execution mode: sdd`**: **N=3** `subagent` dispatches — one per QC seat
  (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`), each body **Act as**
  the respective QC role + QC skill load. **Dispatch all three with
  `run_in_background: true` → the seats run CONCURRENTLY** (background
  children; wall ≈ single seat); foreground (no `run_in_background`) would run
  serially (wall ≈ 3× single seat). Cannot emit required **N** →
  **`Blocked`**.
- **`inline`**: **N=1**.

### SDD implement (serial)

- **`Execution mode: sdd`**: one implementer `subagent` dispatch per task id;
  task reviewer = a separate dispatch (SDD review role) — no sticky resume
  unless the host's continuable-subagent id is available and recorded.

## Commands and skills paths

| Surface | Path / invocation |
|---------|-------------------|
| Plugin skills | Skill **name** via the mstar skill-local provider (`ctx.skills`); canonical `$DSH_BUNDLED_SKILL_DIR/<name>` |
| Plugin commands | `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit` (registered from `harness-commands/`) |
| Session entry | `pm` skill → `mstar-harness-core` via pm **Read next** |

## Command delivery degradation (dsh host quirk, reported 2026-08-10)

The dsh web client resolves slash commands against a client-side lexicon; when a command is NOT claimed client-side (lexicon fetch timing, args parsing, manual typing), the model receives the **bare text** (`/iteration-loop <方向> …`) with NO command body — unlike opencode/cursor/omp where the body always arrives.

**Rule:** when a user message begins with a registered mstar command name (`/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`) but carries no command body, treat it as that command invoked with the user text as its argument — execute the command's OWN semantics from the repo `commands/<name>.md` (or the mirrored `harness-commands/`): in particular **`/iteration-loop` = autonomous (code-first direction lock, NO grill-me questions)**, `/iteration-drive` = Phase 2–5 on the active iteration, `/iteration-start` = interactive (grill-me). Do not silently substitute the interactive start flow for `/iteration-loop`. Also do not re-ask what the command already specifies (e.g. scale auto → M default, branch policy continuity).

## Harness dir and environment

- `{HARNESS_DIR}` resolves via the engine `resolveHarnessDir` (`.mstar/` →
  `.agents/` → `.plans/`/`plans/`), with the plugin Config `harnessDir`
  override winning. The probe starts from the SESSION workspace root (the
  session cwd — **never the dsh launch/process cwd**), so the watermark and
  gates follow the workspace the session actually works in. Repos using a
  non-standard harness root (e.g. `.harness/`) MUST set Config `harnessDir`
  (absolute path) — the gates are inert without a resolvable harness dir.
- The dispatch gate needs the dispatching agent's own role for the
  anti-recursion precheck: declare it via Config **`dispatchBinding`** (dsh
  exposes no per-agent role on the tool-execution context). Under hard
  enforcement with no binding, the plugin logs the absence.

## Files, shell, and approvals

- Prefer host search/edit tools over shell find/sed when available.
- Respect dsh approval prompts for destructive operations.
- Do not edit `$DSH_HOME` credentials or user secrets without explicit consent.

## Git and final evidence

- Git work follows `mstar-branch-worktree` and Assignment **Working branch** /
  **Branch policy**; the worktree L1/L2 gates run in-process.
- Completion reports cite concrete commands, artifacts, and commit lines when
  required.

## Gotchas

- Do not confuse dsh **`subagent`** with opencode **`task_subagent`** or Cursor
  **`subagent_type`** — the detect rows differ by tool shape.
- A renamed `subagent` tool (Config `toolName`) silently disables the dispatch
  gate AND host detection unless `dispatchTools` declares the new name (the
  plugin warns under hard enforcement).
- Role binding is prompt-only on dsh: always include **`Execute as`** +
  **`Act as`** + skill load in the Assignment body — there is no separate
  `agent` field.
- Session plan UI / todos are not durable SSOT unless mirrored to
  `{HARNESS_DIR}`.
- The plugin's bundled skills/commands mirror is synced by `bundle-assets`
  (gitignored, package-local) — an explicit `bundledSkillDir` /
  `skillRoots` Config override wins when a deployment wants a different
  mirror.
