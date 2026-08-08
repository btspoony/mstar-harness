# @mstar-harness/dsh

English | [中文](README.zh.md)

Morning Star harness gates for the DeepSeek Harness SDK (dsh) — a cordis function plugin that mounts the mstar engine in-process and refuses invalid `{HARNESS_DIR}/status.json` writes and disallowed subagent dispatches when `Enforcement: hard` is on. Boot with a dsh Loader app; the gates veto through the seam's refusal channels, never by patching the tools.

## Installation

The package ships as a workspace package (`workspaces: ["packages/*"]`) with the engine bundled into `dist/` at build time (`bun run build`; dist is gitignored). Add it to a dsh app's `cordis.yml`:

```yaml
- name: '@mstar-harness/dsh'
  config:
    harnessDir: .mstar
```

`cordis` and the `@deepseek-ai/dsh-*` seams are peerDependencies — the composed dsh app provides them.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `harnessDir` | `string` | probed (`.mstar/` → `.agents/` → `.plans/` → `plans/`) | Explicit harness root; wins over engine probing. |
| `enforcement` | `'hard' \| 'soft'` | compass, else warn-only | Per-deployment override. Precedence: Config wins; else the Assignment's own `**Enforcement**: hard` header flag (dispatch gate only); else the iteration compass frontmatter; else warn-only. Config `soft` is the ONLY local rollback — an Assignment-level `soft` does NOT override a hard compass. |
| `dispatchTools` | `string[]` | `['subagent']` | Delegation tool names the dispatch gate matches (the dsh subagent tool's `toolName` may rename instances). |
| `dispatchBinding` | `string` | unset (precheck skipped) | The dispatching agent's own harness role; an Assignment whose `Execute as` equals it is self-recursion. |

## Gates

### Status gate

`fs/write-intent` + `fs/edit-intent` listeners (registered `prepend` so they run before dsh-fs-policy) gate writes to `{HARNESS_DIR}/status.json`: `validateStatus` + per-plan `findingsCleanupGate` over the current on-disk document (parsed exactly once — no TOCTOU double read). The gate **never throws** (qc3 F-1): every decision surfaces as the `mstar/status-gate` advisory and the intent waterfall is delegated via `next()`. Warn mode (default) logs + emits on violations. Hard mode allows an **already-invalid** document as a **repair escape** (error-level log + advisory with `hard: true, repair: true`) — the intent waterfall carries no incoming content, so a hard veto on an invalid document would deadlock the very write that repairs it. Unexpected internal errors degrade to allow in BOTH modes with a `degraded: true` advisory (error-containment envelope); the corrupting write itself cannot be vetoed on this seam (see Known Limitations).

### Dispatch gate

`tools/pre-execute` listener on the delegation tool(s): parses the payload's Assignment text and runs the opencode-parity field validators (`validateAssignmentFields`, `antiRecursionPrecheck`, `assertDefaultBranchProtected`) plus the dsh lease gate. The refusal channel is `PreToolDecision { kind: 'deny', reason }` returned **without** calling `next()`; warn mode logs, emits `mstar/dispatch-gate`, and delegates. Non-Assignment prompts and non-delegation tools are inert. Engine failures degrade to allow in both modes **observably**: the catch path emits the plugin-owned advisory with `degraded: true` + an error log, so a hard deployment can detect a dead control instead of a silent pass (qc2 W-003). Registered `prepend` so an earlier-mounted decision can never short-circuit this gate out of reach.

### Lease gate

Additive beyond the opencode field set: for writable dispatches whose Assignment declares `Execution mode: sdd` or whose plan row is `InProgress`, `verifyPlanExecutionLease` + dispatch-context comparisons (`holder`, `worktree_path`, `working_branch`) run against `{HARNESS_DIR}/status.json`. Violations use the dsh-side `lease.dispatch.*` namespace; read-only roles skip the check entirely. A **missing** `status.json` on an sdd dispatch is NOT a silent fail-open: it surfaces `lease.dispatch.unverifiable` (advisory in warn, deny under hard) — the execution_lease cannot be confirmed without the status file. Non-SDD dispatches keep the degrade-allow (no lease obligation). All Assignment field reads are scoped to the engine `assignmentHeaderRegion` (body-quoted examples never leak into header fields).

## Service

`apply` constructs `ctx.dshMstar` (engine-backed: `validateStatus`, `validateResidual`, `findingsCleanupGate`, `resolveCompassEnforcement`, `resolveHarnessDir`, `readHarnessVersion`, `applyEnforcement`). Layering: the P1 gates are co-located engine wrappers in this package importing the engine directly (same plugin, engine bundled at build time); `ctx.dshMstar` is the composition/test façade for future inject consumers (host adapters, catalogs — P2/P3). The engine is the single grammar for both paths. The companion entry `@mstar-harness/dsh/invariant` reserves package ownership with a documented no-op installer.

## Development

Commands (from `packages/dsh`): the coverage gate is per-file 100% on `src/` (dsh testing policy); the build bun-bundles the src entries into `dist/` (engine + schemastery inlined, cordis external) and emits tsc declarations.

```sh
bun test --coverage
bunx tsc --noEmit
bun run build
```

The dev-time seam surfaces (types, event shapes) mirror dsh-private at commit `9451be2` (2026-08-07 snapshot) through `peer-stubs/`; re-sync the stubs when the dsh-private baseline moves.

## Model Experience

### Request surface and condition

#### What the model sees

The plugin contributes no system-prompt or user-message text of its own. Its model-visible surface is produced only when a gate fires: the dispatch veto surfaces as the registry-materialized `PreToolDecision { kind: 'deny', reason }` error; the status gate surfaces every decision as the `mstar/status-gate` advisory (warn pass, hard-mode repair escape, or degraded allow) and the dispatch gate as the `mstar/dispatch-gate` advisory (warn pass or degraded), so every gate decision is reconstructable from the session log.

#### Token effect

Zero direct token effect: no request adds or replaces tokens; veto and advisory text exists only when a gate fires.

#### KV Cache effect

Independent: the plugin constructs no prompt prefix, so it neither creates nor invalidates cache state; tool-error text varies per violation but never participates in the request prefix.

## Known Limitations and Deferred Work

- **Dev-time peer stubs** — the `@deepseek-ai/dsh-*` seams are type-only stubs at dev/test time (no runtime implementations), so the gates are exercised through the exact `ctx.waterfall` dispatch the real registry/fs tools perform; a composed app with real seam packages is the deployment target and is not covered by this package's suite.
- **Anti-recursion binding is Config-declared** — dsh exposes no per-agent role on the tool-execution context, so `dispatchBinding` declares one deployment-wide role; an Assignment with a different `Execute as` cannot be caught as self-recursion, and multi-role dispatchers need per-instance plugins.
- **Lease gate diverges from opencode by design** — opencode's `beforeDispatch` runs no lease checks; the dsh lease gate is additive (`lease.dispatch.*` codes) and fires only for writable SDD/InProgress dispatches, so parity covers the field set, not the lease surface.
- **Engine single-version pin** — `@mstar-harness/engine` is an exact `2.0.0` devDependency bundled into `dist/` (never a runtime dependency); `readHarnessVersion()` reads the dsh package manifest next to the bundle, which stays `2.0.0` by the single-version invariant.
- **Schemastery empty-array materialization** — an omitted optional ARRAY Config key materializes as `[]`; the dispatch keys preserve omission via `.default(undefined)`, and any future optional array key must do the same.
- **Payload boundary** — the dispatch gate validates the delegation payload (Assignment text), not the child's runtime behavior; post-publish observation via `subagent/start` remains an option if model-visible child activity needs surfacing.
- **Status gate is content-blind by seam design** (qc2 W-001) — the `fs/write-intent`/`fs/edit-intent` waterfall carries only `(target, actor)`, never the incoming content, so the write that FIRST corrupts a valid `status.json` passes in BOTH modes (the gate validates the pre-write document only). Hard mode therefore never vetoes status writes: an already-invalid document is allowed as a **repair escape** (error-level advisory with `hard: true, repair: true`) so the repairing write can land. Recovery path: repair the document in place (the gate allows it) or delete `status.json` and let the harness re-create it; monitor hard-mode deployments for `repair: true` advisories.
- **Missing `status.json` lease behavior** (qc3 F-5) — on sdd writable dispatches a missing status file surfaces `lease.dispatch.unverifiable` (advisory in warn, deny under hard); non-SDD dispatches carry no lease obligation and keep the silent degrade-allow.
- **Gate matching follows `displayPath`** (qc2 S-007) — the status gate matches on the resolved `displayPath` of the fs target. A backend reporting workspace-relative paths, a symlinked harness dir, or remote/URI targets never match and the gate is inert for them (no false positives); use absolute local paths for gated harness writes.
