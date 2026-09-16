---
title: OMP native settings and iteration model handoff
status: product-locked
created_at: 2026-09-16
iteration: iter-20260916-omp-model-handoff
plan_id: 20260916-omp-model-handoff
---

# PRD: OMP native settings and iteration model handoff

Primary product spec for plan `20260916-omp-model-handoff`. The six user decisions remain **product-locked**. The 2026-09-16 bounded architecture reassessment supersedes the initial conclusion that B1/B2 necessarily require upstream patches: same-model reselection, transactional cancellation of an already executing switch, and project-only native-UI parity were added constraints, not confirmed user requirements. Public-API alternatives and their precise limits are below. Prepare remains open for E1/E2 integration closure, writing review and PM lock; this is not an implementation GO.

Source: user interactive decisions in `{ITERATION_DIR}/iter-20260916-omp-model-handoff/guides/prepare-context.md`; compass AC1–AC8; upstream OMP plugin-settings rendering (`InstalledPlugin.name` = npm package name; setting **key** is the native label).

## Background

OMP has no built-in "custom goal → model switch" for Morning Star. Users want an opt-in that uses a capable model for Prepare, then continues the same coordinator session on a cheaper configured role after Phase 1 is fully done. The last confirmed activation model is **native persistent plugin settings**, not a session-only command.

## Target Users

OMP operators who run Morning Star iterations in a coordinator (primary) session and already have `@slow`, `@default` and optionally `@smol` role mappings configured.

## User Stories

1. As a coordinator, I enable the feature once in native settings and every later Morning Star iteration automatically starts Prepare on `@slow`.
2. As a coordinator, after Phase 1 fully completes, this same session continues on my chosen `@default` or `@smol` without rewriting my saved role mappings.
3. As a coordinator, if I pick a model myself while a handoff is still pending, that choice wins for this session; later iterations still honor the saved preference.
4. As a coordinator, if a switch cannot happen, I can see that it failed and why; the session keeps the model it actually has.
5. As an operator who never enabled the setting, installing or updating `@mstar-harness/omp` does not change models.

## Locked user decisions

Do not re-ask. Implementation choices belong to architect unless source evidence creates a **product** conflict.

| # | Decision | Product reading |
|---|---|---|
| 1 | Switch after **full Phase 1**, not Phase 2 | Handoff to `handoffTarget` only after sequential product / architecture / writing returns, PM lock, dedicated integration worktree, and the required integration-branch push. Draft compass, lock alone, missing checkout, mismatched branch, or unfulfilled push are insufficient. |
| 2 | Target `@default` or `@smol`; default `@default` | Native enum `handoffTarget`; only those two values. |
| 3 | Enter `@slow` automatically when enabled iteration preparation starts | On a real new Morning Star iteration start, while the saved preference is on, select `@slow` **before** substantive Prepare work. |
| 4 | Manual model changes cancel the current pending handoff | User-initiated model selection cancels **this** session's pending automatic target switch only. |
| 5 | Morning Star-specific settings live in native OMP settings | `/settings` → Plugins → `@mstar-harness/omp`. No competing settings UI and **no activation command**. |
| 6 | Native settings are persistent; once enabled, apply automatically to each later Morning Star iteration | Saved preference is not session-only. Ordinary chat and subagents stay unaffected. This **supersedes** the earlier one-shot activation command. |

## Settings surface

### Navigation and identity

- Path: native OMP `/settings` → Plugins tab → npm plugin **`@mstar-harness/omp`**.
- Evidence: Plugins list label for npm entries is `InstalledPlugin.name` (package name); detail overlay title is the same. Do not add a custom settings screen.
- The host plugin-level **Enabled** toggle remains host-owned. If the plugin is disabled, this feature does not run. **Opt-in for model policy is `modelHandoff`, not plugin install and not the Enabled toggle.**

### Native controls (keys are the labels)

The host renders each schema key as the row label and boolean values as `true` / `false`. Product accepts that host constraint (custom title-case chrome would be a forbidden second UI).

| Key / label | Type | Default | Values | Description (schema `description`) |
|---|---|---|---|---|
| `modelHandoff` | boolean | `false` | `true`, `false` | When enabled, each new Morning Star iteration uses `@slow` for Prepare, then switches this coordinator session to `handoffTarget` after Phase 1 fully completes. Off by default. |
| `handoffTarget` | enum | `@default` | `@default`, `@smol` | Coordinator model after a completed Phase 1. Used only when `modelHandoff` is enabled. |

Persistence:

- Preferences are stored through the host plugin-settings path (`PluginManager.setPluginSetting` / effective merged settings). They **survive sessions**.
- No second config file, no project-local competing schema, no harness-owned settings document, no slash-command that enables the feature for one session.
- Merely installing or linking the plugin MUST leave `modelHandoff=false` and MUST NOT change the current model.

