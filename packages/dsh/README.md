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
| `harnessDir` | `string` | probed (`.mstar/` → `.agents/` → `plans/`) | Explicit harness root; wins over engine probing. |
| `enforcement` | `'hard' \| 'soft'` | compass, else warn-only | Per-deployment override; `hard` forces vetoes, `soft` rolls back compass/Assignment hard flags. |
| `dispatchTools` | `string[]` | `['subagent']` | Delegation tool names the dispatch gate matches (the dsh subagent tool's `toolName` may rename instances). |
| `dispatchBinding` | `string` | unset (precheck skipped) | The dispatching agent's own harness role; an Assignment whose `Execute as` equals it is self-recursion. |

## Gates

### Status gate

`fs/write-intent` + `fs/edit-intent` listeners (registered `prepend` so they run before dsh-fs-policy) gate writes to `{HARNESS_DIR}/status.json`: `validateStatus` + per-plan `findingsCleanupGate` over the current on-disk document. The fs intent slot has no deny shape — the hard veto is a **throw** of `StatusGateError` (`code: 'STATUS_GATE_HARD_BLOCK'`), which rejects the waterfall and fails the tool call. Warn mode (default) logs, emits the `mstar/status-gate` advisory, and delegates via `next()`.

### Dispatch gate

`tools/pre-execute` listener on the delegation tool(s): parses the payload's Assignment text and runs the opencode-parity field validators (`validateAssignmentFields`, `antiRecursionPrecheck`, `assertDefaultBranchProtected`) plus the dsh lease gate. The refusal channel is `PreToolDecision { kind: 'deny', reason }` returned **without** calling `next()`; warn mode logs, emits `mstar/dispatch-gate`, and delegates. Non-Assignment prompts and non-delegation tools are inert. Engine failures degrade to allow in both modes.

### Lease gate

Additive beyond the opencode field set: for writable dispatches whose Assignment declares `Execution mode: sdd` or whose plan row is `InProgress`, `verifyPlanExecutionLease` + dispatch-context comparisons (`holder`, `worktree_path`, `working_branch`) run against `{HARNESS_DIR}/status.json`. Violations use the dsh-side `lease.dispatch.*` namespace; read-only roles skip the check entirely.

## Service

`apply` constructs `ctx.dshMstar` (engine-backed: `validateStatus`, `validateResidual`, `findingsCleanupGate`, `resolveCompassEnforcement`, `resolveHarnessDir`, `readHarnessVersion`, `applyEnforcement`). The companion entry `@mstar-harness/dsh/invariant` reserves package ownership with a documented no-op installer.

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

The plugin contributes no system-prompt or user-message text of its own. Its model-visible surface is produced only when a gate fires: the status veto surfaces as a tool `isError` result carrying `{ name: 'StatusGateError', code: 'STATUS_GATE_HARD_BLOCK' }` plus one violation line per finding; the dispatch veto surfaces as the registry-materialized `PreToolDecision { kind: 'deny', reason }` error; warn-mode passes produce logger lines and the `mstar/status-gate` / `mstar/dispatch-gate` advisory events, so every gate decision is reconstructable from the session log.

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