### Persisted preference vs session execution state

These are different stores. Mixing them is a product defect.

| Store | What it holds | Lifetime | User-visible effect |
|---|---|---|---|
| **Native saved preference** | `modelHandoff`, `handoffTarget` | Host plugin settings; survives new sessions | Decides whether **later** iteration starts arm the feature, and which target to use when a pending handoff fires |
| **Session execution state** | Bound iteration identity; armed / pending / handed_off / cancelled / failed; one-shot fire | This coordinator session and its durable resume identity only | Decides whether **this** session may still auto-switch |

Enabling `modelHandoff` in an ordinary chat does **not** switch that chat to `@slow`. Arming happens at **iteration entry**, not at the settings-save event.

## Iteration entry (`@slow`)

When `modelHandoff` is `true` at a **new Morning Star iteration start** in a coordinator session:

1. Bind this session to **one explicit iteration identity** (fail closed if missing or ambiguous).
2. Select `@slow` **before** substantive Prepare work.
3. Mark session state **pending** (handoff not yet fired).

When the feature MUST stay inert:

- `modelHandoff` is `false` or unset (schema default false).
- Ordinary chat, unrelated commands, audits, standalone plans, other hosts.
- Leaf / subagent sessions (including spawned task agents).
- Scoped-plan PM sessions (non-goal for this slice).
- A session that is not the bound coordinator for that iteration.
- An already-started iteration whose coordinator never armed (enabling the setting mid-flight does **not** retro-inject `@slow` or schedule a handoff for that in-flight iteration). The next new iteration will apply.

`/iteration-loop` is still an iteration start: `@slow` for Prepare, then the Phase 1 handoff before Execute continues. The feature is not a `pause` flag; after a successful handoff, Phase 2–6 continue on `handoffTarget`. PR merge stays manual.

Concrete entry forms and their actual observation coverage are pinned in § Architecture review. A visible command string is not workflow ownership, and a natural-language start must not be silently excluded.

## Full Phase 1 handoff

Pending + bound + `modelHandoff` still `true` + not cancelled + not already fired → select `handoffTarget` **only when all of the following are true**:

1. Sequential specialist Review & Edit returns (product, architect, writing) for this iteration.
2. PM lock (`compass` status `locked` and Prepare gates recorded).
3. Dedicated integration worktree exists and matches the recorded integration branch.
4. Required push of that integration branch is complete.

Negative cases (MUST NOT hand off):

- Draft or `active` compass; lock without worktree or push; mismatched branch; another workflow's artifacts; `evaluatePhaseGate` Phase 2→3/4 `ok` (wrong gate); mutating goal status or workflow lifecycle to fake readiness.

Read `handoffTarget` and `modelHandoff` at **fire time**, not only at arm time:

- Changing `handoffTarget` before fire changes the destination.
- Turning `modelHandoff` off before fire **skips** the automatic target switch (does not revert `@slow` already applied). This is disarm-by-preference, not a manual-model cancel.
- Turning `modelHandoff` back on before fire, if this session is still pending and not cancelled, allows fire. Cancelled stays cancelled for this session + iteration.

Successful fire is **one-shot**. Do not switch again for that binding.

## Coordinator-only ownership

- Only the bound coordinator session changes model.
- Do **not** rewrite saved model-role mappings, thinking-level settings, subagent model policy, or other sessions.
- New sessions keep the user's configured roles (they start as configured; they arm only if they themselves start a new enabled iteration).
- Multiple active workflows: bind explicitly. **Never** first-entry, most-recent, latest-mtime, `workflows[0]`, or "the unique new row" inference. Fail closed and stay inert when ownership is missing or ambiguous. Concurrent iteration `iter-20260916-plan-lifecycle-closure` MUST remain untouched.
- Do not change goal objective/status or workflow snapshot status to force the handoff.

## Cancellation

The confirmed rule is: **a manual model change while the handoff is waiting cancels the not-yet-executed automatic target switch** for this session + iteration.

- Covers completed native picker and role-cycle changes during `pending`. The final cancellation observation occurs before the state transitions to `attempting` and before `pi.setModel` is invoked.
- Same-model reselection and transactional withdrawal of an already invoked asynchronous model action are **not** locked requirements. Do not describe either as part of the six user decisions.
- Without an attributed selection event, conservatively cancel on a new unowned `model_change` entry or a live model differing from the armed baseline. This can also cancel for another extension or host-driven change; describe that safety bias honestly instead of claiming exact user provenance.
- The extension's own `@slow` arm and its own later target switch MUST NOT count as cancel.
- Cancel does **not** clear `modelHandoff` or `handoffTarget`. Later new iterations still auto-apply.
- After cancel: keep the user's selected model; do not later overwrite it for this binding.
- Cancel after a successful handoff does not undo that handoff; there is no pending switch left to cancel.

## Resume

| Situation | Required observable result |
|---|---|
| Same coordinator session resumes, still `pending` | Restore the pending binding; do not call `setModel(@slow)` again. Honor a recorded manual selection and only hand off after complete readiness |
| Same session, already `handed_off` | Do not re-enter `@slow` or fire again; do not undo later user choices or the host's explicit tree navigation |
| Same session, `cancelled` | Keep the actual user-selected model; do not re-arm this iteration |
| Same session, `failed` | Keep the actual model; do not retry in a loop; do not claim success |
| Reload / branch / tree reconstruction | Reconstruct ownership from the session ID and full entry ledger, not only the active branch. A fork with a new session ID does not inherit the old session's authority |
| Different session | Cannot inherit this session's pending/fired flags. A new coordinator starting a **new** iteration with settings still on arms a **new** binding |

The read-only session API exposes both `getBranch()` and `getEntries()`. Use full entries for terminal state, with exact session-ID filtering. A durable attempt without a confirmed outcome restores as `uncertain`, never retries, and never claims a successful handoff merely because the current model matches. This at-most-once recovery does not require an atomic model-plus-entry transaction.

## Failure visibility

Every failed model action or refused handoff MUST be visible to the coordinator (durable session-visible notice or equivalent host-visible report — **not** log-only). Keep the **actual** current model. Never claim success. No automatic retry loops.

| Failure | Model | Session state | Later automatic target switch |
|---|---|---|---|
| Cannot resolve or select `@slow` at entry | Unchanged | `failed` (not pending) | MUST NOT fire (would overwrite the user's actual model) |
| Unbound / ambiguous iteration at entry | Unchanged | inert / fail closed | No |
| Full Phase 1 not reached | `@slow` if arm succeeded | `pending` | No until ready |
| `modelHandoff` false at fire time | Unchanged (`@slow` if already applied) | `pending`, action suppressed by current preference | No while disabled; re-enable may fire only if still pending and not cancelled |
| Cannot resolve or select `handoffTarget` | Unchanged | `failed` | No retry loop |
| Missing auth / model API false | Unchanged | `failed` | No retry loop |

Do not mutate credentials, user config files, or installed host configuration to "fix" a failure.

## Acceptance Criteria (observable)

Compass AC1–AC8 remain binding. Mapping:

| ID | Observable result | Persist vs session | Task coverage |
|---|---|---|---|
| AC1 | Native controls and saved settings survive new sessions without another file/UI/activation command. The supported user-scope native path works; project-only UI discovery is a documented host limitation, not a user-locked parity requirement. | **Persist** | T1, T4 |
| AC2 | Enabled new iteration selects `@slow` before substantive Prepare; excluded contexts stay inert; failed arm cannot overwrite later. | Session action gated by persist | T2, T3; entry binding boundary E1 |
| AC3 | One explicitly named workflow and control root own the coordinator; no inferred selection among active workflows. | Session | T2, T3 |
| AC4 | Handoff requires reviewed artifacts, PM lock, distinct matching integration checkout and verified required push. | Session, existing facts | T2, T3; readiness evidence boundary E2 |
| AC5 | Session-local one-shot/cancellation survive reconstruction; an interrupted recorded attempt becomes uncertain and never retries; forks inherit no authority; later new iterations use the saved preference. | Persist ≠ session | T3 |
| AC6 | A completed manual model change during pending prevents the not-yet-started target action; conservative unowned-change cancellation is disclosed. No transactional cancellation promise for an already invoked action. | Session; persist unchanged | T3 |
| AC7 | Effective settings, lifecycle, bundle discovery and model action have isolated consumer-facing evidence; no real credentials/configuration are touched. | Evidence | T1–T4 |
| AC8 | OMP guidance and one bilingual fragment describe the actual supported contract, not prospective APIs. | Docs | T4 |

## Target State

Native opt-in settings plus a reliable coordinator-only Prepare-to-Execute handoff, without OMP core patches, duplicated lifecycle truth, or a second settings system.

## Roadmap / Release Slices

- **This iteration:** retain the native persistent settings + coordinator handoff requirement in one business plan.
- **Selected local approach:** exported settings reader, conservative pending-state model observation, cancellable navigation guards and attempt-before-action recovery. No upstream patch is a prerequisite merely to obtain same-model reselection or transactional undo.
- **Precise limitations:** B1 lacks exact change provenance and cannot withdraw an already invoked `setModel`; B2 hides a project-only npm plugin from native settings. These facts remain documented. If PM wants stronger semantics or project-only parity, that is an explicit additional scope choice, not repair of a broken user decision.
- **Next iteration:** no new feature batch is proposed. Other hosts and generalized triggers stay non-goals.

## Deferred Scope and Tracking

No confirmed product requirement is deferred or removed. E1/E2 integration closure and T1–T4 remain tracked in the main plan. The added atomicity/project-parity requirements have been withdrawn, not deferred into an implicit upstream project.

## Non-Goals

- OMP core changes; arbitrary custom-goal rules; model cost telemetry; alternate settings UI; activation command (superseded); new global model roles or thinking controls.
- Other hosts; scoped-plan PM sessions; standalone plans; subagent model policy.
- Automatic PR merge; broad package upgrades; unrelated doctor/gitignore repairs; mutating the concurrent plan-lifecycle iteration.
- Claiming this in-development feature already switched the current implementation session.
- Writing private user configuration or credentials.

## Priority

P1 for the OMP in-process binding deepening goal; this is the current iteration's only business plan.

## Effort (agent-oriented)

Conditional implementation tasks: T1 S, T2 M, T3 M, T4 S; each must close in one focused implementer round. These estimates do not authorize implementation before the blocked gate is resolved.

## Prepare Package (Product)

### Specify

- **Problem:** Coordinators need an opt-in, persistent way to spend `@slow` on Prepare and continue the same session on `@default`/`@smol` after Phase 1, without core patches or role-mapping writes.
- **User value:** One native settings change; automatic on every later iteration; user override still wins for the current session.
- **Scope:** `packages/omp/` settings + extension behavior + OMP host guidance / packaging / bilingual changelog fragment.
- **Non-goals:** listed above.
- **Target state:** listed above.
- **Roadmap if split:** no partial product release; resolve the explicit architecture prerequisites before implementing the complete slice.
- **Draft DoD:** AC1–AC8 observable; no silent model changes when disabled; no role-mapping writes.

### Clarify

- **Open questions:** none that require the user. Six interactive decisions stand.
- **Decisions:** the six locked rows, plus derived rules in this spec (persist ≠ session state; arm at iteration entry not at settings-save; fire-time re-read of settings; failed `@slow` does not leave a pending overwrite; mid-flight enable does not retro-arm).
- **Still open:** E1/E2 local integration contracts. B1/B2 remain source facts with documented limits, not automatic upstream blockers under the actual confirmed requirement.

## Architecture review — 2026-09-16

### Clarify validation and decision

- **Inputs checked:** the product-edited spec, plan, compass and prepare-context; current repository Phase 1 command/skill contracts and plan-quality-bar; the read-only upstream checkout at `/Users/bibi/workspace/ai/oh-my-pi`.
- **Upstream baseline:** `packages/coding-agent/package.json:3-4` declares `@oh-my-pi/pi-coding-agent` **18.2.1**. This identifies the inspected source version, not a verified npm release or installed runtime. No build, runtime probe, test or validation command was run.
- **Option A — recommended:** native settings + explicit PM binding + read-only artifact/Git readiness; conservative cancellation while pending; short navigation exclusion around an invoked model action; attempt-before-action with uncertain/no-retry recovery.
- **Option B — not required by the user:** attributed host selection events, atomic expected-session/user-revision actions, same-model-selection cancellation and project-only native-UI parity. Do not mandate upstream work for these enhancements.
- **Gate Decision: blocked on E1/E2 integration closure**, not “host impossible.” B1/B2 alone no longer justify an upstream-blocked verdict. Writing/PM lock are not complete.
- The separate Phase 2 parallel-opportunity / multi-instance research requested during this review is not incorporated here. Main owns any later scope amendment.

### B1 — actual host limitations and bounded local solution

Evidence paths below are relative to upstream `packages/coding-agent/src/`:

1. Public event overloads (`extensibility/extensions/types.ts:1262-1317`) have no model-selection event; `session/agent-session.ts:8931-8958` explicitly excludes internal `model_changed` from extension delivery.
2. Temporary picker (`modes/controllers/selector-controller.ts:934-935`), role picker (`:1113-1116`), role cycling (`session/model-controls.ts:372-397`) and scoped cycling (`:422-444`) write `model_change` history through their normal successful paths.
3. `session/session-entries.ts:103-110` exposes model/role/fallback, not initiator or operation provenance. Another extension's normal switch is indistinguishable from some user switches.
4. The TUI bridge (`modes/controllers/extension-ui-controller.ts:191-195`) awaits auth before selecting the then-current session; model controls await metadata before assignment (`session/model-controls.ts:229-234`). There is no public cancellation argument on `setModel`.

**Correction to the first review:** a manual change after `setModel` has already been invoked can race that action, but transactional reversal of such an in-flight action was not requested. Same-model reselection also was not requested. These races cannot be used to claim the actual pending-cancellation requirement is impossible.

**Pending observation:** after confirmed slow selection, record the baseline live model and last observed model-change entry ID. While `pending`, scan subsequent full-ledger model-change entries at input, before-agent-start, tool-result/agent-end readiness opportunities, navigation-before events, reconstruction, and a final synchronous check after every asynchronous settings/readiness operation. Any unowned change conservatively cancels; do not infer a user source from `role`. Also compare `ctx.models.current()` to catch a live mutation before its history append. Record terminal cancellation before returning; never reset the baseline to a user's newer model and leave the handoff armed.

Own slow changes occur before `pending`; own target changes occur after `pending → attempting`. Thus no “ignore everything while switching” rule or attribution token is needed for ordinary self-cancel exclusion. If the arm observes conflicting model/history evidence, refuse to enter pending. A final no-await transition to `attempting` defines the boundary between cancelling a waiting action and an action already invoked. History observation is conservative, not an exact immediate user-selection notification. A completed change-away-and-back is caught by history even when the live model matches again.

**Session navigation can be guarded with existing APIs.** `SessionBeforeSwitchResult`, `SessionBeforeBranchResult`, `SessionBeforeTreeResult` expose `cancel?: boolean` (`shared-events.ts:347-372,405-408`). The runner awaits handlers and returns immediately on cancellation (`runner.ts:1387-1405`). Host new/resume/fork/branch/tree paths check that result before changing session/history (`agent-session.ts:8279-8297,8411-8425,9457-9476,9831-9852,10206-10222`).

Use a per-extension in-memory operation gate:
- Set `actionInFlight` synchronously before calling `pi.setModel`; clear only in `finally`. A navigation-before handler seeing it returns `{ cancel: true }` immediately with a visible “model handoff finishing; retry navigation” notice. Do not await the action inside the event handler: extension handler timeouts would otherwise let navigation continue.
- When navigation arrives first, set `navigationPending` and increment a generation before returning. Every asynchronous preparation/readiness callback checks that fence and captured session ID before starting an action. Clear the fence only after the matching post-navigation event and reconstruction. If another extension cancels navigation and no post-event arrives, retain a visible suspended condition rather than guessing navigation finished; reload/reconstruction can recover it.
- This serializes the guarded navigation paths; it does not promise to intercept arbitrary core mutations, plugin unload or process termination. Those remain host lifecycle/failure boundaries, not a reason to add a transactional model API.

**Attempt-before-action is sufficient for normal at-most-once recovery.** Append `attempting` before invoking the action. A restored attempt without a matching outcome becomes terminal `uncertain`; do not replay it and do not restore any old model. `session-manager.ts:1516-1531,2865-2868` records the entry before returning; file-backed hot-path appends reach the OS page cache synchronously (`:1323-1337`). There is a real storage caveat: fresh sessions can defer file creation (`:1269-1274`), persistence failures are non-throwing, and indexed storage can defer publication (`:1338-1357`); `ReadonlySessionManager` does not expose flush/error observation. Therefore claim **at-most-once per persisted attempt under normal session persistence**, not exactly-once or power-loss/storage-failure durability. No stronger storage guarantee was confirmed by the user.

**Minimal decision if stronger behavior is desired:** exact manual-only attribution (rather than conservatively cancelling other changes), cancellation after invocation, or guaranteed progress despite uncertain recovery requires an explicit extra requirement. The recommended local design prioritizes not replaying an uncertain switch and does not require such an upstream enhancement.

### B2 — project-only npm install is not listed by native settings

`extensibility/plugins/loader.ts:198-238` discovers user **and project** npm roots and lets project packages shadow user packages. In contrast, `modes/components/plugin-settings.ts:657-688` constructs npm rows from `new PluginManager(cwd).list()`, and `extensibility/plugins/manager.ts:757-783` enumerates only `getPluginsPackageJson()`, the user runtime config and `getPluginsNodeModules()`. A project-only npm install therefore has no native row through this path. The separate marketplace list does not make a project npm install a marketplace entry.

The exported settings helper (`loader.ts:443-450`) reads the **user** runtime settings plus project `plugin-overrides.json`; it does not merge settings from the project npm root's `omp-plugins.lock.json`. The UI setter also writes the user runtime lock (`manager.ts:137-150,917-923`). Installation scope and preference scope are not interchangeable.

**Correct classification:** this is a real installation-scope limitation, but “project-only npm native UI must be identical” was added by the first architecture review, not agreed by the user. Use the existing user-scope native settings path and host-owned preference store; document that a project-only package is not currently listed by that panel. A project runtime may still consume the host's saved preference via the exported helper. Do not silently install another copy, edit host files, add a second UI or treat project npm lockfile settings as supported. If native project-only configuration is later required, record that separate scope choice.

### Verified existing public interfaces

These signatures are available in the inspected source and support the bounded local approach. They do not provide the stronger semantics explicitly excluded above.

```ts
// @oh-my-pi/pi-coding-agent/extensibility/plugins
getPluginSettings(pluginName: string, cwd: string): Promise<Record<string, unknown>>;

// ExtensionContext.models
resolve(spec: string): Model | undefined;
current(): Model | undefined;

// ExtensionAPI
setModel(model: Model): Promise<boolean>;
appendEntry<T = unknown>(customType: string, data?: T): void;

// ExtensionContext.sessionManager (ReadonlySessionManager)
getSessionId(): string;
getEntries(): SessionEntry[];
getBranch(fromId?: string): SessionEntry[];
```

`extensibility/plugins/index.ts:5` re-exports the helper; `package.json:301-323` exports extension/plugin subpaths. `extensibility/extensions/model-api.ts:19-35` delegates role aliases to the host resolver. Do not require `modelRegistry` mutation or parse role settings. `setModel` has no persist option; normal success updates session history without rewriting role mappings (`session/model-controls.ts:215-254`). Host model defaults may change thinking; this feature adds no thinking write. A thrown error is not proof that no mutation occurred: model assignment precedes later awaited synchronization. On error, report `ctx.models.current()` and never “roll back” speculatively.

### Native preference reader and package boundary

New local module `packages/omp/src/model-handoff-settings.ts`:

```ts
export type HandoffTarget = "@default" | "@smol";
export type HandoffSettings = Readonly<{
  modelHandoff: boolean;
  handoffTarget: HandoffTarget;
}>;
export type HandoffSettingsResult =
  | { ok: true; value: HandoffSettings }
  | { ok: false; reason: "settings-read-failed" | "invalid-settings"; message: string };
export function decodeHandoffSettings(raw: Record<string, unknown>): HandoffSettingsResult;
export function readHandoffSettings(cwd: string): Promise<HandoffSettingsResult>;
```

Reader calls the exported helper with the constant package name `@mstar-harness/omp`; defaults apply only when a key is absent (`false`, `@default`); present malformed values refuse the action visibly. No long-lived `PluginManager`: its `#ensureConfigLoaded` caches user settings. The helper rereads on every call, so re-read at entry and immediately before fire; no “reload required” excuse for stale preferences. Do not arm at a settings-change callback. Setting off suppresses action without making pending terminal; explicit manual cancellation remains terminal.

Manifest entries:

```json
{
  "omp": {
    "settings": {
      "modelHandoff": {
        "type": "boolean",
        "default": false,
        "description": "When enabled, each new Morning Star iteration uses @slow for Prepare, then switches this coordinator session to handoffTarget after Phase 1 fully completes. Off by default."
      },
      "handoffTarget": {
        "type": "enum",
        "values": ["@default", "@smol"],
        "default": "@default",
        "description": "Coordinator model after a completed Phase 1. Used only when modelHandoff is enabled."
      }
    },
    "extensions": ["./extensions/model-handoff.js"]
  }
}
```

Merge these keys into the existing manifest; preserve its current name/description. Include `extensions/` in the package `files` allowlist and emit the entry from `src/extensions/model-handoff.ts`.

Factory contract: `export default function modelHandoff(pi: ExtensionAPI): void`. Use type-only OMP imports where possible. Keep runtime host imports external with `--external '@oh-my-pi/*'`; packed-artifact evidence must prove resolution to the running host, including compiled-host loading, rather than merely absence of copied source. Keep `@mstar-harness/engine` inline. Do not install a second runtime host dependency. The inspected 18.2.1 source is the design baseline; select a published peer range only after the affected exported APIs and packed-loading path are verified. No hypothetical future atomic-model or project-UI release is inherently required.

### E1 — explicit entry and workflow binding

| Entry | What is actually observable today | Required integration boundary |
|---|---|---|
| TUI `/iteration-start [direction] [pause]` | `input` sees original text before Markdown expansion; `pause` changes continuation, not arming | New coordinator start; PM names workflow before substantive Prepare |
| TUI `/iteration-loop [direction] [scale]` | Same input hook; command is autonomous Phase 1→6 | Same binding, regardless of scale |
| Natural-language start / direct `mstar-iteration` loading | Only arbitrary text or later skill reads; no exported semantic “iteration-start” event | PM must issue an explicit host-only start binding as its first preparation action; no prose classifier |
| `/iteration-drive` with no args | Existing command starts at Phase 2; **not** a new-iteration form | Restore an existing same-session binding only; never retro-arm |
| `/iteration-drive --assignment`, `--workflow … --plan …`, `--resume …` | Scoped-plan PM route | Excluded; never arm |
| Print/JSON startup, RPC input, extension-generated prompts | `InputEvent.source` names some origins, but the verified TUI pre-expansion path does not establish equivalent coverage | No supported automatic behavior claim until each requested mode has a verified entry/identity path |

Evidence: upstream `input-controller.ts:869-875,908-932` skips focused-agent chat then emits input; `agent-session.ts:6331-6359` expands commands later. Local `commands/iteration-start.md:15-23`, `iteration-loop.md:12-41`, `iteration-drive.md:24-32` own command semantics. Matching command names must not shadow/replace those commands or consume their arguments.

Proposed local PM tool name is `mstar_model_handoff`, not a user activation command. Its binding input is below; E1 still requires the exact first-action/identity adapter to be finalized. A tool description saying “PM only” is not itself caller-identity enforcement.

```ts
export type HandoffEntry = "iteration-start" | "iteration-loop" | "skill-start";
export type HandoffBindingInput = Readonly<{
  workflowId: string;
  entry: HandoffEntry;
}>;
export type HandoffBinding = Readonly<{
  sessionId: string;
  workflowId: string;
  controlRoot: string;
  harnessRoot: string;
  snapshotPath: string;
  compassPath: string;
}>;
export type HandoffBindingResult =
  | { ok: true; binding: HandoffBinding }
  | { ok: false; code: "not-coordinator" | "already-bound" | "invalid-workflow" | "invalid-root"; message: string };
```

The adapter obtains session identity and cwd from the host, never tool arguments. Validate an explicit safe workflow ID **before** any lifecycle reads. Use `readMainWorktree(cwd)` to derive the control root, then `resolveHarnessDir(controlRoot)`, `resolveWorkflowDir(controlRoot)` and `resolveIterationDir(harnessRoot)`; do not use `dirname(harnessRoot)` or a feature checkout's ignored artifacts. Read only the named root entry/snapshot/compass; validate root/snapshot/compass identities, lifecycle type `iteration`, nonterminal state, registered plans and branch anchors. Reject path traversal and conflicting compass refs. Do not inspect other entries to guess intent.

New iterations do not yet have all artifacts before Prepare. A PM start binding can reserve the explicit ID in session-local state before artifact creation, but cannot falsely call it validated or ready. Artifact validation is a separate mandatory step before target fire. It must not write/register the workflow itself or auto-adopt a pre-existing in-flight iteration. The start input/PM protocol must prove “new” and coordinator scope; currently no shipped adapter does so. This ordering, the exclusion of child/scoped PM sessions, and coverage of non-command starts are E1's acceptance boundary. Do not silently restrict support to slash commands.

### E2 — complete readiness, not a new lifecycle flag

Reusable engine signatures: `readWorkflowSnapshot(dir: string): WorkflowSnapshotRead`, `validateWorkflowSnapshot(doc: unknown): GateResult`, `parseCompassFrontmatter(filePath: string): Record<string, unknown>`, `validateCompassFrontmatter(doc: unknown): GateResult`, `readMainWorktree(cwd?: string): MainWorktreeInfo | null`, `isDistinctCheckout(controlPath: string, candidatePath: string, opts?: BranchProbeOptions): boolean`. `resolveWorkflowDir` takes a **start directory**, not a harness directory. Read normalization is not validation; inspect returned diagnostics and reject invalid/conflicting state.

`WorkflowSnapshot` (`packages/engine/src/workflow.ts:99-123`) carries branch anchors and `integration_worktree_path`, but no typed specialist-return, per-plan Prepare-lock or push receipt. `execution_policy.push_policy` is accepted-but-opaque (`:66-69`), not an approved push waiver. `evaluatePhaseGate` (`iteration.ts:462-498`) evaluates later phase transitions and MUST NOT be used here.

Required readiness is a conjunction, evaluated against this binding:

1. Valid named root entry, snapshot and compass; workflow ID/type and compass registered plans agree; lifecycle still active; no ownership mismatch.
2. Sequential product → architect → writing completion and edited artifacts for this iteration, plus PM-confirmed Prepare gates for every plan and compass `status: locked`. A lock alone, arbitrary assistant prose or caller-supplied `reviewed: true` cannot establish those facts.
3. Snapshot/compass base, integration and target anchors agree. The recorded integration path exists, belongs to the same Git common repository, is a distinct checkout from control, and its actual branch equals `branch.integration`. Main checkout residency also matches its recorded branch. `isDistinctCheckout` alone does not prove same repository or correct branch.
4. Required integration push: resolve actual integration `HEAD`, configured upstream remote/ref, and query that remote ref (`git ls-remote --exit-code <remote> <ref>`) successfully; require the remote tip equals the validated local HEAD. A cached remote-tracking ref, prior `git push` text, or merely configured upstream is not proof. No remote/missing ref, query error, divergence or unpushed commit means not ready. No push waiver is defined for this slice.
5. Recheck identity/settings/cancellation and navigation generation immediately before `pending → attempting`; changed sampled artifacts or branches invalidate readiness. Do not claim an atomic lifecycle-plus-model transaction.

**E2 evidence gap:** current compass checkboxes are prose and the engine has no typed Review & Edit-return/Prepare receipt. A host-only readiness call can validate artifact/Git facts, but accepting unverified booleans would create a second untrusted lifecycle truth. Before lock, PM must select a concrete existing evidence reference format or approve a bounded typed receipt adapter tied to native settled task results and artifact versions. No new workflow status or “phase1Done” boolean may replace the real facts. This is not permission to omit specialist returns.

Proposed result interface (no unchecked success constructor or ready flag setter):

```ts
export type Phase1Readiness =
  | { ready: true; binding: HandoffBinding; integrationHead: string }
  | { ready: false; codes: readonly (
      "binding-invalid" | "review-evidence-missing" | "prepare-not-locked" |
      "worktree-invalid" | "branch-mismatch" | "push-unverified" | "evidence-changed"
    )[] };
export function inspectPhase1Readiness(binding: HandoffBinding): Promise<Phase1Readiness>;
```

`inspectPhase1Readiness` is a new **plugin-local** function, not an existing engine export. Until E2's evidence adapter is defined it cannot legitimately return `ready: true`; do not implement an always-false placeholder or ship a permanently inert feature.

### Durable state and action ordering

Store only execution ownership and action outcomes using `pi.appendEntry("mstar:model-handoff", data)`; never write role settings, goal state or workflow lifecycle. Minimal payload:

```ts
export type HandoffRecord = Readonly<{
  version: 1;
  binding: HandoffBinding;
  state: "pending" | "attempting" | "handed_off" | "cancelled" | "failed" | "uncertain";
  operationId: string;
  action: "arm" | "handoff";
  baselineModelChangeId: string | null;
  observedModel: string | null;
  reason: string | null;
}>;
```

`operationId` is a plugin-local attempt ID, not host provenance. `action` distinguishes slow arming from target handoff. The baseline cursor is the last consumed model-change entry ID in the full ledger; a missing referenced cursor on reconstruction is uncertainty, not permission to reset observation.

- Replay full `getEntries()` in recorded order with exact session-ID filtering. Same-session tree navigation cannot resurrect a terminal binding; fork/new IDs cannot borrow ownership.
- Reconstruct on session start/switch/branch/tree/reload without changing the model. An `attempting` record with no terminal outcome becomes `uncertain`, reports the actual model and never automatically retries.
- Arm sequence: reserve explicit new-start ownership, append arm-attempt, invoke slow selection once, and enter pending only after success with nonconflicting model/history evidence. Failure or uncertainty does not leave pending.
- Fire sequence: re-read settings and readiness, check session/navigation generation, scan pending model changes, synchronously append a handoff attempt, then call `pi.setModel` once under the navigation guard. Confirm success with `handed_off`; false/throw reports actual state as failed, without restoration.
- Own arm and handoff writes cannot cancel a pending action because they occur outside its pending interval. Unowned changes during that interval conservatively cancel.
- Setting off suppresses but does not terminalize pending; re-enable can allow a still-pending action. Cancelled/failed/uncertain/handed-off bindings cannot be rearmed by settings edits or reconstruction.
- Never retry or infer success from a matching model string after an interrupted attempt. At-most-once depends on the attempt having been persisted; the existing API does not certify storage-failure/power-loss durability.
- Failure notices state the actual model and reason; do not hide them in logs or “roll back” a newer user choice.

### Verification boundary and handoff

No validation was run in Prepare. Future scoped cases must cover pending picker/cycle cancellation and completed change-away-and-back, conservative external-change cancellation, both orders of guarded navigation versus action startup, persisted attempt/no-outcome recovery, native user-scope settings persistence and the documented project-only limitation. Do not require same-model reselection or cancellation after `setModel` invocation as if the user had selected them. E1/E2, writing review and PM lock still remain before implementation.
