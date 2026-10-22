# Changelog

Chinese summary: [CHANGELOG_CN.md](CHANGELOG_CN.md).

All notable changes to this repository are documented here. Every published harness surface ships the same version.

Package-specific histories: [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md), [`packages/opencode/CHANGELOG.md`](packages/opencode/CHANGELOG.md), [`packages/engine/CHANGELOG.md`](packages/engine/CHANGELOG.md).

## [Unreleased]

## [4.0.5] - 2026-10-22

### Harness

- **dsh publishes three native tools again; every other mstar command is an MCP family action.** The native surface drops from fifteen tools to three and keeps only what the MCP route cannot do — `mstar_plan_bind` (the sole writer of the dsh-local durable `executionBinding` slot and its adoption receipt), `mstar_audit_validate` (the review-report credential scan, which no `mstar_audit` action publishes) and `mstar_execution_clear` (no shared `execution.clear` command). The twelve removed mirrors duplicated an MCP tool 1:1 and cost ~10k characters of fixed context per request; the earlier `dsh native-command-surface` fragment's named-writable set is superseded by this one. **One exception to the 1:1 claim:** the removed compound-validate mirror also published a dsh-only `repo_root` reference-existence check that `compound.validate` does not carry, so that capability has no MCP twin (it belongs to the `mstar-compound-refresh` write seam).
- **Holding an old tool name?** There is no alias and no compatibility tool, and none is planned: call the folded family instead — `mcp__mstar__mstar_<family>` with the matching `action` (the old `mstar_plan_prepare` spelling becomes `mstar_plan` + `action: "prepare"`, and so on) — and read a family's real actions and fields with `mcp__mstar__mstar_schema` (`"action": "schema"` plus `family: <name>`, or `command: <family>.<action>` for one leaf contract). Across the MCP server the same fold took `tools/list` from 113 tools / 173,340 characters of description plus input schema to 33 tools / 32,670 characters.
- **The model-facing `<mstar_engine_status>` row is one delta line.** Measured on the richest payload: 899 characters / 15 lines → 212 characters / 3 lines. It carries the selected workflow, its non-Done plans, the branch anchors and the phase-gate verdict; the residuals rollup, branch policy, spec-integration anchor, plan row scopes, knowledge digest, compass direction and agent-flow ledger are payload-only (the panel renders them) and stay readable from the engine authorities. One disclosure survives: when the issue authority could not be READ at all, the row renders a fixed `issues: unavailable (…)` line naming the cause and the recovery — failure-only, so a readable authority renders nothing and no count bump can move it, which keeps an unreadable rollup distinguishable from an empty one. The always-on system-prompt digest keeps the version, the active workflow, its non-Done plans, the branch anchors and the gate verdict, so a row-less step is never factless.
- **Skill descriptions are trigger contracts again.** All 24 `skills/*/SKILL.md` frontmatter descriptions were cut from 11,281 characters to 4,242 (longest file 932 → 198) by removing methodology summaries, phase lists and path enumerations the body already owns — every trigger word that makes a skill discoverable is kept. The dsh Agent Teams reference now also states the report budget: durable conclusions live in files, a teammate reply is status + artifact path + a short summary under ~15 lines / ~1,200 characters, because the lead re-reads every reply on every later turn of its session (measured: 110 replies / 240k characters in one session).
- **Several ACTIVE lifecycles no longer stall a session's writes.** The dsh selection resolver refused every lifecycle-scoped operation with `workflow.selection.unbound-multi-active` whenever more than one lifecycle was active and the session cwd matched several of them — the ordinary parallel-worktree case. It now resolves a new rung between the session's explicit pick and the single-entry tail: **the plan row the operation names** (`Plan Path` / `SDD dir` on an Assignment, `--plan` on a command). A plan row belongs to exactly one lifecycle, so naming it identifies its owner with no pick and no discriminating cwd. An explicit pick still outranks it, so a pick that names a lifecycle WITHOUT the requested plan row surfaces its own `lease.dispatch.plan-not-found` instead of silently switching lifecycle, and a plan id no lifecycle holds stays unresolved rather than guessed.
- **The refusal is scoped to one operation, not a session pause.** When no rung applies the error now lists the active ids and the ways to name one (`--workflow`, a plan row, a worktree) instead of declaring that writes are paused; every other operation keeps working and one session can drive several lifecycles by naming the plan on each call.
- **Agent Teams is the default delegation channel when mounted.** The host rules presented the channel as a shape filter ("one-shot Assignment → `subagent`", "not for isolated writable tracks"), so a multi-task plan with independent writable tracks was forced onto serial `subagent` dispatches even where the Team layer was loaded. Mounted Agent Teams is now the starting channel: the plan's tasks go on the board first, then one teammate per track. `subagent` is the documented fallback when the layer is absent (or for a one-off seat the board does not track), and `workflow` stays the read-only fan-out surface.
- **Parallel writable tracks are a Team workload.** A teammate is a subagent child carrying the ordinary agent toolset, so the channel's missing `cwd` field means a shared STARTING directory, not an inability to isolate. The worktree procedure still owns checkout creation (one writable seat per worktree, L2); the Lead hands each member its absolute checkout path **in the prompt** and records the repository-relative prefixes it may modify in the task's `write_scopes` — that field is workspace-relative and refuses absolute paths, so a checkout path never goes there.
- **Every execution section now follows the same channel.** The PM dispatch, SDD implement and 1–2-seat sections previously instructed one `subagent` call per Assignment regardless of the mounted profile, which contradicts a Team-mounted toolset where the direct rows are disabled; they now name the mounted channel and keep `subagent` as the direct-profile shape. The dispatch-gate table also lists the Agent Teams carriers it already covers.
- **Exactly one gated carrier per Assignment.** All four Team calls are dispatch carriers (`spawn_teammate.prompt`, `team_task_create.description`, `team_task_update.description`, `send_message.message`), and both failure directions are now closed: a board row repeating the `## Assignment` header recorded a SECOND dispatch (one that never settles, leaving a permanently unresolved duplicate), while a teammate reused on a track was steered header-free with no carrier at all — so the later task's field, lease and worktree gates never ran and nothing was recorded. The board `description` is coordination text (ids, scope, acceptance) in every case, and each task's Assignment rides exactly one carrier: the track's first task in the `spawn_teammate` prompt, every later task on that track in the `send_message` that starts it.
- **Seats are budgeted per track, not per task.** The roster is finite and has no removal operation, and a Team profile disables the direct `subagent` rows — so a "fresh teammate per task" policy exhausted the roster mid-plan and left the remaining mandatory implementation and review work undispatchable. One durable teammate now owns one writable track and is reused across that track's tasks via `send_message`; task reviewers take no seat and run as fresh-context `workflow` single seats, which keeps review isolation without touching the roster. Team width is budgeted against `maxMembers` before the first spawn, with a documented at-cap recovery instead of a ninth spawn attempt.
- **A one-seat read-only `workflow` run is a supported route.** Routing task reviews off the roster only works if the reviewer has somewhere to go: the host contract reserved `workflow` for N≥3 and a Team profile disables the direct `subagent` rows, so the promised no-roster path had no legal carrier. The contract now states that a single read-only seat may run through `workflow` when no direct delegation can carry it — the cost is one `workflow-run` node instead of a subagent card — while writable fan-out still never uses it (no per-child pre-start veto seam).
- **The single-seat template is Mode A with the canonical report payload.** The first version of the template selected `code-reviewer` Mode B by carrying `Task category: audit` (the audit executor), and returned only a verdict plus unclassified findings — which cannot express the mandatory Mode A report, and left the caller unable to persist `{SDD_DIR}/task-N-review.md` when the child cannot write. The template now selects Mode A (a non-`audit` category), takes the four Mode A inputs (task brief, implementer report, diff artifact, Global Constraints verbatim), and returns the canonical sections plus a complete `reportMarkdown` the caller persists.
- **The single-seat route now has an executable template.** Stating that a one-seat `workflow` run is supported is not enough while the canonical script reference still told callers to keep every 1–2-seat delegation on `subagent` and shipped no single-seat script — a compliant PM had no documented way to invoke the reviewer route. Added `mstar-review-single` (`dsh-workflow-scripts.md` § 4: `meta`, `args`, `script` and the verdict schema) with a per-task operator table row, and pointed the host rules at it.
- **Review/audit seats declare their round bounds, and a wave moves a member.** Every `workflow` seat template for a review or audit role now carries `Budget (review / QC seats)` and `Return shape (review / QC seats)` — `validateAssignmentFields` requires both for `qc-specialist*` / `code-reviewer` / `qa-engineer` and for any `Task category: audit`, and `workflow` has no per-child pre-start gate, so the omission used to pass silently and the seat ran unbounded. Separately, the oversized-plan recovery no longer claims a completed wave frees capacity: `maxMembers` counts created teammates and the roster is non-recyclable, so the supported move is to `reassign` an idle member to the later track and `send_message` it the new absolute checkout, branch and full Assignment (that steer is the later task's gated carrier).
- **Regression coverage.** `packages/dsh/tests/execution-read.spec.ts` pins the plan-row rung, its precedence below cwd evidence, and the unknown-plan case; `packages/dsh/tests/dispatch-gate.spec.ts` pins an SDD dispatch that resolves its lifecycle from the Assignment alone while two lifecycles are active.
- **ONE shared MCP connection; the per-agent scoped mount is gone.** The dsh bundle's `mstar-mcp` row is the whole MCP channel for the host: the plugin registers no MCP client of its own, and a subagent shares the connection its parent already has. A per-agent instance could never carry per-call arguments (a dsh gate cannot rewrite tool arguments), so it bought no capability — only one Node process per agent.
- **The control root is DECLARED, never inferred.** It resolves in one ordered rule: the launch pin (`mstar mcp --harness <absolute path>`, else a non-blank `MSTAR_HARNESS_DIR`), then the admitted call's `harness` field; `harness.scaffold` keeps its null-root bootstrap exception, the commands whose contract reads no control root (`schema`, `path.resolve`, `host.*`, `doctor`, the read-only validators) run with a null root instead of being refused, and every other call that declares no root is refused with `[mcp.control-root-unresolved]` naming the cause and the recoveries — the two launcher ones are universal, the per-call `harness` selector is tool-dependent. The launch cwd is the HOST's directory and is no longer a root candidate anywhere — adopting it would root writes on an unrelated project. A pin beats a per-call `harness`, and the invocation workspace now anchors on the root actually used, so cwd-derived paths land under the declared harness. The declared root reaches every handler as the RESOLVED harness dir, whichever launcher fact declared it, so a relative `MSTAR_HARNESS_DIR` is resolved exactly once: `harness.scaffold` creates that directory instead of re-reading the variable against the workspace anchor it derived and silently creating a second, different harness.
- **On an unpinned connection `harness` is REQUIRED** on every published tool whose root is not otherwise fixed, so a caller cannot omit the one fact the root resolution needs; a pinned connection keeps the field optional, since the pin is the default.
- **A declared root selector IS the call root, pinned or not.** On an unpinned connection every root selector a command declares reaches the resolver as that call's root — including a non-`harness` one such as `sdd.workspace`'s `controlRoot`, which the transport accepted but never forwarded, so that action refused with `mcp.control-root-unresolved` although the caller named a real root. A pinned connection still replaces `harness` with the pin and removes every other root selector, so the pin keeps deciding.
- **An omitted `harness` on a union input is reported together with the fields admission already refused**, never instead of them: the requirement is computed before the refusal is chosen, so a call that also carries a key the action does not accept learns it in the same response, not one retry later.
- **A root-free command cannot take its answer from the launch directory either.** A null root also leaves the invocation workspace at the server's launch directory, so the members that DEFAULT a path from it now require that input instead, absolutely, on a connection that declared no workspace: `harness.scaffold` (the bootstrap exception admits the null root, never an unnamed directory, so it creates nothing in the host checkout), `roles.validate`, `path.resolve`, `plugin.validate`, `audit.secret-scan` / `supply-chain`, `pr-review.seat-prompt` and `doctor`'s project scope; `pr-review.size` / `post` refuse outright, since their subject IS the checkout and `gh` would resolve the host's repository. A relative value is refused for the same reason — including a required `reportFile` (`pr-review.validate-report`, `qc.validate-report`), which would otherwise be read from the host checkout, `pr-review.tally`'s `findings` payload, which would otherwise settle a verdict about the wrong run, `pr-review.seat-prompt`'s folded-diff file and `pr-review.worktree-cleanup`'s worktree path, which would otherwise aim a delete at the host checkout. ONE refusal reports every such field, so a call that leaves two paths unnamed does not learn them one retry at a time. Every refusal names the cause and the launcher recoveries, `doctor --scope global` keeps working, and an explicitly named workspace (`mstar mcp --workspace`) or a pinned root lifts them all. The whole class is pinned at the COMMAND level by a second classification axis in `test/mcp-harness-root.test.ts`: every root-free command must appear there and is exercised through a real call. Which of its fields are path inputs is declared by hand in `pathInputs`, so a new path field added to an existing command is covered only once it is listed there.
- **The project-root commands read the DECLARED workspace.** `doctor`'s project scope and `plugin.validate` resolve the project around `context.cwd`, so an MCP server launched with `--workspace` (or pinned to a root, whose parent anchors the workspace) diagnoses and validates THAT checkout instead of the host's process directory. A relative `--root` resolves against the same workspace. The CLI is unchanged: its `context.cwd` is where the operator ran.
- **A validator's relative path argument belongs to the DECLARED workspace.** `review.seats` and `worktree.qc-alignment` read their assignment files through the invocation workspace instead of the process's own directory, and every other path the validation family resolves (`lint`, `skill.lint`, `roles.validate`, `design-md.validate`, `compound.validate`, `dispatch.validate`, `qc.validate-report`) is discovered from that same workspace: `mstar mcp --workspace /caller` now reads `/caller`'s files instead of the host checkout's. On a connection that declared no workspace EVERY path input this family reads is declared once for the family and must be absolute: the two assignment inputs, `lint`'s target, `design-md.validate`'s directory, `skill.lint`'s skill directory and `dispatch.validate`'s assignment file all refuse a relative value with the cause and the launcher recoveries, in the same refusal shape as the other launch-directory members. ONE declaration (`pathInputs`) lists those path inputs and is applied once before any handler branch, so every listed input is checked there and none is reachable only inside a branch; a new path field must be added to that table, and the CLI is unchanged (its invocation directory is where the operator ran).
- **The unpinned requirement follows the DECLARED root selector.** With no declared root, the selector a command publishes as its root is REQUIRED, whichever field name it uses: `harness` for most commands and `controlRoot` for `sdd.workspace`, which previously advertised a field as optional that the resolver refused to do without. `tools/list` and admission now agree with the enforcement, and a pinned connection keeps the selector optional because the pin is the default.
- **An operation TARGET is an explicit input too.** `store.execution.export` / `restore-preview` / `restore` require an absolute `harness` naming the store they read or restore, and `path.resolve` requires its start `path` when the connection declared no root: neither is discovered from the launch directory, so an omitted target can no longer read — or, for `restore`, write — the host checkout's own store. `harness` is published as a REQUIRED field on every route, so CLI help, `schema` and the MCP tool contract agree with the enforcement instead of advertising a call that can only refuse. Both refusals name the field and the recovery.
- **The MCP-only identity wiring is retired from the CLI (`mstar mcp`).** `--identity-env`, the declared-identity lock, selector stripping and the connection-wide default session id are all gone. The connection carries no identity and by default accepts none from a caller either: a call that supplies `sessionId` is refused with `mcp.caller-identity-unavailable`, and only an explicit launch opt-in (`mstar mcp --trust-caller-session-id`, OFF in the shipped row) publishes the selector. That refusal is aggregated with the call's other input diagnostics, so one response reports every problem. An operation that NEEDS a session identity runs on the dsh native command surface, where it comes from `exec.agent.id`, or through the CLI — the native tools cover plan bind, audit report validation and execution clear only, so plan prepare/progress/complete are CLI-only today.
- **The host leaf-seat guard reads the folded tool name, never a separator count.** The connection's server name is deployment-owned: it may contain `__`, and `dsh-mcp-client` rewrites a folded name that needs a character replaced or is over its 64-character limit into `<51-char prefix>_<12 hex of the identity hash>`. The guard matches the known mstar family tools instead of splitting on the last separator, so a leaf calling `plan.complete` / `workflow.evidence` on the shared row is refused whatever that row is named — instead of the refusal depending on a `--seat` the shared row does not carry. A truncated name cannot be attributed at all, so a seat-shaped action on one is refused as well (`leaf-seat.unattributed-tool`), naming the recovery: run the operation from the non-leaf coordinating session, and name the row's `serverName` so the folded names stay attributable.
- Updated `packages/dsh/README.md` (+ `.zh.md`, `bundle/README.md`) and `skills/mstar-host/references/dsh.md` to describe the shipped surface.
- **A `create <branch> from <base>` claim records its branch, not the claim.** `plan prepare` resolved `workingBranch` by storing the Assignment's value verbatim, so a row prepared from `Working branch: create feature/x from main` recorded `create feature/x from main` as `metadata.working_branch`; every `source_branch` derived from it then failed the delivery-source comparison and the workflow wedged at completion (`I-000280`). `prepare` now resolves the claim through the engine's single Assignment branch grammar: the documented `create <branch> from <base>` form records `<branch>`, a plain branch name is stored unchanged, and any other multi-word value is refused with `coordination.invalid-input` (field `workingBranch`, the value, and the accepted forms) instead of being recorded as a scope. Already-persisted leases are untouched — a wedged row is recovered by re-running `plan prepare`.
- **Regression coverage.** `packages/engine/src/execution-workflow.test.ts` drives a create-from claim through `prepare` → `progress` → `complete`, asserting the recorded `source_branch` and `Done`, plus the plain-branch and refused-claim cases.
- **Report-only rows now close through the documented route.** `plan complete` refuses with `coordination.invalid-transition` until the workflow records the fulfilment of its registered `completion_policy`, and that refusal now names `mstar workflow evidence` as the recovery instead of asking for the same `plan complete` again. A regression drives a never-prepared `verification/report-only` row `progress` → `complete` → `status workflow-close` to `Done` and a closed lifecycle.
- **Plan-area evidence refusals name the offending payload field.** `assertEvidenceInsidePlanArea` now receives every evidence value with the field that carried it (`qc.reports[]`, `qc.consolidated`, `qa.report`, `evidence_paths[]`, `progress.evidence_paths[]`) and reports `field`, `value` and `allowed` roots in the details and the message, so a prose value or an out-of-area path no longer leaves the caller guessing which member is wrong.
- **`plan complete` publishes the evidence-path rule.** The `qc.reports[]`, `qc.consolidated`, `qa.report` and `evidence_paths[]` schema descriptions and the `--evidence` / `--file` help state that each value is an absolute path to an existing file inside the plan area.
- **Slash-command entries are thin launchers again.** `commands/` shrank from 418 lines / 46.9 kB to 169 lines / 13.6 kB (−71%) by deleting text its owning skills already carry: Phase flow and gate restatements, the Phase 1 pre-integration checklists, tier/verdict/re-review summaries, dsh-only fan-out instructions, executor routing tables and per-step recon/discover/judge/vet prose. Each entry keeps its trigger description, argument parsing, mount order, the entry-specific supplements only it can own (the bundled `grill-me` pointer and its autonomous opposite in `/iteration-loop`, Phase 5 helper discovery, the host-native fan-out pointer) and its report shape; every procedure contract points at its owner (`mstar-iteration`, `mstar-audit/references/*`, `mstar-host`).
- **One home for the Phase 1 completion checklist.** The duplicated block in `/iteration-start` and `/iteration-loop` moved to `mstar-iteration/references/phase-1-prepare.md` §1.6, so phase-gate edits no longer require touching two command files.
- Aligned `docs/commands.md` with the entries (codebase-audit scope/effort args, the test-audit fan-out owner) and removed the stale `iteration-start` §6 cross-reference.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/opencode-v2`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 4.0.5**.

## [4.0.4] - 2026-10-20

### Harness

- **A cross-harness bind's consumers resolve the harness the bind selected.** The workflow-ledger attribution and the native `mstar_execution_clear` tool no longer re-derive the harness from the workspace: both resolve the session's selected root (the root the bind adoption recorded), so a bind naming a different control root is attributed from, and cleared in, THAT root while the workspace root is never written; the ledger target carries its own harness dir so the scan bound and event append act on the binding's store. The selected root is resolved BEFORE the workspace probe: the adoption receipt is read first and the workspace probe only backs a session that never selected an explicit root, so a bind into another control root from a workspace that declares no harness at all is still attributed and cleared (the workspace-first order answered null there, dropped every row of a valid binding and refused the clear). A relative explicit `harness` is resolved against the session workspace exactly as the shared command resolves it, so the stored `harnessRoot`, the receipt and the ledger target all name the absolute root the engine bound in. A bind whose adoption fails AFTER the engine committed now carries the engine-minted session reference in the refusal itself (`data.resumeRef`, with the workflow id and the targeted `harness` root) and states that the seat stays bound, because that failure is exactly the path where the durable slot was never written; and the clear's unreachable-binding `no-binding` refusal names both the cross-root case (a binding adopted into another control root whose in-process receipt a host restart or a plugin reload lost) and the resume re-bind with that original reference and the same `harness` that re-records the selected root before the clear, keeping the no-action case for a session that never adopted one.
- **The `--identity-env` docs state the identity lock.** `bundle/README.md` and `bundle/cordis.patch.yml` no longer describe the declared identity as a per-call-overridable default: a declared channel whose variable resolves a usable session id — one safe path component under the engine's rule — locks the connection (no published session selector, caller-supplied session ids stripped), and per-caller identity is a per-mount fact. An unset, blank or unsafe declaration resolves no identity, keeps the connection generic and is named, with the recoveries, in one launch-time warning.
- **The workflow ledger gates itself in the harness the bind selected.** The binding-readability guard and the exclusion floor still resolved the workspace harness while the append went to the adoption receipt's root, so a cross-harness bind (workspace A, bind to B) gated root B's rows with root A's guard and floor — an unreadable A binding store paused attribution for a valid B binding, and A's floor could drop or admit B's rows. The guard, the floor, the scan bound and the append now all resolve one selected root; the fork cut and the refusal semantics are unchanged. The receipt-loss recovery (module note + the adoption refusal text) now names the working path — re-run the bind as a resume carrying the original session reference and the same `harness` — instead of a plain re-execution bind, which the engine refuses (a live holder's row is never replaced by a bind).
- **Orchestration skill text is channel-neutral on dsh.** The dispatch, SDD, QC, iteration and PM-role guidance no longer assume the `subagent` tool is the only delegation channel: the transport is selected per work shape — one-shot Assignment → `subagent`; multi-seat / role-persistent / multi-round work → Agent Teams (`spawn_teammate` + task board + `wait_agent` + `send_message`); read-only N≥3 fan-out → `workflow` — with caps and wake semantics left to `mstar-host/references/dsh-agent-teams.md` instead of restated per skill. SDD implementer/reviewer dispatches, tri-review QC seats and the Phase 2 loop now run on the active channel; sticky sessions map to durable teammates resumed by name in Agent Teams mode.
- **Wake discipline is a hard rule in `mstar-iteration`.** On dsh Agent Teams, readiness never starts the owner: completing a blocker does not start it, the Lead must `send_message` (or `reassign` + one message) to start the next seat, and inactive is not completion — plan-row evidence is read before recording done. Phase 2 progression tracks child settle notifications on the native-workflow route without assuming a goal-round loop.
- **dsh delegation channels are capability-based, not `subagent`-only.** The engine `ToolSignal` vocabulary and the CLI `host.detect` token list accept the official Agent Teams carriers (`spawn_teammate`, `team_task_create`) next to `subagent`/`subagent_fork`, and `detectHost` reports `dsh` for any of them. Detection order is unchanged (cursor → opencode → omp → dsh → kimi → zcode → codex); the dsh row only gains accepted tokens, and every other row's verdicts stay identical.
- **The dispatch gate covers the Agent Teams tools.** A separate `TEAM_DISPATCH_TOOLS` map (fixed names, no new Config key) resolves each carrier's Assignment text — `spawn_teammate.prompt`, `team_task_create.description`, `team_task_update.description`, `send_message.message` — and routes it through the SAME gate core (shape guard, one hard resolution, advisory/veto vocabulary, lease + worktree + anti-recursion checks) as `subagent`. `DEFAULT_DISPATCH_TOOLS` stays exactly `['subagent','subagent_fork']`. The team branch is terminal for the names it owns, so a deployment that also lists a team name in `Config.dispatchTools` gets ONE decision and ONE ledger row per call, not two. Non-Assignment coordination text, a missing carrier (a status-only `team_task_update`) and a non-string/empty carrier stay silent pass-throughs. A renamed team tool stays out of reach until its fixed name is added (same documented caveat as renamed subagent instances).
- **The agent-flow ledger records team dispatches without a false settle.** A team carrier that produced a dispatch row is never settled at tool return: `spawn_teammate` returns once the member is created, `send_message` only means inbox acceptance, and task-board writes are not delegation completions. The member's own turn is the completion: the roster read resolves the model-facing member name to its child session and the verified `subagent/end` settlement records the mapped outcome (`completed → ok`, `aborted`/`refusal → denied`, `error`/`max-tokens → error`). Every other shape records an explicit `kind: 'continuation'`, `state: 'unresolved'` durable marker instead of a fabricated `ok`. The call pairing key now carries the tool name as well as the session, so a later non-gated call whose per-message id collides can never settle a team dispatch; every team post-execute consumes its entry (bounded state), the member-child map is capped with an explicit marker on eviction, and team calls reserve no call-window catalog slot. With the experimental team service absent, team tools record nothing at all and nothing throws.
- **Documentation**: `skills/mstar-host/references/dsh.md` now describes each delegation channel's shape and the corrected concurrency paragraph (no `run_in_background` requirement), and the new `skills/mstar-host/references/dsh-agent-teams.md` records the team protocol (roster naming, plan-row ⇄ task mirroring, wake discipline, capacity, creation-failure handling).
- **Upgrade notes**: no Config, state or session-format change; an installation without the experimental Agent Teams bundle behaves exactly as before (team-specific paths are optional and degrade to no-ops), and the subagent gate/ledger paths are unchanged. The unresolved-continuation marker is a durable ledger row only — the panel and model views keep their existing event kinds in this change.
- **dsh gains native writable mstar command tools.** The named writable set — `mstar_plan_bind`, `mstar_plan_prepare`, `mstar_plan_progress`, `mstar_plan_complete`, `mstar_workflow_register`, `mstar_issue_add`, `mstar_issue_close` — registers as dsh tools: each calls the shared `@mstar-harness/commands` implementation in-process through its programmatic entry (the same admission + execution path the CLI uses), injects the caller identity from `exec.agent.id` (a session id argument is stripped before admission, so identity is never model-choosable), and surfaces engine refusal envelopes verbatim. No shell anywhere in the path: `executeCommand` runs in-process and the injected effects carry refusing stubs, so a process/dashboard/browser-taking command refuses by construction.
- **A successful native `plan bind` adopts the durable execution binding.** Both bind arms persist the canonical binding slot (the reference must name the carrying session, the engine resume succeeds before any write, and foreign/copied/stale references are refused with the engine's own code verbatim), so workflow-ledger attribution works with no slash command; the user's workflow selection and exclusion floor are preserved.
- **One scoped MCP mount per agent on dsh.** Every non-leaf agent gets its own scoped `@deepseek-ai/dsh-mcp-client` instance whose stdio child carries `MSTAR_HOST_SESSION_ID = agent.id`, so each agent's MCP tool calls are attributed to its own session id and a subagent never inherits the parent's id. The identity attribution costs one stdio child process per non-leaf agent (linear in concurrent non-leaf agents, restarted on HMR reload); leaf seats and deployments without the MCP client pay nothing, and such deployments keep the single shared bundle row. The mount base is the deployment's MStar row selected by the row's OWN identity — the bundle row id, else the MStar server identity in its config (`serverName`, or the `@mstar-harness/cli … mcp` launch args) — never by the MCP client package name alone, because a profile may enable another `dsh-mcp-client` row for a different server ahead of it; when no row is identifiably the MStar row the shipped-row mirror is the base, never another server's row.
- **The `/mstar-execution` slash command is removed — the native path replaces it.** An operator binds with the native `mstar_plan_bind` tool (adoption happens automatically on success) and clears with the new `mstar_execution_clear` tool, which takes no parameters, derives its identity from `exec.agent.id`, preserves the user selection, and refuses with the named `no clearable execution binding` error when there is nothing to clear. The removed command's `run` arm has no native replacement in this change: coordinator sessions launch through the engine's own `session run` path instead.
- **An identity-locked MCP connection refuses identity override.** A server launched with `--identity-env` (a scoped per-agent mount) publishes no session selector on its tools and strips a caller-supplied `sessionId` before admission, so every call runs under the connection identity the launcher declared — a caller can no longer pass a valid foreign session id and act inside that identity's authority. Generic unbound connections keep the documented per-call `sessionId` selector. A locked connection always has a resolved identity: a declared channel whose variable is unset or blank resolves no session id, so that connection stays generic (the per-call selector remains its identity channel) and one launch-time line names the variable, the cause and both recoveries instead of locking a connection with no identity at all. A declared value the engine's safe-session-id rule refuses — not one safe path component `[A-Za-z0-9._-]+`, not `""`, `.`, `..` or a value containing `/` or `\`, or longer than the engine's `SESSION_ID_MAX_LENGTH` ceiling — likewise resolves no identity: it stays unlocked and warned rather than locking an identity no identity-consuming call could use, and its launch-time line states the rule and the correct-the-variable-or-drop-`--identity-env`-and-relaunch recovery without echoing the rejected value. The declared identity is resolved once when the connection is created, so the lock can neither outlive the identity it locks nor appear after the connection became generic. A locked connection's published tool metadata also omits the session selector everywhere — the input properties, `x-mstar-requirements`, the rendered `CLI:` usage token and the caller-supplied section — so the contract an agent reads never asks for a parameter the tool does not publish and silently strips; a generic connection still publishes it.
- **The `MSTAR_HARNESS_DIR` recovery works everywhere the refusal names it.** The engine's harness-root resolution honours a non-blank `MSTAR_HARNESS_DIR` before its linked-checkout refusal, so the recovery the MCP control-root refusal advertises also resolves on a linked checkout whose main worktree cannot be read.
- **PR review now defines the re-review of the same target.** `mstar-audit` → `references/pr-review.md` gains § Re-review: when a target already has a prior report, that report is the *input*, not the scope. On the covering path — the prior report is settled and its head is still an ancestor — the reviewer revalidates each prior accepted finding and `- unverified:` item as `fixed` / `still present` / `regressed` / `not verifiable`, then reviews only the increment; every other case is a full `base...<new-head>` review that still revalidates the prior findings.
- **The tally describes the current state.** A `fixed` finding leaves the tally so one defect is not penalized twice and the verdict can improve; `still present` and `regressed` are re-classed by the current merge-class criteria, with the prior class only a reference point — a defect that now reaches data loss or an auth bypass is `must-fix` whatever it was before; new findings come only from the reviewed scope (the increment on the covering path) and the fix sites. The prior `Considered & rejected` list carries forward, so a rejected candidate is not re-chased without new evidence.
- **Coverage needs a settled prior report.** A prior `verdict: incomplete` (unread diff basis or a seat that never opened) never makes its hunks prior-covered — listing its `unscanned` scope does not restore them — so the run reviews `base...<new-head>` in full. Arbitrary-diff targets have no stable identity (`<date>-diff-<short-head-sha>` embeds the head), so their re-review needs the prior report named explicitly.
- **The increment is a two-endpoint diff; rewritten history is not one.** The basis is `git diff <prior-head>..<new-head>`, valid only while the prior head is an ancestor of the new head — the three-dot form is used nowhere here, because on a rebase it replays content the prior report already judged. When the ancestry test fails (rebase / force-push), no hunk is prior-covered and the run reviews the resolved `base...<new-head>` in full, declaring the fallback under `- notes:`. Patch-equivalence pairing is never accepted as coverage, and no partial-coverage shortcut exists: `- notes:` cannot qualify a verdict.
- **Seats get the increment pack, not the setup snapshot.** On a covering re-review the increment is written as `increment-<prior7>-<new7>.diff` into the target's run directory from the primary checkout and passed to every seat as `--diff-file`, so the full `base...<new-head>` snapshot can never put already-reviewed hunks back in front of them; a full-review path passes that full diff instead. Seats also receive the prior report path and their assigned findings for revalidation. The setup sidecar and its snapshot keep their existing role for base resolution and posting coordinates.
- **Seats and tier follow the reviewed scope**, using the same sizing bands: the increment on the covering path, the full `base...<new-head>` diff on a full review. A security-sensitive increment stays `deep` at any size, and a domain touched by neither the reviewed scope nor a revalidated finding needs no seat.
- **Report and posting.** The posted review body gains a `### Revalidated findings` subsection (`none` on a first review) and the frontmatter an optional `supersedes:` naming the prior report; a same-directory round escalates to the next `report-r<N>.md` revision, a later date starts its own run directory, and both post a new `COMMENT` review without rewriting or resolving prior threads. A prior captured issue's revalidated state is disclosed in the report — a recurrence appends an occurrence, while closing a `fixed` finding stays the issue-store authority's separate authorized act.
- **Entry surfaces agree.** `/amazing-pr-review` step 1 and the `mstar-audit` variant table route a same-target second run to § Re-review instead of re-running the whole diff.
- **PR-review `incomplete` derives from run facts, never from the wall clock.** The token no longer fires on a maxed tier budget: it fires on exactly three conditions — the run stopped before synthesis, a required domain seat never opened, or the resolved diff basis could not be read — and a run that exceeded its budget with full coverage stays settled, publishes its tally-derived verdict (`ship it` / `needs fixes` / `blocked`) and declares the overrun under `- notes:`.
- **One authority, quoted everywhere.** `mstar-audit` → `references/pr-review.md` § Verdict synthesis owns the trigger list; the tier Budget column, the degradation ladder, the seat-supervision rule and the tally override invariant each point at it in one clause, and the entry surfaces (command `description` + launcher body, `docs/commands.md`, both READMEs) state the same three conditions.
- **No carrier change.** The `incomplete` envelope/report frontmatter, the display block and the tier budget numbers are unchanged; the engine constant's doc comment and the boundary fixture now record that elapsed time is not a settlement fact.
- **Replaced `tally` inputs.** The free-text `--incomplete-reason` cause and the `--unscanned` scope are gone: the CLI now takes the run's own facts — required `--required-domains`, `--opened-domains` (an explicitly empty value means nothing opened) and `--diff-basis readable|unreadable`, plus the optional `--stopped`. Omitting any of the three required facts is refused with the other field diagnostics in one response, never inferred.
- **Seat occurrences, not domain memberships.** `--required-domains` / `--opened-domains` are multisets: each required entry consumes one matching opened entry, so the `default` tier's second seat in a domain (a normal seat plus a same-domain security-lens seat) is never satisfied by its sibling's evidence and an unaccounted seat keeps the run `incomplete`. The `--help` text and the machine-readable constraints now state the same contract: one entry per required seat, a domain with two seats appears twice, and two matching `--opened-domains` entries are needed when both returned.
- **Truncated seat scopes reach `unscanned`.** The new optional `--partial-scope <scope...>` (engine fact `partialSeatScopes`) repeats once per scope a seat declared as truncated coverage; those entries join the derived `unscanned` list of a stopped or missing-seat run, deduplicated after the missing seats and an unreadable basis, so full-coverage-plus-truncation no longer reads `unscanned: none`. The three-condition trigger list is unchanged — the option widens a stopped/missing run's scope, never creates a trigger. When the run settles instead, the declared scopes are echoed machine-readably as `declaredScopes` (deduplicated, input order) — a settled run carries no `unscanned`, so the report records the truncation under `- unverified:` / `- notes:` and the echo keeps it from being dropped; `declaredScopes` is a tally-output fact feeding the report's `- unverified:` / `- notes:`; it is not part of `mstar.review/v1` and is not a declared report-frontmatter field, so copying it into either surface is outside the contract — the envelope tolerates unknown keys silently and the frontmatter parser accepts arbitrary scalar keys, but tolerance is not permission; the two-line settled header is byte-identical.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/opencode-v2`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 4.0.4**.

## [4.0.3] - 2026-10-18

### Harness

- **`dsh-llm-fallbacks` pin bumped `0.6.6` → `0.6.7`**: the two hand-written literals move together — the `@mstar-harness/dsh` devDependency (`packages/dsh/package.json`) and the CLI install-spec constant (`packages/cli/package.json` → `mstar.dshLlmFallbacks`, read by `init` / `doctor --target dsh`) — and the lock re-resolves the row to `0.6.7` with the registry integrity for that version. `0.6.7` keeps the same peer set as `0.6.6` (the `^0.2.1-rc.2` dsh cohort, `@deepseek-ai/cordis` `^4.0.5`, `@deepseek-ai/schemastery` `^3.18.5`, `react` `^18.2.0`), so the workspace peer line already matches it; its only service-surface change is additive (a dispatch-role getter plus role-projection exports), none of it consumed by mstar — the structural mirror and its real → view type gate need no change. Nothing upgrades an already-installed host: `doctor --target dsh` reports an older row `drifted` until `init --target dsh` re-adds the pinned spec. Workspace verification: `tests/peer-deps.spec.ts` 7 pass, the `fallbacks-*` suites 53 pass (60 tests across the scoped 7-file set, zero skips), and both type gates (`typecheck:src` and `typecheck:tests`) exit clean.

### Changed

- **`init` is now a pure install:** it never reads, creates or appends the project `.gitignore`, so the host-specific install paths (`.cursor/plugins/morning-star-harness`, `.codex/agents/*.toml`, `.agents/skills/<name>`, `.zcode/plugin-checkout`) simply stay untracked.
- Removed the `doctor` findings that demanded those ignore entries — the `cursor`, `codex` and `zcode` project checks plus the now-unreachable omp gitignore list.
- `mstar-harness harness scaffold` is unchanged and still emits the canonical `.gitignore` snippet; run it (or add entries yourself) when you want the harness artifacts ignored.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/opencode-v2`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 4.0.3**.

## [4.0.2] - 2026-10-18

### Harness

- **`dsh-llm-fallbacks` pin bumped `0.6.5` → `0.6.6`**: the two hand-written literals move together — the `@mstar-harness/dsh` devDependency (`packages/dsh/package.json`) and the CLI install-spec constant (`packages/cli/package.json` → `mstar.dshLlmFallbacks`, read by `init` / `doctor --target dsh`) — and the lock re-resolves the row to `0.6.6`. `0.6.6` requires a `^0.2.1-rc.2` host, so the pin completes only on that cohort line: the lock still carries the older transitive `@deepseek-ai/dsh-client-ui-plugin-manager@0.2.0-rc.2` copy (with nested `dsh-timeout` / `dsh-typert-protocol` / `dsh-brand` at `0.2.0-rc.2`), because `packages/dsh` declares no direct peer for that name. Nothing upgrades an already-installed host: `doctor --target dsh` reports the older row `drifted` until `init --target dsh` re-adds the pinned spec. Workspace verification covers the direct pinned row and the peer/type gates: `tests/peer-deps.spec.ts` 7 pass, the `fallbacks-*` suites 53 pass, and both `typecheck` gates (`typecheck:src` and `typecheck:tests`) exit clean.
- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.2.1-rc.1` (corridor `dsh-v0.2.0-rc.2` → `dsh-v0.2.1-rc.1`, rolling up alpha.1–alpha.5: custom plugin index, Agent-create-plugin entry, on-demand official bundles, experimental Mods/DevTools/COT-translation/worktrees, secret masking, Web DeepSeek login, `engines.dsh` compatibility preference, Slot `conversation.input.model.label`; dropped the peer on the removed `@deepseek-ai/dsh-invariants`, added `@deepseek-ai/dsh-agent-preset-registry`). Session format v4 unchanged.
- **dsh plugin — role identity now rides agent presets**: dsh 0.2.1 removed `SubagentStartRequest.persona` and the `start`/`startContinuable` pair (`startActivation` is the one start surface; `tool-subagent` rejects a `persona` config and points at a preset). A role-matched delegation therefore SELECTS a deployed agent preset (`SubagentStartRequest.agentPreset`) — `Config.rolePersonas` (role → persona text) is replaced by `Config.rolePresets` (role → preset id), and the deployment declares one complete preset per role (mounting `@deepseek-ai/dsh-persona` for its identity) since a preset owns the child's whole composition. Selection is capability-gated (independent-selection providers only) and skipped, with one debug log, when the composition mounts no `agentPresets` registry; configured ids are validated once per apply.
- The `@mstar-harness/dsh/invariant` companion stays a documented no-op: upstream removed the `invariants` service and the `./invariant` convention, so the entry is now a loadable no-op that requires no host service.
- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.2.1-rc.2` (corridor `dsh-v0.2.1-rc.1` → `dsh-v0.2.1-rc.2`: DeepSeek Search/Fetch web-search settings UI; Flash-1017 temporary model-label badge package; cohort pin). Session format v4 unchanged.
- **Renamed the plan workflow's delivery branch to `branch.work`, and added `branch.base`.** The plan shape recorded its *delivery* branch as `branch.source` — a name that reads as "where this came from", which is what the iteration shape calls `branch.base`. An operator following the `main → worktree → main` reading therefore registered `main` as the delivery branch, and `plan complete` could never satisfy its check. `branch.base` (the branch the workflow was created from) is now recorded as well. **Rows registered before this change keep working:** reads resolve `branch.work ?? branch.source`, writes emit `branch.work` only, and no migration is required. The CLI follows — `--branch-work` / `--branch-base` / `--branch-target` on `workflow register` and `workflow delivery-anchors`, with `--branch-source` still accepted as a deprecated alias of `--branch-work`.
- Added **`mstar workflow delivery-anchors`** — a guarded, revisable way to correct the delivery anchors a registered workflow records (`branch.work` / `branch.target`, plus `branch.base`), under the workflow CAS token. `--branch-work` / `--branch-base` / `--branch-target` are independently optional (an omitted one keeps its registered value) and `--reason` is required and recorded in the operation's intent fingerprint; the write **merges into** the stored `branch` object, so members it does not name — an iteration workflow's `base` / `integration` — are preserved. This closes the gap where a misregistered anchor left a plan un-completable with no supported repair.
- `mstar workflow register` now raises a **non-blocking advisory** (an ok envelope's `data.warnings`) when a `development` registration records the same value for `--branch-work` and `--branch-target`, and its branch option help states what each anchor means.
- **Refusals now name their cause and their recovery** where they previously stopped at a generic message: `plan complete`'s delivery-anchor mismatch names both branch values and carries the repair path as the envelope's `recovery`; `store execution export`'s control-root refusal names the resolved target and the admitted invocations; `plan progress`'s recovery no longer misdescribes its payload as a bare status.
- **`mstar lint --type plan` no longer flags a plan's own YAML frontmatter**: a leading `---` block is skipped, so `status: Todo` is not reported as a placeholder token, while placeholder tokens in the body still are.
- **`mstar schema --command plan.progress` now publishes the `PlanProgress` payload shape** (`status` / `summary` / `evidence_paths` / optional `track_branches`) instead of an open object.
- **A delivery anchor must belong to the addressed lifecycle's type.** `mstar workflow delivery-anchors` now refuses a member the addressed workflow's own type does not carry: an iteration (whose anchors are `branch.base` / `branch.integration` / `branch.target`) refuses `--branch-work`, and the refusal names the type, the refused member and the members that type does allow, so the call is correctable in one retry. Every member the addressed type does carry stays revisable exactly as before, and `branch.integration` stays unwritable for both types.
- **Iteration Phase 1 research and Phase 3 close now read the roadmap and milestones from the project store** — `mstar roadmap show --project <id>`, `mstar milestone list --project <id>` and `mstar milestone status` — instead of deriving route scope from legacy `roadmap.md` Markdown. A project with no roadmap or milestone record is recorded as an explicit known absence; project files, README index rows and catalog paths stay history/transport only and are never a read fallback. The iteration compass `## Milestones` table is documented as iteration delivery nodes, distinct from store `project_milestones`; neither substitutes for the other.
- **`mstar-engine-legacy` is now an inbound-only archive, enforced by the load-order lint.** `lintLoadOrder` exempts it from core-first by exact name (alongside standalone `mstar-coding-behavior`), and the new `roles.loadorder.legacy.archive.reference` violation fails it whenever its text names another `mstar-*` topic of the shipped corpus. Candidate names come from the linted corpus keys, so the historical prose about the `mstar` CLI, `mstar-*` wildcards and the `@mstar-harness/engine` package is not a reference. The archived cross-references were rewritten as neutral prose ("the runtime dispatch rules", "the current field reference", "the host references") with every field, safety and QC seat fact preserved; the runtime core's load contract lists the exemption and its inbound-only rule.
- **A PR review can now report `incomplete` instead of failing or asserting a pass** (requested by issue #503). `PR_VERDICTS` gains the neutral fourth token and `computePrTally` takes an optional `incomplete: { reason, unscanned }`: when supplied, `verdict` becomes `incomplete` while `scorePct`, `band` and the four counts stay the count-derived ones, and the chat header becomes four lines — `incomplete · <score>% (<band>, partial)` + the unchanged tally line + `cause: <reason>` + `unscanned: <csv|none>`. It is neither a pass nor a failure and never authorizes merge; without the declaration every existing run stays byte-identical (verdict, score, band and two-line header).
- **Both published surfaces enforce the declaration.** The `mstar.review/v1` envelope requires `incomplete` exactly when `verdict` is `incomplete` and rejects it on every other verdict (`review.missing-incomplete` / `review.incomplete-malformed` / `review.incomplete-unexpected`, with `tally.verdict` still equal to the top-level verdict); the Markdown report requires the `incomplete_reason` + `unscanned` frontmatter pair for that verdict and rejects it elsewhere (`prreview.report.missing-incomplete_reason` / `invalid-incomplete-reason` / `missing-unscanned` / `invalid-unscanned` / `incomplete-unexpected`), skipping the tally-mismatch check for this token alone while the `score_pct` recompute still runs. `mstar pr-review tally` gains `--incomplete-reason <text> --unscanned <csv>` (supplied together) and reports every invalid tally field — the findings payload (missing file, unparseable file, non-array, invalid or missing `mergeClass`), those two flags and the three count flags — in one refusal; a lone `--unscanned none` (case-insensitive) declares the engine's empty scope instead of the literal entry `none`; `mstar schema` publishes the new optional envelope field, and a malformed fact is now held to the producer's single-line rule (a CR/LF in the cause or in an unscanned entry is refused).
- Updated the `mstar-audit` pr-review reference — verdict lists, the single `incomplete` trigger list and the settled-vs-declared rule (a **settled** run is completed without a stop, with every required domain opened and the resolved diff basis readable and complete — the pinned snapshot when the mode produces one, the resolved `--diff` / `--working-tree` input otherwise — so a cancelled or timed-out run is never settled even when those resources were opened; § Time budget and Stage 3 now point at it), the partial display, the envelope/report carriers, the override invariant and one explicitly-labelled override row — and the entry surfaces (`commands/amazing-pr-review.md`, `docs/commands.md`, `README.md`, `README_CN.md`) now name all four tokens and that rule with the same settled qualifier. The locked deduction schedule, bands and the settled display contract are unchanged.
- Trimmed the README **Install** section to the per-host CLI + native commands; the `init` / scope / `doctor` / binary-alias details now live only in `INSTALL.md` (bilingual counterpart updated).
- Review output now lives in a dedicated **`{REVIEW_DIR}`** tree (default `{HARNESS_DIR}/reviews/`, `.mstarc` `review_dir` aware) with run-scoped directory names — `<date>-codebase-<level>-<round>`, `<date>-pr<N>`, `<date>-branch-<slug>`, `<date>-diff-<short-sha>`; `reviewRunDirName` / `resolveReviewRunDir` / `resolveReviewDir` are exported and `harness scaffold` creates `reviews/`.
- **The codebase audit writes a review report, not plans**: `scaffoldAuditReport` writes `<reviewsDir>/<date>-codebase-<level>-<round>/README.md` (same finding gates; the README drops the plan execution-order block). `mstar audit scaffold` gains `--level` / `--round` / `--reviews-dir` / `--dir`, and the `promote` verb of the `mstar audit` family — with `scaffoldAuditPlan`, the plan-Status-block validators and the plan-list helper — is **removed**. The audit seam now scans markdown under `{REVIEW_DIR}` with the credential scan as its only validator.
- **PR review reports and evidence move to `{REVIEW_DIR}/<date>-pr<N>/`**: `prReviewReportPath` takes `reviewsDir` instead of `reportsDir`, and `mstar pr-review report-path` takes an optional `--reviews-dir` defaulting to the resolved `{REVIEW_DIR}`; the dsh `mstar-pr-seats` `reportsDir` argument is that same review run directory.
- Updated the audit/review skills, the slash commands, `docs/commands.md` + `docs/runtime-reference.md` and the plan-lifecycle references: no plan files, no promotion producer, no plan-quality-bar citation on the review surface.
- `mstar path resolve` also reports `reviewDir`, and the conventions skill records that a directory key declared outside `{HARNESS_DIR}` (e.g. `review_dir=process/reviews`) is not covered by the canonical ignore snippet.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/opencode-v2`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 4.0.2**.

## [4.0.1] - 2026-10-16

### Fixed

- **The published CLI is a Node entrypoint again.** `dist/mstar-harness.js` shipped a shebang that pointed at the repository's development runtime, so every plain `mstar-harness` and `npx @mstar-harness/cli` launch ran on whatever that runtime happened to be on `PATH` — even on a machine with a supported Node, and even though a package runner installs the package with the Node it already has. The bin now carries the Node shebang (`#!/usr/bin/env node`), and `@mstar-harness/cli` declares one runtime requirement (`node >=24.18.0`) instead of two.
- **User-facing runtime text names one runtime.** The `store.runtime-unsupported` refusal, the `status validate` recovery, and the `doctor` runtime-floor message name the Node floor (`>=24.18.0`, native `node:sqlite`) and the runtime actually executing the entrypoint — never a second runtime. The store recovery also stopped answering a runtime refusal with the generic "correct the operator input" text, and now names every store verb **with its own options** (`store init`, `store backup --out <path>`, `store migrate --manifest <path> --apply`, `store activate --manifest <path> --attestation <absolute-json>`, `store retire --manifest <path>`, `store upgrade --operator <name> --harness <control-root>`) and says to rerun the invoked one with the same options, instead of being redirected to `store upgrade`. SDD evidence records the runtime that actually executed the supervisor, so a from-source capture identifies its runner rather than reporting that runner's emulated Node version.
- **Docs follow the entrypoint.** `INSTALL.md` (prerequisites, CLI install, MCP launch, doctor note), `README.md`/`README_CN.md`, and `docs/runtime-reference.md` state the Node floor as the only launch requirement, and the from-checkout steps now point at the maintainer material that owns the development-toolchain commands instead of spelling them out. Host-plugin READMEs attribute their runtime floor to the host that loads them.
- **The doctor probes the `node` its launches resolve.** Every host MCP config launches `npx`, which runs the CLI on the `node` executable on PATH — the doctor now probes that executable's own version instead of reporting the version the doctor's own process happens to expose (a source/development run reports its runner's emulated Node version, which is not a Node install). When the probe fails, the target reports an **unverified** Node floor as a mismatch rather than aligning a launch that cannot start.
- **The `status validate` runtime recovery no longer advises a no-op retry.** It names the entrypoint's Node floor and states that a retry which does not change the executing runtime reproduces the refusal, so an operator on an unsupported runtime switches runtime instead of re-running the same command.
- Regression coverage for both: the below-floor CLI legs assert the store recovery names the invoked verb (upgrade with its options, `store init` as its own command) and that the `status validate` recovery states the unchanged-retry fact; the doctor suite asserts an unprobed launch runtime is a mismatch; the SDD evidence suite asserts the recorded tool fingerprint identifies the runtime that actually ran the capture.
- **A repeat `store upgrade` over an unchanged legacy source is an ordinary success again.** The execution importer's only replay path matched the caller's operation id, which the CLI mints fresh per invocation (`randomUUID()`) and never reports back, so a second upgrade of an already-imported tree always hit the native-id collision refusal and demanded `--ack-skip-workflow` for every already-imported id. The importer now also reads the store's **own retained import receipts**: every committed import already writes a `store_operations` row whose `result_json` carries the consumed `sourceDigest` and the `importedIds` it committed, and that table is never pruned. A colliding id a receipt for **these exact source bytes** already lists is a **proven replay** — the run imports nothing, requires no acknowledgement, and reports each such id in `dispositions` as already held by the native authority from an import of these exact bytes. This is the provenance policy the change settles: a same-ID match is a replay only when stored provenance proves the same source.
- **Unproven collisions are unchanged.** An unrelated workflow that merely shares the id, or a legacy source whose bytes changed after the recorded import (a different `sourceDigest`), still refuses `execution.migration-conflict` naming `--ack-skip-workflow <that id>`, and its unmatched-acknowledgement usage error (exit 2) is untouched. Receipt candidates are shape-validated in JS (an object whose `sourceDigest` string equals the current digest plus an `importedIds` array of strings) rather than trusted because the JSON happens to mention the digest, and the lookup is never keyed on the caller's operation id. Guard order is preserved: unmatched acknowledgement → unsafe-source refusal → collision handling.
- **A replay must now prove the input that SHAPED the rows, not only the bytes.** `sourceDigest` covers only the legacy bytes a run read, while `--delivery` declarations and `--ack-skip-compass` acknowledgements change what the conversion produces without touching those bytes — so a repeat over unchanged bytes could previously accept a *different* declaration and discard it silently, leaving the native row as the earlier import left it. The receipt therefore also records an `inputDigest` over the normalized declarations (sorted by lift id, fixed key order) and compass acknowledgements (sorted). A run carrying **neither** still replays on the byte proof alone, so receipts written before this field existed keep working; a run carrying **either** needs the receipt to record the same `inputDigest`, and otherwise the id stays an unproven collision. That refusal now states only what the evidence supports — the retained receipt does not prove the earlier import consumed this input, so this run does not treat the id as a proven replay and leaves the native rows unchanged — alongside the existing `--ack-skip-workflow <id>` recovery. No new refusal code, table, migration or flag.
- **`MinimalImportResult.verdict` is widened to `"upgraded" | "nothing-to-import"`** (additive), mirroring the DSH importer's existing vocabulary: a run that commits rows keeps reporting `upgraded` with its `imported` count, while a run that commits none but proves at least one replay reports the already-current state. `docs/commands.md` § Store CLI upgrade and recovery describes the proven-replay outcome and keeps `--ack-skip-workflow` for unproven collisions.

### Harness

- **`@mstar-harness/commands` is now strictly internal.** It is marked `private`, consumed as a workspace `devDependency`, and inlined into the CLI bundle, so the Release workflow no longer publishes it (the publish step could never succeed: the package has never existed on npm and OIDC trusted publishing cannot create a package).
- **The root manifest no longer references commands at all.** It is removed from both `dependencies` and `devDependencies`, because the root package is the git-install entry (`omp plugin install github:btspoony/mstar-harness`, `bun add github:…`) and the `workspace:` protocol does not resolve outside the workspace — a git install that also installs devDependencies would fail to install. Workspace packages still link commands directly, and `release:prepare` keeps bumping its version in lockstep.
- **A publish step for a version already on the registry is a reported skip, not a failure.** A pre-publish check classifies every publishable package as `publish` or `skip` (already on the registry) and refuses on any unknown registry state, so each publish step either publishes or states that the version is already there. It checks manifest publishability and registry state only — it cannot verify npm trusted-publisher/OIDC authorization, which only an actual publish attempt proves. CI also asserts the workflow's publish set equals the non-private workspace packages.
- `init` no longer reports success for a failed host install: a refused link, install, or build step ends with a non-zero exit that names the cause and a recovery.
- omp install is deterministic about a pre-existing plugin tree (removes a stale entry through a supported route before linking, verifies the installed version), and no longer passes a scope flag the install path ignores.
- The omp coordinator tool's session parameter uses the two-argument `record` form, so the tool schema constructs under every host shim probed.
- A dsh incompatibility refusal now names the runtime, the plugin spec, and dsh's own `allow-version` recovery instead of relaying the rejection alone.
- Version values come from `package.json` at runtime; the Bun-version gate and version-comparison tests are gone.
- `init` installs the published `@mstar-harness/cli` latest globally when a newer version than the one running is published, and warns with both versions when they differ: a cached `npx` resolution can otherwise run an older CLI, and every step of `init` — including the global install — used to follow that older version. The registry probe is bounded, skipped by `--dry-run`, and silent when offline, so it never blocks or fails an init.
- Rewrote the README **Install** section as a per-host list: each host now shows its `init` command and its native plugin-manager command on separate lines, so a blocked `init` cannot block onboarding. Added the missing native paths (OpenCode `opencode.json` slot, Cursor plugin checkout, Codex marketplace registration) to `INSTALL.md` in the same change.
- **The Release workflow has no manual entry point.** `workflow_dispatch` and its `commit` input are removed: the publish job holds `id-token: write` + `contents: write`, and a dispatched run selects a ref whose copy of the workflow a repository writer could edit before running it, so the publish path is now reachable only through a merged `release vX.Y.Z` PR. A version that is already on the registry stays a reported skip, and a release that fails after some packages published is recovered by preparing the next patch release, which publishes the remaining packages under the new version.
- **The release preflight suite no longer pins the release version.** `scripts/release-preflight.test.ts` asserted that the real workspace manifests carry the literal `"4.0.0"`, so `release:prepare` bumping every manifest to the next version turned CI red on the release branch (`lint-scripts-hooks` → `Test scripts`) while `main` stayed green — a release-blocking failure no ordinary PR could surface. The expected version is now read from the root manifest, the release's own version source, so the assertion still catches a publishable package left behind at bump time.
- **`AGENTS.md` now states the rule this regressed against:** tests derive volatile repository facts (the release version, a package/role/skill inventory or count, a checkout path) from their owning source, and may pin a literal only as a synthetic fixture input nothing compares against reality.

### Added

- **PR-review seat prompts are dispatched with the tier and the shared time budget.** `mstar pr-review seat-prompt` now opens each seat's `## Budget` block with the resolved tier and the **whole-review** soft wall-clock cap (`PR_REVIEW_TIER_BUDGETS[tier].wallClockMinutes`) plus, when given, the minutes left of that one clock at dispatch (`--remaining-minutes <n>` — negative renders as minutes *over*). A seat is never handed a fresh per-seat allowance, and the soft-cap bullet promises a partial return with declared truncated coverage at the deadline instead of a hard stop.
- **Seat supervision while seats run.** New engine constant `PR_REVIEW_NUDGE_CADENCE` (`normalSeconds` / `overrunSeconds`), printed by `mstar pr-review budget` alongside the tier table, gives the main agent one cadence to nudge still-running seats with their remaining budget — the faster tick once the shared cap is passed. The wording (dispatch, nudge, stop-at-completion, overrun-is-not-a-kill, and the host difference where seats cannot be messaged mid-run — the dsh `mstar-pr-seats` script now requires an explicit `budgetLine`, refusing without the recovery text) lives in `mstar-audit` `references/pr-review.md` **§ Seat supervision (progress nudges)**; `commands/amazing-pr-review.md` requires the loop in its Execute steps.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/opencode-v2`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 4.0.1**.

## [4.0.0] - 2026-10-15

### Fix

- **Terminal adoption stamps fresh lifecycle timestamps on a header it terminalizes.** When `adoptTerminalWorkflow` settles an unregistered header that never closed, the adoption instant now becomes both `ended_at` and the snapshot's `updated_at`, instead of reusing an `ended_at` an imported non-terminal snapshot may still have carried and leaving `updated_at` at the import-time value. Projections and audits no longer read an end time that predates later recorded activity. An already-terminal header keeps its recorded `status`, `ended_at` and `updated_at` byte-for-byte, as before.
- Removed the OpenCode-style `tools:` mapping (`write`/`edit`/`bash: true`) from the shared role-agent shells: omp reads an agent's `tools` as a tool-name list, so the mapping form is invalid there and broke agent loading on current omp. `mode:` and `permission:` are unchanged, so no host loses a seat restriction and each falls back to its default tool surface.
- **Deterministic shadow-pack identity**: source ordering now uses locale-independent code-unit comparison, so identical frozen inputs produce the same `packId` regardless of locale behavior.
- **One residual severity vocabulary**: the documented and engine vocabulary is `critical`, `high`, `medium`, `low`, and `nit`; out-of-enum values are refused with the accepted list.
- **One severity vocabulary: `critical | high | medium | low | nit`.** The wrong `info` value had spread into the residual/issue severity axis — the engine SSOT, residual validation, CLI payloads and rollups, the dsh view/schema, and the `mstar-artifacts` reference — so every severity site names `nit` again and `info` is refused as an out-of-enum value.
- **Stored severities are converted by a new schema migration**, never by hand-edited rows: it rebuilds the `issues` table with the `nit` CHECK and rewrites the stored `info` values to `nit` while copying, preserving every row. Earlier migration statements and the `warning → low` legacy read normalization are unchanged.

### Harness

- Hardened the **opencode-v2 write gate** against symlink aliasing: the landing-path resolver now follows symlink chains to the real destination (8-hop bound, fail-close refusal `write.symlink-resolution-refused` on cycles/overflow), closing a dangling-link bypass that could write harness authority files (`store.db-wal`) through outside aliases (#438).
- Hardened the **ZCode git-guard hook** force-push detection: push argv roles are now classified (option allowlist from `git push -h`, values consumed, first positional = repository), `+refspec` force pushes are denied, and unknown option forms fail closed naming the token — closing the `+main:main` and `--repo=origin +main:main` bypasses (#439).
- The MCP and CLI **spawn helpers survive early-exiting children**: `child.stdin` stream errors (EPIPE) are owned by the helper instead of crashing the process with an unhandled exception (#441).
- **Root `hooks/` are CI-covered**: guard behavior tests plus `node --check` run in CI; `hooks/session-context.mjs` degrades fail-soft (diagnostic + unavailable-authority context) when the engine is unresolvable instead of crashing (#445, #446 partial).
- **Status-write lock refusals now diagnose** the stale-lock state (holder alive / confirmed dead with verified removal steps / pid file absent) instead of a bare hand-edit hint; automatic takeover stays deferred pending an atomic primitive (#447 partial).
- Lean cleanup: removed the unreachable CLI target prompt and the `@inquirer/prompts` dependency, deleted the dead `homeRelativeSourcePath` export, unified the judgment shadow digest helpers, fixed a stale release docstring (#453 partial).
- The **omp gate hook now fails closed**: an unexpected error inside a gate returns an explicit deny envelope (gate name + error summary) instead of `undefined`, which the host read as allow; envelope-construction failures rethrow (#443).
- **dsh `workflow-policy` gains direct decision tests**: allowlist normalization/boundaries, mode behaviors, unknown-name handling, ask-cache hit/miss and key normalization, and uncovered-plan precedence, with mutation-bite proof (#444).
- The **codex agent installer caps retained backups** at the 3 newest per target (mtime-ordered, best-effort pruning that cannot fail an install) (#448, partial — engine receipts/ledger retention remains open).
- **Projection reads skip the rewrite when nothing changed**: an unchanged generation fingerprint with intact published rows performs no SQL write; changed inputs render byte-identical legacy output; deleted/corrupt published rows are rebuilt (#449).
- The **loopback dashboard now requires a per-launch random token**: the CLI prints the tokenized URL once, valid tokens set an HttpOnly SameSite=Strict cookie for in-page requests, missing/wrong tokens get a state-free 403; Host/Origin checks unchanged (#450).
- The **installer now refuses to clobber user files**: symlinked/non-regular config targets are refused with a named recovery instead of being silently replaced; an incomplete `~/.mstar/harness` clone self-heals (kept aside as `.broken-<timestamp>`, one re-clone) instead of blocking every future install; failed paired ZCode marketplace writes restore both prior file contents (#452).
- **Published command schemas now state what the engine enforces**: issue closure payloads publish disposition-specific `requiredWhen` branches (`anyOf` derived from the engine's `ClosureEvidence` registry, including disposition overrides), and `plan.complete` publishes/validates its declared completion-evidence shape — clients composing calls from the published schema no longer hit invisible refusals (#451).
- The **issue action vocabulary has one source**: engine exports `ISSUE_ACTIONS`/`ISSUE_ACTION_NAMES` (payload, read, CAS and closure-disposition facts per action); the CLI derives its verb tables from it instead of four hand-maintained lists — drift is now a compile error, published ids pinned by parity tests. Token set and behavior unchanged (#453 remainder).
- **Removed the dead `judgment review-advice` command** end to end (registration, family, CLI adapter/tests, docs, skill routing). It could never succeed — its only production call passed a null evaluator channel, which the runtime refuses before reading any input. The shadow evaluation path in `packages/judgment` is unchanged. The sandbox calibration worker (`scripts/evaluate.ts`) was migrated off the removed CLI spawn: it now imports the built judgment API bundle and submits via `connectEvaluatorChannel` in the same sandbox/supervisor flow (#440).
- **`hooks/session-context.mjs` is now a bundled artifact**: its source moved to `hooks/src/session-context.ts` and is built through the ZCode hooks builder (engine inlined), so the SessionStart hook runs standalone without `node_modules`; the fail-soft unavailable-authority diagnostic is preserved and covered by a bare-copy smoke test (#446).
- **Gate path resolution is single-sourced in the engine** (`host-gate-paths.ts`) and adopted by all five enforcement sites (opencode v1, opencode-v2, omp, dsh, ZCode write gate): symlink chains are followed to the real landing path with an 8-hop fail-close bound — v1/omp/dsh/ZCode upgrade from one-hop resolution, closing the alias-bypass class fixed in opencode-v2 during batch 1. Each host keeps its own refusal envelope (#442).
- Added the `/amazing-test-audit` entry (Codex/dsh project command installation included) and the `mstar-audit` test-suite deep method `references/test-audit.md` — value bar, authoring gate, junk-pattern sweep, retention bar, per-candidate evidence, discovery lanes, and whole-subsystem campaign (per-test R/F/C/D ledger); wired into SKILL.md variant dispatch, playbook § 4, and the full-audit scope variants.
- Added the four canonical audit command definitions with bounded scaffold/promotion writes and the existing secret and supply-chain scanners.
- Routed the audit CLI identities through the shared command definitions and added fixture-backed family coverage.
- **Test-authoring audit check:** codebase, test-suite and PR reviews now report incidental, source-shape, wiring or environment-constant assertions with the conclusion “delete, or replace with a product-behaviour assertion”. Aligned implementer and reviewer contracts include the four PR #280 counter-examples while preserving product-behaviour assertions and fails-first regression defences; rejected assertions are never renamed or re-pinned.
- **PR-review score is now a diminishing-deduction score with bands.** `computePrTally` deducts per finding within a class — must-fix 45 then 15 each additional; should-fix `max(12 − 3·(n−1), 2)` → 12,9,6,3,2,2…; nit 2 then 1 each (class cap 8); unverified 5 each (class cap 15) — floors `score_pct` at 0, and annotates the result with a **score band**: `mergeable` ≥ 90 · `good` 80–89 · `pass` 60–79 · `fail` < 60. Verdict derivation is unchanged (count-driven, 3 tokens) and score/band never override it. New engine exports `PrScoreBand` / `PR_SCORE_BANDS` / `scoreBand()`; `PrTallyResult` gains `band`.
- The chat display header is now `{verdict} · {score_pct}% ({band})`, and the posted report's Verdict heading reads `· Score <score_pct>% (<band>)` — the derived number is labeled **Score** (the per-finding `- **Confidence**:` evidence field is a different concept and stays unchanged).
- `mstar pr-review validate-report` recomputes `score_pct` from the same locked schedule (no second formula), and `mstar.review/v1` envelopes accept an optional `tally.band` — absent stays valid, present must be a valid band token. The envelope payload schema/help advertises those tokens, and `MstarReviewV1.tally` uses a band-optional envelope tally shape (`MstarReviewTally`) so legacy band-less envelopes still typecheck.
- Updated `mstar-audit/references/pr-review.md` (deduction schedule table, band definition, worked-example check table, display contract), `commands/amazing-pr-review.md` and `docs/commands.md`.
- Split the CI `test-cli` job — measured at **594s** on run 37018503961, next-slowest job 249s — into four independent parallel jobs, so CI wall clock is the slowest shard instead of the sum: `test-cli-coordination` (`test/plan-coordination.test.ts`, 163.6s), `test-cli-ops` (the 8 next-heaviest files, ~190.4s combined), `test-cli-web` (the `web/` view-model batch), and `test-cli-suite` (the dynamic remainder).
- The remainder shard computes its own file list at run time — recursive package-wide `find` over `bun test`'s four documented filename classes (`*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, any extension), pruning `node_modules`/`dist`/`.git` and `web`, minus the 9 explicit paths — so a newly added test file joins it automatically, with no shard-list registry or guard script. Discovery is fail-closed: an empty remainder hits an explicit guard that exits 1 with a self-explaining error, never a bare `bun test` that would silently re-run every other shard; the `web/` batch uses the same discovery and passes with a notice when empty.
- Each shard keeps the retired job's setup chain verbatim and now builds the CLI explicitly (`bun run cli:build`, equivalent to the package `build` script the old `bun run --cwd packages/cli test` performed itself), documented in the workflow header.
- Re-split the CLI test shards from four jobs to six (`test-cli-ops` → `test-cli-ops-a` + `test-cli-ops-b`; `test-cli-suite` → `test-cli-suite-a` + `test-cli-suite-b` with the dynamic remainder dealt out by alternating rows of the `LC_ALL=C`-sorted discovery list), capping CI wall clock near ~3 min after both shards drifted past 5 min; full-suite coverage and the fail-closed empty-selection guard are unchanged.
- Organized **CLI subprocess tests by command owner**, retiring the historical `slice4-cli.test.ts` container while retaining all groups, parameter rows, assertions, and fixture content. Moved groups share the CLI spawn harness and package-local assertion/content support; existing skill, lease, and worktree coverage remains alongside its distinct sibling groups.
- Raised the timeout for the `CLI init --target dsh` adapter cases: each spawns `bun run src/index.ts` (a cold TypeScript start plus the adapter's own subprocess work), and the default 5s budget sat close enough to the CI runner's cost that a single slow start failed the suite.
- Removed the reintroduced duplicate `binding` test group (a byte-identical 420-line copy) from `packages/engine/test/coordination.test.ts`; the eight binding contracts remain owned by `packages/engine/test/coordination-bind.test.ts`, and production coordination code plus shared fixtures are unchanged.
- **Isolated actor-only CLI regressions:** check close, triage, supersede, and link in separate active-store fixtures so independent subprocess workflows do not consume a single test's timeout. Preserve all state assertions and default time limits; CLI behavior is unchanged.
- **Remediated three lint backlogs** covering roughly 480 sites across Rule #341 refusal recoveries, help reachability, and frozen-invariant hash-gate structure.
- **Made the gates enforceable:** refusal-quality and help-reachability now pass with empty allowlists, and the hash-gates CI step blocks on violations. Hash-gates reports 3 authorized gates and 11 replay-allowed sites separately from violations.
- **Defined explicit marker semantics:** `// reachability: manual — <reason>` records a site-specific manual recovery only when its reason is non-empty; `// hash-gate: authorized — <reason>` authorizes the adjacent invariant gate only with a non-empty rationale. These markers classify their own sites and do not suppress sibling findings.
- No machine-local store identifiers were added to tracked content.
- Added an **over-design lint family** enforcing the frozen #341/#365 contracts in CI: `lint:refusal-quality` (structured-channel cause/recovery presence) and `lint:help-reachability` (recovery text must name reachable verbs/flags), alongside the now-CI-wired `lint:hash-gates` (`continue-on-error` pending tracked triage of pre-existing main findings). Bounded allowlists reference real tracking issues.
- Added a **QC judge lens** (`overdesign-judge.md`, required on engine/commands diffs): the rules AST cannot decide — gate necessity vs the declared operating model, gate-vs-contract agreement, self-written-output classification, protocol sizing — advisory by design so the judge never becomes a new over-gate.
- Added a **known-answer backtest suite** proving the family catches its historical instance classes from #340/#341, with honest not-covered rows routed to judged examples.
- **Agent-first CLI operability (#393):** `--help`, `schema`, and admission now derive from one shared registry contract (118 commands observed in the runtime `tools/list`); missing input produces one aggregated refusal listing every missing field (path/code/expected/received), the minimal required set, safe defaults, conditional/alternative facts, `helpRoute`, and `recovery` on both CLI and MCP.
- **Error fidelity (touched families: session, milestone, pr-review, audit, dashboard, status, workflow):** engine-authored `code`/`message`/`details` travel verbatim on the refusal paths this plan touched. Malformed attestation/proof/evidence/policy causes are sanitized: real parser grammar and the parser-reported location survive while submitted operands and secret-shaped values are withheld — verified per runtime with actual Bun 1.4.0 and Node 24 malformed inputs, not universally. Schema-unsupported refusals report highest applied schema, supported maximum, and first unsupported migration as three distinct machine facts.
- **Public operations:** `workflow-note.append`/`workflow-note.coverage` join the canonical registry on CLI and MCP; an ambient `MSTAR_HOST_SESSION_ID` or launcher-minted identity satisfies the caller-context requirement without `--session-id` (verified on the built bundle), explicit selectors keep precedence, and no-identity/malformed selectors refuse without writing. `issue.*` mutations publish numeric revision CAS, refuse blank replay ids, and return the generated id in the receipt. `workflow.evidence` publishes the per-delivery-kind file-content contract with record-time revisability and close-time freeze.
- **Terminal recovery & native coordinator:** `workflow.adopt-terminal` settles unregistered ACTIVE sessions via optional operator attestation with addressed-target completeness and per-operation file recovery (POSIX error codes retained); read-only store opens converge across the Bun writer-close window (bounded retry, persistent corruption still refused). The registered `mstar_coordinator` contract binds/recovers ACTIVE schema-9 authorities with host-derived identity, aggregate refusals, and real loaded-entry provenance — evidenced on the SDK 18.3 adapter route only; it does not replace a running host's cached registration, and the guidance no longer promises reload-style replacement.
- Command admission now returns **grouped structured diagnostics**: every schema violation carries its safe field path, stable issue code, message and array index in `details.diagnostics`, so one call reports all missing or malformed fields instead of flattened messages alone.
- **CLI parser errors name the field**: missing arguments and option values identify the input field and the leaf help route (`mstar <path> --help`) when deterministic; unknown flags keep the honest parser diagnostic without a guessed field. Usage responses stay `usage`/exit 2, distinct from engine refusals.
- Plan writes use explicit plan addresses under the acquired workflow coordinator. Sparse own-context resolution retains structured diagnostics for actual scope, identity, token and state conflicts. Stopped-owner recovery names only the workflow coordinator and real stop attestation, never a per-row replacement.
- Usage-message construction for schema rejections is now **bounded**: when a rejected input produces more than 20 issues, the first-line message carries the first 20 causes plus an explicit `…and N more issues` pointer, while `details.diagnostics` keeps every diagnostic (uncapped, with the established secret-shape redaction). The `rejected` summary field reports only the first cause's flag/expected/received facts; the full per-issue facts remain in `details.diagnostics`.
- Top-level CLI and command refusals share one envelope with help routes and recovery guidance; input-schema failures flow through central validation, root-union guidance is preserved, and schema discovery publishes truthful coordinator and plan recovery token kinds.
- Added runtime payload schemas and `mstar-harness schema <TypeName>` output; issue and plan payload help now points to its matching schema.
- Aggregated issue and covered plan payload validation so one refusal identifies all malformed and missing fields.
- **CLI command surface**: non-installer commands are now generated from the canonical `@mstar-harness/commands` definitions. `mstar init` remains the installer. Parser failures return a version-1 usage envelope and exit 2; command outcomes keep their documented exit codes, including SDD task 3 and child 124/127/128+n.
- **Runtime session selectors and generated bundle**: `plan.bind` uses runtime invocation identity instead of a request field, declared CLI session selectors reach the handler context (including the multi-value `workflow recover-coordinator --stopped` list), and `packages/commands/dist` is generated locally rather than tracked.
- Preserve structured engine details while deriving refusal help metadata; cover omitted usage/refusal defaults.
- Unknown MCP tool calls now return a close tool-name suggestion when available and direct callers to `tools/list`.
- **Commit identity policy**: Repository-writing agents use configured Git author/committer identities, never fabricated or per-commit-overridden ones. Before committing, check `git config --get user.name` / `git config --get user.email`: an empty value is Blocked, preventing Git-synthesized identities; the operator configures the user's identity or uses a configured checkout. Completion reports require author-visible `git log -1 --format='%h %an <%ae>'` evidence.
- **Commit-surface coverage**: Branch/worktree guidance, fresh and sticky SDD prompts and handoffs, shared and Cursor plan-mode bridges and rules, iteration-close and knowledge-bootstrap recipes, and PM dispatch reports point to the single shared leaf Git rule. The execution-consumer fixture now uses a neutral test identity; engine, CLI and hook behavior is unchanged.
- Added coordinator-only `mstar session run --workflow W --role coordinator [--harness H] -- <argv>`: child-local identity replaces spoofed/legacy inputs, inherits stdio and propagates exit/signal. Session recover replaces the explicitly stopped workflow coordinator under acquired identity and stop attestation.
- Plan file/ACTIVE transports remain disjoint. Current coordinator context may be derived for ordinary actions; explicit session reference/token/operation inputs remain constraints. Mixed authority or numeric ACTIVE expectations refuse before payload IO.
- `mstar workflow register` / `iteration register` publish through the atomic DB registration, `workflow evidence` records the delivery transition and `status workflow-close` performs the terminal lifecycle transition — no file close, no unregister step and no `--ended-at` rewrite survive on the active route. The closed `phase` / `lifecycle` / `execution-policy` / `integration-worktree` grammar joins the existing `mstar workflow` group.
- `store execution restore-preview` and `restore` use ordinary `store backup` images for disaster recovery; `export` reports live execution state. The staged execution migration faces (`preview`, `apply`, `activate`, `retire`, `abort`) were removed. `store activate` remains only the issue/catalog migration step.
- `status validate` reports the root and per-workflow execution tokens the active writes consume as their CAS, so a caller passes `--expect` from a read instead of inventing one.
- **A coordinator bind retry under an explicit operation id is now the recorded replay.** `bindExecutionSession` takes an OPTIONAL `expected` and resolves the workflow's current token from its own header inside the write transaction; the bind request fingerprint carries the freshness-omitted marker instead of a freshly derived token, so the unchanged retry of `{workflowId, operationId}` after the first commit's revision advance is served as the replay rather than `execution.operation-conflict`. A SUPPLIED token keeps its strict-CAS semantics: a stale value still refuses `execution.stale-token`, and the same operation id with a different supplied token stays an operation conflict.
- The host-owned `mstar_coordinator` ACTIVE `bind` forwards an omitted `expected` as omitted (the engine resolves it) and mints the operation id when the caller names none; its `recover` arm still reads the current token from the addressed authority because `recoverExecutionCoordinator` requires an explicit one. The registered tool description, parameter advertisement and the `mstar-host` OMP reference state the same contract.
- **Incompatible-store FILE recovery keeps its engine facts and loaded-module provenance.** The stored-target reader's §4.3 authority veto carries the original thrown `StoreError`, and the FILE recovery boundary projects it through the shared engine-refusal path, so a `store.schema-unsupported` refusal reaches the caller with its three schema-version facts, `loadedEntry` and the incompatible-loaded-build guidance — the same fidelity the bind / show-recovery / ACTIVE-recovery branches already provide.
- **Coordinator identity is acquired, never generated.** A fresh coordinator bind now requires an explicitly acquired session id: the engine refuses an omitted id with `coordination.identity-missing` before any write instead of minting a UUID, and `plan bind --coordinator` no longer accepts the inherited `MSTAR_HOST_SESSION_ID` as authorization. Plain local operators pass `--session-id`; managed host sessions use the new host-owned tool.
- **One adapter-only `ExecutionIdentity` type** (`packages/engine/src/session-identity.ts`): the `(canonical harness root, workflowId, role, planId, sessionId)` tuple plus `validateExecutionIdentity`, shared by engine, CLI and host adapters instead of a second per-consumer shape.
- **New host-owned `mstar_coordinator` tool** (`bind`): the extension derives the native session id from the host and the canonical control root from the host cwd, refuses leaf/scoped-plan callers, and accepts no session id, root, caller role, authority flag or credential path.
- **Retired the blanket bare-`bash` env revision.** A managed `plan bind --coordinator` attempted through `bash`/`functions.bash` is blocked before shell execution with a redirect to `mstar_coordinator`; unrelated shell calls are unchanged and an absent or unsupported `env` field no longer produces an input revision.
- Added the audited **JSON Prepare coordinator recovery** (`showPrepareCoordinatorRecovery` / `recoverPrepareCoordinator`, prerequisite contract §3.3): it replaces a workflow's recorded coordinator binding when the recorded owner can no longer authenticate — the state a cancelled host handoff leaves behind. It is deliberately NARROWER than the existing active-DB recovery (`execution-workflow.ts`), which keeps its full execution token and stop attestation: no prepared-plan takeover, no lease transfer, no raw session rewrite and no force flag.
- The write is admitted only under the snapshot write lock and requires: file authority (an active execution authority refuses and names the existing DB recovery verb), a registered RUNNING iteration in this canonical root, a committed registration, a prior envelope that still authenticates the **exact** recorded coordinator, a freshly acquired identity addressing this workflow's coordinator seat, an explicit reason + authorization reference + a stop assertion naming that holder, both fresh byte versions, and the **original** `prepareAdmission` over every row. Every semantic refusal happens before a file is created.
- The accepted effect is one role-scoped envelope through existing exclusive creation, the top-level coordinator binding replaced, one immutable `coordination.identity_recoveries` audit record appended (operation id, request digest, both public session ids, authorization reference, reason, stop assertion, both versions, time — never a credential or envelope body) and `updated_at` refreshed. Rows, branch anchors, evidence and sibling workflows stay byte-identical; the prior envelope's bytes remain as history and stop authorizing because the binding moved.
- The snapshot schema owner (`coordination-write.ts`) validates the audit strictly and the ordinary writers pin it (dropping, rewriting or forging an entry through a generic snapshot write refuses `coordination.direct-write-refused`). A crash between the exclusive envelope creation and the snapshot commit reports failure — never a success receipt — and reclaims only the exact envelope that operation created; an exact retry returns the recorded receipt without revision churn, while a changed request, a stale token or a superseded binding refuses.
- New transport: `mstar workflow recover-coordinator` (explicit operator route, exit 2 for usage, 1 for refusals) and the host-owned `mstar_coordinator` tool's `show-recovery` / `recover` operations, which derive the native session id, the canonical control root and the recorded prior holder from host/engine facts — never from the call. The public projection is §3.3's list only: the coordinator envelope/credential path stays in coordinator-owned transport, so the CLI's JSON and diagnostics never print it, and every stop-assertion entry must be a public session id (single safe path component, bounded length) before it is hashed, stored or echoed.
- Reviewed-token integrity is closed on all three seams: the recovery re-reads the compass immediately before its commit (a concurrent compass edit refuses `stale` and reclaims only this operation's envelope), crash cleanup unlinks a leftover envelope only while its bytes still equal the ones this operation wrote (a replaced path is left untouched), and a create-only generic snapshot write may not carry `coordination.identity_recoveries` at all — recovery history is provenance, not shape.
- **Identity-missing refusals name the supplies verbatim.** Every active route that refuses for a missing session identity — `plan bind` in all its forms (coordinator, identity session, sparse, resume), `plan show`, sparse plan operations, and workflow transitions/evidence/recovery — now states the exact supply paths in the refusal: CLI `--session-id` (or `MSTAR_HOST_SESSION_ID`), MCP: the host passes `sessionId` per call. The ACTIVE registration refusal was reshaped for the optional-creator contract: only `expect` and `operation` can be missing, and its text explains that an unset identity registers a NULL creator the first coordinator bind adopts.
- **`mstar doctor --target omp` now reports real plugin alignment.** The doctor's `pluginVersionNote` is fed by a new `detectPluginVersion` effect the CLI supplies from the existing per-host discovery (for omp: `omp plugin list`), so the stale-plugin guidance ("CLI X is newer than installed plugin Y — update the Morning Star plugin: omp plugin install @mstar-harness/omp") and the not-installed note reflect the actually detected version instead of always claiming no plugin was found.
- **ACTIVE registration no longer requires a session identity (issue #383c).** `workflow register` / `iteration.register` over the active DB route accept a caller with no session id and write a NULL `creator_session_id`; an explicit id is still recorded as attribution when the transport supplies one. The trust boundary is unchanged and now tested end to end from real unset-identity creation: the first coordinator bind adopts a NULL-creator workflow once, later adoption is refused once any coordinator record exists, and the creator fence plus duplicate-holder/holder-matching gates are untouched.
- `validateExecutionIdentity` gained one explicit registration-only relaxation (`allowUnsetSessionId`): the normalized empty string passes as "unset" for the create path, every other consumer keeps the acquired-identity rule.
- Reworded registration refusals to disclose state and the supported next action.
- **MCP session identity:** the `MSTAR_HOST_SESSION_ID` environment fallback has been removed from the MCP resolve path. Identity-consuming commands such as `session.recover` take the main-conversation session id solely via their explicit per-call `sessionId` input (the CLI `--session-id` flag / MCP schema field — parity that already existed); the existing fail-safe refusal when the parameter is absent is unchanged. MCP-invoked identity tests now pin the identity-gate-specific refusals, the wrong-session ownership refusal, and real CLI parse/routing.
- **Ambient environment identity no longer blocks legacy `mstar plan bind --resume`**; that route ignores ambient env and refuses declared identity (`--session-id` or host-supplied).
- Routed every registered-plan pointer through the ONE path resolver (prerequisite contract §4): `resolveRegisteredPlanFile` / `PlanPathError` are exported from the engine barrel beside `planDeclaredHeaders`, so registration, the Prepare append and later readiness share one parser instead of restating the `{PLAN_DIR}/<plan-id>.md` convention.
- `mstar iteration register` now persists the **canonical absolute** plan path in the snapshot instead of copying the caller's spelling, and the catalog registration preflight resolves and refuses an iteration row pointer **before** the first `prepared` journal row — a repository-relative `.mstar/plans/<id>.md` input is refused (received form, base, expected canonical target, permitted forms) with no root, snapshot or journal write; the normalized request is what gets hashed, stored and handed to the producer, and the shipped transport derives its default operation id from that same normalized workflow, so equivalent spellings of one target share one operation identity.
- The Prepare `appendPlans` pointer check consumes the same resolver (its private fence-aware parser is gone); the `invalid-plan` refusal vocabulary and codes are preserved and now carry the resolver's typed path detail, and a missing/non-string append pointer refuses with that code instead of escaping as a raw path `TypeError`. Standalone/audit catalog location schemas are unchanged.
- The resolver settles the pointer's **shape** before any path API sees it, so an exported-contract caller (a JavaScript caller or a decoded payload) supplying no `file`, `null`, a number or an object is refused with `plan-path.invalid-pointer` — naming the received type, never the rejected value — rather than a raw Node `TypeError` it cannot map onto its own domain refusal.
- Extended the guarded **Prepare workflow amendment** (`amendPrepareWorkflow` / `mstar workflow amend-prepare`) with the optional `correctPlanFiles` list (prerequisite contract §4.1): each entry names one existing Todo row by the **exact pointer it holds now** (`expectedFile`) and that row's own canonical plan file (`file`), repairing a malformed repository-relative pointer without a raw snapshot edit. `appendPlans` stays present — a correction-only call passes an empty append array.
- A correction moves only the addressed row's `file` (plus the ordinary `updated_at`); every other row field, the root register and the review documents survive by value. It refuses an unknown or ambiguous row, a mismatch between the row's pointer and `expectedFile`, an old pointer that does not identify that same plan, a no-op pointer, an id that collides with an append or repeats, and a corrected pointer the shared `resolveRegisteredPlanFile` refuses — all without writes, under the unchanged coordinator identity, Prepare/no-execution admission, double byte-version CAS, exact compass plan-id set and last-moment compass recheck.
- The old pointer is accepted in only two forms: one the shared resolver accepts (canonical absolute or normalized harness-relative), or the exact repository-relative spelling derived from this control root's configured plan directory and the repository root that owns it. A foreign absolute path, a same-basename guess, an unrelated directory prefix and a copied plan document with a matching header all refuse; normal registration and readiness still do not accept that spelling.
- The Phase-1 readiness checkpoint now consumes the **shared** prerequisite seams instead of its own path/base logic (prerequisite contract §4/§5): every registered plan row pointer is resolved through the ONE `resolveRegisteredPlanFile` resolver (the same one registration and the guarded Prepare correction use, including a `.mstarc`-declared or external `{PLAN_DIR}`), and the coordinator identity verdict is read through the engine's own read-only `showPrepareCoordinatorRecovery` view.
- Refusals keep the frozen broad codes callers depend on (`binding-invalid`, `prepare-not-locked`, …) and now carry a typed **diagnostic** that names the §5 subreason, the subject, the safe identity-source label, the public ids already in play, the canonical base/target of a plan pointer and the next supported operation. Identity detail distinguishes `identity-missing`, `identity-mismatch`, `foreign-owner`, `recovery-not-prepare`, `recovery-stale` and `recovery-unauthorized`; path detail distinguishes `plan-pointer-invalid`, `plan-identity-mismatch` and a genuinely `prepare-unlocked`.
- A stale stored pointer (the pre-contract `.mstar/plans/<id>.md` spelling) is therefore never rendered as an unlocked compass: it keeps its own path detail, and readiness never normalizes or repairs the row — the guarded Prepare plan-file correction remains the operation that repairs it.
- The registered model-handoff tool forwards those diagnostics verbatim into its `not-ready` details and names the typed reason and the next supported operation in the refusal text. Diagnostics render public ids, codes and canonical plan pointers only: never an envelope path, credential, session JSON or environment payload. A refused plan pointer is therefore classified by its **received form** (canonical absolute or harness-relative) instead of the value it held, and a receipt/row disagreement reports only the canonical expectations — a malformed stored row can no longer project an arbitrary absolute path.
- Bulk dev-dependency refresh merging dependabot PRs #455–#460 into one change: GitHub Actions version bumps, @types/node 26, js-yaml 5, vitest 5, katex 0.19, shiki/@shikijs/langs 4.5, `@modelcontextprotocol/client` 2.3.1, simple-icons 16.34, `use-sync-external-store` 1.7, and the `dsh-llm-fallbacks` 0.6.5 pin synced into the engine constant.
- Type checking and declaration emit now run on TypeScript 7 (tsgo); the four AST-based lint scanners keep parsing with TypeScript 5 through the new `typescript5` alias until tsgo ships a `createSourceFile`-style parsing API.
- Renamed the Chinese brand copy to **晨星** across the docs, skill descriptions, host reference, marketplace `zh-CN` display names and the dsh panel locale value.
- Dropped the parenthetical Chinese gloss from the English plugin `longDescription` fields and the package READMEs — `Morning Star …` now reads directly, with no `(晨星)` substitute. The root README pair keeps the bilingual brand line (`Morning Star (晨星)`), so both languages change in the same set.
- **Runtime-facing READMEs.** README.md and README_CN.md are rewritten for people running the harness with their own coding tools: plain-language positioning and use cases, a condensed install/verify surface covering all seven hosts, the three entry shapes (single task, iteration, audit/review/verification), the delivery workflow as one Mermaid diagram per language, and a help-driven CLI section (`--help` lists a command's inputs, including issue payload fields with requiredness and type; a usage refusal names the problem, the help route, and the recovery).
- **Product identity restored.** Both READMEs carry the original subtitle (`Harness Workflow Engine · Agent Plugin`) and the full badge set — CI, license, version, last commit, dshfind, Greptile, and the four npm download badges.
- **Role overview retained.** Both READMEs keep the original role table followed by a short explanation of how the PM dispatches work; the Markdown customization wording is removed.
- **Workflow diagram.** The numbered workflow list is replaced by one Mermaid diagram per README: plan → implementation → independent review → acceptance with rework loops → iteration repetition → PR checks and review corrections → merge-ready → explicitly authorized merge → verified merge and post-merge close, with scope notes for the hotfix/inline and report-only routes.
- **Dashboard and MCP sections.** Both READMEs gain dedicated Dashboard and MCP sections — what the user sees or does, plus a minimal startup example — which replace the duplicate dashboard/MCP bullets in the command-line section.
- **Reference split.** Component, storage, CLI-contract, report, and enforcement detail moved off the homepage into the new docs/runtime-reference.md — detailed role/skill references and MCP host-integration material live there too, while the role overview and a short user-facing MCP introduction stay on the README — and INSTALL.md's report link now points at its Offline report draft anchor.
- **Install facts corrected.** omp installs only when its CLI is present; `init` defaults to `--scope project` with host-specific surfaces (dsh's profile is machine-global; Codex's global scope skips the command skills); the runtime reference documents all seven host MCP launch configurations, including the shipped dsh Cordis row loaded through the `@deepseek-ai/dsh-mcp-client` bridge plugin, and iteration wording follows the Phase 2–6 lifecycle.
- **Simpler README installation entry.** The English and Chinese installation sections now start directly with the host table. A **Node.js 24+** badge links to the full prerequisites in `INSTALL.md`; existing badges are retained, and MCP prerequisite links point to the same reference. Runtime requirements are unchanged.
- Recorded the repository's CLI-usage rule in `AGENTS.md`: run this checkout's own build (`bun run --cwd packages/cli build`, then `packages/cli/dist/mstar-harness.js`) rather than a globally installed `mstar`/`mstar-harness`. A global install is the released package for other projects — linking this checkout into it makes those projects run unreleased code, and invoking the global copy here runs a released CLI against unreleased engine behavior.
- Added two **prose-hygiene rules** to `mstar-compound`'s knowledge-document quality gate: durable bodies state the rule and the outcome, not the authoring date (timestamps belong to the frontmatter `date` / `last_updated` schema fields), and citations use repo-relative paths or `{HARNESS_DIR}`-style symbols rather than machine-local absolute paths.
- Reinforces the existing `CONCEPTS.md` rule (no status/date/owner fields) at the compound write path.
- **Guard 8** validates links and heading anchors across tracked Markdown, using the canonical `github-slugger` behavior to resolve heading fragments.
- Same-file fragments such as `#section-name` are checked against their source document.
- **`drift-lint` gate clean**: dashboard file-header comments rewritten to behaviour-only prose — tracked text carries no local plan/iteration ids (14 provenance citations cleared; the scan reports 0).
- Restored the product name in both README titles: the H1 pair reads `Morning Star` again instead of `Morning Star (晨星)`. The Chinese brand name stays in the Chinese page's lead line, and the two one-line edits keep the README pair size-mirrored.
- Ignored transient **Bun cache output** (`/Library/Caches/bun/`) at the repository root so session-environment cache dumps no longer dirty worktree `git status` or block clean-worktree gates.
- **`validate` gate repaired**: the engine builds and typechecks again — the duplicate root `Severity` re-export (core vs issue vocabularies) is resolved to the canonical core path, and the undefined-narrowing / matcher-overload errors in the engine tests and `initializeStore` are fixed with no runtime semantics change. `packages/cli` `typecheck:src` now regenerates the gitignored dashboard asset module first (`scripts/build-web.ts`; deterministic, round-trip-verified), so a fresh checkout typechecks without a full build.
- Removed the unused tracked root `specs/` directory: `{SPECS_DIR}` resolution picks `{HARNESS_DIR}/specs/` first, so the root copy was shadowed, shipped in no package, and referenced nowhere.
- **Hashes are provenance, not gates.** Remove content-hash and canonical-serialized equality refusals across prepared documents, submitted evidence, workflow/catalog/roadmap operations, migration/coverage/activation, recovery and stored schema records. Ordinary document edits no longer require restoration, adoption, resealing or re-signing; recorded digests remain historical information.
- **Keep real constraints.** Same-operation-id/different-request replay conflicts, current semantic scope/owner/QA/state/path requirements, numeric revision and execution-token constraints, and actual Git delivery facts remain. Remove obsolete byte-version, manifest/coverage hash and restore-loss digest admission inputs without adding bypass or replacement-seal protocols.
- Align canonical CLI/workflow/evidence guidance and add four targeted routing scenarios with semantic negative controls; generated host assets continue to derive from canonical sources.
- Accept equivalent session-reference and execution-token key JSON without byte canonicalization. Preserve interrupted ledger tails instead of truncating or refusing them, and retire only reviewed index rows while preserving added rows and narrative content.
- Add a bounded architecture check for hash, raw-byte and canonical-equality refusals/assertions, with operation-id lookup evidence required for each replay exception.
- Remove persist --expect-version, Prepare recovery/amendment byte-version inputs and store execution restore --accept-loss-digest. Removed extra-primary launch admission is not replaced by another seal.
- Restore compares authorized loss row identities/revisions and operation IDs, inventories and installs one private backup image, and retains fresh pre-restore safety backups. Re-preview is needed only for newly endangered work or authority generations, never for a changed digest.
- Legacy migration derives current source data under its root lock, preserving workflow/plan membership and current coordinator ownership. Deleted launch reservations have no replay/repair successor.
- State `persist write` replacement semantics in help, update obsolete hash/CAS expectations in consumer tests, and escape non-ASCII code literals for bundled CLI execution.
- Validate recovery-point paths before staging the image so missing/unreadable points return typed refusals with public backup/preview recovery. Rebuild the committed ZCode hook bundle from the current engine.
- Keep the retained ledger descriptor open through commit so inode reuse cannot mask a replaced destination; clear stale migration `ended_at` fields while preserving authored notes. Keep actor-only mutation scenarios independently isolated instead of grouping thirteen CLI processes under one timeout.
- **Recovery-first engine surface.** Exported lifecycle operations (`mutatePlanCoordination`, `mutateExecutionPlan`, `mutateExecutionWorkflow`, `amendPrepareWorkflow`, the registration producers and the closes) accept a sparse intent — omitted redundant selectors, revisions, session projections and copied metadata — resolved against the caller's trusted root, its durable association and recorded declarations, with transaction-local inputs staying strict. Published resolvers: `resolveIntentRoot`, `resolveIntentTarget`, `resolveCurrentAuthority`.
- **One recovery sidecar on every outcome.** A successful value carries `recovery`; a refusal carries the same object under `error.details.recovery` (`outcome`, `applied`, `unresolved`, `resolvedFrom`, `warnings`, `commitState`), so a partially applied compound intent is never reported as a mutation-free refusal.
- **Semantic replay instead of transport freshness.** A repeated intent is a current success with no revision, receipt or byte churn; a revision that moved without the intent changing is a drift warning rather than a refusal; a genuinely different payload or target still refuses.
- **Registration derives its own identity.** `derivePlanRegistration` and `deriveLifecyclePhase` derive a plan's id/title/pointer and an iteration's phase with the selected document as the authority; an interrupted registration finishes its missing link on retry and a phase-less iteration is derived on read.
- **Prepare amendment commits per component.** Independent components land and withheld ones report one minimum decision each in the stable `append plan <id>` / `correct-plan-file <id>` / `integration-worktree <path>` / `execution-policy <value>` vocabulary — one partial receipt per call on both authority routes, no applied component applied twice on replay.
- **Every declared lifecycle state has a writer, on both routes.** Evidence recorded before a row is `Done` completes the report-only tail; `closeFileWorkflow` is the file authority's one close verb and the DB route composes the same intent on one handle; explicit `failed`/`stopped` outcomes are recordable on both routes, settling only owned claims of non-live holders and preserving the first `ended_at`.
- **Additive engine exports only.** New: `closeFileWorkflow`, the intent resolvers, phase constants, `CloseWorkflowOutcome` and the resolution/derivation/close types. No export renamed or removed.
- **CLI and MCP recovery transports.** The CLI and stdio MCP share the command registry and return the same versioned outcome envelope for recovery-sensitive commands; MCP tool schemas expose the registry's payload contracts, and the smoke probe runs against isolated file and SQLite roots.
- **`roadmap replace` states its own comparison basis.** `--expect-project` and `--expect-roadmap` are irreducible caller claims; an omitted claim is one aggregated usage refusal naming both flags, and a stale claim refuses `roadmap.revision-conflict` with nothing written (the guard no longer compares the authority against itself).
- **MCP tool schemas no longer advertise fields the handler does not read**, and a declared string-or-null payload field (`IssueTriage.owner`) keeps its type instead of degrading to `z.unknown()`.
- **Cancellation during a dashboard start stops the listener it created** instead of leaking a connection-scoped service; a handle another call already owns is reused and left running.
- **`plan issue-add` derives plan-owned project association per finding** and reports independently invalid entries with their array indexes before capture; DB capture and plan linking stay composed in one transaction with occurrence keys as stable event identities.
- **Declared per-kind `persist.write` payload schemas**; aggregate status validation failures surface through the persist command while coordinated replacement/version-conflict handling is preserved.
- **Retired the `judgment review-advice` route**; the historical `judgment submit` intent has no registered command. ReviewDecisionPack-owned fields are derived and multiple missing pack paths surface together only in the retained judgment APIs.
- **Documented `mstar-harness schema` discovery** for issue capture/occurrence/triage/closure/link and plan progress payloads; disposition-specific fields are checked before writing, not guessed through repeated refusals.
- **Test corpus cleanup.** Every inventoried package corpus (engine, cli, commands, omp, opencode, judgment) was swept under one written keep/delete rule: assertions pinning source shape, wording/help prose, forwarding echoes, duplicated registry copies, exported arity or environment constants were deleted, not renamed or re-pinned; consumer-visible behavior, boundaries, atomicity, authority, replay and actionable diagnostics were retained.
- **Development acceptance stays isolated.** Acceptance language aligned with isolated product-behavior proof rather than live provider, authenticated host, installed artifact or device receipts; separately authorized operational verification remains independent.
- **Native model-handoff preference off is a success-shaped no-op** with a neutral notice at both direction-lock and phase-1-lock; enabled handoff still checks coordinator identity and actual readiness.
- Allowed sparse active workflow mutations and workflow close to derive current tokens and generate one operation id when omitted; explicit session references and tokens remain constraints.
- ACTIVE cleanup reads the authoritative store; a launched minted coordinator identity takes precedence over ambient identity without granting unrelated workflow authority.
- Execution authority lives in store.db: ordinary primary-coordinator prepare/progress/complete and workflow transitions use atomic SQLite transactions, CAS and receipts; per-row PM identity/transfer/execution-lease admission is removed.
- Registration atomically publishes catalog delta, ordinary workflow/row metadata, root membership and receipt. Catalog edits do not silently relocate registered plan pointers; no sealed Assignment is required.
- Added the authoritative execution read route: workflow/plan state is read from the store in one read transaction, and a missing, staged, corrupt or busy authority refuses (`execution.consumer-not-ready`) instead of degrading to leftover root/snapshot JSON, newest-workflow guessing or dashboard projections. While the authority is active the retired file writes are refused at every entry boundary.
- Replaced the staged execution migration preview/apply/activate/retire/abort protocol with the single static `mstar store upgrade --operator <name>` path: it opens or creates the store, imports recognizable stopped-workspace state and activates authority in one run, leaving skipped source bytes in place. Standalone backups freeze the file-native bodies a SQLite copy does not carry (ledgers, identity index, cursors, history chunks, selection body) together with their accepted-record identities.
- Completion is witnessed by a sealed Git proof instead of refs alone (checkout/git/common-dir identity, `HEAD` and its refs, the index, every tracked path's content and mode, the directory listings a new untracked path changes, merge/rebase sentinels, the object inventory). It is re-read from the filesystem with no child process and no await immediately before the completion transaction, so a worktree, index, untracked or object-store change inside that window refuses without a `Done`, a receipt or a released lease.
- Added the execution coverage substrate: a closed 18-surface inventory with a byte codec per surface, and a validator that recomputes coverage from the retained bytes — hashing every named witness and deriving each result hash from what the bytes say — so an invented result, a changed byte, a borrowed or unpinned witness, a foreign workflow identity or a mislabelled capability refuses as `execution.coverage-incomplete`.
- An injected `ArtifactStore` (`setArtifactStore` / `--store` / `MSTAR_STORE_MODULE`) is served behind a guard that refuses the root register, a workflow snapshot and their `json` aliases while the canonical control root's authority is active; the control root is resolved from the process, never from the injector's own claim.
- Updated `mstar-artifacts` `references/status-and-residuals.md`: the transport split (active DB authority vs pre-activation file route) is now stated where the v2 file shapes, lease fields and lockdir prose are introduced, instead of only in the later coordination section — remaining snapshot-as-SSOT references are scoped to the pre-activation transport or legacy history.
- Canonicalize active workflow registration's catalog plan path relative to the plans root, accepting canonical absolute plan paths without changing the execution resolver input.
- Coordinator recovery is an explicit attested bootstrap: it names the prior holder, adopts only the ownership that revocation orphaned, and never revives an old-epoch lease.
- Source readiness does not switch installed consumers, bump version surfaces or claim live activation or release. The committed ZCode hook bundle `hooks/mstar-write-gate.mjs` is rebuilt from the current engine; installed fencing and consumer refresh remain separate operational work.
- Kept standalone backup recovery (`store backup`, `store execution restore-preview`, `store execution restore`) and live-state export (`store execution export`) independent from upgrade.
- Added whole-store recovery (`previewExecutionRestore` / `restoreExecutionBackup` / `exportExecutionState`): the backup carries committed WAL-visible work, restore internally checks authorized loss row identities/revisions and operation IDs and retains a fresh safety backup, and the diagnostic export is inert and credential-free. No caller-supplied CLI loss-digest flag is required.
- CLI/session/host writes use independently acquired workflow coordinator identity with explicit plan addresses and checked or derived current transport context. No per-plan PM identity or child transfer survives.
- Kept the file forms only in explicitly labelled pre-activation sections that also state an active authority refuses them; no active instruction tells a reader to hand-edit a snapshot or to treat a legacy envelope as the live route.
- Made the session reference a lookup rather than a bearer credential: it names a stored row and grants nothing without the caller the engine compares inside its own transaction, and a reference, an expectation value or an operation id is never forwarded into a child assignment. Resume is not recovery — a stopped owner is replaced only by the explicit recovery verb on an active authority, or by the guarded Prepare recovery on the file route.
- Host specifics moved to their owning host references and were sourced from the reviewed implementations; the DSh README pair was realigned on the ledger identity/dedup authority, the durable cursor and the archived display tail.
- Added two vocabulary entries to `CONCEPTS.md`: **Consulted header set** (a label-keyed plan parser consults a closed, exactly-matched label set — never a prefix, so a descriptive sibling such as `Working branch policy` cannot alias a consulted field) and **Maintenance exclusion** (the single outermost lock an engine lifecycle operation holds so no cooperative writer in any package can append into its window; a coordination discipline, not an authority).
- Documented the shipped coordinator identity routes in the skill corpus: the host-owned `mstar_coordinator` entry (`bind`, `show-recovery`, `recover`), the local `plan bind --coordinator --session-id` form, the `mstar workflow recover-coordinator` verb, and the registered-plan pointer forms. The corpus separates pre-activation routes from active-store DB recovery (full execution token + stop attestation) and native one-shot model handoff (`mstar-host/references/omp.md`, `mstar-use-cli/references/plan-and-workflow.md`, `mstar-use-cli/references/preconditions.md`).
- Registered plan pointers are documented as the **canonical absolute** `{PLAN_DIR}/<plan-id>.md` — a canonical absolute or normalized harness-relative input is accepted, the repository-relative `.mstar/plans/<id>.md` spelling is refused before the first journal/snapshot/root write — and the guarded `correctPlanFiles` correction is the same-row repair, changing only `row.file` plus `updated_at` under the existing Prepare admission and current semantic/revision constraints, not obsolete byte-version inputs (`mstar-artifacts/references/status-and-residuals.md`, `mstar-iteration/references/phase-1-prepare.md`).
- Workflow coordinator identity is explicitly acquired; public recovery output contains safe facts, never envelope paths/body. No Assignment or row identity is a binding input.
- Documentation alignment itself changes no source behaviour, flag or refusal code and claims no installed generation, released verb availability or operational handoff.
- Removed `status.json` from the engine `compoundRefreshScope` allow-list (its ACTIVE file-route guard refuses that path); regression coverage asserts the narrowed scope and the ACTIVE refusal through the real write port.
- Appended the `Amendment 2026-10-06 — ACTIVE store execution authority` to the frozen plan-workflow lifecycle contract: store registration/close seams primary, file routes as pre-activation/engine-absent fallback.
- Closed the knowledge_refs carrier decision on catalog relations (`mstar catalog link`); snapshot `plans[].metadata.knowledge_refs` labeled legacy read-only across artifacts/compound/compound-refresh.
- Added execution-authority state and the supported upgrade entry to `status validate`; clarified route-scoped tokens and plan-file addressing.
- `mstar store upgrade --operator <name>` is the sole default execution-state upgrade: it opens or creates the store, imports recognizable records in one run, activates authority, and returns one result with skipped items. Unknown and unresolved sources remain at their original paths; no attestation, inventory, staged manifest, coverage gate, activation barrier, or command-owned recovery point is required.
- Removed `store safe-upgrade` and the staged execution `preview`, `apply`, `activate`, `retire`, and `abort` verbs. Standalone `store backup` remains; execution `restore-preview`, `restore`, and `export` remain as independent backup/disaster-recovery and live-state reporting utilities.
- **Canonical store administration:** CLI and MCP store operations now accept the project's canonical control root through explicit `--harness` selection or normal project discovery. Backup verification, maintenance locks and migration/activation attestation guards remain in force; command help documents the supported target.
- Store-upgrade migration retirement now requires current snapshot or root execution evidence; stale journal history alone no longer qualifies.
- Added `workflow adopt-terminal` to record an adoption receipt for an unregistered workflow header, with a revision CAS and truthful status reporting.
- Restrict the `mstar persist` family to `review` and `json`; engine `status` and `snapshot` kinds remain internal to the migration path, whose permanent consumer is `migrate.ts`.
- Retire the coordinated artifact read/replace chain and its public exports. The coordinated purge-entry veto remains deferred to the T21 terminal sweep.
- Registration replay no longer answers over a **terminal lifecycle snapshot**: during the close window (terminal snapshot on disk, root entry still present) a committed registration refuses with `catalog.registration-terminal-lifecycle`; committed reconcile replays apply the same guard. Let an in-flight close finish; if it was interrupted, run `mstar status workflow-close --workflow <workflow-id> --harness '<harness-root>'` to finish unregistering, then retry the registration. Ordinary plan-row progress replays still replay the committed receipt (#323).
- **Dashboard views:** Workflow and iteration views now read from the execution authority on ACTIVE harnesses instead of refusing the request. Fixes #354.
- **ACTIVE projection:** Removed an unreachable synthetic plan validator and redundant lease queries; completed plans with retained released leases remain visible without historical ownership.
- Added the file-native workflow notes ledger (`appendWorkflowNote`): one canonical line per note, appended under the execution-maintenance exclusion and the per-workflow status lock, with the synchronous current-session assertion as the last step before the fsynced byte write. Migrated legacy lines and the inline plan notes stay byte-for-byte preserved — nothing rewrites, reorders or compacts a retained ledger, and no note becomes a DB event.
- A note's identity is the caller's stable id: the same id with the same body replays without appending, the same id with a changed body refuses, and an id already recorded elsewhere refuses instead of picking a winner. A crash-cut partial line of the record being written is reconciled into exactly one accepted line; an unaccepted prefix that follows the record's own accepted line is healed by removing that prefix only; an unterminated tail that is not that record's partial refuses with every retained byte left in place.
- The retained leaf's trust decision is its open: `O_NOFOLLOW` plus a re-verification of that same descriptor's device/inode **and its bytes**, so a leaf swapped for a symlink, replaced or removed between the read and the commit refuses instead of being followed, truncated or written through.
- Durable writes complete a short write (a capacity-limited descriptor can accept fewer bytes than it was given) and refuse a write that accepts nothing, in both the ledger append and the atomic-replace helper.
- The DSh agent-flow ledger now derives every new row's identity from verified native facts — the log's verified incarnation plus the carrying session and call id — makes the accepted-identity index the dedup authority and the cursor sidecar a per-incarnation scan bound, and keeps the append, the identity commit and the scan-bound advance inside one shared-lock critical section. Display compaction is a single transaction recorded in a transient journal (before/after tail hashes plus the exact archive range), and evicted lines are archived byte-exact into sealed history chunks before the display tail is rewritten.
- Both agent-flow write paths take the same execution-maintenance exclusion as the engine's activation, restore and migration before their own lock, so a plugin write inside that window is refused with a bounded advisory instead of landing in a directory that is being rewritten.
- Exported the lifecycle-branch fact type from the engine package entry point for the commands consumer.
- Removed the retired file-route Prepare recovery suite and `lease.verify-integration` setup-verb test cases; surviving L1 lease coverage remains in `worktree check`.
- ACTIVE iteration registration now canonicalizes compass references to harness-relative paths and refuses paths that escape the harness, including through symlinks.
- Replaced retired recovery instructions with ACTIVE status/token reads, coordinator recovery, and an actionable failed-close/re-register route for a missing delivery kind.
- `mstar worktree check --entry` admission is now workflow-type specific: a standalone plan workflow requires only the source/target anchors its registration records (and uses `target` for main-worktree residency), while iteration workflows keep the required base/target/integration anchors plus the integration-checkout validation. Missing-anchor refusals now give per-type, achievable recovery instructions.
- Audit-promote CLI fixtures assert the ACTIVE execution graph (single store initialization, activated token) instead of the retired snapshot/`status.json` projections.
- Made the status-write gate execution-authority-only and regenerated its bundled hook.
- Removed retired lease verify-integration assertions from the MCP identity test and retained the active worktree check surface.
- Inject acquired session identity into `milestone.assign` while preserving the optional checked session reference.
- Removed the retired empty status template fixture and its validation case.
- **OMP**: `mstar_coordinator` gained the active `bind` / `recover` forms that call the DB verbs directly under the host-derived execution identity, with `show-recovery` answering from the DB on an active root and keeping the unchanged Prepare view on the file route. The route is read from the addressed control root, never selected by a tool argument: a mixed or partial key set, an active form on a pre-activation root and a Prepare form on an active root all refuse before any IO.
- **OMP**: `mstar_phase2 {operation:"bind"}` takes no caller-supplied session path and adopts what the addressed root's own authority holds (the DB coordinator binding on the active route, the workflow's own recorded envelope on the file route). The durable record is version 2; earlier records stay readable as legacy history and are never upgraded into a DB binding, and an active binding always supersedes one.
- **OMP**: added a read-only hidden-history reader/exporter that classifies one session ledger by its exact hidden entry types, preserves every payload verbatim with its digest, and decodes only what a verified producer schema admits. An entry whose producer is unknown or whose payload cannot be admitted is retained in full and diagnosed rather than guessed into a session or another type, and the exporter refuses instead of exporting with evidence missing.
- **DSh**: session selection and exclusion floors persist separately from rebuildable engine-status emissions; only canonical execution-binding witnesses are stored, and a stale, revoked, missing, corrupt or scope-mismatched authority is refused without falling back to the root register or the newest workflow. The legacy target route survives only when no active authority exists.
- **DSh**: added the plugin-owned `/mstar-execution` human command (closed JSON `adopt | clear | run`) — identity comes from the carrying native session, known leaf/subagent seats are refused before any parse or harness probe, and `run` launches a shell-free child whose execution-identity transport is overwritten while every spoof and legacy key is removed.
- **OpenCode**: the execution identity is derived from the native hook session id plus an independently acquired scope, the session's own reference is learned from its CLI traffic and carried into a real shared-CLI invocation, and both legacy keys are removed while the root comes only from an explicit flag or the child's working directory.
- Inject the omp session's native identity into eligible Morning Star MCP calls and diagnose a missing ACTIVE-workflow identity injection path.
- **omp now supplies the Morning Star MCP `sessionId` per call (issue #383a).** The new `mcp-identity` extension (registered in `omp.extensions`) revises eligible `mcp__morning_star_mstar_*` `tool_call` inputs to `{ ...input, sessionId: <native id> }`, so a standalone plan workflow chain — `workflow register -> coordinator bind -> plan prepare -> progress` — carries the calling session's identity without the agent passing ids by hand. Eligibility is schema-aware: a tool qualifies only when its declared `ToolInfo.parameters` schema declares `sessionId` (the host revalidates revised inputs, so an undeclared key would be rejected host-side); the name prefix is a prefilter only. Injection is additive-only: an explicit caller id is never overridden, `block` is never set, and the id is read per event from `ctx.sessionManager.getSessionId()`, so leaf sessions carry their own id.
- Restored host session identity injection for shell commands with an idempotency guard, keeping repeated revisions from stacking `MSTAR_HOST_SESSION_ID` exports without touching the `env` input.
- Changed the coordinator-visible OMP notice **bar titles** to the shared types: the phase-2 diagnostic notice and the model-handoff notice now send `customType` `mstar:notice`, and the bounded phase-2 advisory sends `mstar:advisory` (previously `mstar:phase2-notice` / `mstar:model-handoff-notice` / `mstar:phase2-advisory`). The bar header prints the sent type, so the visible title now matches the shared Morning Star notice family.
- Unchanged: the hidden durable ledger identities `mstar:phase2` / `mstar:model-handoff`, their restore and dedup identity, the observed body workflow id/status/fallback, the delivery/continuation options and every machine refusal code (`phase2.workflow-terminal` included). A visible title rename is not a ledger or refusal-code change.
- Source-level change to the emitted values plus the matching host-reference paragraph; the emitted body states its own workflow status once. No installed UI, renderer registration, bundled host copy or publication is claimed by this entry.
- Removed the dead omp validator tool sources (`src/tools/`: `mstar_iteration_gate`, `mstar_worktree_check`, `mstar_status_validate`, `mstar_lease_verify`, `mstar_path_resolve`, `mstar_dispatch_validate`). The build stopped compiling and shipping them when the MCP stdio server moved into the CLI; the same capabilities are served by `npx @mstar-harness/cli mcp` through the packaged `mcp.json` (`iteration.gate`, `worktree.check`, `status.validate`, `lease.verify`, `path.resolve`, `dispatch.validate`). One scope note: the CLI `path.resolve` command resolves the four top-level directory symbols (`{HARNESS_DIR}` / `{SPECS_DIR}` / `{WORKFLOW_DIR}` / `{PROJECT_DIR}`); the per-plan `{PLAN_DIR}` / `{SDD_DIR}` and the `{ITERATION_DIR}` / `{KNOWLEDGE_DIR}` symbols follow the documented resolution conventions from `{HARNESS_DIR}` (engine `resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir`; SSOT `mstar-conventions`). Deleted the omp-side test arms that pinned them (`execution-read` validator suite, `worktree-check`, the `store-cutover` tool route, the bundle-smoke custom-tool probe) and the cross-package arms in `packages/cli/test/tools-v2-smoke.test.ts`; the omp `tool_call` pre-hook coverage is unchanged.
- Widened the optional host peer to `@oh-my-pi/pi-coding-agent@^18.3.0` (any 18.x host) and moved the development baseline in `devDependencies` to `18.3.0`, so the suite validates against the host users actually run. The exact `18.2.1` pin had already drifted from reality: hosts in the omp 18.3.0 line refuse any `bash` tool call whose input carries `env` without a service `name` (`ready and env require a service name.`), a parameter-surface contract this package's shell-transport code must respect.
- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.2.0-rc.2` (corridor `dsh-v0.2.0-rc.1` → `dsh-v0.2.0-rc.2`: desktop menu-bar bundled dsh install, experimental async Q&A, model-picker fuzzy search, UX/desktop fixes, pi-ai → 0.87.1; deferred until npm published 0.2.0-rc.2). Session format v4 unchanged.
- Renamed the `@deepseek-ai/dsh-*` peers `dsh-agent-presets` → `dsh-agent-preset` and `dsh-code-runtime` → `dsh-ptc-runtime`.
- Migrated the planMode bridge from `agent/session-start` to serial `agent/created`.
- Bumped the `dsh-llm-fallbacks` devDependency `0.5.2` → `0.6.4` (first fallbacks generation matching the `0.2.0-rc.1` peer cohort); the engine `DSH_LLM_FALLBACKS_VERSION` pin moves with it.
Route the live workflow picker through ACTIVE execution state, fail closed when dispatch-ledger targets are omitted, preserve alternate branch-form lease matching, and reuse one ACTIVE workflow-source read across dispatch gates and recording.
- Documented the issue/catalog SQLite path `{HARNESS_DIR}/store.db` and its authority split from execution JSON (`ArtifactStore`).
- Indexed the `mstar issue …` CLI family (verbs in `--help`; flags not restated in skills).
- Recorded CLI launch floors by entrypoint: Bun `>=1.4.0` for the shebang, Node `>=24.18.0` for explicit `node` on the CLI bundle — not a demand to install both runtimes.
- Added the **catalog authority** in `{HARNESS_DIR}/store.db` (migration 2): project/iteration/plan/document identity, paths, membership, spec/knowledge relations and catalog lifecycle are DB rows, while document bodies stay files and execution routing, leases and frozen inputs stay JSON.
- Replaced the maintained Markdown index obligations (iteration README rows, package Documents tables, specs/knowledge index tables) with **catalog discover / import / register / query** duties; completeness is a DB query, and a missing README is no longer a failure.
- Added the `mstar catalog` verb family (list, show, register, update, link, discover, import, export, reconcile) — verbs and flags live in `--help`.
- Added the **registration journal**: the snapshot/root writes and the catalog delta publish through one recoverable operation (`catalog.registration-pending`, recovered with `mstar catalog reconcile`), and a prepared plan pins its execution input to a catalog revision.
- Added **disposable execution/roadmap projections** (migration 3) with honest freshness and diagnostics, plus the `withStoreRead` read boundary and dashboard DTOs.
- Documented the cross-clone limit: `store.db` is local and gitignored, tracked bodies alone cannot rebuild local catalog history, and discovery reports explicit unknowns. Live index retirement and activation belong to the cutover plan.
- Landed the **capture duty** as settled by compass D18: a confirmed finding becomes an issue in `{HARNESS_DIR}/store.db` at the moment it is confirmed — capture records evidence only, disposition is a separate authorized act, and a recurrence appends an occurrence instead of opening a second issue.
- Made **`mstar-project-governance`「Issue capture」the single authority** (issue contract §6 verbatim): the seat that owns the confirmed outcome captures — the PM seat and a PR-review round's main agent at Stage 3 — while leaf audit/QC/QA seats return evidence and never write the store. The other five owner texts carry pointer landings only.
- Re-pointed the residual-register prose in the artifacts family (`SKILL.md` + `references/status-and-residuals.md`), `mstar-audit` (incl. the PR-review reference) and `mstar-review-qc`, and added the minimal delivery-loop sentence to `mstar-harness-core`: the register is **migration history**, open items are **store issues**, and `mstar status tech-debt` / `mstar status findings-cleanup` read the store. Retired register writers (`mstar status backlog-register` / `backlog-close`) refuse and name the issue verbs; skills never restate flags.
- Plan issue mutations use only the recorded workflow coordinator envelope or ACTIVE coordinator reference plus acquired identity and explicit plan address. Deleted per-row identities and their historical envelope aliases grant no authority.
- **Dashboard rows scope by their own workflow** (PR #266 review RV-1): projection plan/lease rows are matched by the tables' own `(workflow_id, plan_id)` key — the same plan id under a plan workflow and an iteration workflow no longer attaches the other workflow's lease, status, progress or pin revision in the workflows view or the iteration execution overlay.
- **Symlink cross-harness register writes are vetoed** (PR #266 review RV-2): a pre-activation register reached through a symlink that lands on another harness's active or unreadable issue authority is refused by the landed context (`project.register.retired` / `store.authority-unavailable`) in all three enforcing copies (ZCode hook, omp gate, dsh store-authority); both contexts pre-activation keep the §7 legacy register path.
- **Catalog imports never leave a silent prefix** (PR #266 review RV-3): a mid-plan `importCatalog` failure rethrows `catalog.import-partial` carrying exactly the applied receipts and the resume instruction — the applied proposals are journalled progress, and re-running the same reviewed plan with the same operationId converges to the full plan exactly once.
- **OpenCode plugin declares its Node floor** (PR #266 review RV-4): `@mstar-harness/opencode` `engines` now requires `node >=24.18.0` (`node:sqlite`) alongside Bun, and the package INSTALL/README name the floor.
- Added **DESIGN.md** for the local read-only governance dashboard: light-theme tokens, four-view navigation, evidence/history presentation, accessibility and explicit empty/stale/error states.
- Added an offline `mstar report` draft generator with explicit caller-supplied fields, finite secret redaction, and a user review step; it does not collect local data or submit issues.
- Documented matching CLI and MCP report usage, absent/unknown values, and the meaning and limits of redaction counts.
- **Issue writes are actor-only:** every unscoped issue write verb, including `link`, records through the store without a session envelope or workflow requirement.
- Plan issue-add/issue-close use the workflow's primary coordinator and explicit plan address; plan/iteration link targets remain labels, not independently checked authorities.
- **Workflow creator fidelity.** Imported workflow creator identity is preserved, and first-bind adoption is limited to workflows with a NULL creator.
- **Plan provenance is origin-scoped:** only plan-scoped writers can create scoped membership; actor-only links remain unscoped, and historical provenance remains plan-scoped.
- Origin-dependent issue reads refuse outdated stores with the supported `mstar store upgrade --operator <name>` recovery.
- Removed the obsolete `triageIssueExecution`, `closeIssueExecution`, and `linkIssueExecution` exports from the engine API.
- The public `IssueProvenance` type exposes `origin` as `"scoped" | "unscoped"` for typed consumers.
- **Issue revision conflicts** now include recovery instructions that preserve the original invocation's `--operation-id`, `--actor`, and payload while replacing `--expect <current-revision>`; CAS help is available only for the issue verbs whose engine path enforces the revision CAS (triage, close, waive, duplicate, supersede, reopen, link).
- Added revision-guarded `issue reopen` for reopening terminal issues with an auditable reason and idempotent operation receipts.
- `mstar issue <verb> --help` now lists each payload field with its type and conditional requiredness, derived from `ISSUE_PAYLOAD_SCHEMAS` — e.g. `references (requiredWhen: resolved)` — replacing the opaque `Payload fields: payload` line (#420).
- Closure payload requiredness now follows the **effective disposition** end to end: `--disposition` overrides select the required fields at decode time, and static transport schemas keep disposition-conditional fields optional so composed MCP/CLI admission matches `assertClosureAuthority` (#420).
- **Iteration registration now records `phase-1-prepare` and stores a harness-relative `compass_ref`**: the producer normalizes an absolute in-root spelling to the contract form and refuses pointers that escape the harness root (symlink-safe), so every newly registered workflow is amendable by construction.
- **Prepare commands recover legacy snapshots instead of dead-ending**: `workflow show-prepare` reports derivable state (`derived`) when the phase label is absent or the stored compass pointer is absolute-but-in-root, and the next `workflow amend-prepare` adopts both in its ordinary locked write — a present non-Prepare phase is still refused, never rewritten, and real execution facts (leases, non-`Todo` rows) keep refusing first.
- **Phase 1 writes land only in the gitignored iteration package**: the §2.3 integration-worktree checklist step 7 (reached through `iteration-start` §6) now pushes only the newly created `spec_integration_branch` (`git push -u`; the branch tip stays at the recorded base, satisfying the `phase-1-lock` readiness check that the pushed remote tip equal the live integration HEAD — enforced by the omp model-handoff runtime). Phase 1 roles write compass / plans / the `<iteration-id>/` package (specs in `<iteration-id>/specs/`) — all default-gitignored local artifacts; the global `{SPECS_DIR}` is written at Phase 3 iteration-close promotion — compound-rewritten **directly into the integration worktree's tracked `{SPECS_DIR}`** (`{KNOWLEDGE_DIR}` promotion follows the same integration-worktree write; the primary checkout carries only gitignored process artifacts) and committed into the integration branch by the §3.5 close commit — with the existing registration surfaces completed in the same step: package `Promoted to:` annotation, plan `primary_spec` / `spec_refs` + compass references, and catalog `register` / `link` (the registered path resolves against the integration worktree during close and PR review, and against every checkout after merge). Renamed the `iteration-start` / `iteration-loop` pre-commit checklists to pre-integration checklists (loop's `phase-1-autonomous-start` todo now completes on compass lock + integration-branch push), rescoped the §1.6 chain and writing-specialist corpus hygiene to the iteration package (`iteration-artifact-boundaries.md` / `iteration-corpus-hygiene.md` updated to the same boundary), and dropped the stale Phase-1 "commit" from the plan-mode bridges (`_shared/plan-mode-bridge-core.md` gate + anti-pattern row, `cursor.md` Phase-1 Plan-mode gate, `cursor-`/`omp-`/`kimi-`/`zcode-plan-mode-bridge.md`).
- **Prototype-first preparation:** interactive Phase 1 revises a retained plain-language visual HTML until the current design is explicitly approved before formal artifacts; autonomous opt-in retains an appropriate HTML/Markdown/JSON prototype for planning and traceability without routine human confirmation.
- **Selected specialist review:** PM reuses prototype contributions and selects product-manager/architect by remaining gaps; actual selected reviewers run sequentially with mandatory writing-specialist last, and OMP readiness accepts their ordered completion receipts.
- Removed the dead `judgment review-advice` command route; judgment runtime and shadow-supervisor APIs remain available.
- Exposed judgment runtime, audit, evaluator-channel, and shadow-supervisor APIs; made the shadow runner available as `@mstar-harness/judgment/shadow`.
- **`@mstar-harness/judgment`**: add shard-scoped author pre-dispatch gate (`author-gate.ts`, `author-sink.ts`, `scripts/author-gate.ts`) reusing the shadow supervisor Docker launcher pattern — provisions tool-less author inputs, runs deny probes for forbidden qualification paths, validates create-only sink scoping, and records supervisor access transcripts before Q2 shard dispatch.
- **`@mstar-harness/judgment`**: add seat-scoped annotation pre-dispatch gate (`annotation-seat-gate.ts`, `annotation-sink.ts`, `scripts/annotation-seat-gate.ts`) reusing the author gate Docker probe launcher — provisions tool-less seat inputs (brief + projected shard view), deny-probes forbidden qualification paths (other seat, crosswalk, gold, sources, authoring, protocol artifacts, tuner, model output), validates create-only annotation sink scoping, and records supervisor access transcripts outside seat reach.
- **Judgment runtime:** observing `jev_mode=off` during input collection now aborts active file and stdin reads, prevents further collection, and discards late read results.
- **Judgment**: Reject TypeSafe responses whose reported model does not match the requested native model.
- **Fixed calibration shadow staging** so citation files, inventory identifiers, and confined readonly runtime assets match the supervisor's contracts.
- Made the annotation projection test use a generated local fixture instead of maintainer-specific qualification evidence.
- **Fixed shadow receipt reconciliation** so required receipts are enforced while frozen-inventory omissions remain visible as incomplete work, without rejecting valid cancellation dispositions or treating zero-work runs as incomplete.
- Documented an **optional, finite A05 shadow step** in PR-review synthesis, preserving original vet, deduplication, rejected-candidate record, tally and posting authority when evaluation is off or unavailable.
- Added account-free component exercise guidance and an explicit synthetic-only evidence boundary; component receipts grant no Jev work credit and never count as named-host/W5 verification.
- Fixed strict TypeScript errors in the judgment package and aligned its declaration root with its engine import.
- Repaired the first red runs of the newly registered `test-judgment` / `test-commands` jobs: the shadow-supervisor confinement case probes its declared environment (Linux platform, listable `/proc`, writable `/mnt/output`, which the CI job pre-creates runner-writable) and a capability guard fails the CI run with the named missing capability instead of silently skipping the witness; the study-closure cases now run everywhere through the supervisor's public controlled-provider inputs over the real mailbox protocol (the live-provider witness remains a documented gap), two latent assertion defects they had never exercised were fixed (missing assessor evidence fields and unbalanced receipt accounting), and the synthesis-pack tests assert `validatePack` content equality (`toEqual`) since validation intentionally returns a normalized derived copy, not the same reference. The container/mount isolation semantics the study-closure cases used to exercise are NOT exercised by this rewrite (the test job has no configured container worker image/namespace launcher); what remains verified is the host-side capability probe and loud guard plus the supervisor's mailbox closure over valid requests and the assessor's refusals of failed or run-identity-mismatched study results. The controlled-mailbox integration test widens its worker poll budget (1s→6s), child cap (2s→the pilot's 10s ceiling) and test timeout, which a loaded CI runner outran (observed 1.1s round trip) without changing the lifecycle contract it witnesses.
- **Development calibration** recognizes a genuinely fresh frozen qualification root as a first run and loads prior-run manifests and request hashes from the newest per-run directory, preserving freeze identity checks.
- **Freeze validation** now rejects annotated corpus variants that lack a gold row instead of silently excluding their labels from coverage checks.
- **Security:** Removed worker CLI attestation based on caller-controlled environment values and filesystem shape. The shadow runtime continues to reject unattested evaluator channels before pilot/pack collection; worker-side submission remains unavailable until an authenticated launch adapter exists.
- Added **CI test routes for the `commands` and `judgment` packages**: both package manifests now declare `test: "bun test"`, and CI runs each surface as an independent `test-commands` / `test-judgment` job alongside the existing per-package jobs.
- Corrected package release surfaces, hosted-install dependency specs, CLI option decoding, installed-host MCP doctor paths, request-scoped store selection, child stdin policy, and dashboard lifecycle cleanup; aligned CI consumers with the canonical command definitions.
- Integrated the stdio MCP server into `@mstar-harness/cli` as `mstar mcp`; host configs now launch `npx @mstar-harness/cli mcp`. The standalone MCP package, per-host bundles, and native bridges are removed.
- **MCP health checks host configs, not per-host bundles.** `mstar doctor` MCP inspection now validates each host's real MCP configuration file and its `npx @mstar-harness/cli mcp` launch entry (server entry resolved from `command`/`args` arrays), replacing the retired `build-info.json`/`stdio.js` bundle probes, and refuses runtimes below each packaged target's native floor. `evidence.verify` reports a failed assessment as `ok` data with an `assessmentPassed` flag instead of a `refused` envelope.
- **DSH gains its Cordis MCP client row.** The shipped dsh bundle patch inserts an `mstar-mcp` row (`@deepseek-ai/dsh-mcp-client`, stdio `npx @mstar-harness/cli mcp`, server name `mstar`) next to the plugin row; `mstar-harness doctor --target dsh` parses the profile's Cordis sources structurally (comment-proof) and reports aligned only with the bridge plugin installed. `spawnProcess` normalizes ENOENT to a deterministic `executable not found in $PATH` error, and relative dev-command args resolve against `MSTAR_CLI_PROJECT_ROOT`.
- Documented CLI-based MCP launch paths for the six JSON-backed hosts and OpenCode's plugin-injected config, plus the DSH Cordis YAML follow-up; recorded runtime prerequisites, doctor status meanings, host/session boundaries, and separate installed-host verification.
- Recorded the OpenCode V1 `@opencode-ai/plugin` 1.4.8 pin and removal of the global CLI fallback.
- Added the `consumer-v1` source/package inventory producer (`scripts/execution-consumer-manifest.ts`): per consumer (engine, CLI, DSh, OMP, OpenCode, ZCode) it records the canonical build-input closure, the generated output closure, the entrypoint, the exact runtime target and floor, the declared capability and the copied-instruction trees each package bundles from the repo-root `skills/`, `commands/`, `agents/` and `assets/` corpus — reusing the existing build layouts instead of introducing a second build system. `--write` emits the manifests; `--check` re-verifies every written manifest against the bytes on disk without writing anything.
- The producer also publishes one per-consumer evidence document derived from the aggregate, so the handoff form cannot disagree with the operator-facing artifact.
- Assembled-package Node regression drives the built CLI's coordinator registration, binding, ordinary source/configuration/progress and exact retry; it compares public/store facts, current consumer manifests and committed ZCode hook stdin/exit behavior. It never launches a per-row PM.
- The regression states explicitly what it is not: no native host process, no installed binary and no TypeScript source import. Host entrypoints are covered by generated-manifest parity plus a populated OMP-shaped database fixture executed against the built engine generation.
- A `.gitignore` that already states any harness-root rule (`.mstar` or `.agents`, including a leading slash, a negation or a partial rule) is **author-owned**: scaffold, the install fence and `doctor` make no change at all — no append, reorder, dedupe or normalization, and the file bytes stay exactly as written. Unrelated paths and a lone `.mstarc` entry do not declare, and the custom-layout skip is unchanged.
- Added the exported `hasHarnessRootDeclaration(content)` predicate to the engine path module: a mechanical, read-only line scan that recognizes either layout's root rule, including a leading slash, a negation and a partial declaration, and introduces no glob, escaping or precedence semantics.
- `validateGitignore` now returns `gitignore.author-declared` for a declared file before any missing-entry computation and proposes no rewrite. A missing file stays `gitignore.missing`, and an undeclared file still reports the canonical entries it lacks. The canonical-completeness success branch was retired as unreachable, because canonical content is itself a declaration.
- **Smallest complete implementation:** distilled Ponytail's affected-consumer/data-risk scope, first-working reuse ladder, readable minimal solutions, preserved safeguards, and concise actual-check/unchecked-risk reporting into `mstar-coding-behavior`, with small API/data, house-component, and recovery responsibilities in developer/ops roles; existing presets and `simplify:` conventions remain unchanged.
- **Evidence-led audit and review:** strengthened expected-load and connected-flow reasoning, reachable finding cases, meaningful regression-test gaps, and minimal responsibility-based fixes in `mstar-audit` without changing read-only boundaries, scope budgets, severity, or report schemas. Full-audit prompts hand off canonical load/reportability rules and the finding template; generated PR-seat prompts hand off shared investigation rules and concern lenses. `ATTRIBUTION.md` records the three pinned source skills, target surfaces, and complete upstream MIT notice; no external runtime skill or command family is added.
- **Execution receipt payload slimming**: graph-sized operation receipts (workflow creation, lifecycle transitions, terminal adoption) now persist a slim envelope — `{slim, token, storeId, epoch, operationRecovery?}` — instead of the full root graph, and replay re-serves the live data/token pair for those rows. Per-row size becomes a small constant (pinned by a bounded-size test) instead of scaling with the project graph; plan-verb, bind/recovery and catalog receipts stay byte-faithful for the consumers that parse them.
- **Mixed receipt forms are declared**: `result_json` payloads are write-time versioned — pre-slim rows keep their full form and replay from stored bytes, slim rows carry the envelope — and the `store execution restore-preview` surfaces (engine module header, CLI help, `docs/commands.md`) now say so, so inventory differences from mixed forms are declared, not silent. Versioning is forward-only: an older engine reading a slim row refuses `store.corrupt`; restore the matching build.
- **Execution receipt retention**: terminal close and adoption now prune the closed workflow's `execution_operations` receipts inside the same transaction, and an epoch-bump purge statement pins the invariant that an in-place epoch advance never leaves replay-dead receipt rows behind. RUNNING workflows keep every receipt (replay and recovery evidence stay intact); per-workflow accumulation is documented as the deliberate tradeoff tracked by #466.
- **Restore preview declares pruned receipts**: `store execution restore-preview` help, the engine module contract, and `docs/commands.md` now state that receipt retention is an expected source of backup-only `execution` operation rows (restore preserves prior-epoch receipt rows; replay stays current-epoch scoped), so backup-vs-live differences after pruning are declared, not silent.
- **Notes-ledger expectations documented**: `workflow-note append`/`coverage` help and the engine ledger header now state the append-only growth model and the whole-file read costs (id-dedup scan, whole-file coverage hash) as contract behavior.
- **The release workflows cap the inlined changelog section to the platform body limits.** `scripts/extract-changelog-section.ts` gains `--max-bytes <n>`; `Release prep` passes `60000` (GitHub rejects a PR body over 65536 characters) and `Release` passes `120000` (Release body limit 125000). A 4.0.0-sized release line is ~133 KB, so `gh pr create` was failing with `Body is too long` and the Release publish would have failed the same way.
- Truncation cuts on a line boundary — never mid-line or mid-code-point — and appends `> Truncated at <n> bytes to fit the platform body limit. Full section: \`CHANGELOG.md\`.` Absent `--max-bytes` keeps the previous uncapped output byte-for-byte. An unusable cap is refused with the offending value and the exact recovery instead of silently producing a longer body: a non-integer or non-positive value names the input it got, and a cap too small to carry the truncation notice itself is refused with the smallest usable value — that notice is the operator's pointer to the full section in `CHANGELOG.md`.
- **`release:prepare` now refuses a version the registry already publishes.** The check runs at the version-selection point, before any changelog or manifest is touched: a target version that an already-published release surface carries refuses with the recovery (choose a different version and re-run), and an unreadable registry prints an explicit skip line — the read is bounded, so a hung registry degrades to that statement instead of stalling the release. `release:validate`'s offline tag gate still makes no network call.
- **The `env-injection-seams-removed` fragment declares `packages: engine`** (plus its CN block behind the marker), so an engine change is assembled into `packages/engine/CHANGELOG.md` instead of the root changelogs.
- **`INSTALL.md` gains a 3.x → 4.x upgrade section**: the plan-PM product route removal (one workflow coordinator drives every row through ordinary prepare/progress/issue/complete), the no-argument `/iteration-drive`, and a per-host refresh table — the plugin installers reuse an existing checkout, marketplace or linked tree, so each host's 3.x copy is moved explicitly (Codex needs its checkout pulled, `codex plugin marketplace upgrade` and an agent-file re-copy; omp needs the shared checkout rebuilt before it is re-linked; dsh and Kimi are re-installed through their own plugin managers) — with the release CHANGELOG entry as the complete change list.
- **Release prep and Release typecheck through one self-preparing command.** `bun run typecheck` now builds the workspace declaration dists it resolves (`typecheck:prepare`: engine → judgment → commands) instead of depending on each caller's step order, which had left `Release prep` failing on `Cannot find module '@mstar-harness/commands'` since the CLI command-adapter cutover.
- Removed the duplicated declaration-build steps from `ci.yml`, `release.yml` and `release-prep.yml`; the prerequisite chain now exists in exactly one place.
- **Removed application file/directory mutexes** without a replacement mutex protocol. Native SQLite transactions/CAS, authorization and genuine workflow integration ownership remain; ordinary notes and documents are not authority.
- **Workflow notes are a plain append log**: repeated IDs/submissions append again, one LF-framed `O_APPEND` write preserves peer bytes on failure, tolerant readers continue past partial records, and receipts return the note ID without an accepted-operation replay promise. An admitted append may finish after later session revocation; its record is not current execution authority. Native device/inode observations reject a detected replacement during append; they are not a mutex and do not prevent subsequent external rotation.
- **Production note, catalog-purge and execution-restore operations ignore removed test-control environment values**: a working-directory `.env` cannot execute test scripts, truncate unrelated files, park production work or select recovery fault injection. Failure and interleaving instrumentation lives only in the test suite.
- **Dsh host state uses the existing control-root database** for events, accepted source identities, scan bounds, bindings and newest status emissions, without JSONL tail/index/cursor/cache authority or file compaction. Dispatch, settle and workflow-verdict evidence follows the selected logical workflow ID, never a destination directory basename. Native session logging continues before ACTIVE authority; unavailable persistence reports supported init/upgrade recovery. Engine-status reads preserve native refusal causes and distinguish a true addressed no-row answer from absent, staged, corrupt and schema-refused authority. Legacy binding imports reject a session already bound at another cwd while preserving same-pair replay and the existing explicit skip recovery.
- **Legacy Dsh import preserves tail-only replay identities** and reads source leaves through no-follow file descriptors; identical native replay preserves the original event, conflicting identity bytes refuse, and a replaced symlink leaf is not followed.
- **Legacy execution recovery imports directly** through `store upgrade`, retaining original v1/v2 source bytes; standalone `mstar migrate` staging and internal status/snapshot writers are retired, and engine `ArtifactKind` is `review | json` only. Active standalone v1 lifts require one addressed `--delivery` JSON object per original workflow ID, supporting different delivery intents in one same-source retry before execution registration; kind is never inferred, and inapplicable declarations refuse. Store initialization may already have committed when declarations refuse. Existing Dsh skip acknowledgements recover an unregistered symlinked Dsh source, including the whole `workflows/` root with `--ack-skip-dsh dsh-workflows`, without following it or changing link/target bytes; registered execution sources retain containment/no-follow checks and cannot be discarded by a Dsh acknowledgement. Database backup captures a consistent native image; restore replaces all authority domains transactionally on the same live database with a new epoch, without freezing or rolling back ordinary files. A committed restore remains successful if its optional filesystem receipt copy fails, returning `recoveryReceiptPath: null`; pre-commit cleanup reclaims only the attempt's own safety image when the native store generation proves it did not commit, and preserves images on changed or unreadable authority. Fresh-store failures distinguish unpublished filesystem failure from an already-published store whose handle could not open, with phase-specific public recovery.
- **Unsafe registered sources and native-ID collisions have explicit import recovery**: optional `--ack-skip-workflow <id...>` skips only named refused execution imports, independently of Dsh disposal, while preserving source/link/target bytes and existing native rows. Unknown/noncolliding acknowledgements report a usage error before registered unsafe-source refusals. Receipts disclose lost imports; default no-follow and ordinary physical containment remain, with no fabricated resumption.
- **Nested execution-source refusals use the same workflow acknowledgement**, including symlink/non-regular snapshots. Legacy status, snapshots and session bytes use no-follow, identity-checked descriptors; session validation consumes those bytes without reopening the path. The checkpointed-authority regression no longer waits for garbage collection or asserts SQLite cleanup timing.
- **Legacy source leaves are opened non-blocking**, so a FIFO or other special file at a registered leaf refuses by type and names its recovery instead of hanging the command; a decidable sibling source in the same run still imports. The same bounded, type-checked, no-follow read covers the v1 `iterations/<id>/delivery-compass.md` leaf, which a special file at that path would otherwise have blocked.
- **The v1 conversion consumes the already-verified register bytes** rather than re-acquiring `status.json` by path, so classification and the converted rows come from one descriptor-verified read on the supported v1 route.
- **A store-upgrade receipt is bound to the imported source**: the source digest participates in the request identity, so reusing one `operationId` over changed legacy bytes conflicts instead of answering with a receipt that describes bytes the run never imported. Unchanged input still replays its retained receipt.
- **The upgrade retry survives a publication race**: an upgrade that loses `initializeStore`'s create-only publication race is pointed back at `store upgrade` (its legacy import may be unfinished) instead of at the "do not initialize or migrate an existing store" instruction meant for `store init`.
- **A history chunk that vanishes after enumeration refuses**: the DSH import no longer reads that `ENOENT` as "this workflow kept no retained history", so the identities in a vanished chunk cannot be skipped silently; a genuinely missing history directory keeps its previous treatment.
- **A v1 compass that changes under the probe is refused**: once the type probe has observed a compass, a leaf that vanishes or becomes a link before its read refuses by name instead of being treated as absent (which would silently regroup that iteration's plans); the non-regular-compass refusal names both supported repairs — replace it with a regular file, or remove it to convert those plans as standalone rows.
- **A malformed v1 plan row is skippable**: a converted v1 lifecycle whose rows cannot be imported refuses as that lifecycle's own source and is addressable by `--ack-skip-workflow <original id>`, exactly like a malformed v2 snapshot, so one agent-authored row no longer blocks every valid workflow.
- **Root `status.json` `residual_findings` are reported rather than dropped**: the v1 conversion states the exact count and the supported route (a project register document at `projects/<id>/residuals.json`, or the issue verbs), leaving the legacy field untouched.
- **The upgrade recovery and help name the complete skip vocabulary**: the machine-facing DSH recovery also names `--ack-skip-workflow` for ids this run already committed, and the command description lists every source class the acknowledgement accepts.
- **A refused legacy source is always skippable by its id**: a registered snapshot whose plan rows are missing, duplicated or unconvertible now refuses as that workflow's own source (the default refusal names `--ack-skip-workflow`), so one malformed row no longer aborts the upgrade or blocks every healthy sibling import.
- **The acknowledged-skip disposition names the refused source, not a presumed cause**: a nested-source skip no longer asserts that its (real, in-root) containing directory is unsafe; the per-item reason carries the exact cause.
- **Both source digests are ordered by code unit, never by the process locale**: the same legacy bytes keep one identity across machines, locales and ICU versions, so a same-input retry is never falsely refused as `execution.operation-conflict`.
- **The v1 compass refusal names three supported exits**, and a link raced into the open window refuses exactly like a static one: replace the compass with a regular file (keeping the iteration grouping), remove it (converting those plans as standalone rows), or explicitly start without importing any legacy source (`store init --harness <new-empty-control-root>`, existing data untouched). The descriptor is also identity-checked against the probe, so a swapped-in regular file cannot contribute its bytes.
- **A `workflows/` entry that sources nothing is treated as absent**, not as a conflict: a regular file (or other non-directory) with no registration under it no longer aborts the upgrade, while a registration under it keeps the existing per-source refusal.
- **The upgrade receipt binds the bytes it consumed**: each source hash is taken from the single descriptor read that produced the rows (and the v1 compass reads record theirs), so the digest no longer re-acquires the same paths; a DSH refusal that follows a committed execution import names both acknowledgements its advertised retry needs.
- **Catalog purge-registration settles the native execution journal only**, without reading, hashing or rewriting the recorded snapshot: the failed producer's source bytes are retained exactly, and an edited document no longer blocks journal cleanup. The recorded digest remains historical failure evidence on the receipt, never a re-certification of the live file; identity, generation, catalog-revision, ACTIVE and recorded-receipt replay guards remain.
- **New store publication synchronizes its parent directory** before removing the fallback image. A failed barrier reports the published partial outcome, retains readable data and the fallback, and supports recovery through the same public upgrade entry.
- Retired `mstar migrate` now recognizes its former delivery and branch flags before returning the explicit no-writer refusal. Legacy-status and Dsh workflow-selection diagnostics direct operators to `mstar store upgrade --operator <name> --harness <control-root>`.
- **Milestone mechanism** in the project store: `mstar milestone add|update|assign` write milestone metadata and the sole issue association under store-revision CAS; read-only `list`/`status` expose open/resolved/other-retired rollups. Delivery is an explicit status change that requires at least one linked issue and zero open ones.
- **Composed roadmap surfaces**: `mstar roadmap export` (JSON v2 / grouped Markdown) and the roadmap dashboard render milestones — target, status, linked issues and counts — alongside the retained Direction; they work without Markdown content and never modify milestone records.
- **Governance wording** now references milestones: the Durable Roadmap Gate accepts a milestone ID plus linked-issue acceptance/owner/dependency/trigger evidence, and retired `roadmap.md` stubs remain history/import transport only.
- **Project roadmap authority** now lives in the project store record, not a live `roadmap.md`: CLI, dashboard and dsh read the same content; a known project with no roadmap is reported explicitly.
- **Roadmap authoring** uses read-only import preview and reviewed apply, revision-guarded replacement, and Markdown/JSON transport export. Harness scaffold registers `_default` without writing roadmap Markdown; legacy files remain import candidates or history.
- **Iteration close** reads the stored roadmap, exports an independent candidate and replaces it against observed revisions instead of editing a live project roadmap file. Runtime guidance now points to one governance rule home.
- Fixed roadmap CLI discovery, import-preview round-tripping, dashboard absence handling, and legacy roadmap migration disclosure without creating a second authority.
- Refused worktree cleanup when ignored files would be lost; refreshed the committed hook bundle and migration/scaffold expectations.
- Corrected roadmap dashboard and project-rollup absence messages, and updated migration-6 test expectations.
- Read dsh project roadmap milestones from the store authority and disclose absent, partial, and unavailable roadmap coverage in the panel.
- Restored catalog facts in roadmap views, clarified the empty project rollup message, and retained migration steps in successful JSON output.
- Added the read-only local dashboard: `mstar dashboard` serves the issue list/detail with recorded history, the workflow / iteration / roadmap views and one cumulative captured-vs-retired issue-flow chart on `127.0.0.1` (loopback only, no bind option), from the issue store and the lazy execution/roadmap projections. The dashboard never mutates; unknown historical dates are disclosed and counted separately, pre-store buckets are labelled register history, and the issue-flow chart is paired with an accessible data table.
- **Dashboard roadmap is now a milestone board**: the roadmap page lays each project's milestones out as columns (one column per milestone, in store ordinal order) with that milestone's assigned issues as the items inside it — mono id, disposition badge and stored title — instead of the previous vertical card list. The project's unassigned issues appear as an explicit, named trailing column; the count is named on the no-milestones branch too, so it is never silently dropped.
- **Direction demoted below the board**: the content authority's Direction and the stored historical document now render as collapsed sections under the board, each keeping its own heading and its existing "content authority ≠ milestone data" wording. Catalog facts and the store/projection freshness block are unchanged, and a refused roadmap read still renders its notice — never an empty board, never the empty-milestones state.
- **Dashboard roadmap entry is projects-first**: opening `#roadmap` without a `?project=` now lists every catalog project (title, id, lifecycle, open-issue count) and each entry links into that project's read-only roadmap, replacing the "add the project to the URL" dead end.
- **New `projects` dashboard read view** end to end: engine `DashboardView` + `ProjectListDTO`/`ProjectListItem` (complete, deliberately unpaged read over the catalog table with an open-issue count), the param-free `/api/projects` transport route, and the regenerated offline dashboard bundle.
- **Gate path resolution is single-sourced in the engine**: `@mstar-harness/engine` now owns the landing-path resolver (`landedPathOf`, the chained form) and the case-folded authority naming/classification, and the OpenCode v1, OpenCode v2, omp, dsh and ZCode write gates import it instead of keeping hand copies. The copies had drifted — four of them followed a single symlink hop while v2 followed the chain — so a two-link alias chain to a harness authority file (`store.db` / `-wal` / `-shm`) bypassed the gate. Every gate now resolves the chain (8-hop bound, cycle/overflow refuses fail-closed with `write.symlink-resolution-refused`) and classifies case-variant authority names identically; each host keeps its own refusal envelope (#442).
- Historical R3 (3 calls, pass) and intermediate R4 (initialize infrastructure error, 0 calls) evidence remain archived in their respective run directories; R4 predates the initialize-response fix.
- Refreshed current acceptance evidence in `eval/r5-guess-path/` on full SHA `3c0f0eea8c9f6298d701e472da81f2a8ffd8de73`: the local-built-CLI stdio MCP guess path recorded 3 calls (failed near-miss, catalog recovery, corrected call), graded pass, with run/report exit 0.
- Made the evaluator driver clone-portable: it derives repository root from `import.meta.url`, accepts `MSTAR_SKILL_EVAL_REPO_ROOT` and `MSTAR_SKILL_EVAL_DURABLE_DIR`, and records the current full SHA and built CLI identity/help hash. From a clone, run `bun run --cwd packages/cli build && bun scripts/skill-eval/run-bounded-resolution-real.ts`.
- **model compliance stays unverified (scripted client, no LLM)**.
- Re-freeze the skill-eval closure inventory onto reachable `origin/main` (`c42c16b4`): the prior BASE revision was unreachable after a history rewrite. The BASE-tree owner hashes now match that reachable revision, while current-byte hashes remain pinned. For anchors already absent from this BASE, the check guards against reintroduction rather than proving their historical removal. The current file contains 35 tests; the historical 37-test count is not a requirement for the repaired gate. This closure check is manual-run only because CI does not execute `scripts/skill-eval`; drift or reintroduction is surfaced only by a local run (#357).
- Added the **fault tolerance and discoverability first** working rule to `AGENTS.md`: agent-authored mutations must stay revisable through ordinary public operations, every parameter is optional except a minimal required set with safe defaults, and capabilities must be discoverable from `--help` and refusal text. Principle anchor: #365.
- Add a maintenance policy rule requiring every user-facing refusal to name the actual cause and an exact recovery reachable through a supported, documented interface. A gate with no paired recovery, a refusal that leaves the operator with nothing to do, and a generic blocked message that masks an identifiable cause are all defects; a new hard limit must ship with its recovery and a test.
- Added **architect design minimality through ablation**: remove proposed components unless their removal breaks a named, confirmed requirement (including the approved long-term target state or recorded non-functional constraints); record one evidence line for each non-obvious retained component. Keep the smallest design aligned with the long-term target state, not a temporary hack.
- Authorized **architecture template pruning**: mark sections inapplicable at the task's scale as `N/A — <one-line reason>` in both Prepare & Plan and Architecture Spec outputs instead of inventing filler; reference `mstar-coding-behavior` § Decision Rules for the implementation-level playbook.
- **Standalone coding behavior:** compact `mstar-coding-behavior` around original user outcomes, first principles, Occam/YAGNI, surgical diagnosis, and scoped evidence. Remove mandatory harness loading, repeated templates, and engine preflights; retain concise dependency justification, bounded-shortcut markers, and conditional workflow authority.
- **Agent-facing design:** prioritize discoverable commands and recovery, minimal required input with safe defaults, revisable public mutations, and faithful errors and partial outcomes; reject speculative features and gates without weakening required safeguards.
- **Narrow load contract:** exempt only exact `mstar-coding-behavior` from mandatory Load Order/core-first validation. Preserve other topic and roles-hub checks, align the existing loading prose with exact-identity exemptions, add behavior regressions, and align the Cursor PM routing scenario.
- **Behavior-focused drift checks:** remove repository-wide document-count and closure-prose pins that rejected valid skill compression. Keep malformed-command regressions, real load-order behavior checks and executable corpus validation; do not repin incidental totals or wording.
- Plan templates use three direct coordinator completion routes: iteration proves its actual serial integration; standalone development proves registered source and keeps its delivery tail; standalone report-only records matching policy fulfilment before Done without invented Git/PR.
- Updated `mstar-artifacts/templates/plan.main.md` (Engine lifecycle block) and `mstar-artifacts/references/plan-quality-bar.md` (item 8, Engine lifecycle ownership) to match the authority.
- Sparse intended actions derive the acquired coordinator's own context where unambiguous. Explicit scope/token/operation constraints still validate; missing source facts use revisable prepare, not per-row bind/claim or universal repair.
- Replaced the `mstar-use-cli` decision rule that refusals are mutation-free with action-local refusal semantics: a refusal's commit state is read from its receipt — the engine's coordinated plan-route refusals are transactional (no row, receipt or counter change), action-local partial receipts preserve already-committed components, and only the documented remaining action is replayed; a stale explicit token recovers by re-reading and retrying fresh.
- Removed the stale decision rule that the argument parser can exit 1 for a missing required argument: a probe of the current built CLI answers a missing positional argument with the usage envelope (`command.invalid-input`, exit 2).
- Aligned `mstar-use-cli/references/preconditions.md`'s active-route identity and token guidance with the verified transport: the CLI/MCP transports carry no ambient identity, so the independently acquired caller identity is supplied per call as the verbs' own `--session-id`/`sessionId` (never read from a session file, never carried by or derived from the session reference); plan mutations keep the execution token only as an explicit constraint — omitted, the engine derives the current token from the plan's own read — while a fresh active bind and the workflow-level active writes (registration, evidence) state the full execution token themselves: the fresh bind together with the independently acquired session identity, the workflow and the caller-owned operation id, registration and evidence with the explicit expectation, the operation and the main session identity (evidence additionally its session reference).
- Aligned `mstar-use-cli/references/plan-and-workflow.md` with the same transport: plan mutations keep the execution token only as an explicit constraint (omitted, the engine derives it) while workflow-level writes and the fresh active bind state the full execution token as `--expect` (the pre-activation bind stays token-free); every active call supplies the independently acquired `--session-id`/`sessionId`, so an omitted `--expect` on plan mutations and an active `--session-id` are no longer usage errors, and the "refusals are mutation-free" blanket became action-local commit-state semantics.
- Reconciled the remaining `mstar-use-cli` references with the probed behavior: `checks-and-lints.md` drops the parser exit-1 caveat — as probed on the current built CLI, a missing required argument answers `command.invalid-input`, exit 2 — and `status-and-registers.md`'s plan-scoped capture entry states the same explicit-constraint token rule.
- Aligned the **harness skill corpus and iteration commands** with the ACTIVE `store.db` execution authority: workflow/plan rows, root register, leases, sessions and branch anchors are store-backed, and root `status.json` / workflow `snapshot.json` / `sessions/*.json` instructions remain only as explicit pre-activation or engine-absent fallbacks.
- Replaced retired residual-register and README index duties with **store issues and catalog operations** (`mstar plan issue-add`, `mstar issue add`, `mstar catalog discover/import/link`), preserved append-only workflow notes and authored plan/assignment surfaces, and removed duplicated lease-protocol prose from `mstar-iteration`.
- Clarified store `init`/`upgrade`/`activate` versus the pre-activation bootstrap template in `mstar-conventions` / `mstar-artifacts`, completed the `mstar-use-cli` command-family and execution-refusal indexes, and centralized findings-cleanup semantics at the artifacts authority.
- Aligned `.cursor/skills/mstar-routing-eval/` gate fixtures with the same split: ACTIVE store-transaction/execution-lease arbitration wording, file-flock cases labeled pre-activation (case IDs and expected routes unchanged).
- Made `mstar-compound` the single owner of compound **steps** — and nothing else. A one-line interface boundary in `mstar-compound/references/compound-workflow.md` states that trigger timing, cwd, write surface and record surface belong to the **calling** flow, which declares them itself and cites the step file. The compound side no longer restates caller context (integration worktree, compass summary, workflow delivery record, PR-head timing), removing a reverse dependency and its second maintenance surface.
- `mstar-iteration` Phase 3 §3.2 now cites the step SSOT and keeps the iteration call surface as its own declaration; the standalone delivery tail cites the same step file from `mstar-roles/references/project-manager/plan-management.md`, with pointers added in `mstar-harness-core` and `mstar-conventions`.
- Removed the compound side's remaining caller registry: the interface-boundary line, the lifecycle-integration paragraph, the `description`, and the package-promotion preface no longer name the calling flows' files or their gate labels. The dependency stays one-way — callers cite the step file; the compound skill owns the steps and nothing about who calls it.
- **L1 worktree ownership:** ignore a row claiming the recorded main-worktree branch when checking residency and identify the owning workflow and plan for real ownership conflicts.
- **Plan preparation:** refuse to use the control checkout's current branch for any plan row, including report-only workflows, and fail closed when that branch cannot be resolved.
- **L1 worktree checks** now derive workflow, plan, lease, and lifecycle-branch inputs from the ACTIVE execution authority graph instead of retired snapshots and sibling scans.
- **Sibling worktree root**: moved the default for feature/L2 worktrees and `pr-review worktree-setup` to `<parent>/<repo>.worktrees/`, outside the checkout. The repository root is the realpath of the Git top-level; in-repo `.worktrees/` remains a legal manual/override location. Removed the default setup's `.git/info/exclude` append, which is obsolete outside the repository.
- **Convention alignment**: updated the skills and `AGENTS.md` to teach the sibling-root convention, keeping linked checkouts out of the repository scan/edit surface and permission guidance independent of cwd or unverified glob semantics.
- Added an **executor-side worktree checkout gate**: when an Assignment carries `Worktree path`, leaf roles must `cd` there and verify the checkout root with `git rev-parse --show-toplevel` before the first repo write or commit, and disclose `Worktree path used` (absolute) in the Completion Report — closing the gap where subagents inherited the primary checkout and wrote product files into it.
- Updated `mstar-branch-worktree` (可写角色执行规则 + 回报要求), the shared `mstar-roles/references/_shared/leaf-executor-core.md` Git NEVER block, and the `frontend-dev` / `ops-engineer` role files to match the existing `fullstack-dev-shared.md` instruction.
- Fixed worktree cleanup attribution after stopped and failed (cancelled-terminal) registrations are superseded: the terminal owner no longer makes a shared worktree/branch appear foreign. The real-store dry-run now plans the merged worktree for removal; branch deletion remains deferred until the worktree is removed and cleanup is replanned.
- **Safer worktree cleanup ownership:** Completion retains the plan's exact branch and worktree path after lease release. Cleanup can also recover a claim from a valid completed Done-row handoff; degraded parseable snapshots preserve handoff resources as protective, nonterminal metadata but never authorize removal. Unreadable snapshots withhold removals unless explicitly ignored. Applying cleanup re-plans after deferred integration worktrees are removed before deleting newly-unchecked-out branches. Ambiguous ownership still refuses removal.
- **Ignored-content cleanup:** Ignored-only files no longer make a worktree dirty for cleanup. Applying an eligible removal deletes those ignored files without a Git recovery backstop; tracked changes and non-ignored untracked files still block removal, and cleanup never forces it.

### Added

- Added **`@mstar-harness/opencode-v2`** — the OpenCode **2.x** native plugin package, authored on the pinned `@opencode/plugin` **2.0.26** SDK. It registers the same bundled `mstar-*` skills, role agents, and iteration commands through the V2 native editor surface, and its `write`/`edit`/`subagent` gates **refuse for real** through the typed `Tool.Error` channel (the V1 package's warn-only no-refusal-channel limitation does not apply here). `patch`, `shell`, and Code Mode stay explicit non-claims; installed-host behavior is unverified.
- Made `mstar init --target opencode` / `doctor --target opencode` **generation-aware**: `--opencode-generation <v1|v2>` always wins; a real install otherwise probes `opencode --version` (major ≥ 2 → `@mstar-harness/opencode-v2`, 1.x → `@mstar-harness/opencode`); probe failure refuses with the flag recovery — no silent v1 fallback — and `--dry-run` previews with probes skipped (an unresolved generation is annotated, never guessed). Config markers are a consistency guard only.
- The V2 config write set keeps the V1 key untouched and preserves user values: plural `plugins` with owned-slot dedupe, `agents.<role>.model` only when supplied, a non-destructive `mcp.servers["morning-star"]` merge, and `$schema` preserved — never invented.
- Docs: new `packages/opencode-v2/README.md` + `INSTALL.md`, dual-generation pointers in the OpenCode (V1) package docs, the V2 section in the `mstar-host` OpenCode reference, and the root README install row.

### Breaking

- **BREAKING — remove the entire plan-PM product route.** One workflow primary coordinator now drives every row through ordinary `prepare`, `progress`, `issue-add`, `issue-close` and direct `complete`. Per-plan sessions/roles/claims/binding, sealed Assignment admission and handoff/accept/return/integration-start/integration-accept/reconcile/repair/release protocols are removed, without aliases or a relocated transfer sequence. Coordinator bootstrap/resume and explicit stopped workflow-coordinator recovery remain.
- **No-argument iteration drive only.** `/iteration-drive` rejects all nonempty input before boot; old scoped flags never silently become whole-iteration authorization. OMP removes extra-primary preferences, capacity/terminal transports and launch journals; native leaf dispatch and the bounded bind/checkpoint/read-only-history scheduling observer remain. Model-handoff behavior is unchanged.
- **Ordinary revisable configuration.** Source branch/worktree metadata and QA/cleanup are configured through prepare, including while active. Defaults are mandatory QA and allow-residual cleanup. Valid metadata/defaults require no ceremonial prepare record or immutable plan/Assignment bytes. Transactions, CAS, exact-request receipts, explicit authorization, L1/L2 checkout isolation, SDD, QC tri and QA remain.
- **Three distinct completion obligations remain.** Iteration completion verifies the actual already-performed serial two-parent merge in the clean recorded integration checkout and leaves parent compound/PR/verified-merge/close intact, with no child PR. Standalone development verifies its registered source without iteration integration and retains its own delivery tail. Standalone report-only consumes explicit matching policy fulfilment recorded before Done and retains evidence-backed close, without fabricated Git/integration/compound-before-PR/PR. Complete releases only applicable integration exclusion, retains ownership and preserves timestamps on exact replay; it never performs or repeats Git merge.
- **Explicit authority and historical cutover.** An already-selected store root is never rediscovered: missing or empty `--harness` targets refuse without opening another ACTIVE store and remain recoverable through public store upgrade. Schema-8 retirement requires full operator-stop attestation and preserves business provenance; imported completed ownership uses current metadata/completion, never a retained plan-PM handoff reader.
- **Authority, phase and retained-track corrections.** ACTIVE authority veto precedes malformed plan-read payload validation; recorded numeric progress contributes to iteration phase derivation. FILE worktree checks retain the selected row's track ownership and expose ordinary observed-revision progress recovery with the explicit control root, without clearing live tracks or weakening checkout/identity guards.
- **Policy/host parity.** Canonical skills, command text, templates, routing pressure data, bounded-resolution dispositions and README pairs use the same direct route across hosts. DSh keeps real writable scope checks against row metadata and their existing public refusal codes, not a per-row holder. Superseded unreleased seal/admission/stopped-plan-owner fragments are retired, while unrelated issue/transport/model-handoff behavior is preserved.
- **Reviewer least privilege.** Remove the deleted plan-lease verifier's exact/wildcard Bash permissions from QC tri and code-reviewer thin shells. Do not replace them with integration/business mutation or build/test grants; role prompts remain thin and existing review boundaries remain unchanged.
- **Report-only policy-evidence idempotency.** The recorded fulfilment remains the basis that authorized `Done` on both transports: re-pointing its evidence reference after completion refuses with the same stable code, while identical re-recording is an idempotent no-op. The development tail remains write-time-only.
- **Completed-row coherence stays positive under direct completion.** A `Done` standalone row must satisfy its declared completion kind and applicable integration/no-lease constraints, not bypass them through another state label. The former `validateStandaloneCompletedCoherence` handoff-state bug let a one-word rewrite bypass integration contamination, `integration_worktree_path` / `branch.integration` and no-lease checks, allowing close to stamp `completed`/`ended_at`, unregister the root and pass phase 6 while a handoff was still `accepted`; the direct route retains completion coherence without reinstating that retired handoff reader.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/opencode-v2`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 4.0.0**.

## [3.11.2] - 2026-09-19

### Harness

- Moved the **coordinator model-handoff arm to the direction lock**: a new iteration now arms `@slow` once the direction is locked and **before** the Phase 1 draft is written, instead of after workflow registration — so the arm always takes the unregistered reservation path, which is the expected state for a new iteration (no register row, no snapshot, no compass) and never a reason to defer the call. No arm/fire logic, refusal code, authority derivation or tool schema changed.
- Renamed the shared new-iteration anchor `iteration-entry` → **`direction-lock`** and moved its carrier to the §1.2 tail: the anchor now fires once the direction is locked and before the compass/plans draft is written, and the three Phase 1 entry routes bind it at that boundary — the interactive route in its own step between the lock and the draft, the autonomous and host-Plan routes through their pre-commit checklists.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.11.2**.

## [3.11.1] - 2026-09-18

### Harness

- **Host session identity now reaches the engine on OMP**: the `@mstar-harness/omp` model-handoff extension revises every `bash` tool call of its session to carry the host session id in `MSTAR_HOST_SESSION_ID` — overwriting any caller-supplied value under that name, `bash` only, nothing injected for a host session with no id, and no engine or harness write, notice or state — and a fresh `mstar plan bind` resolves its identity **`--session-id` → `MSTAR_HOST_SESSION_ID` → the engine-generated id** — the injected variable is the fallback (trimmed; empty or whitespace-only counts as absent) — so the engine session id and the host session id are one identifier for the readiness and start-authority comparisons. The generated default and every comparison are unchanged: an absent or foreign association still refuses (the readiness `binding-invalid` code, the existing start-authority codes), and `--resume` never re-identifies — it refuses `--session-id` as a usage error.
- **`bindPlanSession` adopts a caller-supplied `sessionId`** on both fresh-bind variants (coordinator and plan scope), keeping `randomUUID()` when none is supplied. The id names the session envelope's file, role-scoped at `{WORKFLOW_DIR}/<workflow-id>/sessions/<role>-<session-id>.json` (`<role>` ∈ `coordinator` / `plan-pm`) — so one host session may hold the coordinator envelope and a plan-pm envelope of one workflow under the same shared id — and is therefore validated as a single safe path component (non-empty, no separator, not `.`/`..`, at most 128 characters) and refused with the new, additive `coordination.invalid-session-id` before any write; a re-used id is still refused by the exclusive envelope creation with the existing `coordination.session-mismatch`.
- Updated `skills/mstar-host/references/omp.md` with the anchor-side session-identity association contract.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.11.1**.

## [3.11.0] - 2026-09-18

### Harness

- Full codebase audit reports now close with a Coverage table: one row per material review question (surface × boundary/invariant × subsystem × category), with exactly five final statuses — `covered` requires a reviewed `file:line` plus the invariant checked and the observed result; every non-covered row requires a concrete reason, and blocked-before-read or prior-evidence-only rows are represented honestly instead of forced into false evidence. Statuses are `covered` (examined, not clean), `blocked`, `deferred`, `out_of_scope`, and `not_applicable`; the closing summary names gaps already in the table with no numeric tallies or aggregate path ledgers. Coverage is reviewer-checked markdown: the `mstar audit scaffold` command rebuilds the index without preserving or validating it, so prior coverage must be read and re-reconciled after each scaffold, and no engine shape validation is claimed.
- Audit scaffold findings files now preserve what the auditor supplied: the CLI parser maps `description` → `impact`, keeps explicit `confidence` and `evidence` (previously discarded), and accepts optional `fingerprint`, `trace`, and `severity` metadata plus structured `{file, line?, description}` evidence locations, with documented absent-field defaults (`MED` confidence, `[]` evidence). A new deterministic engine gate `validateAuditFindingGates` (fingerprint grammar/uniqueness/ordering, `severity.overall ≤ severity.impact`, trace topology, safe typed paths, visible-text predicates, credential rejection on opaque fields) runs inside `scaffoldAuditPlan` before any file is written; invalid findings exit 2 with field-path diagnostics and no partial output. Legacy string-evidence input remains supported. The durable field contract is published in `skills/mstar-audit/references/finding-format.md` (§ Machine-readable findings file), the scaffold engine-check callout in `references/codebase-audit.md` was updated for the real gates and their limits, and the five-state attack wording in `mstar-audit` SKILL.md was tightened to its four actual dispositions.
- Contracted the **Phase 1 PM draft** (`mstar-iteration` §1.3): it is the context carrier a dispatched role reads from disk, never from the PM's conversation, so it must now carry the locked direction, the settled decisions, the open questions with their owners, the non-goal rationale, the constraint sources, the acceptance seed and the branch policy — while option analysis, module/interface detail, per-task decomposition and plan-level technical design may legitimately stay coarse.
- Sanctioned exactly **one** unfinished form during Prepare: the owned `TODO(owner: <role-id>)` marker, defined once in §1.3 with its owner vocabulary limited to the Phase 1 chain — `product-manager` / `architect` / `writing-specialist` / `PM`. Only a marker pointing at an owner may stand in for unfinished detail, and it must be cleared — or explicitly re-owned to `PM` and raised to the user — before the compass reaches `status: locked`. An unowned `TBD` / `...` / `etc.` remains forbidden at every stage.
- Added two required compass sections, `## Decisions` (decision + rationale + source) and `## Open Questions` (each item with an owner and a blocking flag; `None` when empty), immediately after `## Scope` in both the template and the §1.3 inline scaffold, with their `## Fields guide` rows.
- Gave every Phase 1 editing role a **marker-clearing duty** (§1.6 and the artifact-boundaries table): a role discharges the markers naming it in its own edit pass, re-owns to `PM` whatever it cannot close, and reports the cleared/re-owned counts; `writing-specialist` additionally runs the closing no-marker check that precedes the compass lock.
- Stated the **Prepare-writing bar** in `mstar-artifacts/references/plan-quality-bar.md` as the mirror image of "write for a zero-context executor" — the draft and the compass are the context carrier, and no role-owned marker survives the compass lock. `mstar-phase-gates` now names the gate timing: the no-placeholder judgment runs at `plan(locked)`, while the marker clearing deadline is the compass `status: locked`; the ban itself is unchanged.
- Required a Phase 1 review-and-edit Assignment's **`Inputs`** to carry the draft path, the direction decisions (or a pointer to compass `## Decisions`), the open questions with their owners, the non-goal rationale, and the list of markers the role owns — and added "dispatch an editing role without decisions / open questions" to the anti-pattern list, since such a role can only re-derive context it cannot see.
- Removed the Assignment **`Model tier`** field. It was unenforceable — a skill document cannot observe which model a host actually runs — and nothing machine-checked it: neither the engine nor the CLI required it, so removing it needed no runtime change.
- Deleted the field's two host-mapping tables and every producer/consumer reference with them: the `mstar-sdd` tier section (including its "always name model on dispatch" rule), the `Model:` lines in the three SDD dispatch-prompt templates and the sticky-session header line, the `file-handoffs` required-field bullet, the Phase 2 per-task dispatch step and the Assignment-field clause that forbade omitting it, the Assignment template field and its SDD NEVER mention, the routing-eval expectation string, and the tier section in `mstar-host/references/cursor.md`. The never-omit clauses that named the field now cover only `Execution mode` / `SDD dir`.
- Host-native model selection is left to the host and the session, where it already lived: Cursor's Task `model` argument is documented as an optional host slug for the session's own model policy that prescribes no mstar tier, and the dsh `agent()` and omp model-handoff capabilities keep their existing descriptions.
- The security-review deep-dive (`skills/mstar-audit/references/security-review.md`) expands its coverage and false-positive discipline: §2 gains explicit severity anchors (informational → critical) plus anti-strengthening rules; §8 hunting angles gain concrete `Signal:` clauses; the §9a–§9h category folds gain item-level exclusions and new checks (OAuth/SAML binding, WebAuthn, supply-chain/CI trust, infra/IAM, data isolation, AI/LLM trust); three new folds — §9i desktop/mobile/local IPC, §9j memory safety & binary (source review only), §9k availability & resource exhaustion; new §12 "Static evidence required" rule; new §13 "Per-class exclusion rules" (self-injection, existing-permission-check, crypto-error/write-only-validation) with a pointer line routing every other false-positive signal class to its owning section; and new §14 protocol/RPC/messaging invariants.

### Changed

- Documented the producer of the prepared Assignment in the OMP host reference: the `reserve-launch` admission clause and the optional transport section now name **`mstar plan prepare`** as the coordinator step that writes `coordination.prepared` and its pinned `coordination.prepared.assignment_path`, define the transport placeholder as that absolute path, add an ordered summary of the extra-primary route (registered `Todo` row → existing feature worktree → coordinator bound → prepare → `reserve-launch` → the journaled record-before-side-effect transitions and pane/start/submission sequence), and state the admission windows — row admission closes with Phase 1 (earlier once any row starts preparation or execution), while an already-registered eligible row may still be prepared during Phase 2.
- Added the host-agnostic precondition to the scoped-plan PM transport note: a conditional extra-primary launch is available only for a plan row the coordinator has already registered and prepared, and whose feature worktree exists — a row that does not yet exist cannot be launched, because row admission closes with Phase 1.
- Added the **six-item scoped-route dispatch checklist** to the OMP host reference's optional transport section: a fresh target session, a prepared (not merely registered) row, handover content frozen before preparation with only the Assignment hash re-checked at bind (`coordination.assignment-stale`), a single initial submission, readback-confirmed execution with single-key recovery only, and post-bind steering — bounding *exactly once* to the initial command. The trailing-Enter behavior stays a field observation of a transport CLI this repository does not own.
- Named the **supported cross-session dispatch path** in the shared dispatch gates: concurrency across separate primary sessions or terminals has exactly one supported form — the scoped route with a prepared Assignment as a fresh session's first instruction; a coordinator-authored leaf Assignment sent through a terminal prompt is unsupported because it bypasses scoped boot, lease ownership and handoff.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.11.0**.

## [3.10.3] - 2026-09-17

### Harness

- Added the **`mstar-use-cli`** skill as the agent-facing CLI SSOT: a task→command-family index, the precondition ladder (harness-root resolution, control root vs feature worktree, neutral cwd, session envelope, revision and byte tokens), the two canonical sequences (versioned read-modify-write, plan completion), and how to read exit `0` / `1` / `2` — including the argument parser's exit `1` for a missing required argument. Flags are never restated: each command's own `--help` owns them.
- Retired **`docs/cli.md`** by splitting it by audience instead of redirecting: its two install-only sections (Codex agent files, install path layout) moved into `INSTALL.md`, where its own install cross-references plus `packages/cli/AGENTS.md` and `.cursor/LOCAL-VALIDATION.md` now resolve to in-file anchors. The CLI-contract pointers — `README` / `README_CN`, `docs/commands.md`, and the runtime skill references — now point at the **`mstar-use-cli`** skill. The old file is deleted outright: no redirect page and no compatibility layer.
- Extended the **drift guard's CLI inventory** past the CLI entry module into the plan / workflow / sdd registration modules — 16 command paths that were previously invisible, including 13 `plan` verbs — so citing those verbs is now checked instead of silently passing. The same check (declared bin prefix plus a real command path) now also scans the new skill's own markdown, not only the Engine-check callouts.
- Registered the skill in the **runtime load surface**: implementers, reviewers and QA, operations, architecture, harness-text work, and PM load `mstar-use-cli` in their preset menus / load table when the round runs or interprets CLI commands.
- Granted the **QC seats and `code-reviewer`** read-only CLI validators in their bash allowlist (`qc validate-report`, `lint`, `dispatch validate`, `worktree qc-alignment`, `status validate`, `lease verify`), removing the contradiction where a skill required a machine-checked gate the seat had no permission to run.
- Updated the **host support tiers** in the README pair: **`dsh = omp ≥ ZCode = OpenCode = Cursor > Kimi > Codex`**. ZCode now shares a tier with OpenCode and Cursor: its plugin hooks enforce the default-branch commit guard, the bare-force-push guard and the engine-backed coordination-write gate at tool-call time — runtime integration in the same class as OpenCode's. Worktree isolation stays skill guidance rather than a hook-enforced check.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.10.3**.

## [3.10.2] - 2026-09-17

### Harness

- The engine now **refuses delivery-tail evidence** (`compound`, PR identity, `merge`) at the `recordWorkflowDelivery` write seam while any plan row is not `Done` — enforcing the order the lifecycle contract already declared. The gate is write-time only: idempotent re-records skip it and existing snapshots that already carry evidence are unchanged.
- The **plan template**, PM required reading, and PM self-review now carry the scoped engine lifecycle sequence and the evidence order (`compound` / PR / `merge` recorded only after the row is `Done`).
- **Standalone `development` plans** now declare the read-only phase-6 gate output as a merge-ready precondition; iteration workflows keep their Phase 4/5 exit checklist unchanged.
- Residual **R2** (standalone plans cannot reach `Done` without integration anchors) remains open — the template states the honest stop at a submitted/accepted handoff instead of fabricating a terminal state.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.10.2**.

## [3.10.1] - 2026-09-17

### Harness

- Added a host-agnostic **host hook anchor** contract to the host-adapter skill — `iteration-entry`, `phase-1-lock`, `phase-2-entry`, `rescheduling-checkpoint` — each carried by a marker in the shared lifecycle references and resolved by the active host reference.
- The OMP host reference now declares, per anchor, the coordinator calls that were previously documented but never wired, so a coordinator session actually executes them.
- Removed shared-corpus host-name leaks from the four densest files; the relocated per-host role-binding field and engine-scope detail now lives in the host references.
- The remaining corpus cleanup is tracked as a roadmap goal (`host-seam-corpus-cleanup`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.10.1**.

## [3.10.0] - 2026-09-16

### Harness

- Landed four register-driven docs fixes: restored the `zero-residual` scope qualifier in the Phase-6 blocking sentence, fixed the Session-todos pointer wording, switched the L4 QA residual-verify input citation to the project register, and aligned the plan-template `Main worktree branch` header with the parser-documented form.
- Flipped the formal-iteration Phase 2 findings-cleanup default from **zero-residual** to **allow-residual** with hard register-and-disclose duties: every open finding carries id + severity + tracking location across QC decisions, Completion/Status reports and leaf/SDD report formats; close-time surfaces (main-plan Review Gate Summary, compass Quality Gate Summary, PR body) add the blocker-defer flag. Explicit `zero-residual` opt-in, unresolved-critical blocking and Phase-6 no-manufactured-closure rules are unchanged.
- Added the **Task budget (implement / ops rounds)** field to the canonical Assignment contract: SDD fresh/continuation prompts require the header before task-body markers and repeat the overrun escalation with the mandatory no-shortened-verification rule from `plan-quality-bar.md` item 7; a previous task's budget is not inherited.
- Budget overrun on `NEEDS_CONTEXT` / `BLOCKED` now routes to PM split/re-dispatch under plan-quality-bar item 7 in `mstar-sdd`; `mstar-review-qc` and `mstar-dispatch-gates` engine-check notes point to the same presence-only requirement.
- Added the **implementer task-capacity criterion** (`Task shape / session fit`) as plan-quality-bar item 7: one implementer round must close a task's Files and gates, with a named split point when it cannot; budget pressure never shortens assigned scoped verification.
- Wired the criterion into `mstar-phase-gates` (tasks bullet, self-review question, quick-check item) and added per-task **Effort (agent-oriented)** / **Split point** slots to the main plan template; `effort-estimation.md` now points task-level sizing at item 7.
- Documented the **phase-transition `todo` refresh discipline** as a host-agnostic rule: refresh session todos at every phase/gate transition before the next action or dispatch, close only completed entries, preserve pending gates and seed the next phase — todos stay a projection of the snapshot/plan state, never a second store.
- Added a named **`Rescheduling checkpoint`** to the authoritative Phase 2 procedure (`mstar-iteration/references/phase-2-worktree-lease.md` §2.4): five frozen reasons (`before-wait`, `result-settled`, `dependency-changed`, `ownership-changed`, `capacity-changed`) and a six-step decision procedure that starts every authorized independent ready task before waiting for an unrelated running child, keeps true dependencies blocked until reviewed commits are in the dependent's assigned base, and allows one reasoned native wait without polling or repeated reminders. Short pointers added in `mstar-sdd` § Ready-task scheduling and the PM role; no new scheduler, ready-state register or engine schema.
- Added the six `phase2-*` routing-eval cases (version 30, 62 cases) with their regression signals (each pointing at the §2.4 home), and documented the before/after behavioural evidence for them plus the affected `plan-scope-duplicate` / `plan-scope-last-plan` / `plan-scope-leaf` cases. That evidence is single-sample with no per-call model identity attested, so it establishes neither model compliance nor a behavioural gain.
- Wired the **per-plan delivery tail** into the normal route (frozen contract `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`): register at commitment → pre-lock knowledge-recall receipt → execute/acceptance → compound disposition (`created`/`updated`/reasoned `skipped`) → development PR submission → merge-ready milestone → verified merge → terminal close/unregister. Standalone development plans now reach the same delivery lifecycle; iteration plan rows and plan-scoped session authority are unchanged.
- **This repository no longer tracks its own harness specs.** `.mstar/specs/` is local-only here again (`.gitignore` back to a single `.mstar/` rule), so an iteration sweep can no longer commit local plan artifacts into the history of the harness source repository. Downstream repositories are unaffected: the `mstar harness scaffold` snippet, the coordination write gate, and the resolver chain still treat `{HARNESS_DIR}/specs/` as a tracked result.
- **The plan-workflow lifecycle contract now lives in the skill corpus.** Its semantics — delivery-kind declaration, lifecycle stages, evidence contracts and the engine seam inventory — are the skill reference `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`. Engine module comments, CLI help text, tests and the runtime skills that cite it point at that path instead of a repository-local harness spec.
- **Two process specs stayed in the project corpus.** `omp-phase2-instances.md` and `phase2-proactive-scheduling.md` are the process sources behind runtime guidance that already exists (`mstar-host/references/omp.md` § Phase-2 plan instances; `mstar-iteration/references/phase-2-worktree-lease.md` §2.4), so they were kept as project references rather than duplicated into the skill corpus — their citations now point at those runtime homes.

### Changed

- Added the opt-in **coordinator model handoff** to `@mstar-harness/omp`: a new extension entry (`extensions/model-handoff.js`, published through manifest `omp.extensions`, engine inlined, its single host import resolved by the running host) plus native plugin settings `modelHandoff` (off by default) and `handoffTarget` (`@default` \| `@smol`). A **new** Morning Star iteration start in the bound coordinator session arms `@slow` before substantive Prepare, and a complete Phase 1 — specialist returns, locked Prepare, distinct matching integration checkout, verified required push — switches that one session to the saved target once. Ordinary chat, leaf and plan-scoped sessions stay inert; no role mapping, goal objective or workflow state is written, and a manual model change while the switch waits cancels it for that session only.
- Pinned the package's OMP host contract: optional peer and development dependency `@oh-my-pi/pi-coding-agent@18.2.1`, Bun floor `>=1.3.14`, and a `bundle-smoke` case that unpacks the published tarball and drives it through the host's own plugin discovery, extension loader and custom-tool loader in a disposable host root with no engine package installed. It replaces the previous source-text bundle assertions (emitted symbol, no bare engine import) with that runtime behaviour.
- Documented the native `/settings` → Plugins path, persistence and its user-scope limitation (a project-only install has no native settings row), supported entries and modes, coordinator binding, full-Phase-1 readiness, cancellation, replay and failure semantics in the OMP host reference and the package README.
- Added opt-in **Phase-2 plan instances** to `@mstar-harness/omp`: a new extension entry (`extensions/phase2-orchestration.js`, published through manifest `omp.extensions`, engine inlined, its one host import resolved by the running host) plus native plugin settings `phase2PlanInstances` (off by default; gates **extra primary launches only**) and user-configurable `maxPlanInstances` (positive safe integer, default 2, minimum 1, no ceiling of 2; a malformed present value fails visibly and authorizes no launch). A Phase-2-only coordinator session gets at most one bounded advisory per **changed** opportunity observation — the observation key is recorded before the message, identical unchanged state never re-fires, there is no timer or polling, and native completion delivery stays authoritative.
- Added the `mstar_phase2` bookkeeping tool with its local transport-intent journal (`<workflow dir>/omp-launches.json`, version 1): `bind` (the coordinator's first Phase-2 host action), `checkpoint` (acknowledges the shared rescheduling checkpoint against the sample taken then, with the frozen five reasons), and `reserve-launch` / `record-launch` — strict `reserved → starting → created → submitting → submitted` transitions, each persisted **before** its pane / OMP-start / prompt side effect, with occupancy counted once per plan id as owned pending intents ∪ active plan primaries against the latest cap, and `refused` / `uncertain` never blindly retried. Compiled code admits and records only: it never spawns, merges, rewrites workflow state or releases leases.
- Documented the native `/settings` → Plugins path (with its user-scope limitation — a project-only install has no native settings row), the launch-only opt-in, capacity semantics, the explicit bind/checkpoint/intent call sequence and the optional skill-driven Herdr/tmux transport in the OMP host reference, the package README and the scoped-plan PM transport note: prerequisite gating (skill actually present and read + CLI + matching managed environment; tmux stays unavailable while no tmux skill exists), non-focus pane creation at the prepared worktree, verbatim returned opaque targets, one absolute `/iteration-drive --assignment` submission with no coordinator credentials, and terminal handling of `agent_not_ready`, a timeout or a stalled submission. Transport evidence is explicitly marked simulated, not native E2E.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.10.0**.

## [3.9.4] - 2026-09-15

### Harness

- The protected `mstar persist` kinds (`status`, `snapshot`, `residuals`) now have exactly one writer: `--expect-version <absent|sha256:<hex>>` routes the put through the engine's locked `replaceCoordinatedArtifact` (same-host CAS), a coordinated `snapshot` replacement additionally requires `--session <coordinator envelope>`, an injected `--store` module is refused because it cannot honour that contract, and a bare (un-versioned) `put` or `delete` of a protected kind is refused before anything is written. A missing / invalid / mixed flag fails closed as a usage error (exit `2`) before anything is read, and a version or session mismatch is an engine refusal (exit `1`) with the bytes intact.
- `mstar persist get <protected> --versioned` prints `{payload,version}`: the `sha256:` byte version of the exact bytes read, or the `absent` token with a `null` payload for a missing document, so a read-modify-write is `get --versioned` → `put --expect-version` and the reported token is passed back as `--expect-version`.
- Added the **`mstar plan` scoped coordination transport**: `bind` (coordinator / workflow+plan / Assignment / `--resume`), `show`, `prepare`, `progress`, `residual-add`, `residual-close`, `handoff`, `accept`, `return`, `integration-start`, `integration-accept`, `complete` and `reconcile`, with JSON on stdout, diagnostics on stderr and the `0` ok / `1` engine refusal / `2` usage exit contract.
- Scoped verbs pin the active `FsStore` to the engine's resolved root before every call, so a process inside a linked feature checkout resolves the **main worktree's** harness instead of its own `.mstar`.
- `mstar harness scaffold` awaits the now-async, store-routed engine bootstrap and pins the store root it resolves.
- Coordinator transition verbs now **carry the `--handoff` id into the engine**, which re-checks it against the row inside its own lock: a handoff replaced between the CLI's read and the mutation can no longer be transitioned by a command that named the old one. The CLI pre-check stays as an early, friendlier refusal.
- Git reads refuse an unanswerable environment as `coordination.git-unavailable` (with the path, command and cause) instead of reporting integration divergence, and are bounded by a 10s timeout so a blocked `git` can no longer pin the row lock until every other writer times out.
- The integration proof reads the first-parent path in **one** `git rev-list` call instead of one subprocess per commit, keeping the lock hold constant on a busy integration branch.
- The findings-cleanup gate is evaluated while holding the register write lock (snapshot → register order), and the workflow merge lease is compared by plan and source branch, so a foreign lease is never reused or released.
- The `mstar plan` row verbs now act on the row's **live** handoff: `--handoff <id>` is validated against the handoff the engine reports (a *different* live id is refused as `coordination.handoff-mismatch`, exit `1`, nothing written) and `plan show --json` reports `handoff_id` alongside the row's `state` / `attempt`, so a recovery step can read the id after a crashed caller lost it.
- Added a **plan-scoped primary entry** to `/iteration-drive`: `--assignment <absolute-md-path>`, `--workflow <id> --plan <id>` and the explicit `--resume <absolute-session-json-path>` form drive one prepared plan in an independent primary session. That session stops at a durable **handoff** — `Done` and both lease releases stay with the iteration coordinator after it verifies the merge. A second fresh entry for the same plan fails as a duplicate holder; malformed nonempty arguments fail closed, and no arguments keep the whole-iteration route.
- The scoped session owns one plan row: it reads with `show` and writes only `progress`, `residual-add`, `residual-close` and `handoff`, leaving sibling rows, lifecycle anchors, the root register, the shared indexes, the iteration PR and Phase 3–6 to the coordinator. User guide: `docs/commands.md` — the unified command reference this change ships, with the scoped session as its `/iteration-drive` section; CLI flags and exit codes: `docs/cli.md`.
- The scoped terminal is **transport, not a dependency**: any terminal works, and Herdr / tmux are optional — ownership never reads pane state, TTL or terminal labels.
- Added seven `plan-scope-*` cases to the PM routing-eval corpus covering both addressing forms, duplicate entry, unknown arguments, last-plan stop, `Done`-before-integration refusal, the no-argument route and the leaf boundary. The `mstar plan` transport itself is recorded in `.changes/unreleased/plan-coordination.md`.
- Because `/iteration-drive` now advertises its argument shapes in the command frontmatter, the dsh client-claim table that pins every `input:` hint (`packages/dsh/tests/commands.spec.ts`) moved to the new hint, so the composer ghost text offers the scoped forms instead of executing the bare command.
- `mstar status workflow-close` closes a workflow through the engine's locked snapshot writer and takes `--session <absolute coordinator envelope>`: a coordinated workflow now refuses to close from a plan session (`snapshot <path> is coordinated — close requires --session <coordinator envelope>`, exit `1`, nothing written) before it judges the plan rows, so an unfinished-row refusal can no longer be mistaken for a session problem.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.9.4**.

## [3.9.3] - 2026-09-15

### Harness

- Added a **provenance guard** to drift-lint: the tracked repo text face (`.md` full text, `.ts` comment lines — leading comment lines plus trailing `//` comments, detected after masking string and template literals via the shared comment mask and with no whitespace requirement, with `://` URL sequences excluded) is scanned with the engine provenance finder, and dated plan/iteration ids or dated local-harness paths on it now fail CI with a `file:line` row. The walk intersects with `git ls-files`, so untracked local files never fail the guard (`.mstar/sdd/…` deeplinks remain under the skill-lint ephemeral check, which covers the skills corpus). Assembled release surfaces (`.changes/archive/`, `CHANGELOG*.md`) are exempt as historical record.
- Scoped the E2E evidence boundary to development plans: `mstar-harness-core` § 定向执行与验证边界, `mstar-phase-gates` § 最小证据要求, `mstar-artifacts` plan-quality-bar + `plan.main.md`, and `mstar-e2e` now agree that real-browser / device / installed-deployment E2E is never a development plan's task nor any gate's evidence obligation — it lives only in a separately requested `mstar-e2e` workflow, whose named scenario rows are that workflow's own plan rows, while each layer proves itself through its own unit/integration tests.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.9.3**.

## [3.9.2] - 2026-09-14

### Harness

- Added a **round-bounding dispatch gate**: when `Execute as` is a review seat (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`, `code-reviewer`, `qa-engineer`) or `Task category` is `audit`, the Assignment must declare both **`Budget (review / QC seats)`** and **`Return shape (review / QC seats)`**. `mstar dispatch validate` now fails such an Assignment when either field is absent, empty, or `N/A`, naming the missing field; implement / ops / docs rounds are unaffected. Only field **presence** is checked — the field values are prose and are never parsed.
- Added **`validateQcReport`** (`@mstar-harness/engine`) and **`mstar qc validate-report <report.md>`** for plan-QC seat reports. The gate checks that the report opens with `---` frontmatter carrying the required `qc` fields, that the frontmatter `verdict` is an enum member and agrees with the body verdict line, that each `## Summary` tally matches the number of entries in its `## Findings` section, that the verdict follows from those counts (no `Approve` with an open Critical or Warning; any `Unconfirmed` count requires the `Unconfirmed` verdict), and that a present `Truncated coverage:` line is never reported as `Unconfirmed` — a cap stop is a scope cut, not a failed evidence channel. Undecidable cases stay silent rather than guessing.
- The report gate reads the **last** verdict line, and `## Summary` is the report's **single current count** — an in-place revalidation refreshes `## Summary` and `## Findings` rather than appending a second tally, so a revalidated report is judged on its current state and every count rule shares one source.
- Both gates read only the Assignment **header region** / the report's **frontmatter**: the dispatch gate stops at the first `## Task` heading, `---` rule or single-`#` heading, so field lines quoted in the task body neither satisfy it nor disable it (a body `**Execute as**: scout` no longer turns the writable gate off); the report gate reports `qcreview.report.unclosed-frontmatter` (high) when the opening `---` is never closed, since the body would otherwise be read as frontmatter and the field and body rules could not be decided.
- Wired the checks into the runtime skills: one Engine-check callout in `mstar-review-qc` § 席位预算与截断, pointers from `qc-specialist-shared.md` and the QC report template, and the round-bounding bullet in `mstar-harness-core` § 定向执行与验证边界 now names both required Assignment fields.
- No audit-chain behaviour, verdict vocabulary, severity semantics, register schema, or existing report contract was changed.
- Added a **review-seat termination contract** in `mstar-harness-core` § 定向执行与验证边界: read-only review / QC / L2 seats are bounded by a default seat budget, stop there instead of expanding until a human steers, and declare `Truncated coverage:` — which stays distinct from `Unconfirmed`.
- Extended the canonical Assignment template with **`Budget` / `Return shape` / `Severity bar` / `Input provenance`** for review / QC rounds, plus a quantitative-stop dispatch invariant, an unbounded-negative-acceptance anti-pattern, and two PM self-check rules for artifact claims and `path:line` citations.
- Threaded the rule through the seat side (`qc-specialist-shared`, `reviewer-workflow`, `report-template`, `mstar-sdd` task reviewer) and PM orchestration (`mstar-review-qc`): a truncated seat stops and declares its coverage, and a gate decision on uncovered scope is not an approval. Tightened the residual **severity bar** in `mstar-artifacts`: `critical` vs `high` now turns on whether the unsafe outcome is reachable on this merge, independently of the QC report section the finding was filed under, so an unsafe reachable finding cannot ride `Approve with residuals`; grading is by consequence, not uncertainty, and a documentation defect grades by its own consequence when it would drive an unsafe outcome — removing the "when unsure, use `high`" default that turned non-blocking documentation findings into blocking ones.
- Unified the harness's blocking judgement behind one **reachability axis**: the cross-chain vocabulary table (register `severity` / audit Merge class / plan-QC report section / L2 task review) now lives in the register SSOT — `mstar-artifacts` `references/status-and-residuals.md` §5 Cross-chain vocabulary.
- `mstar-audit` `references/pr-review.md` § Merge class now qualifies `must-fix` as the same class as register `critical` (unsafe **and** reachable in the reviewed change) and places `should-fix` on the same axis (unreachable-unsafe / significant tech debt / substantive non-blocking), with a pointer to that table instead of a restated definition.
- Gave `Critical` / `Important` / `Minor` their missing definition at `mstar-roles` `references/code-reviewer.md` § Issue severity (Mode A) — thresholds keyed to the axis, `Critical`/`Important` as per-task fix-loop drivers, `Minor` handed to `## Minor (for plan QC)` — and pointed the L2 dispatch prompt (`mstar-sdd` `references/task-reviewer-prompt.md`) at it. Mode C (PR review) stays the only Merge-class consumer; Mode B (audit) keeps its own finding format (`Impact` / `Effort` / `Risk` / `Confidence`, plans ranked by `Priority`).
- No enum, verdict rule, tally/score rule, tier or budget mechanic, or routing behaviour changed — labels remain projections of the one judgement.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.9.2**.

## [3.9.1] - 2026-09-14

### Fixed

- `mstar worktree cleanup` no longer aborts on an unrelated workflow's broken snapshot, and no longer drops that snapshot's safeguards. A sibling whose JSON parses but fails validation enters the safety set in **degraded form** — only protective declarations survive (branch base/integration/target, lifecycle worktree path, merge/execution leases, row ownership metadata) with lifecycle and row states forced non-terminal, so it can only ADD keep/refuse verdicts. A sibling that cannot be parsed at all leaves the safety set incomplete, so every removal is withheld as `cleanup.refuse.unreadable-snapshot` (the plan still prints whole) unless the operator asserts `--ignore-unreadable-snapshots`. The selected snapshot stays fail-loud (exit 1), and no broken snapshot is ever repaired, rewritten or removed. Contract documented in `mstar-branch-worktree`「Worktree / branch cleanup」.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.9.1**.

## [3.9.0] - 2026-09-13

### Testing

- Generated the synthetic audit password before interpolating the test document, preserving random secret-detection coverage while preventing a source scanner from mistaking the nested expression for a hardcoded credential.
- Isolated the evidence output-cap test in a captured CLI subprocess, verifying complete forwarding and capped log storage without flooding the test runner's live output.
- Updated exact drift-regression counts to include the validated cleanup and post-merge close gate callouts: 48 Engine-check callouts and 46 CLI citations.

### Fixed

- Cleanup now re-probes local branches released by deferred integration worktree removal, deleting merged branches in one apply while preserving refusal guards and evidence-base deletion ordering.
- Updated **dsh headless guidance** to retain restricted permissions for unattended work, verify effective session permissions, and move operations requiring approval to the web profile instead of removing sandbox restrictions.
- Escaped remaining Unicode literals in worktree validation, SDD discovery and evidence diagnostics without changing runtime text or matching behavior, restoring the ASCII source gate.
- Escaped em dashes in worktree check and cleanup CLI literals to satisfy ASCII source checks while preserving runtime messages.
- Regenerated the bundled write-gate hook from the current engine and canonical hook source to restore bundle freshness.

### Harness

- Install Codex custom agent TOMLs as regular files so discovered roles can load. Re-running init replaces expected legacy links and backs up differing regular files before refresh; doctor detects links and source drift. Update installation and dispatch guidance to require successful named-role invocation.
- Added the **Phase 6 post-merge close engine gate** (`evaluatePostMergeClose`): a pure, additive local-state check over the terminal snapshot shape, leftover leases and root-status unregister, with stable `PHASE6_*` codes; `mstar iteration gate --phase 6 --workflow <id>` evaluates it without `--compass`.
- The Phase 6 gate now validates the root `status.json` with the full v2 root validator (`validateStatusV2`, structure-only): a malformed registry (non-v2 version, missing `updated_at`, malformed `workflows[]` entries) fails closed as `PHASE6_INVALID_ROOT` instead of false-PASSing when the workflow id is absent; `/iteration-start` and the README commands table now state the auto-continue completion at Phase 6 post-merge close (same Done definition as `/iteration-drive`).
- Build the real DSH plugin entry with frozen dependencies before security scanning, and preserve the scanner's complete JSON findings with an untruncated job summary.
- Streamlined repository maintenance instructions: removed duplicated runtime loading rules and historical release details, updated package routing, and aligned authoring guidance and scoped verification with current harness contracts.
- Removed the mandatory full-diff approval gate for repository maintenance; agents can continue already-authorized work without separate approval for each complete diff.
- Added the **guarded `mstar worktree cleanup` verb** with the pure `planWorktreeCleanup` engine planner: dry-run by default prints `verdict | kind | ref | reason` per worktree/branch candidate; `--apply` removes eligible worktrees (ordinary `git worktree remove`, never force), re-probes/re-plans, then deletes newly unchecked-out branches (`git branch -d`, never `-D`) and runs expected-OID `--force-with-lease` remote compare-and-delete. Active leases, branches checked out anywhere and foreign ownership refuse; protected refs are never removed (default and `branch.base` refs are kept, non-terminal owners refuse); merged evidence is a hard precondition (squash-only residue is retained and reported, never force-deleted).
- Wired the two cleanup timing lanes into the skill corpus: a new **`mstar-branch-worktree`「Worktree / branch cleanup」** contract home (ownership from snapshot row metadata/retained track Assignments or verified `--worktree` assertions — never naming inference), a same-round post-merge call in `mstar-iteration` Phase 2 (a Done plan is eligible while its parent iteration still runs), and the Phase 6 §6.4 call after terminal close + PR merged.
- Worktree dirtiness now counts ignored files: an ignored-content worktree (e.g. a local-only `.env`) is refused (`cleanup.refuse.dirty-worktree`) instead of being removed.
- `--apply` defers the branch-deletion cwd host (typically the terminal integration worktree) to a last removal pass: other eligible worktrees are removed first, then `git branch -d` runs from the evidence-base checkout, and the deferred integration worktrees are removed last — plan branches merged only into the integration branch (squash-merge era) now delete instead of refusing on the main worktree.
- Unify active lifecycle branch checks across hosts, retain parallel track ownership, bound SDD Git probes, and preserve integration-cwd workflow selection.
- Keep the dedicated integration checkout under feature-worktree waivers, record retained parallel-track branches, and centralize L1 refusal semantics.
- Renamed the workflow-snapshot integration field `control_worktree_path` to **`integration_worktree_path`**: writers emit only the canonical key, the canonical reader accepts the v1 alias with a medium migration advisory (normalized in memory, never rewritten in place), strict validation refuses documents carrying both keys, and `mstar migrate` lifts the rename.
- **`mstar worktree check`** now validates main-worktree residency — the process SSOT (`status.json` / `workflows/`) resolves from the verified main worktree root and is never recorded in the snapshot.
- Renamed the `worktree check` flag `--control` to **`--integration`**; `--control` remains as a deprecated alias for one release (stderr migration notice).
- Cut the **dsh / omp / opencode** host surfaces (gates, tools, hooks) over to the canonical write model.
- Rewrote the runtime skill corpus to the **three-domain worktree write model** (control / feature / integration residency) and refreshed all bundled mirrors.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.9.0**.

## [3.8.3] - 2026-09-12

### Harness

- Scope local verification and review to changed behavior, parallelize independent work, and keep routine QA on targeted unit evidence; full local suites require explicit user authorization.
- Accept explicit `scoped-check` evidence for documentation and policy changes without invented test files, while preserving executable-change test evidence.
- Add the independent `mstar-e2e` workflow and `/amazing-e2e-check` entry, including Codex project command installation, for explicitly requested browser, device, and installed-deployment scenarios.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.8.3**.

## [3.8.2] - 2026-09-12

### Changed

- **dsh docs**: the package README now documents the recommended `workflowNames` allowlist for the native read-only fan-out path on dsh — `mstar-qc-tri` (plan QC tri), `mstar-audit-fanout` (large-repo `/codebase-audit`), `mstar-pr-seats` (`/amazing-pr-review deep`) — with the production-overlay note in the same place: with the shipped empty allowlist every name is *unknown*, which the default `workflowGate: 'warn'` turns into one survivable `workflow.name.unknown` advisory; a deployment that also wants unknown names vetoed sets `workflowGate: 'hard'` in the profile layer. No default changed — `workflowGate` stays `'warn'` and `workflowNames` stays unset (operator overlays, never mstar defaults).
- **dsh read-only fan-out (docs)**: `skills/mstar-host/references/dsh.md` gains the **Read-only fan-out via the `workflow` tool** section and `references/dsh-workflow-scripts.md` ships the copy-pasteable `script` + `meta` templates for the three names; `commands/codebase-audit.md` and `commands/amazing-pr-review.md` carry the dsh-conditional sentence (slash → native `workflow` tool → conversation `workflow-run` node, other hosts unchanged), and `skills/mstar-sdd/SKILL.md` notes the plan QC tri MAY run through the qc-tri script while per-task implementers stay serial `subagent`.

### Harness

- **dsh host**: mstar progress on dsh is now defined as **native-workflow driving** — the workflow snapshot phases, the dispatch gates, and subagent settle notifications — and the goal bridge is **advisory-only**, so a human `/goal pause` can no longer be overridden by mstar's own dispatch edges. `mstar-host` scopes its host-agnostic `/goal` rule with an explicit dsh exception (other hosts keep the complete-flow objective rule), `mstar-host/references/dsh.md` gains a progress-discipline section (a dispatched child owning the critical path means wait for its settle notification, not another work unit), and PM required reading carries a dsh pointer.
- **dsh host**: shared steering helpers (`isRootLikeAgent`, `rootAgentOf`, `steeringCompass`) moved to `gates/steering.ts` in the dsh plugin — planMode behavior unchanged.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.8.2**.

## [3.8.1] - 2026-09-11

### Harness

- **dsh plugin**: the workflow panel migrated from the conversation-area view ring to the dsh **right Sidebar** — the panel now registers as a first-class page tab type (`kind: 'mstar-workflow'`) through the sidebar's public two-stage seat contract, with a guide-page capsule as its entry point (opening expands the column, a second pick focuses the existing tab) and the panel body + chip title as keyed seats. The old `conversation.view` tab is **removed** (a migration, not a second surface); the tab chip title is captured at open time and no longer follows a mid-session locale switch; while the column is collapsed or another pane tab is active the body renders nothing.
- **dsh plugin**: the panel is re-laid out for the narrow docked column — a single-column shell with exactly one scroll owner (`[data-mstar-scroll]`; the per-page scrollers and the workspace-digest's nested scroller are retired), width driven by **container queries** instead of viewport media queries (compact rhythm below 480px container width; the group grid spreads to two columns at 720px+), and the agent-execution **canvas replaced by a vertical grouped list**: the SVG edge layer, card ports, and pointer pan are deleted — flow order is carried by the fixed phase/stage/sub-bucket group headings, entity cards become full-width flow rows keeping the role chip, status point, ×N count, emphasis tiers, done ✓ (off-tier excluded), evidence/idle placeholders, and the on-demand badge; the tasks tab's plan board stacks into five groups with a vertical stepper, and the event log's partitions become flow content.
- **dsh plugin (behavior change)**: the emitted engine-status catalog anchor identity is renamed `mstar-engine-status` → **`mstar-engine`** (the `kind: 'plugin'` / `form: 'catalog'` source shape is unchanged). Rows already emitted by shipped builds persist the legacy identity in their session logs, so the panel's anchor reader accepts **both** identities; any other `plugin` value is not an anchor and the session degrades to the explicit `waiting` state.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.8.1**.

## [3.8.0] - 2026-09-10

### Harness

- **dsh plugin**: the engine-status catalog row's persisted `source` is now the first-party `plugin` arm — exactly `{ kind: 'plugin', plugin: 'mstar-engine-status', form: 'catalog' }`, with no other member. The previous custom `kind: 'mstar-engine-status'` plus its five payload members made every pre-V3 session log that ever ran the plugin **unopenable in the Web GUI** (the released session-format V2→V3 classifier refuses the whole log with `cannot safely transform unclassified message source`), and the extra members are refused by all three released historical edges as soon as a `plugin`-arm source is member-audited. A new regression test asserts the exact three-member source on the real composition row, so neither the custom kind nor a "just add one field" edit can return.
- **dsh plugin**: the payload no longer rides the message `source` at all. The exact emitted payload is snapshotted per session at `{HARNESS_DIR}/snapshots/engine-status.json` in the same digest-gated emission that appends the row, and the workflow panel fetches that session's snapshot on demand from the host's shared `/api` typert gateway (`mstar/engineStatus`; browser half `connection.rpc.call('/api', 'mstar/engineStatus', { args: { sessionId, cwd } })`, the host validating the asserted session and answering its stored record). A missing, unknown-version, torn or foreign snapshot renders an explicit `unavailable` reason — no panel field silently degrades to an empty state. The endpoint is unauthenticated: a caller that can reach the local `/api` gateway **and** knows a `(sessionId, cwd)` pair is served (the payload is a workspace digest, not a secret), while every answer stays scoped to the requested session — the stored record's `cwd` must match the asserted and the server-resolved workspace, and the client re-checks the echoed id and workspace before rendering.
- Docs synced to the new contract: the `packages/dsh` README pair + `bundle/README.md`, the dsh host reference, and the `mstar-artifacts` residual fail-loud handoff clause (which now names the **`decision`** enum alongside `severity`, and the whole-register refusal a lifecycle value such as `"resolved"` triggers there).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.8.0**.

## [3.7.3] - 2026-09-10

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.7.3**.

## [3.7.2] - 2026-09-09

### Harness

- Moved the `mode: primary` **`project-manager`** agent shell out of the shared `agents/` subagent surface into `packages/opencode/agents/` (OpenCode-only). Host plugin surfaces (ZCode / omp / Claude-plugin manifests) no longer register PM as a subagent — PM entry stays via the `pm` skill; OpenCode bundling merges the shell into `harness-agents/`.
- Updated omp/dsh mirror contracts and host docs to match.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.7.2**.

## [3.7.1] - 2026-09-09

### Harness

- **CLI ↔ plugin version drift is now visible in one command, for every supported host**: `mstar-harness doctor --target <host>` compares the running CLI version against the installed Morning Star plugin with per-host local discovery (opencode package cache, cursor plugin checkout manifest, codex/omp `plugin list --json`, zcode plugin cache, dsh profile node_modules across all profiles, kimi `$KIMI_CODE_HOME/plugins/managed`; highest semver wins) and prints one directional prompt — CLI newer → per-host plugin update hint, plugin newer → update the global CLI (`npm i -g @mstar-harness/cli@latest`) — as an informational note that never becomes a doctor error or changes the exit code; the `mstar-harness-core` version-drift contract now states all-host coverage.
- `kimi` joins the supported install targets with a minimal adapter: doctor reports the resolved `$KIMI_CODE_HOME/plugins/managed` location without requiring the kimi binary; init is notes-only — plugin install and update go through the Kimi TUI `/plugins install`.
- **Marketplace manifests now pin the plugin version.** `.claude-plugin/marketplace.json` and the root `marketplace.json` carry `version` on the `morning-star-harness` plugin entry, and both manifests joined the release version surfaces — `release:prepare` bumps them at `plugins[0].version` and `release:validate` gates them there, so a ZCode marketplace refresh can detect newer releases.
- **ZCode bootstrap marketplace entry carries `version`.** The CLI seeds the entry with the CLI release version; ZCode's marketplace refresh overwrites the seed with the repo-shipped manifest. Doctor deliberately does not gate on version skew — a snapshot newer or older than the installed CLI is the update signal itself, not an unhealthy marketplace.
- **Worktree gates now distinguish Git checkout identity from physical path nesting.** A real linked worktree created inside the control checkout (the documented `.worktrees` layout) passes the L1 pre-dispatch check and the bound SDD execution context; the same control checkout, a plain subdirectory of it, or a symlink alias of it is refused — even when the declared branch equals the control branch. Git-probe failure fails closed with the existing bounded timeout.
- **The control checkout root is derived by git probe, not `dirname(harness)`.** `resolveSddExecutionContext` resolves the real repository top-level of the declared harness root (`git rev-parse --show-toplevel`, bounded and fail-closed), so a `.mstarc`/override nested harness like `<control>/state/.mstar` gates the same-checkout isolation identically in standalone and active-lease contexts; an unresolvable root fails closed.
- **One shared checkout-identity predicate.** `l1PreDispatchCheck`, `assertControlVsFeaturePath` and `resolveSddExecutionContext` (the `sdd.context.feature-in-control` gate) share `isDistinctCheckout` (canonical per-worktree git dir comparison) — no `.worktrees` name special-case, no duplicated containment rule, and the control-harness-inside-feature, path-escape, lease and branch protections are unchanged.
- **ZCode coordination-write gate**: new engine-backed PreToolUse (`Write|Edit`) process hook `hooks/mstar-write-gate.mjs` — hard-enforced repos block writes to harness coordination documents (status.json, workflow snapshots, project registers) with exit 2 plus an actionable stderr reason (stdout stays empty); soft-mode and non-harness writes pass silently; disable per session with `MSTAR_WRITE_GATE=off`.
- **Edits validate the reconstructed post-edit result (ZCode host)**: deterministic Edits (`old_string` + `new_string` with a unique match, or `replace_all`) are validated against the reconstructed content instead of the pre-edit on-disk state — a deterministic corrupting edit now blocks under hard enforcement; ambiguous or non-reconstructible edits keep the pre-edit fallback.
- **Oversized coordination docs are now a violation on the ZCode host**: content or on-disk targets beyond the 2 MiB validation budget yield `status.oversized` (hard-mode block naming the escape hatch instead of a silent pass; omp keeps the default silent pass).
- **omp hook lazy loaders removed (versioned divergence)**: the engine is inlined at build, so a stale engine dist now fails the omp build instead of silently degrading; Gate-1 block/pass decisions and reason strings are unchanged (golden fixture matrix).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, the portable Agent Plugins manifest, and both marketplace manifests: **→ 3.7.1**.

## [3.7.0] - 2026-09-08

### Harness

- Iteration skill (mstar-iteration) restructured for progressive disclosure: main SKILL.md is now a 122-line phase router (one route map + universal invariants; 408 lines before); Phase 1 start detail moved to new `skills/mstar-iteration/references/phase-1-prepare.md`, Phase 2 loop detail merged into `references/phase-2-worktree-lease.md`, and each start/drive/resume/close/PR route names exactly one phase reference — structural per-route byte reduction of 23–56% (route sets pinned by 37 closure tests; byte accounting in the plan's eval evidence, not observed model loads).
- Commands (`iteration-start/drive/loop`), PM role reference, and helper-discovery pointers retargeted to the phase references; no lifecycle rule duplicated (phase route map is the single dispatch table; §2.6 stays in main as the cross-phase SSOT).
- Frozen 30-case skill-eval corpus (v28) gains five adversarial phase-transition cases (parallel review chain, Phase 3 collapse, early-PR jump, wrong-phase resume, overridden pause) folded into existing case ids plus ordered product→architect→writing-specialist chain pin; Cursor routing-evals bumped to v28 with five matching regression cases.
- Evidence: paired dev comparison complete on the shared 30-case corpus (candidate `cef1675c` vs original baseline `ec7cc1bc`: 17/20 vs 17/20, identical failure sets, zero candidate-side regressions, 0 infra); frozen three-repeat heldout **incomplete at 24/60** — real-model runs were capped by a user quota directive and remaining validation is user-run via the plan's eval RUNBOOK; observed reads inspected from traces (first-run + resume; synthetic fixtures keep skill closures unmaterialized, so route-load reduction stays a structural-bytes claim, not a causal model-load claim); drift/standalone green.
- **Root-caused** the legacy plugin-scanner `SHELL_INJECTION_PATTERN` false positives instead of suppressing them: `packages/dsh` command-frontmatter parsing now matches labels line-by-line against a static value regex (no `RegExp` assembled from label strings), and the engine audit child-process test assembles its script by plain concatenation (no template literal near `Bun.spawnSync`). The repo-root **`.plugin-scanner.toml`** now downgrades only `UNICODE_OBFUSCATED_INSTRUCTION` to `medium` — the unfixable remainder: cisco's obfuscated-instruction signature regex has no word boundaries ("readability→token", "ready→environment"), so ordinary Chinese text in bilingual skill docs trips it under the awesome-ai-plugins legacy stack (`plugin-scanner` 2.0.1116 + `cisco-ai-skill-scanner` 2.0.14). Our pinned stack (scanner 3.0.104 + cisco 2.0.12) is unaffected, and our own CI ignores repo config (`trust_repository_policy: false`); findings stay visible, only the legacy `high` gate is unblocked.
- Removed local-harness provenance citations (plan/iteration/QC-report references) from tracked code comments, test names, and migration fixtures.
- Hardened CLI path handling after a deep static-security scan: relative `--output` values containing `..` segments are now rejected instead of escaping the project root; agent-plugin install validation requires the plugin root to be a real directory and builds manifest/MCP/skill component paths by literal joins; lint target collection and tracked-file listing build child paths from guarded readdir entry names; owned PR-review artifact paths are constructed as single-segment names beside the worktree.
- skill-eval is now fully automated / test-driven: the argv CLI dispatchers (`scripts/skill-eval/index.ts`, the `manifest.ts` stage entry) were removed and the harness is invoked programmatically through its exported stage functions (`prepareManifest`, `executeManifest`, report builders); process spawn stays isolated in the `node-launch.ts` adapter with `manifest.cli.path` validated (absolute local path, no URL scheme or control characters) and realpath-normalized before launch; `canonicalJson` key ordering no longer relies on array `sort()` and is pinned by byte-stability equivalence tests.
- SDD handoffs now carry an absolute destination contract: fresh/resume/reviewer prompts cite the absolute control harness root, feature worktree/cwd, plan, brief/report and context file; native hosted subagents observe pwd/branch before writing, and the handoff states explicitly that a later deliberate `chdir`, absolute-path write, or host-native edit tool (`apply_patch`) is not blocked.
- New bound SDD execution surface (spec A3): `mstar sdd exec --context <context.json> -- <argv>` launches CLI children with cwd bound to the feature worktree (no shell, exit 1 gate / 2 usage / 127 not-found / 128+n signals); `mstar sdd check-context` gates `source|artifact|launch` seams; `task-brief`/`review-package` accept `--context` to validate destinations before mkdir/write and emit absolute paths. A causal replay suite reruns the historical relative-source write raw (wrong-primary reproduced) vs bound (feature-only) on disposable fixtures.
- Engine exports: `resolveSddExecutionContext`, `checkSddAction`, `runInSddContext` — bounded action checks reusing the existing lease/branch/path machinery; no new global hardening and no sandbox claim.
- Added a **maintenance-only skill evaluation harness** under `scripts/skill-eval/`: a frozen 30-case corpus (5 routes x 6, dev4/heldout2, first-run/resume and false-pass/wrong-checkout traps), an immutable manifest `prepare` stage (zero model calls, exit 0/2), an argv-array subprocess `run` stage (real CLI execution, evidence capture, resumable scheduler, honest pass/fail/unverified/infrastructure grading with exit 0/1/2), and a `report` stage that aggregates recorded evidence without rerunning a model.
- Real smoke baseline recorded: harness mechanics verified on codex-cli 0.144.1 (closure-sentinel reads, isolated workspace-write diffs, exact session-id resume); observed model identity absent from event streams and usage attribution left unverified — both recorded as explicit nulls, so no fixed-model efficacy claim is made.
- **Evidence-gated hot-path skill thinning**: removed duplicated and model-native generic guidance from the four standard-preset hot-path files (`mstar-harness-core`, `mstar-coding-behavior`, `mstar-dispatch-gates`, `mstar-roles/_shared/leaf-executor-core.md`) — 8 bounded ablation batches, −8,419 bytes (−14.5%) on the subject-file set — with every removal row carrying provenance, a removal basis, a restore record, and a surviving owner in the frozen `scripts/skill-eval/ablations.json` inventory.
- **Behavior evidence recorded, not claimed**: each batch was adopted only after a fixed paired dev run showed zero new critical (authorization / wrong-checkout / false-pass) failures and no normal-success regression (17/20 vs 17/20 passes); the final candidate was re-frozen (baseline `c4e338a0`, candidate `4a750601`) for the interleaved three-repeat baseline/candidate/minimal comparison with heldout grades reserved for independent QA adjudication. Token-level load effect stays unverified (`usageBasis=unknown`); no efficacy or cost claim is made.
- **Protected semantics untouched**: user policies #109/#144/#153/#156/#167, the engine-legacy conditional archive, engine-absent fallback reachability under `Skill presets: none`, and all negative-constraint owners are preserved and pinned by `scripts/skill-eval/closure.test.ts` (24 tests); `validation:drift` stays exit 0.
- **One skill-lint classification policy across hosts**: CLI `mstar skill lint`, dsh skill-lint gate and drift Guard 5 now consume the shared Engine classifier `classifySkillLint` (exact `mstar-harness-core` → five-question exempt, `mstar-skill-authoring` → strict authoring, other `mstar-*` → runtime aliases, everything else → strict authoring). Identity is the resolved skill-directory basename — never the YAML `name` — so shipped runtime skills no longer receive conflicting dsh/CLI judgments; frontmatter and ephemeral-citation checks stay active in every profile and dsh content-blind repair behavior is unchanged.
- **Real-corpus parity + drift sensitivity evidence**: before/after lint decisions recorded on the shipped corpus (pre-fix dsh failed 15/20 `mstar-*` skills in authoring mode; candidate dsh, CLI and Guard 5 all pass the 18 runtime skills with 0 violations), plus red probes proving an intentionally mismatched classification or a removed real heading fails the corpus guard.
- Made **`mstar-roles` the single load-selection authority**: the roles hub owns the `Skill presets:` decision (identity-first; explicit `none` / omitted-standard / named preset / trivial routes; unknown preset refuses instead of guessing), and `mstar-harness-core` remains the lifecycle/authorization authority while pointing to the hub instead of mandating universal core reads.
- Made `Skill presets: none` coherent: role identity, the shared leaf safety boundary, and role-owned QC/QA evidence obligations stay reachable without optional topics; `none` never grants delegation or waives gates.
- Removed duplicated preset-interpretation prose from role references (each now lists only its preset members) and narrowed the Engine `lintLoadOrder` contract: the roles-hub bootstrap is the single recognized exception — arbitrary topic exemptions still fail.
- ZCode plugin cards now show the Morning Star **icon and display name**: the repo-shipped marketplace manifests (`.claude-plugin/marketplace.json`, root `marketplace.json`) and the CLI `zcode` bootstrap snapshot carry `icon` + `displayName` for the `morning-star-harness` entry.
- Bundled **ZCode plugin hooks** (`hooks/hooks.json`): **SessionStart** injects a compact harness-workspace context ({HARNESS_DIR} + `status.json` summary + `mstar-harness-core` load pointer; silent no-op outside harness workspaces), and **PreToolUse (Bash)** adds a deterministic git gate backing `mstar-branch-worktree` — blocks direct commits on the default protected branch (`MSTAR_ALLOW_DEFAULT_BRANCH_COMMIT=1` escape) and bare `git push --force` (`--force-with-lease` required; `MSTAR_BRANCH_GUARD=off` disables the hook).
- Documented the icon + hooks behavior in `INSTALL.md` (ZCode sections) and `mstar-host` → `references/zcode.md`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.7.0**.

## [3.6.3] - 2026-09-06

### Harness

- Replaced static synthetic credentials in security tests with locally generated disposable values (random tokens, locally signed JWTs, in-memory RSA and OpenSSH keys), preserving every detection and redaction assertion without requiring an OpenSSH executable. CLI coverage now also asserts a tracked token is found and its value never printed.
- Reworded the placeholder-masking comment in the engine audit source and the mstar-audit prompt-injection rules to state the invariant without quoting attack phrasing; paired before/after classification checks keep the defensive behavior identical.
- Hardened repository contribution readiness: pinned all GitHub Actions to immutable commit SHAs, restricted ordinary CI to read-only permissions without persisted checkout credentials, added weekly GitHub Actions and Bun workspace dependency updates, and published a bilingual security disclosure policy. Release write permissions and push authentication are unchanged.
- Aligned Kimi plugin interface metadata with Kimi Code's supported display fields and added the project website link. Removed unsupported Codex-style capabilities, starter prompts, and visual metadata from the Kimi manifest only; skills, commands, and session-start behavior are unchanged.
- Added an advisory HOL Plugin Security Scan workflow for pull requests, main-branch pushes, and manual runs, with a pinned Action, explicit Cisco skill analysis, an 80-point/high-severity target, and reports preserved on threshold failure. Repository-owned suppressions remain untrusted.
- Included the MIT license and a link to the shared security disclosure policy in the dsh package distribution.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.6.3**.

## [3.6.2] - 2026-09-05

### Harness

- Added a **`collectFolded` seat-prompt option** to `prReviewSeatPrompt` (Stage-2 only; a Stage 1 seat combined with it throws): one fold bullet after the `## Budget` block tells a deep-tier domain seat to do its own collection — pinned diff pack first, then in-domain changed files, within the budget block; reachable from the CLI via the new `mstar pr-review seat-prompt --collect-folded` flag (engine guards surface as command errors).
- Deep PR review now runs **two waves by default when the pinned diff pack exists** — the Stage 1 collect wave folds into the Stage 2 domain seats (`collectFolded`), and the collect wave is kept only in the exceptions (no `diffFile` snapshot, PM judgment), declared in the report `- notes:` as `collect wave folded (pack)` / `collect wave kept (no pack / PM judgment: <reason>)`; the independent cross-domain security seat is never folded.
- Tightened **pack-first bounded seat reads**: seats read the pinned diff pack first, then targeted in-domain opens within `fileOpenCap`, and `deep` fan-out wording stays consistent across the `mstar-audit` prose and the `/amazing-pr-review` command.
- Hardened **`collectFolded` fail-loud guards** (mirroring the Stage-1 contradiction guard): `collectFolded` now requires a pinned diff snapshot (`diffFile`) and is refused on the independent cross-domain security seat (never folded) — both throw `TypeError`; `prReviewSizing.collectSeats` / `mstar pr-review size` docs carry the kept-wave qualifier (collect seats apply only when the deep collect wave is kept), and the deep-tier glosses in `pr-review.md` were reconciled with the fold default.
- PR review synthesis now uses a **tiered three-way vet**: must-fix / should-fix findings get the full attack (counter-example, simpler explanation, evidence verifiability); nits get evidence-verify only (open the cited file, confirm `file:line` supports the claim). Domain seats keep their full three-way attack — tiering applies to the main-agent synthesis pass only.
- Stage 2 domain seats now return a **fixed findings block per finding** in the result payload — field names verbatim from `finding-format.md`, `Merge class` immediately after `Confidence` (lint-enforced), a one-line `Fix sketch` — staying lint-compatible with the single validator (`mstar lint --type finding --pr-variant` → `validateFindingDoc`), and declare truncated coverage in the payload tail when a budget cap stopped expansion.
- The posted review body gains a **soft cap (~150 lines)** triggering degradation ③ of the time-budget ladder: past the cap, nits fold into the summary body (display only — findings are never dropped) and the fold is declared in the report `- notes:`.
- Added an **optional `elapsed` field** to the PR-review report frontmatter: `validatePrReviewReport` accepts a non-negative integer minutes value (absent = valid for legacy reports; malformed = violation), and the `/amazing-pr-review` command records the start time at worktree-setup and writes the measured wall-clock minutes into the frontmatter.
- Added a **PR review time-budget system**: engine constant table `PR_REVIEW_TIER_BUDGETS` (wall-clock target + per-seat caps per tier) is the numeric SSOT, rendered as a budget block in `prReviewSeatPrompt` seat prompts.
- Added a **`mstar pr-review budget`** CLI command printing the per-tier budget table (`quick`/`default`/`deep`) for humans and drift checks.
- Added a **Budget column and a time-budget degradation ladder** (①read-depth ②seat topology ③display, with a never-degrade list) to `mstar-audit` PR-review prose and the `/amazing-pr-review` command.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.6.2**.

## [3.6.1] - 2026-09-03

### Harness

- Removed the INSTALL.md marketplace version anchor and its release tooling: `release:prepare` no longer bumps a quoted `"version"` field in INSTALL.md and `release:validate` no longer requires one — the ZCode marketplace example (and the marketplace catalogs) are version-less; install-time versions come from `.zcode-plugin/plugin.json`. Follow-up to #183/#184: the anchor's only purpose was being bumped by the release tooling, so it was removed together with the tooling instead of restored.
- Converted all 14 repo-root agent shells (`agents/*.md`) to **single-line quoted English `description` frontmatter**. ZCode's flat agent frontmatter parser does not support `|-` block scalars — it parsed the literal string `|-` as the description and silently dropped the nested `tools`/`permission` maps, leaving plugin agent entries with a broken trigger description. Wording is unchanged (the existing English line is reused verbatim); `mode`/`tools`/`permission` are preserved for OpenCode semantics.
- Corrected the ZCode host contract (`mstar-host`): current ZCode **does** register Morning Star role agents (`agents/*.md`) as callable `subagent_type` values — dispatch now prefers the **bare role id** (e.g. `fullstack-dev`), keeps `general-purpose` as the universal fallback, keeps C5b prompt + skill-load binding required because the role shells are thin, and carries its own C5/C5b SSOT (the shared role-binding doc is re-scoped to Kimi-only; `zcode.md` no longer loads it). Documents the ZCode frontmatter constraint (single-line quoted English `description`; `|-` blocks and nested `tools`/`permission` are silently mangled/dropped) and that direct marketplace add works now that the repo ships `.claude-plugin/marketplace.json`.
- Shipped repo-side ZCode marketplace manifests (`.claude-plugin/marketplace.json`, with root `marketplace.json` as fallback) so ZCode's `github`-source marketplace refresh can discover the catalog in-repo — previously refresh failed with `Marketplace manifest not found in GitHub repo`. Plugin entries use the `github` source with no pinned version; install-time versions come from `.zcode-plugin/plugin.json`.
- Aligned the `zcode` adapter: the local marketplace snapshot written by `init` no longer pins a plugin version, and `doctor` accepts version-less plugin entries (a successful ZCode refresh overwrites the snapshot with the repo manifest).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.6.1**.

## [3.6.0] - 2026-09-03

### Harness

- **New `@mstar-harness/omp` npm package**: `omp plugin install @mstar-harness/omp` now works without any local build — the omp hook + six `mstar_*` tools are bundled with the engine **inlined** (zero runtime `@mstar-harness/engine` resolution), fixing `Cannot find package '@mstar-harness/engine'` on third-party installs. Docs (`INSTALL.md`, `README.md`/`README_CN.md`, `mstar-host` omp reference) and the CLI omp adapter now prefer the npm install path; the maintainer `omp plugin link` path is `<repo>/packages/omp` (needs `bun install && bun run engine:build && bun run --cwd packages/omp build` in the checkout).
- **BREAKING (intended)**: repo-root `hooks/` and `tools/` moved into `packages/omp/src/` — the omp hook/tools are now omp-only package surfaces. Anyone relying on repo-root `hooks/pre/mstar-gates.ts` / `tools/mstar_*` paths must use the package (`packages/omp/src/…` sources, `<pkg>/hooks/` + `<pkg>/tools/` in the installed npm tree). The maintainer `omp plugin link` path is now `<repo>/packages/omp` (built) — linking the repo root no longer provides the runtime gates.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.6.0**.

## [3.6.0-alpha.4] - 2026-09-03

### Harness

- **PR review diff snapshot**: `mstar pr-review worktree-setup` now pins the review diff basis to a snapshot file beside the sidecar (`<parent-of-worktree>/.<wt-dirname>.prreview.diff`, printed as `diffFile` in setup output; `null` for `--diff` / `--working-tree` modes) so every Stage 1/2 seat reads one pinned diff instead of re-running git — `mstar pr-review seat-prompt` passes it through as `--diff-file` and the prompt gains a "read the pinned diff snapshot FIRST" ingredient; cleanup removes the snapshot with the sidecar, and snapshot capture is wrapped in the worktree rollback so a failed setup never orphans a worktree.
- **Worktree convention + ownership**: review worktrees now default under `<repoRoot>/.worktrees/review-…` (the `mstar-branch-worktree` convention; `.worktrees/` is added to `.git/info/exclude` when the target repo does not ignore it) instead of a sibling directory beside the repo, and `worktree-cleanup` only deletes files whose identity (dev/ino/mtime, link count) matches the snapshot recorded at setup — a replaced or foreign file at the snapshot path is left in place, and a pre-existing sidecar makes setup refuse with a `worktree-cleanup` hint instead of deleting it.
- Slimmed the `amazing-pr-review` command to a thin launcher: all procedure contracts now live in `mstar-audit/references/pr-review.md` (tier ladder, three-stage pipeline, worktree isolation, posting, report archive, batch), removing duplicated rule text from the command body.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.6.0-alpha.4**.

## [3.6.0-alpha.3] - 2026-08-31

### CLI

- Codex installs now use a repo-bundled marketplace: the harness repo ships `.agents/plugins/marketplace.json` (name `mstar-repo`, plugin root = repo root), and `npx @mstar-harness/cli init --target codex` registers it via `codex plugin marketplace add btspoony/mstar-harness --ref main`. Install with `codex plugin add morning-star-harness@mstar-repo`; refresh snapshots with `codex plugin marketplace upgrade`. `doctor --target codex` validates the marketplace registration via the codex CLI and reports legacy `personal` marketplace entries as a migration note; Codex custom-agent `.toml` symlinks continue to come from the shared `~/.mstar/harness` checkout.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.6.0-alpha.3**.

## [3.6.0-alpha.2] - 2026-08-31

### Harness

- Fixed **iteration-close (Phase 3) commit anchor**: the §3.5 close commit is now **branch-anchored and fail-closed** — before any `git add`, PM must verify `git branch --show-current` equals `spec_integration_branch` (from snapshot `branch.integration` / compass); on mismatch STOP and redo tracked writes (`knowledge/`, `specs/`, `CONCEPTS.md`) on the integration checkout, instead of committing compound products onto the control branch (`main`). Engine `iteration gate` branch probes (`--branch` / `--integration` / `--target`) wired into the §3.5 pre-commit verification.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.6.0-alpha.2**.

## [3.6.0-alpha.1] - 2026-08-31

### Harness

- `mstar-harness-core` now carries a "核心研发守则" (core engineering rules) section: seven global engineering invariants — no backward-compatibility layers (remove obsolete paths), simplest implementation over speculative abstraction/configuration/indirection, grow the system in layers on top of a working product, modular components with separated concerns, prefer established well-maintained libraries, lean on existing project dependencies before adding packages, and make architectural decisions for the long term (no intended-to-be-replaced stopgaps). Injected into the mandatory entry skill so every role loads them; operational detail remains in `mstar-coding-behavior`, whose Simplicity First section now links up to these invariants to keep the two layers drift-free.
- Rules provenance recorded in `ATTRIBUTION.md` (source: a post by Marcos Hernanz on X).
- Prerelease versions (`X.Y.Z-suffix`, e.g. `3.6.0-alpha.1`) now flow through `release:prepare` / `release:validate` / publish: npm publishes under the dist-tag `alpha` (never `latest`), the GitHub Release is flagged prerelease, and the INSTALL.md marketplace example stays on the last stable release.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.6.0-alpha.1**.

## [3.5.1] - 2026-08-28

### Harness

- Fixed git/hosted installs (`omp plugin install github:btspoony/mstar-harness`, `bun add github:…`) failing at dependency resolution: the root manifest's `@mstar-harness/engine` dependency used the pack-time-only `workspace:*` protocol, unresolvable outside the monorepo. It is now `^3.5.0`, fetched from npm on hosted installs, while dev checkouts still link the workspace member.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.5.1**.

## [3.5.0] - 2026-08-28

### Harness

- Added a pluggable **ArtifactStore** for JSON coordination docs: `status.json`, workflow snapshots, and project residuals now persist through `ArtifactStore.put` / `get` (default `FsStore` keeps the existing `{HARNESS_DIR}` paths and atomic-write semantics). Integrations can mount their own store in-process via `setArtifactStore` or per-command via `MSTAR_STORE_MODULE` / `--store` — filesystem paths only, URI schemes are rejected before `import()`.
- Added `mstar-harness persist <kind> --key <key> [--file <path>|--stdin] [--store <module>] [--schema <id>]` and `mstar-harness persist get <kind> --key <key> [--store <module>]` for `status` / `snapshot` / `residuals` / `review` / `json`, running the existing kind validators before put.
- `mstar-harness init` now auto-installs the **matching-version** `@mstar-harness/cli` globally after a successful run, so the `mstar-harness` binary lands on PATH for engine-check commands. The install is skipped when the PATH version already matches, is fail-soft on npm errors (init still exits 0), and can be opted out with `--no-global-cli`; `--dry-run` prints the would-run `npm i -g` command without executing it.
- `mstar-harness doctor` now prints a non-fatal CLI-on-PATH note (missing / mismatch / match) for every target.
- mstar-dispatch-gates: role-binding field check now resolves the host column via `mstar-host` §Detect active host tool-shape detection; config paths and repo content are explicitly forbidden as host signals (prevents applying another host's dispatch key, e.g. OpenCode `subagent`, to an omp session whose task tool schema uses `agent`).
- Added a first-class **review JSON kind** (`mstar.review/v1`): `synthesizeReview` folds vetted findings into a validated envelope (verdict/tally from `computePrTally`), `mstar-harness persist review` validates the envelope before put (inspector M1 vocab rejected), and `pr-deep-review` / `amazing-pr-review` Stage 3 must persist the envelope — the Markdown report is the optional human copy.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.5.0**.

## [3.4.1] - 2026-08-27

### Harness

- **Anti-recursion precheck re-scoped to CALLER semantics (fixes #156)**: `composeDispatchGate` no longer feeds the host role-binding field into `antiRecursionPrecheck` as if it were the dispatching agent — on omp/OpenCode/Cursor that field (`agent` / `subagent` / `subagent_type`) carries the spawn TARGET, and target == `Execute as` is the documented compliant C5 dispatch pattern, so under `Enforcement: hard` every correct dispatch hard-blocked on `dispatch.anti-recursion.self-type`, while omitting the field hard-blocked on `dispatch.anti-recursion.empty-binding` (no spec-compliant binding existed). The composition now takes `caller` (the dispatching agent's OWN role) + `callerRequired`; the precheck runs only when a caller binding exists, and fails closed on an empty one only where the host contract mandates the binding (dsh). The `agent` option is removed — migrate callers to `caller`.
- **omp plugin**: Gate 2 (task dispatch) no longer runs the anti-recursion leg (omp's `tool_call` event carries no caller identity; the NEVER red line stays prompt-level via `mstar-dispatch-gates`), so the documented `agent: "<Execute as role-id>"` pattern passes under hard. The dispatch gate now ALSO honors the repo-level `.mstarc` / compass `enforcement: hard` (previously header-flag-only — a hard compass left Gate 2 unhardened, diverging from Gate 1 and dsh `resolveDispatchHard`), and soft-mode dispatch violations are warn-logged through the extension logger instead of silently dropped (opencode parity; the silent drop is why the #156 pincer stayed latent for five iterations).
- **OpenCode surface**: `validateDispatchAssignment` drops the `subagentType` plumbing (the spawn target is not an anti-recursion signal) and composes the repo-level `.mstarc`/compass hard setting below the Assignment header flag, matching the status-write gate and dsh. Compliant dispatches no longer warn `self-type` / `empty-binding`; a hard repo now escalates flag-less dispatch violations to error-level + `hardBlocked`.
- **dsh surface**: `dispatchGateCore` passes `caller: config.dispatchBinding ?? ''` with `callerRequired: true` — behavior unchanged (self-recursion critical; unset binding fails closed under hard). `mstar_dispatch_validate`'s `agent` param is now `caller` (the DISPATCHING agent's own role; omit when unknown).
- **Docs**: `mstar-dispatch-gates` records the caller-vs-target engine scope; `mstar-host/references/omp.md` gains the Gate 2 anti-recursion scope note; stale dsh `dispatchBinding` "precheck skipped" rows corrected to the fail-closed contract.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.4.1**.

## [3.4.0] - 2026-08-27

### Harness

- Renamed `/pr-deep-review` → `/amazing-pr-review` with a clean cutover (no alias) and added three review strengths: `quick` (single-pass, 1 seat, collect + review in one pass) / `default` (the no-flag landing tier — 2 domain seats, collection folded in, reduced seats) / `deep` (the former full three-stage pipeline: collect → domain review → main-agent synthesis, 4–7 seats). The tier is chosen by an explicit keyword or inferred from the change shape; the default tier no longer fans out the full seat plan.
- Deterministic static checks from the audit security review are now mechanical engine code with CLI entry points: `mstar audit secret-scan [path]` walks git-tracked files read-only through `scanSecrets` and prints `{file, line, type}` findings (never values), exiting 1 on any hit; patterns cover provider key shapes (AKIA/ASIA, sk-ant-, ghp_/github_pat_, sk_live_, sk-, xox[baprs]-, JWT, private-key blocks), never-commit filenames (`.env*`, `*.pem`, `*.key`, `id_rsa`, credentials/service-account JSON, git-credentials), CI/IaC leak shapes (Actions plaintext `env:` map entries and same-line assignments, Docker `ENV`/`ARG`, Terraform `password =`), while safe placeholders (`${ENV_VAR}`, `process.env.X`) are excluded. `mstar audit supply-chain [path]` runs `supplyChainChecks`: lockfile-missing / lockfile-duplicate across the known lockfile set, `action-unpinned` (`@main`/`@latest`, trailing-comment tolerant, SHA pins clean), and `pull_request_target-head` PR-head checkout; reachability triage stays with the reviewer.
- Credential patterns now have a single source of truth: `WHOLE_MATCH_PATTERNS` / `VALUE_PATTERNS` in `packages/engine/src/audit.ts` back both `redactSecrets` and `scanSecrets`, reconciling the engine-vs-prose drift — the engine table gained fine-grained GitHub PATs (`github_pat_`) and Stripe live keys (`sk_live_`). `scaffoldAuditPlan` wires `redactSecrets` over finding evidence/description so scaffolded plans honor the redaction promise, and `security-review.md` §6 collapses its duplicated pattern list to an engine-check pointer at `mstar audit secret-scan`, keeping only discipline prose.
- Programmatic deferred-PR backlog registration: `mstar status backlog-register` / `mstar status backlog-close` replace the hand-rolled python lock protocol in `skills/mstar-audit/references/pr-review.md`. The engine `appendProjectRegisterEntries` / `closeProjectRegisterEntry` run inside `withStatusWriteLock` with atomic temp+rename writes (crash-safe, fail-loud validation); same-day key bump (`-2`, `-3`, …) and entry-id uniqueness are enforced inside the lock (B-9).
- **Role references:** Add a shared coding-philosophy line to dev-role Role Missions (`fullstack-dev`, `fullstack-dev-2`, `frontend-dev`): "YAGNI is your coding philosophy; PDCA is your behavioral discipline."
- **Role references:** Unify executor Role Mission phrasing to the second-person "You are …" convention (`qa-engineer`, `prompt-engineer`, `ops-engineer`, `fullstack-dev-shared`); `project-manager` keeps its Identity section as orchestrator exception.
- Added **npm total downloads** badges for `@mstar-harness/cli`, `@mstar-harness/dsh`, and `@mstar-harness/opencode` to the README badge row (before the Last commit badge).
- Reworked `amazing-pr-review` batch semantics to **one session = one PR**: when multiple PRs are passed in, only the **first** runs the full three-stage deep review; the rest are registered as audit todos in `{PROJECT_DIR}/_default/residuals.json` (`decision: defer`, `target: next session`, `tracking: pr-deep-review backlog`) and the report suggests opening one session per remaining PR. The old four-seat N/4 batch fan-out is removed.
- Reworked single-PR deep review into a **three-stage pipeline** (collect → domain review → synthesis): lightweight read-only collect seats fan out by domain, mstar built-in roles review code + security per domain, and the main agent dedupes, three-way vets, and publishes the single GitHub Review. Posting ownership moved to the main agent — review seats never post. Fan-out is scale-driven, reusing the existing ~300-line sizing band.
- Synced the **three-stage pipeline** and **one session = one PR** semantics across skill core, roles, and user-facing docs: `mstar-audit` SKILL.md (`pr` variant dispatch + Hard Rule 2), `mstar-roles` shared Audit Mode and `code-reviewer.md` Mode C (every seat — collect or domain — returns evidence / findings in its result payload: any seat may be write-blocked, and the main agent writes / consolidates the evidence files; seats produce no verdict, never post), and README.md / README_CN.md / docs/cli.md. Posting ownership is unified on the **main agent** across all surfaces — review seats never post.
- PR-review deterministic arithmetic and naming contracts moved from LLM hand-computation into tested engine code, exposed as the new `mstar pr-review` command group: `tally` (locked-formula tally/verdict/score + verbatim two-line chat header from accepted findings JSON), `report-path` (local-report/evidence filename resolver with same-day `-r2`/`-r3` collision escalation and never-fabricated SHAs), and `validate-report` (saved-report frontmatter validation: verdict-from-tally, score recompute, comments tri-state). `mstar-audit/references/pr-review.md` § Tally / § Local report archive naming / § Output shape now carry engine-check callouts pointing at these commands.
- PR-review external side effects became tested engine code behind new `mstar pr-review` commands: `post` (builds the GitHub Review plan via `planReviewPost` — owner/repo parsed from the PR url only, never `headRepository`; `event` locked to the literal `COMMENT`; `commit_id = headRefOid`; at-most-once 422 fallback folding exactly the rejected inline comments into the body), `worktree-setup` / `worktree-cleanup` (collision-free branch naming via `pickReviewBranchName`, explicit-refspec fetches, `preflightChangeset` gates where untracked-only changesets count, sidecar-guarded cleanup that removes the tree, prunes and deletes exactly the recorded review branch behind the report-saved gate), `size` (`prReviewSizing` ~100/~300/~1000 bands + Stage-1 seat plan, split advice, file-size watch) and `seat-prompt` (`prReviewSeatPrompt` skeletons: Hard Rules 4/5 verbatim, payload-return contract, no-verdict/no-post clauses, `<domain>-<seat>` slugs). Finding docs gained a programmatic hook: `mstar lint --type finding` backed by `validateFindingDoc` (`### [CATEGORY-NN]` numbering, category/effort/risk/confidence enums, evidence `path:line` shape; Merge-class presence/enum/placement with `--pr-variant`).
- Drop the root `postinstall` hook (`opencode:bundle-assets` && `dsh:bundle-assets`) flagged by static security scanning as an install-time code-execution surface ([high] R10). Asset mirrors are now synced only when explicitly running `bun run <pkg>:bundle-assets` or via each package's build/prepublish chain.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.4.0**.

## [3.3.0] - 2026-08-25

### Harness

- `mstar-audit` review-process hardening: `pr-review.md` gains **input modes** for uncommitted working-tree and single-commit reviews, **sizing bands** with change-shape **escalation** (schema/API/framework/performance/security surfaces), **originating-spec discovery** (score every acceptance criterion against the diff), a **standards precedence** and twelve-smell **baseline** with binding rules, **presumptive-structural** merge classes, and a matter-of-fact tone contract; `audit-playbook.md` gains **Chesterton's Fence** / over-simplification guards and **dependency add/upgrade discipline**; `codebase-audit.md` requires **behavior-preservation gates** on simplification plans; `finding-format.md` gains **remedy-named** Fix sketches (structural remedies).
- Added **`mstar harness scaffold [path]`** (default cwd): one-shot harness bootstrap — engine `scaffoldHarness` now also prebuilds `projects/_default/` (`roadmap.md` with valid `validateRoadmap` frontmatter + `## Direction` placeholder, and an empty `residuals.json` passing `validateProjectRegister`); the CLI appends the canonical `.gitignore` snippet when absent, writes a minimal `.mstar/AGENTS.md` when absent, and prints a created/skipped summary. Idempotent — re-running on an initialized tree only creates missing pieces.
- `mstar harness scaffold` is now `.mstarc`-aware: it scaffolds into the `.mstarc`-declared `harness_dir` (or the `MSTAR_HARNESS_DIR` override), lands `projects/_default/` under the resolved `project_dir`, and prints the resolved harness/project dirs. The canonical `.gitignore` snippet is appended only for the default `.mstar/` layout — custom harness layouts skip it. The fence now splices `.mstar/**` BEFORE existing `!.mstar/…` re-includes when the broad rule is missing (gitignore last-match-wins), keeping the re-includes effective.
- `mstar path resolve` failure guidance now points to `mstar harness scaffold` instead of `mstar init`.
- `mstar-audit`: new `references/security-review.md` deep-dive for the Security category — exploitability bar (concrete attack scenarios), attacker-vs-server-controlled input triage, framework-mitigated false-positive tables, cross-file data-flow sweep, hunting angles, and expanded surfaces (auth/session, business logic, client-side, AI/LLM, supply chain/CI-CD, infra configs, privacy retention). Playbook §2 rewired to point at it; audit index template gains **Needs verification** and **Hardening & checked notes** sections so every security disposition has a defined landing place; third-party provenance consolidated in root `ATTRIBUTION.md` (skill files stay link-free).
- `mstar-roles` role references are now **identity-first**: mission, scope, and NEVER rules lead each leaf role file; topic `mstar-*` skills moved from top-of-file "Required Skill Dependencies" into a trailing **Skill Preset (PM-Activated)** section. Skills are presets the PM controls via a new canonical Assignment `Skill presets:` field — omitted on an implementation / QC / QA round defaults to the role's `standard` preset; explicit `none` (or a trivial route) runs identity-only without topic skills. QC/QA role-owned procedure files (`references/qc-specialist/*`, `acceptance-gate.md`) are never preset-gated. `project-manager` keeps its required-reading list unchanged as core orchestrator.
- **dsh plugin**: the fallbacks seed mandatory-load line now matches the preset model — `Load mstar-roles (references/<role-id>.md) first — identity comes before skills; load topic skills only when the Assignment activates them via its Skill presets field.` (mirrored in `tests/fallbacks-seeds.spec.ts` and both READMEs; pairing hashes re-recorded).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.3.0**.

## [3.2.6] - 2026-08-24

### Harness

- **PR deep-review report template hardening**: the `Considered & rejected` placeholder no longer embeds the bullet dash inside angle brackets (a posted review rendered literal `<finding>` wrappers verbatim); rejected entries now use `- **<short title>**: rejected — <reason>` with an explicit "never render brackets" rule stated at the template top; empty Plan-to-fix sections collapse to a bare `none` instead of prose.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.2.6**.

## [3.2.5] - 2026-08-24

### Harness

- **PR deep-review lists every finding by default**: the `[full]` flag is removed from `/pr-deep-review` — complete findings (all merge classes, nits included) are now always listed in the chat output and GitHub Review; nothing is truncated. README command signature updated.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.2.5**.

## [3.2.4] - 2026-08-24

### Harness

- **PR deep-review local report archive**: each `pr`-variant review now saves a durable markdown report under `{PROJECT_DIR}/<project-id>/reports/pr-review/` (`_default` when project-less) — YAML frontmatter metadata (PR, head SHA, verdict, score, tally, review URL) plus the posted GitHub Review body verbatim; bare branch/diff reviews archive the chat display instead. Written via the primary checkout (never inside the review worktree), saved before worktree cleanup regardless of POST outcome; new `- report:` field in the Completion Report output shape.
- **Docs describe current state only**: removed truly retired-path prose from runtime skills — `{PLAN_DIR}/reports/` (legacy report location; no code or migration path references it) and the retired `{HARNESS_DIR}/notes.json` (no code creates or reads it; runtime notes live in `workflows/<id>/notes.jsonl`). Compat behaviors verified against shipped code and kept: `designs/` read-only `{SPECS_DIR}` fallback (`resolveSpecsDir`), legacy flat delivery-compass read/migrate directives, `.agents/` discovery chain, and all v1→v2 migration guards.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.2.4**.

## [3.2.3] - 2026-08-24

### Harness

- **PR deep-review report template**: the GitHub Review body now follows a fixed three-section report — Verdict (verdict token + confidence score + four-class emoji findings table), Review (PR summary, ranked findings with merge class, linked-issue AC, verified checks, considered & rejected), and a collapsible **Plan to fix** section holding the fix plan in a fenced ```md block. Chat display contract unchanged.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.2.3**.

## [3.2.2] - 2026-08-24

### Harness

- Dropped the root changelog **Published harness surfaces** version table. Every published surface already ships the same version, so the header table and the release-prep step that rewrote it are gone. Per-release `### Version alignment` blocks are unchanged.
- **`mstar-harness-core` guardrail is now host-neutral**: "do not modify `opencode.json`, credentials, or `secrets.env` without user consent" → "do not modify host config files and user credentials without user consent" — the shared skill no longer names a single host's config file.
- `/pr-deep-review` now emits a merge signal computed from the finding tally: the middle verdict token is renamed `needs review` → `needs fixes`, each accepted PR finding carries a `Merge class` (`must-fix` | `should-fix` | `nit`), and the output shape gains `- score_pct:` (derived, `max(0, 100 - 40*must_fix - 15*should_fix - 3*nit - 10*unverified)`, floor 0) and `- tally:` with four counts. The verdict is derived from the tally (`must-fix ≥ 1` → `blocked`, else `should-fix ≥ 1` → `needs fixes`, else `ship it`); leftover linked-issue `unmet` ACs increment `should_fix` (or `must_fix` when unsafe-to-ship) before that mapping and are not extra findings. `score_pct` is display-only and never overrides it. Chat and the GitHub Review `body` open with `{verdict} · {score_pct}%` plus the tally line; `event` remains `COMMENT`. The list cut now applies to nits only — every `must-fix` / `should-fix` is listed. Formula and rules are SSOT'd in `skills/mstar-audit/references/pr-review.md` § Verdict synthesis / Tally and derived score.
- **Release prep** now opens a **new** `release vX.Y.Z` PR when the previous one for that branch is closed or merged. It no longer treats `gh pr view` success on a closed PR as “update in place” (that left #131 closed and no new 3.2.2 PR).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.2.2**.

## [3.2.1] - 2026-08-24

### Harness

- `/pr-deep-review` now **requires** posting a GitHub Review when a PR number exists: the `pr` variant always leaves `COMMENT`-event comments on the PR (inline comments on diff-line findings, summary body folds any already-written follow-up plans into a `<details>` section), and the output shape gains a `- comments:` field with the review URL. Posting procedure is SSOT'd in `skills/mstar-audit/references/pr-review.md` § Comment posting; `mstar-audit` Hard Rule 2 and the Audit-Mode contract now carve out only this required GitHub Review POST (Git stays read-only, no commits). `code-reviewer` gains Mode C (PR review) loading `pr-review.md`. `commands/pr-deep-review.md` drops the "optional / separate explicit step" wording. Chat-only verdict is no longer complete for PR seats.
- README Use section regrouped into three entry shapes: **General (without iteration)**, **Iteration**, and **Audit & review** — the third groups `/codebase-audit` and `/pr-deep-review` into one table under one heading, with a shared read-only advisory intro naming both `mstar-audit` variants (both were previously parallel top-level sections; per-row SSOT tails folded into the intro). Bilingual counterpart applied (README.md / README_CN.md).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.2.1**.

## [3.2.0] - 2026-08-23

### Harness

- Hoisted the shared plan-output contract out of `references/codebase-audit.md` into the `mstar-audit` SKILL.md core as **`## Plan output (all variants)`**: write-only-on-selection boundary, `{PLAN_DIR}/audit-<date>/` layout (README index + numbered plan files), `plan.main.md` + plan-quality-bar enrichment, Status-block fields + status values, `git rev-parse --short HEAD` commit stamp, and the four handoff steps (promote / state machine / fast-track Prepare / SDD or inline dispatch). Both variants (`codebase-audit`, `pr-review`) and both commands (`/codebase-audit`, `/pr-deep-review`) now cite the core section; `pr-review.md` § Plan output carries no `codebase-audit.md` cites. Engine audit Status-block and scaffold validators repoint their spec cites to `mstar-audit SKILL.md § Plan output`, and `pr-review.md` § Evidence rules now cites `finding-format.md` § What disqualifies a finding. Closes residual R1 (hoist when a third variant arrives — that condition is now met by the `pr` variant) early.
- Restructured `mstar-audit` into a **variant carrier**: SKILL.md now holds the common core (hard rules, recon, attack-and-vet discipline, variant dispatch table, output-format contract), with full codebase-audit detail moved verbatim to `references/codebase-audit.md` (Phase 2 category fan-out + subagent-prompt requirements, effort table, scope variants, Phase 4 plan writing, audit index / plan-file output templates, `mstar audit scaffold` callout, handoff to execution). `pr-deep-review` no longer loads full-audit-only content; pointer surfaces (`references/pr-review.md`, both commands, `code-reviewer` role, `mstar-harness-core` index) cite the common core + the correct variant reference.
- Added a **generic deep PR review** command (`pr-deep-review`) + `mstar-audit` `pr` scope variant: worktree-isolated, evidence-first, verdict-producing review with concern lenses, linked-issue hygiene, and batch sibling-PR support.
- Renamed `mstar-plan-conventions` → **`mstar-conventions`** and `mstar-plan-artifacts` → **`mstar-artifacts`**: the two skills are general harness conventions (paths, artifacts), not plan-specific, so the `plan-` prefix was dropped. All live surfaces swept (`skills/**` load orders, index rows and cross-cites, `commands/**`, `AGENTS.md`, `README.md` + `README_CN.md` skill tables, `docs/cli.md`, `.cursor/` routing-eval fixtures + local validation, `scripts/` guards, engine/dsh/cli source comments and path literals, dsh test expectations). Historical changelogs and engine test-fixture prose are untouched — old names there are correct as historical record.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.2.0**.

## [3.1.3] - 2026-08-23

### Harness

- **`mstar audit promote` (CLI)**: selected audit plans can now enter the v2 workflow lifecycle as `type: plan` — `promoteAuditPlans` writes the workflow snapshot (`{HARNESS_DIR}/workflows/<id>/snapshot.json`, one Todo `PlanRow` per selected plan, `id` + `title` + `file`) **before** registering the workflow in root `status.json`, so the snapshot-before-register invariant holds. `--plans` accepts the README Plan column id, stem, or basename; `--workflow` defaults to the `audit-<date>` dir basename; `--harness` defaults to the resolved `{HARNESS_DIR}`. Promote stays an explicit post-selection action — the audit itself never registers (advisory contract preserved).
- **Engine**: `promoteAuditPlans` exported from `@mstar-harness/engine` (titles come from the audit README index, falling back to `readPlanFileSummary`).
- **Harness skills**: `mstar-audit` Handoff step 1 now names `mstar audit promote <audit-dir> --plans <ids>` as the first-class v2 path (manual `mstar-plan-artifacts` wording kept as fallback).
- **Unified the three CLI `execFileSync` wrappers** into a single `runCliCommand` helper (`packages/cli/src/exec.ts`): `runCommand` (shared-install), `runOmp` (omp), and `runDsh` (dsh) are now thin calls with today's defaults — no public signature or behavior change. Timeout / env / dry-run can no longer drift independently across the wrappers; `runDsh` keeps its `env: process.env` + `timeout` contract (dsh PATH injection in tests).
- **Engine git env-pin regression test (test-only)**: `packages/engine/test/exec-env.test.ts` now detects any git `execFileSync` call whose options carry an empty env (`env: {}` / `env: { PATH: "" }`) across `path.ts` / `sdd.ts` / `worktree.ts` — production env handling is untouched.
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.1-rc.2` line (`^0.1.1-rc.2`; `@deepseek-ai/cordis` stays `^4.0.1`; `dsh-llm-fallbacks` stays `^0.3.0` — its 0.3.3 peers are `^0.1.1-rc.1`, satisfied by the rc.2 line). Verified against the `0.1.1-rc.1 → 0.1.1-rc.2` diff (deepseek-harness @ `b150a55`): the change is the unified image/Files request pipeline plus the permission-preset copy-and-default revert — the plugin consumes none of those surfaces (no image region reads, no attachment request payloads, no permission-preset default-copy helpers; the only `preset`/`permission` references are the `dsh-llm-fallbacks` role-seed registry and a dsh-core `/permission` command precedent), so zero adapter-code changes. Lock re-resolved to a single `0.1.1-rc.2` line — zero `0.1.1-rc.1` (and older) copies anywhere, no `dsh-client-web-react` holdover.
- **Engine public surface**: `redactSecrets` is no longer re-exported from the `@mstar-harness/engine` barrel (breaking for downstream imports of the bare package); the audit-module utility is now reachable via the new `@mstar-harness/engine/src/audit` subpath, and the `RedactResult` / `SecretFinding` types stay in the barrel. Barrel importers must migrate to the subpath.
- **dsh**: the audit seam (`packages/dsh/src/gates/seams.ts`) now imports `redactSecrets` from the `./src/audit` subpath instead of the barrel.
- **Thinned the iteration slash commands** (`/iteration-start`, `/iteration-drive`, `/iteration-loop`) into wrappers: shared PM invariants, session todos, the continuous-execution STOP list, and the assignment-preflight bash (warn-only + `enforcement: hard` fail-fast) now live once in `skills/mstar-iteration/references/command-shared-invariants.md`, and `mstar-iteration` points at it. Frontmatter (`name` / `description` / `agent` / `input`) and each command's unique bits (start grill-me, drive helper discovery, loop do-not-load-grill-me) are unchanged.
- **Trigger-strong `mstar-iteration` description**: the skill now loads for "start an iteration" / "drive the iteration" / "run an autonomous loop" even when no `/iteration-*` slash command fires; phase labels no longer treat command names as phase names.
- **Skill pointer + callout hygiene**: `mstar-audit` Handoff step 1 now registers the workflow + plan rows in `{WORKFLOW_DIR}/<id>/snapshot.json` (root `status.json` v2 holds the workflows registry only); the plan-conventions R# sentence names `{PROJECT_DIR}/<id>/residuals.json` as the open-state SSOT.
- **Load-condition fix**: `mstar-design-md` is now an **on-demand** skill (UI / design-token plans only) in the `architect` and `product-manager` role references; `mstar-compound-refresh` no longer claims STRATEGY.md creation (delegated to `mstar-strategy`).
- **Callout-dedup guard**: `scripts/drift-lint.ts` gains `checkCalloutDuplication` — normalized (whitespace + bilingual-variant) Engine-check callout bodies now fail when duplicated across files; lease (`mstar-plan-artifacts`) and review-seats (`mstar-review-qc`) callouts are canonical with one-line pointers elsewhere.
- **Shared anti-recursion NEVER**: the five conceptual anti-recursion bullets now live once in `_shared/leaf-executor-core.md` with role-specific pointers kept in each role reference.
- **Strategy thin**: `mstar-strategy` create/maintain prose is replaced by a pointer to `project-knowledge-bootstrap.md` Phase 2 (six-section table + engine check retained).
- **Knowledge usage gate**: harness entry, iteration §1.1, `iteration-start` Research, phase-gates implement, and `knowledge-and-designs.md` now discover `{KNOWLEDGE_DIR}/README.md` by default — implementers scan the index and read relevant Active rows even when `plans[].metadata` has no knowledge link (registered metadata links stay mandatory).
- No `audit promote` CLI is added (a separate promote plan owns it).
- **audit-004 validator CLI surface closure verification**: the five validator commands (`mstar status tech-debt`, `mstar status findings-cleanup <plan-id>`, `mstar lease verify-integration`, `mstar worktree qc-alignment`, `mstar host skill-root`) were smoke-verified runnable against the repo fixtures from the dist build (`node packages/cli/dist/mstar-harness.js`), each exiting per its documented semantics; no command code changed. Residual `20260816-audit-004-validator-cli-surface` moves to in-place `lifecycle: resolved` with the smoke evidence referenced.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.1.3**.

## [3.1.2] - 2026-08-21

### Harness

- **Anti-recursion fails closed on an empty host binding**: `dispatch.antiRecursionPrecheck` now returns a **critical** `dispatch.anti-recursion.empty-binding` violation when the host role-binding field (`omp task entry agent` / opencode `subagent` / cursor `subagent_type` / dsh `dispatchBinding`) is empty, omitted, or whitespace-only — the host cannot prove the dispatching agent is not recursing, so the dispatch must not proceed as if the NEVER red line held. `composeDispatchGate` no longer skips the precheck for empty bindings (the `if (agent !== "")` skip is removed); the precheck is the single decision point and runs for every Assignment-shaped text, including read-only (scout/explore) Assignments (no carve-out). A set binding equal to `Execute as` keeps the existing critical `dispatch.anti-recursion.self-type`; a set binding with an empty `Execute as` stays ok on the anti-recursion leg (field presence remains `validateAssignmentFields`' job).
- **OpenCode surface**: `validateDispatchAssignment` (via `composeDispatchGate`) now warns `dispatch.anti-recursion.empty-binding` at critical severity when the task tool carries no `subagent` / `subagent_type` key; under the Assignment's own `**Enforcement**: hard` the empty binding hard-blocks (`hardBlocked: true`). No `src` change — the hook already flows the default `""` binding through the engine composition.
- **dsh surface**: `dispatchGateCore` passes `config.dispatchBinding ?? ''` into the engine composition, so an unset binding now emits `dispatch.anti-recursion.empty-binding` (critical) on every Assignment-shaped dispatch — advisory in warn mode, `PreToolDecision { kind: 'deny' }` under hard. The boot-time warn string no longer claims the precheck is "skipped": an unset `dispatchBinding` under hard enforcement now fails closed until the binding is set. The Zod `dispatchBinding` schema is untouched.
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.1-rc.1` line (`^0.1.1-rc.1`; `@deepseek-ai/cordis` stays `^4.0.1`; `dsh-llm-fallbacks` re-aligned `^0.2.0` → `^0.3.0` so its peers land on `^0.1.1-rc.1`). Verified against the `0.1.0-rc.8 → 0.1.1-rc.1` diff (deepseek-harness @ `528c682e06`): every consumed server-side package changed docs/package.json only, client-side consumed surface changed additively, and the `__ModuleLoader__` handoff survives — zero adapter-code changes. No checklist seam (credentials records, pi-ai auth, index-inject, session-projection) is consumed. Lock re-resolved to a single `0.1.1-rc.1` line — zero `0.1.0-rc.8` copies anywhere, and the `dsh-client-web-react` rc.7 holdover is eliminated (fallbacks 0.3.3 dropped that peer); `@oh-my-pi/*` / `@bufbuild/protobuf` resolutions are unchanged from the previous lock. No previously blocked mstar-dsh goals were unblocked by this line.
- **Plan-Writing Path Gate closes the symlink-escape gap**: `assertPlanWritingPath` now compares the canonical path of an **existing** plan file against the canonical `{PLAN_DIR}` (the plans dir itself may legitimately be a symlink). A plan path that lexically sits under `{PLAN_DIR}` but `realpath`s outside it now returns a **high** `plan-path.symlink-escape` violation instead of `plan-path.ok`; internal aliases (`plans/alias.md` → `plans/real.md`) and whole-dir `plans/` symlink layouts still pass. Missing files (first write) stay lexical-only, and unexpected fs errors (EACCES etc.) degrade to the lexical verdict — the gate never throws. `plan-path.outside-plan-dir` and `plan-path.no-harness` semantics are unchanged.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.1.2**.

## [3.1.1] - 2026-08-20

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.1.1**.

## [3.1.0] - 2026-08-20

### Harness

- **Agent-flow ledger tail read**: `readAgentFlow` now reads large ledgers (above the 64 KiB read gate) as a bounded latest-first tail — seek from EOF, align the window start to a line boundary, and double the window backward until it holds `limit` complete lines — so the catalog pays O(window) at the byte layer instead of parsing every historical line. Small ledgers keep the existing full-read path verbatim; both paths feed the same parse funnel, so tail/full parity is structural. Write path (append + 500-line truncation under the per-workflow lock) is untouched.
- **Project-scoped research corpus**: theme research (surveys, epic roadmaps, third-party notes) now lives under `{PROJECT_DIR}/<id>/references/` — named as current by `mstar-project-governance` (Scope table), `artifact-storage-paths.md` (new path-SSOT row), and `knowledge-and-designs.md` (boundary: research ≠ specs ≠ knowledge ≠ iteration guides).
- **Engine filename listing**: `PROJECT_REFERENCES_DIR` + `listProjectReferenceFiles(projectDir)` in `packages/engine/src/project.ts` — sorted relative paths (root files + one-level subdirectory files; skips `roadmap.md` / `residuals.json` strays; missing dir → `[]`); directory metadata only, never file bodies, never a markdown schema.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.1.0**.

## [3.0.1] - 2026-08-20

### Harness

- **CI runs dsh test + typecheck again**: the link-farm era `dsh:link` call and the source-tree availability gate (`DSH_SOURCE_DIR` / `~/.dsh/source/current`) are gone — the rc.8 seam packages resolve from the public npm registry, so the dsh suite runs unconditionally in CI. The install e2e specs keep their self-skip when no `dsh` bin is on PATH. Test fixtures updated for the v3.0.0 `MstarHarnessState.project` field (5 sites across 4 specs), which had left `typecheck:tests` red on main.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.0.1**.

## [3.0.0] - 2026-08-20

### Harness

- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.8` line (`^0.1.0-rc.8`; `@deepseek-ai/cordis` stays `^4.0.1`). Local rc.7→rc.8 source review of consumed seams found no adapter-code break: the only consumed-surface change is `dsh-commands` `CommandRuntime.execute` gaining a required `images` argument (plugin registrations unaffected; test call sites updated) and an additive `CommandInvocation.attachments` field. Lock freshly resolved to a single rc.8 hoist (`dsh-client-web-react` stays at rc.7 — the latest published); `dsh-llm-fallbacks` moved 0.2.0 → 0.2.2 with the 9-key service-surface drift STOP gate updated in kind.
- Harness dir is uniformly `.mstar/` across the repo: maintenance docs moved under `.mstar/docs/`, the legacy maintenance root is gone, and probe/override docs no longer reference a legacy root name. `harnessDir` / `MSTAR_HARNESS_DIR` semantics unchanged — explicit override wins; probe order stays `.mstar/` → `.agents/` → `.plans/`/`plans/`.
- `drift-lint` roadmap-citation exemption now recognizes `.mstar/`-prefixed citations (gitignored roadmap/ADR docs); engine/dsh/opencode source citations updated to the new path.
- `.mstarc` now supports every harness directory symbol under `[config]`: `plan_dir`, `sdd_dir` (per-plan base), `iteration_dir`, `knowledge_dir`, `specs_dir` (authoritative — skips the candidate chain) alongside `harness_dir`. The engine resolvers (`resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir`) honor them from the nearest `.mstarc` at the harness dir or its parent; `mstar_path_resolve` reports the knowledge dir too.
- `.mstarc` `[config] enforcement=hard|soft` declares the repo hard-gate policy (invalid values ignored). Precedence: explicit Config > Assignment `Enforcement: hard` header flag (dispatch only) > `.mstarc` > iteration compass > warn-only — `.mstarc` `soft` is a local rollback against a hard compass, `hard` hardens flag-less dispatches and gates. New engine `resolveMstarcEnforcement` / `resolveRepoEnforcement`; dsh gates, opencode hook and omp hook now compose the repo policy.
- New gitignored repo-local config **`.mstarc`** (`[config] harness_dir=<dir>`) lets repos with a non-default harness root declare it programmatically — `resolveHarnessDir` honors it above probing (explicit `opts.harnessDir` / `MSTAR_HARNESS_DIR` still win), `sddWorkspace` follows, and the canonical `.gitignore` snippets (engine / CLI init fence / plan-conventions) ignore `.mstarc` by default. Resolution order SSOT updated in `mstar-plan-conventions` § {HARNESS_DIR} 解析顺序.
- Tracked `*.ts` / `*.md` files no longer cite gitignored harness artifacts (paths under `.mstar/` — status.json, plans/, sdd/, iterations/, knowledge/, references/, archived/, docs/): engine/host/test comments and docs now reference `{HARNESS_DIR}` / the consumer default or drop the local path; the drift-lint `.mstar/`-citation exemption is removed (the guard now enforces the rule), and AGENTS.md codifies it.
- **v3 workflow lifecycle schema (engine)**: lifecycle state moved from root `status.json` `plans[]`/`residual_findings` into per-workflow snapshots (`{HARNESS_DIR}/workflows/<id>/snapshot.json`, `validateWorkflowSnapshot`) and project registers (`{HARNESS_DIR}/projects/<id>/residuals.json`, `validateProjectRegister`); the v2 root keeps only `version` / `updated_at` / active `workflows[]`. New dir resolvers `resolveWorkflowDir` / `resolveProjectDir`.
- **`mstar migrate` (CLI)**: one-shot v1→v2 tree migration (`migrateHarnessTree` / `applyMigratePlan`) — archives the v1 root to `archived/status.v1.json`, lifts every lifecycle into `workflows/<id>/snapshot.json`, seeds the project register + roadmap, replaces the root with the v2 commit point; idempotent re-run no-op; `--dry-run` prints the step plan and surfaces apply-time validator violations as warnings; exit codes 0/1/2; `--path` defaults to the resolved `{HARNESS_DIR}`.
- **CLI/tools/hook hard cutover to v2 inputs**: `status validate` (v2 root or snapshot), `status tech-debt` / `status findings-cleanup` (project register), `lease verify` / `lease verify-integration` / `iteration gate` / `worktree check` (workflow snapshot via `--workflow <id>`), `path resolve` (+ workflow/project dirs); `status archive-residuals` removed (error stub names the register close flow); `tools/mstar_*` and the omp/opencode Gate 1 hooks validate the three v3 coordination documents, with lazy-loaded P1-only engine exports so a stale published engine degrades to a warning instead of dropping the hook/tool.
- **Skills v2 surfaces**: retired `done-compaction` / `plans-done` / `notes.empty` artifacts and scrubbed all references; rewrote status/residual/lease/convention surfaces across `mstar-*` skills to v2 addresses (`workflows/<id>/snapshot.json`, `projects/<id>/residuals.json`, `mstar status validate` / `findings-cleanup` / `tech-debt`, `mstar lease verify --workflow <id>`, `mstar iteration gate --workflow <id>`).
- **`mstar-engine-legacy`** (new): conditional contract archive for engine-absent hosts — status v1→v2 field history, lease protocol, per-host QC seat N=3/N=1 restatements, anti-recursion checklists, engine-check boilerplate; not loaded when engine constraints are active.
- **`mstar-project-governance`** (new): `projects/<id>/roadmap.md` authoring conventions (frontmatter schema + body conventions, warnings-only) and `residuals.json` register lifecycle (open → verified close in place, severity enum, provenance fields, `_default` fallback); schema verbatim with the engine `project.ts` validators.
- **Docs sync**: README.md / README_CN.md layout description and workflow diagram updated to v2 state surfaces (workflow snapshot / project register; `workflow_dir` / `project_dir` `.mstarc` keys); routing-eval scenario set re-pointed to v2 artifact addresses.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 3.0.0**.

## [2.4.1] - 2026-08-17

### Harness

- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.7` line (`^0.1.0-rc.7`; `@deepseek-ai/cordis` stays `^4.0.1`). Local rc.6→rc.7 source review of consumed seams found no adapter-code break (`createUserMessage` / `ToolExecution` / `PreToolDecision` / `PreStepDecision` / `FsWriteIntent` / dump-config `disabled: true` unchanged; `apps/cli/src` version-only). Lock purged every entry below `0.1.0-rc.7` — 62 unique `@deepseek-ai/dsh-*` packages, single hoisted copy each, 0 nested copies. Root `dependencies` stays engine-only.
- **README readability**: Install Command cells wrap with `<br>`; `npm i -g @mstar-harness/cli` is a standalone fenced command; Iteration / Codebase audit tables use **Command** (full signatures) and wrap **When**.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.4.1**.

## [2.4.0] - 2026-08-17

### Changed

- **dsh install target**: `npx @mstar-harness/cli init --target dsh` now installs the full dsh capability in one command — it runs **two independent** `dsh plugin --profile web add` calls (`@mstar-harness/dsh` first, then `dsh-llm-fallbacks`; never folded into a patch file). `doctor --target dsh` reports each plugin row as `uninstalled` / `disabled` / `mounted` and exits non-zero on any uninstalled or disabled row. `--no-fallbacks` (dsh target only) skips the `dsh-llm-fallbacks` row; `--dry-run` previews without probing or executing; re-runs are idempotent (already-installed rows skipped). README pair, `INSTALL.md`, and `docs/cli.md` updated.
- **CLI `mstar` bin alias**: `@mstar-harness/cli` now installs a second executable, `mstar`, alongside the canonical `mstar-harness` — both map to the same `dist/mstar-harness.js` entry, so the two names are interchangeable (pinned by a new manifest test). `commands/` citations now use `mstar-harness` (version-proof: the long name exists in every released version; the short alias ships with this release), and `docs/cli.md` plus the README pair note the alias. **Caution**: `mstar` is a shared bin namespace — an unrelated third-party npm package named `mstar` claims the same command name, so bare `npx mstar …` only resolves to this CLI where `@mstar-harness/cli` is installed; keep the canonical `mstar-harness` in scripts and use the long name on any collision. Existing global installs obtain the `mstar` shim on their next upgrade: `npm i -g @mstar-harness/cli@latest` (or the bun equivalent) re-links all declared bins.
- **Drift-lint bin-prefix guard**: `validation:drift` now checks the binary prefix of every backticked CLI citation in Engine-check callouts against the declared `bin` names from `packages/cli/package.json` (the manifest is SSOT), so citing a nonexistent executable (e.g. a typo like `mstarr`) fails drift-lint instead of silently passing while the subcommand paths validate.

### Harness

- **dsh full support (docs)**: the `packages/dsh` README triple's Install section now documents the one-command CLI entry (`init --target dsh` — the two `dsh plugin --profile web add` installs, orchestrated) and what a user gets zero-config once both rows are installed: the 13 `mode: subagent` mstar role seeds with mirror-default personas (revertible in settings; runtime advisory reports overrides), plus a fresh-publish `minimumReleaseAge` window note (re-run init or pin the version). The installed-deployment e2e closes the loop: a real CLI install into a temp `DSH_HOME`, booted from the installed artifacts, asserts all 13 roles seeded with non-empty personas. Root README pair adds the dsh full-support one-liner.
- **Five-question lint runtime mode**: `lintFiveQuestion(body, mode?)` now supports `mode: "runtime"` (default `"authoring"`, non-breaking) with a locked `RUNTIME_HEADING_ALIASES` table — heading synonyms (e.g. `process`/`playbook` for Workflow, `hard rules`/`门禁` for Decision Rules, `output format`/`证据` for Evidence, `dependencies`/`关系` for References) that count as the canonical sections for shipped topic skills. `mstar skill lint` selects runtime mode for `mstar-*` skill dirs except `mstar-skill-authoring` (always authoring/strict); `mstar-harness-core` prints an explicit **exempt** row for the five-question checklist. Greenfield (authoring) lint still demands canonical headings.
- **Runtime corpus alignment**: 15 shipped `mstar-*` topic skills gained minimal annotations/thin sections (Evidence ×13, Workflow ×9, References ×6, plus `mstar-host`'s load-order/decision-rules gaps) derived from existing material — every runtime skill now passes runtime-mode five-question lint; `mstar-audit` needed zero edits. `skills/mstar-skill-authoring/SKILL.md` documents the alias map (runtime-mode semantics stay SSOT: aliases exempt mechanical lint, not content).
- **drift-lint Guard 5 (five-question corpus smoke)**: `bun run validation:drift` now loads every shipped runtime `skills/mstar-*/SKILL.md` (excluding `mstar-harness-core` and `mstar-skill-authoring`), strips frontmatter, and runs `lintFiveQuestion` in runtime mode — deleting a Step-3 aligned heading or losing runtime alias coverage fails CI (audit finding 5).
- **`mstar-skill-authoring` strict self-lint**: the fence-aware heading scan exposed the standard's own `SKILL.md` as a fence false-green (five-question coverage came only from the `## 默认 Body 结构` template code fence), so real `## Workflow` / `## 6 条作者原则（Decision Rules，必须遵守）` / `## 验证门控（Evidence，原则 4 + 6）` sections now answer the five questions honestly and `mstar skill lint skills/mstar-skill-authoring` passes strict (authoring) mode.
- **Fail-loud fragment validation**: `scripts/prepare-release.ts` now validates each changelog fragment's `packages:` tokens against the release-surface enum (`root | cli | opencode | engine | dsh`). A typo'd or unknown token (e.g. `clii`, `scripts`) previously matched no changelog target and silently dropped the fragment's bullets from every changelog; release prep now prints one error line per bad token to stderr and exits 1 before any changelog mutation or fragment archival. `validateFragmentPackages` is exported for tests.
- **`mstar roles validate`**: new CLI command exposing the mstar-roles skill-dir checks — a thin mirror of the dsh seam `validateRolesState`: `validateRoleMapping` on the roles dir plus `lintLoadOrder` over every sibling `mstar-*` skill, with unreadable siblings skipped best-effort. Defaults resolve through the project-root path resolution (`--roles-dir` → `skills/mstar-roles`, `--skills-dir` → its parent); exit 0 prints OK + counts, violations exit 1 with one row each. `skills/mstar-roles/SKILL.md` engine-check callout now cites the CLI command.
- **drift-lint Guard 4**: roles/load-order corpus guard in `scripts/drift-lint.ts` (plan 003 Task 2) — `lintLoadOrder` over every `skills/mstar-*/SKILL.md` text (each must declare `mstar-harness-core` in a Load Order / First action section) plus `validateRoleMapping` on `skills/mstar-roles` (mapping / parameter tables must resolve against the on-disk `references/*.md` layout); CI drift-lint now fails on role-table or load-order regressions.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.4.0**.

## [2.3.0] - 2026-08-16

### Harness

- **SDD fix-round mechanics**: `mstar-sdd` gains four mechanical rules for PM fix-wave dispatch and close-out — an **unverified round counts** (a fix round without verification evidence — reviewer not confirmed / report not on disk — is not clean; re-check and count the round, never enter the convergence branch), **full re-entry** (the next fix dispatch carries all open findings, including last round's unverified items; never slice a subset), **capped cross-round excerpt** (from round ≥2 the dispatch brief carries an excerpt of prior rounds' findings and dispositions — advisory ~500 words/round, ~1500 total, suggested values not hard limits), and **honest non-convergence** (open findings at wave close are listed in detail with an explicit re-feed-to-next-round or transfer-to-residual disposition — never silently closed). Folds Candidate C5 into `mstar-sdd` SKILL.md "After all tasks" + `references/file-handoffs.md` cross-reference (the per-task fix loop applies the same mechanics).
- **Residual fail-loud handoff contract**: `mstar-plan-artifacts` `status-and-residuals.md` now requires findings to pass engine validation before R# registration — `validateResidual` per entry and `validateStatus` for the whole file; malformed entries (non-object, missing any of the nine required fields id/title/severity/source/scope/decision/owner/target/tracking, or severity outside the enum) are **rejected** — fix and rewrite, never silent pass-through, downgrade-write, or write-then-patch. Folds Candidate C6; the architect-verified D-3 branch (covered-but-untested) is closed by backfilled non-object rejection regression tests in `packages/engine` at both the `validateResidual` level and the `validateStatus` aggregate level (engine suite 658 pass / 0 fail) — zero source diff, no new public API.
- **CLI `dispatch validate` non-ASCII literal fix**: bun-executed CLI bundles misdecode raw multi-byte UTF-8 in regex/string literals, so a legal `Branch policy: direct on main — <reason>` (em-dash) was reported as two false violations. Source literals across 20 `packages/engine` + `packages/cli` src files are escaped to `\uXXXX`, a post-build dist escaper guarantees bundle-level ASCII (bun build re-normalizes string escapes), a bundle-smoke regression test covers em-dash + ASCII separators, and `bun run lint:ascii-literals` plus a CI step guard against recurrence. The guard covers `packages/engine` + `packages/cli` source and the CLI dist bundle; the opencode dist bundle is not wired to the escaper — it is not run as a large bun bundle.
- **Regression-fixation paired-evidence reference**: new `mstar-skill-authoring/references/regression-fixation.md` — real artifact as test subject (built bundle / command sequences, not a source import), mock host hooks, dual-path assertion consistency, and fix solidification (reproduce → FAIL → fix → PASS → into the regression set); zero external dependencies, explicitly an optional heavy weapon (default stays P6 before/after + application case). SKILL.md gains the References pointer and syncs its verdict enum to the 4-value SSOT (Approve | Request Changes | Needs Discussion | Unconfirmed).
- **Dataflow-directed debugging protocol**: `mstar-coding-behavior` §4 Debugging gains a compact diagnosis procedure — map the data flow before judging (input → processing → storage → output, who writes/reads at each step; a bug is a state deviation from expectation at a flow point), four verifiable cross-checks (re-run the repro / log comparison / input-output comparison / dual-path comparison — a hypothesis that cannot be verified on the spot is not a conclusion), and falsify the fix (after fixing, re-run the original repro and compare with expectation; report "verification failed" explicitly instead of pretending success) — cross-referencing, not restating, the existing root-cause and repro-test bullets.
- **QC report evidence contract + `Unconfirmed` verdict**: `qc-specialist` report-template findings entries now require `Verification` + `Expected vs observed` on every severity class — Critical/Warning may use the four cross-checks (or a `diff/read/grep` anchor), Suggestion is `diff/read/grep` anchor only — backed by two hard rules (no verifiable cross-check → do not report the finding; a failed evidence channel is not "no problem" — mark the affected scope **Unconfirmed**); the verdict enum gains `Unconfirmed` for evidence-channel failure; `deep-review-lenses.md` now requires every lens finding to carry a diff/read/grep anchor + expected vs observed (no anchor, no report).
- **Audit red-team attack pass before vet**: `mstar-audit` Phase 3 gains an attack sub-step before the human vet — take the top candidate findings (by leverage; count scales to finding volume) and run a three-way attack on each (counter-example / simpler explanation / evidence verifiability); survivors pass to vet unchanged, refuted findings are dropped and recorded in the index's "considered and rejected" section (`- <finding>: not worth doing because <one line>`), hallucinated claims surfaced by the attack are discarded and logged as red-team record lines (never into the findings table, and they do not occupy a "considered and rejected" slot), and findings the attack did not reach are treated as unreviewed and kept for vet — with a one-line boundary reference to the vet step (the attack decides whether a claim stands on its face; vet keeps open-cited-code confirmation and by-design / mis-attribution / duplicate disposition).
- **QC consolidated coverage semantics + `Unconfirmed` propagation**: `mstar-review-qc`'s PM consolidated section now requires — unmentioned = unreviewed (a finding / severity item / claim not raised by any seat must be marked `unreviewed` and routed to targeted re-review, never silently treated as covered); zero injection at the consolidation layer (every consolidated entry must trace to a `qcN.md`; the PM's own observations go to a separate Status Update); and any seat verdict `Unconfirmed` → the gate decision must not be `Approve` until the evidence gap is closed (existing targeted re-review path — same `qcN.md` `## Revalidation` in-place verdict update; no new re-review form, N rules unchanged). The PM `Consolidated Decision Template` verdict enum is synced to the 4-value set (Approve | Request Changes | Needs Discussion | Unconfirmed).
- Added a **DSHFIND** badge to the README header linking to the plugin directory listing.
- **Ephemeral-citation lint (engine)**: new `findEphemeralCitations` scans skill text for short-lived citations — concrete task artifacts (`task-<digits>-(brief|report|fix-report|diff)`, incl. dot form `task-N.diff`) and SDD deeplinks (`.mstar/sdd/` / `.agents/sdd/` + concrete first segment) — while discriminating placeholder forms (`task-N-report`, `<plan-id>`, `{SDD_DIR}/…`, `.mstar/sdd/**` path globs): zero false positives on the current `skills/` corpus.
- **CLI `skill lint`**: third checklist `skill lint (ephemeral citations)` wired into `mstar skill lint` after the five-question checklist; each citation reports as a `skill.ephemeral.<kind>` violation (line + match + placeholder rewrite fix) and sets exit 1.
- **drift-lint guards**: docs audit-enum set-equality (docs/cli.md `<category>` row and README category-focus lists vs the engine `AUDIT_CATEGORIES` — catches fabricated tokens like `deps` and omissions like `bug` / `direction`), README.md / README_CN.md same-commit bilingual pairing over the push range, and a skills-corpus ephemeral guard reusing `findEphemeralCitations`; plus a `citesKnowledgeConventions` exemption for harness-local knowledge citations.
- **History-rewrite push safety**: `mstar-branch-worktree` gains a "History rewrite 与推送安全" section — any history rewrite of an already-pushed branch must first `git fetch` and record the remote **exact OID**, then publish with `--force-with-lease=<branch>:<observed-oid>` (bare `--force` prohibited); after the rewrite, prior review threads / approvals / check results are no longer current evidence and must be re-reviewed before merging; `mstar-iteration`'s phase-4-5 reference now points at that section as the SSOT for rewrite / force-with-lease / evidence-invalidation rules.
- **Authoring devices library**: `skillsbench-authoring.md` gains 6 small composable authoring techniques (calibrated examples file, recall batteries, overcorrection traps, required-explicit-input, questions ≠ write authority, invocation boundary), each mapped onto one or two SkillsBench principles with in-harness instances.
- **Bilingual minimal-update rule**: `AGENTS.md` Core Rules now require the minimal counterpart edit for paired docs (README.md/README_CN.md, packages/dsh README triplets) — never re-translate a document to apply an update — with pairing hashes re-recorded (`git hash-object`) in the same change set.
- **Knowledge-doc prose hygiene**: `mstar-compound` workflow gains §3.5 — a HEAD-resolvability quality gate (a reader at HEAD — no chat transcripts, dispatch prompts, or unmerged drafts — can resolve every reference and verify every claim) with an mstar-adapted leakage taxonomy (dead session citations, change narration, review choreography, hedges without `simplify:`/`temporary` markers, authoring-language slips) and sanctioned keep rules (R#/finding ids in review bundles, issue references, measured bounds, iteration/plan ids); `writing-specialist` Output Guidance points to the SSOT without duplicating it.
- **Future-decision-value classification**: `mstar-compound-refresh` Phase 2 gains a second axis — docs whose rationale / alternatives considered / negative guarantees / reintroduction conditions still guide a future change are **kept regardless of length** — plus a guardrail (a captured rejected approach stays only while the losing idea remains a tempting, meaningful mistake) and an explicit exclusion of frozen-archive seal machinery (rule 6 delete-don't-archive intact).
- **Editorial rubric for writing-specialist**: Output Guidance adds the complete-proposition rule (enumerate actor+action / condition / modality / negative guarantee / ownership before trimming; trim only when every factual clause survives), a coverage-by-artifact table over the six mstar surfaces (knowledge docs / plans / review bundles / SKILL.md / README / completion reports), and doc standards (atomic-move rule, tutorial-vs-reference classification).
- **QC deep-review lenses**: `deep-review-lenses.md` gains 5 new lenses — Lifecycle & Concurrency, Ownership / Derived-State, Bounds, Enforcement-Path, Real-Entry-Path — each with 2–4 structured questions answerable via diff/read/grep, plus deepened Testing / Contract lenses and signal-map seats (QC3 default += Enforcement-Path / Ownership; QC2 default += Bounds / Real-Entry-Path).
- **Audit playbook probes**: `mstar-audit` playbook §1/§2/§4/§5 gain 8 codebase-level probes (derived-state drift, bounds covering the final operation, enforcement bypass, real entry path, externally observable state, user-visible output is behavior, public-but-one-caller, unjustified defaults/public options); §5 adds the prove-or-reject methodology for DEBT findings (consumer three-way classification, hand-rolled vs dependency swap bar, mirrored-fact test, strong-candidate families, guards).
- **`/codebase-audit simplify`**: new `simplify` scope variant routes through the existing command — a DEBT-focused deep pass whose findings use Category DEBT and never inline TODOs.
- Documented `/codebase-audit` usage and keyword parameters (effort levels, category focus, `branch`, `next`/`roadmap`, `simplify`) in README.md/README_CN.md and docs/cli.md.
- Internal `@mstar-harness/engine` devDependencies in cli/opencode/dsh now use the `workspace:*` protocol; the release-prep engine-spec sync step was removed.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.3.0**.

## [2.2.0] - 2026-08-13

### Harness

- **dsh plugin**: the context catalog now carries an **`agentFlow`** evidence row — the actual subagent dispatch/settle ledger (`{HARNESS_DIR}/agent-flow.jsonl`, bounded JSONL truncated to ~500 events; single recording core `DshHostAdapter.dispatchGate` behind both the `tools/pre-execute` listener and the `beforeDispatch` host hook; real settle recording — `tools/post-execute` is a VERIFIED registry seam (dispatched for every tool call) settling foreground dispatch calls, background tasks settle via `ctx.tasks.onTaskDone` terminals, paired by exact dispatch identity — settlement is never fabricated, unpaired calls record nothing). The workflow panel's main graph adds the expected-vs-actual subagent flow pipeline: a third column of stage boxes lit by dispatch evidence, a collapsible event-detail footer strip (role → planId#taskId, all five status colors, settled ✓), and the flow-expected / flow-actual / flow-unexpected legend.
- **dsh plugin**: the ledger's missing-file state now reads as an EMPTY view (the panel shows the "no actual dispatches yet" empty state from plan merge — not an evidence-missing degrade); the ledger append path is documented single-writer and size-gated with an atomic truncation replace.
- **dsh plugin**: fix the unified `mstar-engine-status` catalog row breaking the session round (`session event "user/message" carries non-JSON-serializable data`) when the iteration-gate section cannot be built — no `status.json`, no active steering compass, or an unreadable control doc. The optional `iteration` key is now omitted instead of present-as-`undefined`, keeping the appended message losslessly JSON-serializable at the `Session.append` boundary.
- **dsh plugin**: fixed the broken `@mstar-harness/dsh` build gate — the web client bundle (`dist/client.js`) is now emitted by the full build. Root causes: `tsconfig.json` `types` omitted `react` (TS7026: no `JSX.IntrinsicElements` for the panel `.tsx` sources) and the `@deepseek-ai/dsh-client-*` peer-stub workspace links were missing from `node_modules` (TS2307), which failed the build's final `bunx tsc` step and left the client bundle absent. The typecheck gate is green again; `dsh --profile web` boots with the plugin's `/plugins/@mstar-harness/dsh/client.js` registered and served.
- **dsh plugin**: mstar slash commands (`/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`) now declare an `input` hint (new frontmatter `input:` in `commands/*.md`), so the dsh web client **claims** them on menu pick instead of executing immediately: `/name ` is inserted into the composer with the command highlight, the arg hint shows as ghost text, and the line submits only on Enter — the same interaction as `/plan` / `/goal` / `/advisor`. User-typed args are appended to the steered command message as a `## User input` section; quoted frontmatter values (description/input) now register unquoted. Updated `mstar-host/references/dsh.md`.
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.3` line (`^0.1.0-rc.3`; `@deepseek-ai/cordis` `^4.0.1` — same-class alignment with the dsh-advisor upstream bump, `dsh-external/dsh-advisor#14`); every installed version below `0.1.0-rc.3` (old `0.0.1-rc.x` / `0.1.0-rc.2` lock entries and nested copies) was purged from `bun.lock` + `node_modules`. The monorepo root gains a `bun` `overrides` entry pinning `@deepseek-ai/dsh-llm` to `^0.1.0-rc.3`: bun otherwise installs same-version nested peer copies for each dependent dsh package, and TS 5.9 package-id resolution treats the copies as distinct modules — the plugin's `MessageSourceMap` augmentation (`mstar-engine-status` catalog kind) no longer merges into the union dsh-agent/dsh-session see, breaking `createUserMessage` typing at the `agent/pre-step` catalog push. `tests/peer-deps.spec.ts` pins `^0.1.0-rc.3`.
- **dsh plugin**: dev-time `@deepseek-ai/dsh-*` seam resolution switched from the local **link farm** to the **npm registry** at `0.0.1-rc.5` (bun auto-installs peers via the monorepo-root `.npmrc` `${NPM_TOKEN}`). Removed `scripts/setup-dsh-links.ts` + `dsh:link`/`dsh:link:check` (`prepare` is now build-only); dropped `peerDependenciesMeta.optional` (the old skip-unpublished-peers workaround) and completed the peer set — `dsh-client-runtime`/`dsh-client-locale`/`dsh-client-ui-conversation`/`dsh-client-ui-slots`/`dsh-invariants`/`dsh-jobs` joined the existing peers (all `^0.0.1-rc.5`); added `keywords: ["dsh", "dsh-plugin"]` and `tests/peer-deps.spec.ts` (registry peer contract, peers-not-optional regression).
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.6` line (`^0.1.0-rc.6`; `@deepseek-ai/cordis` stays `^4.0.1`) — every lock entry below `0.1.0-rc.6` (`0.1.0-rc.3` pins and any `0.0.1-rc.x` leftovers) was purged from `bun.lock`; the whole dsh tree now resolves at `0.1.0-rc.6` (60 lock entries, single hoisted copy per package). The monorepo-root `bun` `overrides` entry for `@deepseek-ai/dsh-llm` is **removed**: with every dsh package on the same `^0.1.0-rc.6` range bun dedupes to one copy, so the rc.3-era nested-copy workaround is no longer needed (verified: 1 lock entry, 0 nested `dsh-llm` copies; the `MessageSourceMap` augmentation typecheck passes). Root `dependencies` stays engine-only. Seam-resolution docs updated for the public-registry reality (the root `.npmrc` auth token was dropped in 0c884d47): `packages/dsh` README (EN/zh) and `tests/peer-deps.spec.ts` no longer claim a root `.npmrc`/`${NPM_TOKEN}` — the spec now asserts no scoped-registry mapping comes back and the installed `dsh-llm` resolves to exactly `0.1.0-rc.6`. Caveat: `@deepseek-ai/*` publishes `dist-tags.latest = 0.0.1-rc.1` (an ancient line whose packages reference never-published peers like `dsh-user-interaction`), so `bun update @deepseek-ai/...` must not be used — it downgrades to that line and 404s; the lock-purge + `bun install` path is the supported upgrade route.
- **dsh plugin**: dev-time dependency strategy for the `@deepseek-ai/dsh-*` seams switched from committed `peer-stubs/` stand-ins to a **link farm** (`packages/dsh/scripts/setup-dsh-links.ts`, dsh-advisor pattern): the REAL packages from a local dsh source tree (`$DSH_SOURCE_DIR` → `$DSH_HOME/source/current` → `~/.dsh/source/current`) are symlinked into the repo-root `node_modules/@deepseek-ai/` (idempotent; `bun run dsh:link` / `dsh:link:check`; wired into `prepare` before the build). `peerDependencies` stay declared (the host provides them at runtime; marked optional so bun 1.2 does not 404 on the private registry); the `peer-stubs/` workspace was removed.
- **dsh plugin**: CI (validate job) now detects dsh source-tree availability (`$DSH_SOURCE_DIR` / `~/.dsh/source/current`) and skips the dsh test/typecheck steps when absent — dsh is not run in CI.
- **dsh plugin**: `src/index.ts` slimmed from a 3184-line monolith to a module index over `src/gates/*` (pure refactor, zero behavior change — the 27-name export surface is frozen identical by `tests/export-surface.spec.ts`, and the export-surface type layer now runs in CI via `typecheck:tests` (`bunx tsc --noEmit -p tests/tsconfig.json`)).
- **dsh plugin**: `HarnessResolver.forWorkspace` now passes `workspaceRoot = the session cwd` (the probe start) — the `{HARNESS_DIR}` probe stops AT the session workspace and never walks up beyond it, so a harness dir above the workspace (e.g. the global `~/.mstar` CLI-install root) is never adopted. The dsh boundary deliberately diverges from the CLI's git-top-level boundary. Explicit `config.harnessDir` still wins outright.
- **dsh plugin**: the pre-step catalog is now ONE unified `mstar-engine-status` message — watermark (version, harness dir, enforcement) + iteration phase-gate section (when a steering compass resolves) + workspace-state digest section (plan registry, open residuals, branch/policy anchors, active leases, knowledge summary, compass direction — when the workspace has a `status.json`) — all from one cached `status.json`/compass/knowledge read.
- **dsh plugin**: the catalog row is TTL-refreshed per workspace (Config `catalogTtlMs`, default 60000 ms — mid-session plan/compass/residual changes land within one interval while the hot path stays a timestamp compare + cache hit) and digest-gated (injected once per turn, re-injected only when it changed — a long turn shows the catalog once, not per step).
- Unify local scratch layout: temp files → `.tmp/*`, git worktrees → `.worktrees/*` (both gitignored); documented in AGENTS.md.
- **dsh plugin**: the web client workflow panel is now **"MStar 工作流" / "MStar Workflow"** — a reworked layout (header with version / harness dir / enforcement evenly spread; fixed right sidebar for plans / residuals / knowledge / leases / branches+policy / direction; main body = a **react-flow cyclic workflow graph**) with an upgraded visual system (dsw-token spacing ramp, type hierarchy, dark mode, motion). The graph projects the `mstar-engine-status` catalog through a pure `projectGraph` function (schema constants strictly separated from catalog evidence; never throws; explicit degraded states): a phase ring (iteration-start → autonomous-execute → iteration-close → pr-delivery → merge-ready, loop edge) + plan state machine (Todo → InProgress → InReview → Done / InProgress ⇄ Blocked / unknown bucket), with current-phase highlight, legend, zoom/pan and fitView. `@xyflow/react@^12.11.2` is inlined into `dist/client.js` (MIT; license/size reviewed in guides); the build script now asserts the bundle carries no `import.meta` / ESM statements — the web loader executes plugin bundles as classic `<script>`s, so a zustand v4 `import.meta.env` read (which would break the panel at parse time) is defined away. Local install re-verified: profile add → web boot → client.js route serves the built bundle byte-identical (sha1).
- **dsh plugin**: fixed the unstyled MStar workflow panel — CSS Modules hash class names in the web client bundle could start with a digit (FNV-1a → 8-hex, ~62.5% digit-leading), producing illegal selectors (`.20fd0e45_root`) that browsers silently drop (the whole rule is discarded). The client bundle build now escapes digit-leading class selectors at the CSS text layer (WHATWG `CSS.escape`, e.g. `.20fd0e45_root` → `.\32 0fd0e45_root`; DOM class names unchanged) and adds a build-time two-layer assertion (transform + emitted artifact) that no unescaped digit-leading hash selector remains — a regression guard so silent style loss cannot slip through again.
- **dsh public release prep**: removed the `prepare` script from `@mstar-harness/dsh` (fresh-checkout `bun install` no longer fails on the gitignored engine `dist/`; the monorepo builds packages explicitly, matching cli/opencode), wired dsh into the release pipeline (`release-surfaces.ts` version surface + changelog, `release.yml` build/publish), and made the READMEs public — the private dsh-provider block and the private-mirror repo-URL install (`dsh-external/mstar-workflow`) are gone, replaced by the registry form `dsh plugin --profile web add @mstar-harness/dsh` (plus local-checkout dev install). Dropped a stray committed `.pnpm-store/` (gitignored now).
- **dsh plugin**: fixed ReactFlow v12 silently dropping every edge whose endpoint node exposes no connection-point `<Handle>` — all 17 graph edges (phase ring 5 + state machine 5 + connector 1 + pipeline 6) render again in the real browser.
- **dsh plugin**: synced `packages/dsh` to the dsh `0.0.1-rc.2` rename wave — seam package renames consumed (`@deepseek-ai/dsh-skill-local` → `@deepseek-ai/dsh-skill-filesystem`; test-only `dsh-tasks`/`dsh-tasks-fake` → `dsh-jobs`/`dsh-jobs-fake`), peerDependencies bumped `^0.0.1-rc.1` → `^0.0.1-rc.2`, and renamed API symbols (`SkillService` → `SkillRegistry`; the optional background-seam surface `ctx.tasks`/`onTaskDone`/`TaskId`/`TaskDoneListener`/`TaskSnapshot` → `ctx.jobs`/`onJobDone`/`JobId`/`JobDoneListener`/`JobSnapshot`; client `LocaleService` → `LocaleRuntime`, `SlotsService` → `SlotRegistry`). Docs/README `skill-local` prose renamed to `skill-filesystem`.
- **dsh plugin**: the `<mstar_engine_status>` watermark now shows one unified `mstar version` line instead of separate engine/plugin versions (single-version invariant — the bundled engine and the plugin share one version).
- Removed local-maintenance path references from user-facing skills: `mstar-host/references/dsh.md` and `mstar-iteration/references/phase-2-worktree-lease.md` now reference only runtime consumer contracts (verified zero residual paths).
- Aligned `mstar-branch-worktree` feature-worktree naming to the workspace root `.worktrees/<plan-id>-<slug>` convention (AGENTS.md「Local scratch layout」), gitignored by repo convention.
- **dsh plugin**: the web client module manifest moved from the top-level `dshClient` field to the nested `dsh.client` (`platform: 'web'` + declared inject faces), matching upstream `client-modules` discovery (`dsh.client` + `exports["./client"]`). The legacy top-level key is removed — upstream has no compatibility fallback, so the old field silently un-discovered the client half and dropped the workflow panel from the web boot manifest (`window.__DSH_BOOT__.entries`). A manifest-contract regression test now freezes the new contract and fails first if upstream renames the field again.
- **dsh plugin**: version aligned to `2.0.5` (single-version invariant — the `@mstar-harness/engine` devDependency is pinned exact `2.0.5` and the engine version assertions in the dsh suites now expect `2.0.5`), restoring the unified `mstar version` watermark after the upstream v2.0.5 merge.
- **dsh plugin**: version bumped to `2.1.1` (single-version invariant — the `@mstar-harness/engine` devDependency is pinned exact `2.1.1` and the engine version assertions in the dsh suites now expect `2.1.1`), restoring the unified `mstar version` watermark after the upstream v2.1.1 sync (QC F-001: the shipped bundle and the workspace source now report the same version).
- **dsh plugin**: the `@mstar-harness/dsh` package now ships a **web client plugin** (workflow panel) on the same `mstar` bundle row — `dsh.client` + `exports["./client"]` discover the client half automatically (no separate profile layer or install step). The plugin registers a `conversation.view` view-ring tab (`id: 'mstar-workflow'`, `order: 20`) rendering the latest `mstar-engine-status` catalog row as a structured panel: watermark (version / harness dir / enforcement), iteration phase-gate section (transition, all-plans-done, gate verdict + violations, status/compass anchors), workspace-state section (plan board, residuals, branch/policy anchors, leases, knowledge, direction) and a freshness marker; refresh follows the session snapshot (no polling). Bundle ships as a closure-factory CJS artifact (`dist/client.js`) served at `/plugins/@mstar-harness/dsh/client.js`; local install into the `web` profile is verified.
- **dsh plugin**: **Known limitations** — the panel is a structured segmented presentation this iteration; the graphical workflow canvas (react-flow DAG) is the NEXT iteration scope (compass Roadmap Position). No react-flow dependency or panel render-shape change lands here.
- **dsh plugin**: `{HARNESS_DIR}` now resolves per session workspace — the probe starts from the session cwd (never the launch/process cwd), so the engine-status watermark and the gates follow the workspace the session actually works in; an explicit `harnessDir` config still wins outright.
- **dsh host**: concurrent subagent dispatch now **requires** background mode — any N≥2 dispatch that needs parallel execution (QC tri-review, dual-track) MUST invoke every `subagent` call with `run_in_background: true` in one message; foreground N≥2 invokes run serially (fail-closed `exclusive` tool classification) and do not satisfy an N-parallel requirement (dispatch-incomplete / `Blocked`). Updated `mstar-host/references/dsh.md` (PM dispatch + QC default).
- **dsh plugin**: agent-canvas legend + Phase layout simplification (plan `20260813-panel-agent-canvas-legend-layout`) — (1) the canvas **legend is simplified to the 3 role-card status entries** (`agent-running` running glow / `agent-settled` settled — the standalone GREEN done frame + ✓, never on off-tier roles / `agent-idle` idle dashed); the 7 collaboration-edge / layout entries (`flow-actual` / `port` / `group` / `sub-bucket` / `supervise` / `on-demand` / `unknown`) are removed from the legend copy (the canvas itself keeps the edges / ports / partitions — only the legend copy drops them); (2) the **Phase 1 / Phase 2 groups now sit SIDE BY SIDE** — Phase 1 (review-edit-chain) on the LEFT, Phase 2 (sdd-implement → qc-tri → qa-gate) on the RIGHT, top-aligned — instead of stacked top/bottom, saving vertical canvas space. Docs synced: dsh.md SSOT + bundle mirrors + README.md / README.zh.md / bundle/README.md.
- **dsh plugin**: the 代理执行 tab (spec F1.4) is now a **draggable agent canvas** (replacing the stage-column AgentFlowZone, which is deleted): a native pointer-event **pan** surface (pointerdown/move/up + `setPointerCapture`, translate-only — no zoom, no third-party deps, `touch-action: none`) with the coordinate-space content layer exposing the pan state as `data-canvas-pan` (`transform: translate(xpx, ypx)`; the grid background moves with the content). Every **KNOWN_AGENTS** roster member renders an entity card — **title = the agent name** (session id / task tag are auxiliary record fields); un-evidenced agents show the muted **idle** card (dashed frame, `data-agent-idle`), evidenced agents light by the honest status priority (running business glow ring / settled ✓ / error / denied / advisory). Collaboration edges reuse the `AgentEdge` model: dim dashed expected stage skeleton, business actual handoffs, and the **animated "next" edge** (`@keyframes canvas-dash-flow`, disabled under `prefers-reduced-motion` — engine-verified). The **Legend** re-mounts on the canvas with the idle swatch (`data-mstar-legend-item="agent-idle"`) + the collaboration-edge swatches; the canvas degradation note now distinguishes the settle-only ledger (`data-canvas-note="settle-only"`) from empty/degraded, and the dead AgentFlowZone styles were removed from `zones.module.css`.
- **dsh plugin**: the agent canvas was verified in the browser harness on **light + dark** themes — entity cards (idle dashed / running glow / settled ✓), legend swatches (incl. the idle swatch), and the next-edge stroke were probed for computed styles in both themes (host token flip observable, zero bare colors of any form across the panel/zones/canvas css, `prefers-reduced-motion` run asserts the next-edge and running-card animations compute to `none`); a **real pointer-drag** sequence (CDP `Input.dispatchMouseEvent`) moved the `data-canvas-pan` transform from `translate(0px, 0px)` to `translate(60px, 30px)` with pointer capture released — the drag contract verified end to end; evidence in `{SDD_DIR}/review/harness/` (browser-checklist.md + browser-results.txt).
- **dsh plugin**: the MStar workflow panel's agent-execution zone now renders the real subagent flow — the six EXPECTED_ROLE_FLOW stage/phase columns with **entity cards** aggregated from actual dispatch evidence (agent display name / role chip / task tag `planId#taskId` / status point / ×N count; running entities get a business glow-pulse highlight, un-evidenced stages show a dashed "pending" placeholder with their expected role chips, and the header carries the `N executing · M pending` summary). Flow arrows: dim expected skeleton arrows between consecutive columns, small in-column handoff arrows between same-column cards, and an **animated "next" edge** — a business dash-flow arrow (`@keyframes agent-dash-flow`, disabled under `prefers-reduced-motion`) from the latest running entity's stage to the next constant-order column, drawn only while a running entity exists. The zone degrades to muted empty states (never orange warn boxes) when the ledger is missing/empty/settle-only.
- **dsh plugin**: the agent zone and the agent-flow event dock were verified in the browser harness on **light + dark** themes — entity cards, status points, pending placeholders, the next-edge dash animation (declaration + computed `animation-name`) and the dock's event-row status colors were probed for computed styles in both themes, including a `prefers-reduced-motion` run asserting the animations are disabled; evidence in the iteration guide `iter-20260810-panel-zones/guides/agent-flow-zone-dual-theme-verification.md`.
- **dsh plugin**: the MStar workflow panel canvas was rebuilt as an **HTML/CSS zone dashboard** — the react-flow cyclic graph (the `@xyflow/react` rendering layer, its plain-`.css` text loader, and the devDependency) is removed, and the build now asserts the emitted `dist/client.js` carries **no `xyflow`/`reactflow` markers** (the bundle dropped from ~468 KB to ~85 KB raw). The canvas fills the Tab (no page-level scroll): an **iteration zone** (Step 1–5 stepper + `Step N/5` badge, active-highlight / inactive dimmed states, branch panel: iteration base / target / spec integration — rendered only while active), a **tasks zone** (6-column kanban: Todo / InProgress / InReview / Done / Blocked / unknown with count badges, Done ≤5 + `+N more`), an **agent-execution zone** (pending skeleton — entities + flow arrows land in plan `20260810-panel-agent-flow-zone`), a bottom **fixed footer bar** (zone legend + gate summary with collapsible violations) and a canvas-corner **AgentEventDock** (agent-flow event strip, mounted only when events exist — hidden entirely at 0 events). The three orange warn frames are gone — degraded states render as muted empty states, never orange boxes.
- **dsh plugin**: the zone dashboard is fully token-driven (zero bare colors of any form) and verified in the browser harness on **light + dark** themes — zone backgrounds / borders, status colors and the muted empty states were probed for computed styles in both themes (`prefers-reduced-motion` respected, motion ≤200ms); evidence in the iteration guide `iter-20260810-panel-zones/guides/canvas-zones-dual-theme-verification.md`.
- **dsh plugin**: the 事件记录 tab (spec F1.5) is now a **non-canvas log page** — `EventLogPage` renders two partitions from the projected `ZoneView` slices (consumed unchanged, zero projection changes): **Agent 流转事件** (`view.events` ≤50 latest-first; off-pipeline unexpected dispatches fold in once via `expected: false` — never double-appended) and **违规记录** (`view.violations`, gate violations with severity/code/message). **Every row is an expandable native `<details>`** (no-JS, keyboard-accessible): the summary IS the toggle (role/agent, stage, `planId#taskId` tag, HH:MM time, token-colored status chip, settled ✓, duration, unexpected badge) and the expanded body shows the **full catalog fields** (role/agent/stage/plan/task/category/time/kind/status/expected/settled/duration; violations: severity/code/message) — a missing field renders muted **「—」**, never a fabricated value. Empty/degraded states are muted (both-empty → one「暂无记录」note; mixed empty degrades each partition independently) — never an orange warn frame. The canvas-corner **`AgentEventDock`** is **removed** (无双份日志, spec §5): its row layout + status colors migrated into this page, and the header TabNav already is the jump to the tab — zero `data-agent-event-dock` anchors remain. New `data-event-log-*` test anchors (section/row/details/field/missing/empty), 23 new `event-log.*` locale keys (zh/en symmetric) in the `PanelKey` union, and a new token-driven `event-log.module.css` (zero bare colors — dark mode is the host token flip; the `<details>` disclosure chevron is a token-colored `::before` that rotates 90° on expand; 150ms hover/rotation sits in the 120–150ms window; motion killed by the panel root `prefers-reduced-motion` rule).
- **dsh plugin**: the event-log page was verified in the browser harness on **light + dark** themes with a **real `<summary>` click** expanding a row's `<details>` (open state + detail-body computed styles asserted): partition frames (bg/border), log-row summaries, status chips (business/warn/error/success), severity chips (error/warn), the disclosure chevron (caption token, rotates on open), and the muted empty state were probed in both themes (host token flip observable, zero bare colors of any form across the panel/zones/canvas/event-log css, no panel-side dark overrides); a `prefers-reduced-motion` run asserts the row hover transition computes to `0s`; evidence in `{SDD_DIR}/review/harness/` (browser-checklist.md + browser-results.txt + dual-theme screenshots with one row expanded).
- **dsh plugin**: QC fix wave (plan `20260811-panel-event-log` re-review): the unexpected-role badge is now dispatch-only — settle rows (completion records) never flag as unexpected and render「—」in the detail expected-role seat; `formatEventTime`/`formatEventTimeFull` no longer throw RangeError on a finite-but-out-of-Date-range `ts` (it degrades to「—」like any missing value); the events partition title moved to the symmetric `event-log.section.events` locale key; the READMEs/dsh guide now attribute the fixed footer bar's removal to the tabs-shell plan (this plan removed only the `AgentEventDock`).
- **dsh plugin**: panel F2 quickfix (plan `20260811-panel-f2-quickfix`) — (1) the 任务迭代 tab's step row now renders 5 equal full-width unit blocks (flex `1 1 0`, centered content, `--mstar-space-*` gap) with pure-number badges and `n/total` summary — the connector bars (`data-step-connector*`) are removed and zh/en carry no 步骤/Step wording; (2) `KNOWN_AGENTS` is now exactly 14 roles — `project-manager` (the primary orchestration agent, never an assignable subagent) is removed from the 代理执行 roster; (3) the agent canvas drops the `ops-on-demand` pipeline stage (5 stages, `qa-gate` terminal), moves `ops-engineer` / `prompt-engineer` into a separate **on-demand column** (projection-owned `zone`, no expected/next arrows into it, localized label + legend entry), and renders the SDD implement ↔ task-review **loop back-edge** (`sdd-task-review → sdd-implement`) as a visually distinct curved double-arrow with its own `data-agent-edge-loop` anchor — `pending` semantics follow (11 in-flow roles).
- **dsh plugin**: panel F3 agent-general model (plan `20260811-panel-f3-agent-general`) — (1) the 代理执行 canvas pipeline drops from 5 to **4 stages** (`review-edit-chain → sdd-implement → qc-tri → qa-gate`, `qa-gate` terminal; the `sdd-task-review` stage is removed and its SDD L2 reviewer moves off-pipeline); (2) `KNOWN_AGENTS` is now exactly **13 roles** — `generalPurpose` becomes the **`general` bucket** (its own trailing column, `stage: null`), `explore` is removed (no card, no column — a stray `explore` dispatch folds into `general`), `ops-engineer` / `prompt-engineer` keep the on-demand column, `project-manager` stays out of the roster; (3) entity cards now aggregate **by role** instead of by session — the same role across sessions folds into one card ×N, and every off-roster dispatch (former `generalPurpose` reviewer, `scout`, anonymous `role === ''`) folds into the single `general` entity (`agent` / `task` become record fields); (4) the SDD loop back-edge is redrawn as `sdd-implement` ↔ `general` — a curved double-arrow **below the column band** (anchored at the column bottoms, true bezier extremum 16px below the lowest column bottom, `data-agent-edge-loop="autonomous-execute:sdd-implement->general"`); (5) `AgentZone` is `'flow' | 'on-demand' | 'general'` (the `unexpected` track is removed; columns = 4 stages + on-demand + general); (6) the 事件记录 (Event Log) page now renders its two partitions **side by side** in a locked-height two-column grid (`repeat(2, minmax(0, 1fr))` — no whole-page scroll; each partition pins its title and scrolls internally), falling back to stacked rows below 1200px, with all `data-event-log-*` anchors preserved (event-log `unexpected` badge semantics unchanged — `expected` ⟺ role ∈ EXPECTED_ROLE_FLOW union).
- **dsh plugin**: panel F4.2 agent-view layout (plan `20260811-panel-f4-agent-view`) — the 代理执行 canvas drops the standalone **general bucket column** (5 columns now: 4 stages + on-demand; `data-canvas-column` never emits `general`): the single `general` bucket card renders at the **bottom INSIDE the `sdd-implement` column** (stable partition — dev cards first, general card below — with a dashed separator + small in-bucket `general` label, idle placeholder preserved, `data-agent-bucket="general"`); the `sdd-implement` ↔ `general` **SDD loop back-edge is removed** — no more curved double-arrow below the column band and no `data-agent-edge-loop` anchor (`AgentEdge.loop` / `solveLoopBow` / `LOOP_BOW_MARGIN` / `GENERAL_COLUMN` dead code cleaned); the 3 forward skeleton arrows, in-column handoff arrows and the animated next edge are unchanged, and the on-demand column (ops-engineer / prompt-engineer) is untouched. Evidence-driven "dynamic lines" for the review cycle are a later roadmap iteration.
- **dsh plugin**: panel F4.3 iteration-zone (plan `20260811-panel-f4-iteration-zone`) — the 任务迭代页 expanded head is now a LEFT-RIGHT SPLIT: the branch panel (`data-iteration-head-branches`) sits in the small left half and the Steps row (`data-iteration-head-steps`) in the large right half (`data-iteration-head-split`, DOM order branches-before-steps; narrow widths stack at the existing 860px breakpoint; no branch panel when there is no active iteration). The current step is now compass-driven: while the steering compass is `status: active` (Phase 1 in flight — catalog `compassStatus` field), Step 1 (iteration-start) renders CURRENT with verdict `unknown` and NO PASS/FAIL badge (Phase 1 has no gate verdict), next = Step 2; `locked` / missing `compassStatus` keeps the existing gate-transition-driven Step 2→4 + gate badge. Every step reserves a fixed-height verdict seat (`data-step-verdict-seat`) so centered content groups align — the PASS/FAIL badge no longer skews the step blocks. Docs synced (dsh.md SSOT + bundle mirror + READMEs + knowledge update-only).
- **dsh plugin**: panel F4.1 timeliness (plan `20260811-panel-f4-timeliness`) — the 代理执行 canvas now reflects REAL subagent completion: settles are recorded only from verified completion signals — `tools/post-execute` (the dsh-tools registry dispatches it for every tool call, verified against the upstream source) settles foreground dispatch-tool calls, and `ctx.tasks.onTaskDone` terminals settle background subagents (`completed → ok` / `killed → denied` / `failed → error`); every paired settle carries its dispatch's identity (`role`/`planId`/`taskId`, same fields + semantics as the dispatch event), so under QC-tri N=3 concurrency each card settles on its own, the `N 执行中` count derives from the ledger, and unpaired/non-dispatch calls record nothing (never fabricated). A ledger record (dispatch/settle) now invalidates the workspace's TTL-cached catalog row immediately, so the panel refreshes per step during active orchestration instead of waiting up to the 60 s TTL (idle gaps keep the last snapshot — documented limit).
- **dsh plugin**: panel F5 agent-layout rework (plan `20260812-panel-f5-agent-layout`) — the 代理执行 canvas now renders **4 stage columns + a rightmost `unknown` column** (the `general` bucket gets its OWN rightmost column, user 2026-08-12 decision — the former F4.2 "bottom inside `sdd-implement`" placement is superseded); the `sdd-implement` column splits into **sub-buckets** by the projected `entity.bucket` — **implementor** above (flow roles in stage order, then the on-demand roles ops-engineer / prompt-engineer carrying an **on-demand badge**; the standalone on-demand column is removed) and **sdd-reviewer** below (code-reviewer, the SDD L2 task reviewer — v2.1.1, the former `generalPurpose` seat), with implementor / sdd-reviewer caption labels; a **bidirectional supervise line** (implementor ↔ sdd-reviewer — the mstar-sdd mutual-supervision contract) runs inside the `sdd-implement` column, dim dashed by default and lit business only when the projected `evidenced` flag is true (evidence-driven lighting, never a fabricated activation); `KNOWN_AGENTS` grows **13 → 14 roles** (`code-reviewer` joins the pipeline roster); the no-harness branch renders a **centered inactive-state card** (folder icon + 「No Morning Star harness detected」 title + hint — no tabs, no sidebar, activates automatically once a harness is detected). Docs synced: dsh.md SSOT + bundle mirror + README.md / README.zh.md / bundle/README.md.
- **dsh plugin**: panel F5 design system (plan `20260812-panel-f5-design-system`) — the 代理执行 canvas now implements the user-approved design system (design doc v3, two 2026-08-12 review rounds): **(1) emphasis opacity tiers** — every entity card carries a projected `emphasis: 'current' | 'next' | 'off' | null` tier derived from the iteration's current phase (current-phase roles **100%** chrome, later-phase expected roles **75%**, already-passed / stage-less on-demand + general roles **45%**, `null` = no iteration → NO override); the tier is always a chrome **alpha mix** (`--mstar-canvas-emphasis-*` tokens), never a whole-card `opacity`, so the status point + running glow stay fully opaque. **(2) edge rework** — a strict **4-column layout** with NO standalone unknown column (the `general` bucket sinks into an unknown sub-partition at the bottom of the `qa-gate` column); the `expected` stage skeleton arrows and the ANIMATED `next` edge are **REMOVED** (flow order implied by the fixed column order + labels, current position by the running glow + status point), leaving TWO semantic kinds: evidence-driven **`actual` handoff** edges drawn as **bezier `C` curves** anchored to card **ports** (4 edge-midpoint ports — north/south/east/west, static-invisible, hover-revealed) with the arrow tip pulled back to a **10px standoff** off the port, plus the **bidirectional supervise line** re-anchored to the **side-gap vertical anchor** (`x = card right edge + 18px`, vertical bezier flow); two line RULES — **H1** arrow follows the line's local tangent, **H2** no line crosses any text. Cards are a single rounded element (glow on the rounded `.card-body`, no square outline). Docs synced: dsh.md SSOT (incl. leaf report-tool discipline — leaf completion goes in the closing message, not the `report` tool, whose default quiet delivery strands in the parent's next-step queue) + bundle mirror + README.md / README.zh.md / bundle/README.md.
- **dsh plugin (v4, user round 4)**: the agent canvas lands the round-4 design revisions (plan Task 8, design doc v4): **(1) Phase 1/2 groups + current-plan annotation** — the 4 columns split into TWO stacked bands (Phase 1 review-edit-chain ABOVE — the sequential Review & Edit chain; Phase 2 sdd-implement → qc-tri → qa-gate BELOW — the iterative plan loop), each with a group label row, and the Phase-2 label annotates the CURRENT plan (projected `activePlanId` = the first InProgress `state.plans[]` row; `+N more` when several run in parallel, muted「无进行中 plan」when none). **(2) settled green done frame + ✓ with the off-tier exclusion** — a settled entity with `emphasis ≠ 'off'` gets a standalone full-strength green frame (success border + 1px ring on the rounded card body) + the green ✓; an off-tier role (already-passed / stage-less on-demand + general) renders a muted dot and NEVER the completion marker (the v3 leak — the ✓ survived the off-tier low transparency — is fixed). **(3) shared iteration info section** — the tasks and agents tabs render the SAME `IterationInfoSection` component from the same `view.iteration` data (one implementation, two mounts). Inter-band handoff edges (Phase 1 ↔ Phase 2) reroute via the side-gap vertical anchor so no line crosses the group label rows (H2). Docs synced: DESIGN.md / DESIGN.dark.md v4 (Phase groups, done-frame token, plan annotation, shared section) + dsh.md SSOT + README.md / README.zh.md / bundle/README.md.
- **dsh plugin**: panel F5 iteration-zone fixes (plan `20260812-panel-f5-iteration-zone-fix`) — (1) the iteration Steps now carry a **four-state machine** (`current` / `next` / `done` / `idle`): every step BEFORE the current one projects `done`「已完成」 (completed — a finished Step 1 no longer reads as idle「待命」 while Step 2 is current; `next` stays the single forward target, `idle` is schema-only), with a quiet passed treatment — success-tinted badge border + muted chip text with a leading ✓ (`data-step-state="done"`, projection-derived, never UI-guessed); (2) the branch panel in the expanded split head is **width-capped** (`flex: 0 1 260px` + `max-width: 280px` — it no longer stretches with the container; the Steps row absorbs the remaining width, and the <860px column stack resets to content height). `current`/`next`/verdict semantics, the Phase-1 no-badge rule and the Step-5-never-current limitation are all preserved (Step 5 renders `next` only while Step 4 (pr-delivery) is current — docs corrected to match). Docs synced: dsh.md SSOT + bundle mirror + README.md / README.zh.md / bundle/README.md.
- **dsh plugin — panel quick fixes (plan `20260813-panel-quick-fixes`)**: the workflow panel's three tabs land the 2026-08-13 quick fixes. **(1) 任务迭代 tab** — the kanban is now **5 columns** (Todo / InProgress / InReview / Done / **`blocked-unknown`** — the Blocked state and the former unknown catch-all fold into ONE merged column titled「受阻/未知」/「Blocked / Unknown」); every column caps its rendered rows at `PLAN_CAP` and shows a clickable **「更多」/「收起」 expand button** (`data-kanban-more` anchor) that unfolds the full column — the projection keeps ALL plan rows (the cap is a render concern, never a discard). **(2) 代理执行 tab** — the canvas filters dispatch evidence to the **current iteration's plans only** (the steering compass `iterationId`, else the nearest iteration via the catalog `plans[].iterationRefs` — most-recent plan by 8-digit id date prefix + doneAt); provably cross-iteration events produce no entity/edge while the roster keeps its idle cards, and plan-less / unknown-plan / standalone dispatches are never hidden; **`advisory` is no longer terminal** — a soft-enforcement dispatch falls through to its paired settle (green ✓ completed when a settle exists, `running` when none), `denied` stays terminal, and the advisory verdict still renders in the event log; edge routing is tightened (**H1/H2** — same-column vertical flows reroute into the LEFT side gap when the center-x line would cross an in-between card body, forward AND reverse; reverse horizontal beziers keep direction-aware control points BETWEEN the endpoints, no card/seat hits) and the **legend moved below the canvas viewport**. **(3) 事件记录 tab** — the row list now scrolls INSIDE the panel partition: the panel root opts into the host `data-conversation-composer-overlay` (full-height opt-in) so `.rowList`'s `overflow-y: auto` engages and the host page no longer scrolls, with bottom clearance reserving the floating composer via the host-published `--dsh-composer-height`.
- Updated `skills/mstar-host/references/dsh.md` + `packages/dsh/README.md` / `README.zh.md` / `bundle/README.md`. The `harness-skills/` mirrors are gitignored and regenerated by `bun run bundle-assets` (not hand-committed).
- **dsh plugin**: the MStar workflow panel sidebar was reworked (info-layout direction #1) — the header row is gone, version + harness dir now live in a bottom **fixed meta dock** (small muted, does not scroll with the sidebar digest); the sidebar is capped and reordered (plans ≤5 in time-desc order + `+N more`, open residual findings ≤10 with severity chips + overflow hint, policy with **enforcement first** then push / worktree / control worktree, leases, knowledge, direction); the branches block moved out of the sidebar to the iteration zone (plan `20260810-panel-canvas-zones`). Catalog evidence: `HarnessPlanView.doneAt` (from `done_at`) and `MstarHarnessState.residualFindings` (open-lifecycle filtered, severity-ordered, capped at 10) — model-visible text stays compact.
- **dsh plugin**: the sidebar / bottom meta dock theme audit is locked in — every color-family declaration in `panel.module.css` resolves through a `--dsw-*` token (zero bare colors of any form, including CSS Color 4 `color()`), spacing rides the `--mstar-space-*` ramp, motion 120–200ms with `prefers-reduced-motion` off-switch; dark mode is the host's `body[data-ds-dark-theme]` token flip (no panel-side theme overrides). Verified by a browser harness run (light + dark computed-style probes on sidebar / bottom meta dock background, text, border and status colors — 46 PASS / 0 FAIL, evidence in the iteration guide).
- **dsh plugin**: the MStar workflow panel moved from the single-page zone dashboard to a **Tabs + Content** layout — a resident right **sidebar** (shared by all tabs: plans / residuals / policy / leases / knowledge / direction + the bottom version/harness meta dock) and a fixed header nav with the 3 MenuTabs **任务迭代 / 代理执行 / 事件记录** (default = 任务迭代, D1) switching the main content. The 任务迭代 tab is a full re-org (spec F1.3): a **Content Head** carries the iteration info (iterationId / gate verdict / branches) with the 5 iteration **Steps laid out horizontally** (current step highlighted, the connector into it lit — no "completed" checkmarks, honest to the schema's current/next/idle states); **未启动（`active === false`）时整体收拢为一行摘要（可展开）**，启动后展开完整 Steps，且同一挂载实例在实时 catalog 更新把 `active` 从 false 翻转为 true 时会自动展开（用户已激活后手动收拢不被覆盖）。下方任务区为**全宽标准 Kanban**（6 列 Todo/InProgress/InReview/Done/Blocked/unknown，Done 溢出沿用 PLAN_CAP，content 区内独立滚动——不再被 canvas 高度压成小坨）；代理执行 / 事件记录两 tab 落 muted 占位页（真实页面由 `agent-canvas` / `event-log` plan 交付）。zone dashboard 布局随之收敛：`WorkflowCanvas` / `IterationZone` 删除，其 zone 级图例项与 footer/gate-summary 样式一并移除，bundle 负向 xyflow 断言保持。
- **dsh plugin**: the Tabs+Content panel was verified in the browser harness on **light + dark** themes — iteration head / horizontal steps / full-width kanban / resident sidebar / tab nav / muted placeholder pages were probed for computed styles in both themes (token flip observable, zero bare colors, `prefers-reduced-motion` run asserts the root kill rule zeroes every transition); the layout invariants were pinned in-browser: page never scrolls, the content area is the only vertical scroll body, the sidebar stays resident across tab switches, and the kanban columns spread the content width (a real layout finding — the kanban column `min-width` is now border-box so the six columns fit at desktop widths instead of overflowing behind the internal scrollbar); evidence in the harness under `{SDD_DIR}/review/harness/` (browser-checklist.md + browser-results.txt).
- **Sync upstream v2.1.1**: merged the upstream `mstar-harness` v2.1.1 line into the dev-dsh branch — adds the `code-reviewer` role (read-only L2 SDD task reviewer / audit executor; replaces `generalPurpose` as the SDD per-task review seat, with generic fallback only when the role agent is absent on the host), ships the canonical default-ignore harness `.gitignore` format (`.mstar/**` + tracked re-includes `AGENTS.md` / `knowledge/` / `specs/`) across the engine, CLI `init` fence and bundled skills, and aligns all 11 version surfaces to 2.1.1.
- **engine**: `emitGitignoreSnippet` / `validateGitignore` / `HARNESS_PROCESS_GITIGNORE` now emit the default-ignore + re-include format instead of the flat per-directory ignore list; `ROLE_MAPPING` grows to 14 ids with `code-reviewer`.
- **bundle-assets**: re-synced `packages/dsh/harness-skills` / `harness-commands` from the merged `skills/` tree — the 6+ upstream-touched bundled skills and all `mstar-host/references/*.md` host adapters (cursor/kimi/omp/opencode/zcode) now carry the v2.1.1 wording (SDD task reviewer → `code-reviewer`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.2.0**.

## [2.1.1] - 2026-08-12

### Harness

- Canonical `.gitignore` snippet now default-ignores the whole harness dir (`<dir>/**`) and re-includes only the tracked results (AGENTS.md, knowledge/, specs/) — new process subdirectories are ignored automatically.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.1.1**.

## [2.1.0] - 2026-08-12

### Harness

- Added a **`code-reviewer` role** (L2): a read-only seat for SDD per-task review and `Task category: audit` / `mstar-audit` execution. PM entry stays `/codebase-audit`; large-repo fan-out uses read-only `scout` / `explore` via Assignment `Delegation: allowed (scout/explore only, read-only)`.
- Wired `code-reviewer` into SDD per-task dispatch (named L2 reviewer id, `generic` fallback), audit routing (`mstar-harness-core`, `commands/codebase-audit.md`), engine `ROLE_MAPPING` (13→14), and the bilingual README role tables; `qc-specialist*` (L3) / QA (L4) semantics unchanged.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.1.0**.

## [2.0.6] - 2026-08-10

### Harness

- Added a **host-agnostic full-flow goal rule** in `mstar-host`: any host exposing a `/goal` command (Codex Goal Mode, omp, future code agents) must set the goal to running the **complete flow to its end** — whether advancing an iteration (start → per-plan cycles → close → PR delivery → merge-ready loop) or non-iteration work (specify → clarify → plan → tasks → implement → plan QC tri + QA gate → Done) — never a sub-stage goal.
- Removed the Codex-specific `references/codex-plan-goal-mode-bridge.md`; goal text rules now live host-agnostically in `mstar-host` SKILL.md, and Codex Plan Mode reads `references/_shared/plan-mode-bridge-core.md` directly.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.6**.

## [2.0.5] - 2026-08-10

### Harness

- `/iteration-start`: accepts an optional `direction` hint (constrains §2 candidates, seeds §3 grill-me — start stays interactive) and a `pause` flag; auto-continues into Phase 2→5 (execute → close → PR → merge-ready) after Phase 1 lock + integration branch, by default. `/iteration-drive` remains standalone for re-entry/resume on an already-locked iteration. Updated `iteration-loop` vs-commands table, README/README_CN command tables + workflow diagrams, OpenCode package quick start; added routing eval `iteration-start-auto-continue-phase2`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.5**.

## [2.0.4] - 2026-08-09

### Harness

- omp plugin: engine-version compatibility — the blocking hook and `mstar_dispatch_validate` no longer statically import `composeDispatchGate`; on engines predating the export the task dispatch gate (Gate 2) is skipped with a one-time warning while the status gate stays active, and the dispatch tool reports an explicit upgrade error instead of silently vanishing (parity with `mstar_iteration_gate`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.4**.

## [2.0.3] - 2026-08-09

### Harness

- omp plugin: in-process engine binding — model-callable mstar_* validator tools + blocking tool_call gate hook (Enforcement: hard only; commands shell-out stays as fallback).
- engine: `iteration.parseCompassFrontmatter` moved from CLI (shared single parser; CLI re-imports from engine).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.3**.

## [2.0.2] - 2026-08-08

### Fixed

- OpenCode plugin entry now default-exports `{ server: MorningStarHarnessPlugin }` so helper function exports are not registered as plugins (fixes `plugin config hook failed: N.config` / `N.dispose` on startup).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.2**.

## [2.0.1] - 2026-08-08

### Fixed

- OpenCode plugin hooks no longer abort-log on non-string `task`/`write` args: Assignment and `status.json` validators refuse non-string input before `.match` / `path.resolve`, and the `tool.execute.before` hook snapshots `prompt`/`filePath` once (avoids getter/Proxy type flips).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.1**.

## [2.0.0] - 2026-08-08

### Harness

- **Bash SDD/rollup scripts removed (engine CLI is the documented path)**: `skills/mstar-sdd/scripts/{sdd-workspace,task-brief,review-package}` and `skills/mstar-plan-artifacts/scripts/tech-debt-rollup.sh` are deleted. Skill text now documents `mstar sdd workspace|task-brief|review-package` and the engine `techDebtRollup` import (`mstar status validate` remains the schema gate); parity tests compare engine output against stored golden fixtures captured from the byte-proven ports (slice 2).
- Added the **`@mstar-harness/engine`** package scaffold: a version-aligned workspace library (`zod` + `ajv`, `node:*` only, no `bin`) with a typed `ValidationResult` + `readHarnessVersion()` placeholder core, wired into the release surface list (10 → 11), changelog assembly, and root workspaces.
- **Engine hardening (QC fix wave, slice 1)**: lease location/orphan/dual-write verify (`lease.verify.*`) moved into `@mstar-harness/engine` (CLI `mstar lease verify` is now a thin wrapper); `archiveResiduals` gained a plan-id path-traversal guard, the status write lock, and append dedup; `withStatusWriteLock` gained an ownership guard (never removes another writer's lockdir), a `holder.pid` crash-diagnosis file, and fast-fail reentrancy detection; `readHarnessVersion` reads the module's own manifest first (published installs no longer regress to `0.0.0`); `tech-debt-rollup` parity now mirrors jq `//` exactly (`false`/`0` edges tested against the bash oracle); residual closed-lifecycle completeness (`closed_at` + `closure_note`) and plan-row `Done` ⇒ no-lease invariants added. Release prep now ensures the `@mstar-harness/engine` registry row + package-history link in root changelog heads.
- **Harness Workflow Engine positioning (iteration v2.0.0)**: unified engine-first descriptions across the 7 plugin manifests and the 4 package manifests; added `workflow-engine` / `workflow-enforcement` / `deterministic-workflow` / `harness-workflow` keywords to the root plugin manifest; re-framed README.md / README_CN.md around deterministic workflow gates enforced by a TS engine (not prompts alone) with judgment staying in `mstar-*` skills, plus a What-ships table (Harness Workflow Engine / mstar CLI / `mstar-*` skills / host adapters).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.0**.

## [1.8.9] - 2026-08-07

### Harness

- Added a portable **Agent Plugins v1.0.0** manifest (`plugin.json`) at the repo root, aligned with the CLI release surface (`skills/` is the Agent Skills component), plus `mstar-harness plugin validate` to check the package (including `mcp.json` / `skills/`) against the Agent Plugins v1.0.0 spec.
- **Phase 5 checkout**: merge-ready product fixes edit **directly** on the control / `spec_integration_branch` checkout; **forbid** opening a separate Phase 5 feature/fix worktree or applying Phase 2's "no product edits on control" rule. SSOT stays in `mstar-iteration` (`phase-4-5-pr-delivery` §5.0); **not** in the general `mstar-branch-worktree` skill.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 1.8.9**.

## [1.8.8] - 2026-08-06

### Harness

- **`mstar-skill-authoring`**: fold the skill-writer 6 principles into the runtime authoring skill — expert process first, compact 5-question body, 1–3 skill routing, per model+harness validation, encode only model gaps, every edit as paired experiment. Body stays the executable gate; full writer loop / output template / anti-patterns → `references/skillsbench-authoring.md` (progressive disclosure).
- Tightened `description` trigger contract with exclusions; keep purpose test / frontmatter / progressive disclosure / review template as reusable SSOT.
- Reframe as **general** skill-authoring guidance (any domain/repo): drop Morning Star / `mstar-*`-only branding from body; keep minimal harness hooks (Load Order + `mstar-host` path resolve) only when working in this repo.
- Restored `## Skill-relative script and asset paths` heading so `mstar-host` § cross-reference stays valid (Post-Skill-Change stale-ref checklist).
- Keep changelog SSOT tight in `AGENTS.md`: §1 owns the fragment rule (including no hand-edit of assembled `CHANGELOG*`); Quality Gate #6 stays the executable check; remove copy-paste repeats elsewhere.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests: **→ 1.8.8**.

## [1.8.7] - 2026-08-06

### Harness

- Made the SDD dispatch templates **host-neutral** so they no longer prime a single host's tool schema: `implementer-prompt.md`, `task-reviewer-prompt.md`, and `implementer-continuation-prompt.md` now use `Dispatch:` / `Role:` / `Name:` / `Prompt body:` labels with an inline host-field map (`omp agent / Cursor subagent_type / OpenCode subagent → mstar-host C5`) instead of Cursor-only fields (`subagent_type`, `description`, `prompt`). The L2 task reviewer template now states the omp `agent` value directly (`reviewer` or `task` + C5b), closing the mapping confusion that produced generic-worker fallbacks under SDD.
- Trimmed the **envelope-first** rationale repeated across `mstar-host/references/omp.md` and `parallel-dispatch.md` to a one-line mechanical rule + SSOT pointer (the long-body prose was itself contributing to attention crowding), and added the L2 reviewer `agent` mapping to the omp SDD section.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests: **→ 1.8.7**.

## [1.8.6] - 2026-08-06

### Harness (dispatch fidelity — invoke field-completeness gate)

- Added a per-item **field-completeness gate** at the dispatch self-check: every Task/subagent invoke must carry the role-binding field matching `Execute as` (omp `agent` / Cursor `subagent_type` / OpenCode `subagent` / Kimi·ZCode `subagent_type`). A missing field (e.g. omp omitting `agent` ⇒ silent generic `task` fallback) is now **dispatch incomplete** — same severity as paste-only zero-invoke — so a bare `tasks:[{task:"…"}]` no longer passes just because invoke count = N. N=1 sequential Review-&-Edit chains are explicitly covered (count gate is vacuous there).
- `mstar-dispatch-gates`: pre-send self-check line + anti-pattern bullet; `mstar-host/references/parallel-dispatch.md`: hard rule + self-check step; `mstar-host/references/omp.md`: Review-&-Edit example now shows a full `task(...)` block per pass (architect / writing-specialist) with `agent` set, plus an N=1 gotcha.
- `.cursor/skills/mstar-routing-eval`: regression signal for "invoke role field missing ⇒ silent generic fallback".

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.6**.

## [1.8.5] - 2026-08-06

### Harness (skill path discovery — runtime surfaces)

- Closed remaining cwd-looking `skills/mstar-*` traps on **shipped runtime surfaces**: Cursor `rules/mstar-entry.mdc` and `rules/mstar-cursor-plan-mode.mdc`, plus omp CLI post-install note in `packages/cli/src/adapters/omp.ts` (now `mstar-host → references/omp.md` / `skill://…`).
- **`mstar-host`**: new § Resolve loaded skill root (per-host prefer + filesystem fallback: omp `skill://`, Cursor plugin checkouts, OpenCode `harness-skills/`, Codex/Kimi/ZCode plugin mounts). Host references point at the table; `mstar-skill-authoring` documents the same anti-pattern for rules/CLI notes.
- INSTALL / `docs/cli.md` Host adapter bullets use the same skill-relative form (not consumer-cwd `skills/mstar-host/references/…`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.5**.

## [1.8.4] - 2026-08-06

### Harness (skill script path discovery)

- **Skill-relative script naming**: runtime docs now reference executables as skill **`mstar-sdd`** → `scripts/<name>` (or `<mstar-sdd>/scripts/…`), not as consumer-cwd paths like `skills/mstar-sdd/scripts/…`. Agents were searching the literal repo-relative path under app checkouts and missing the loaded skill / plugin install location.
- Updated `mstar-sdd` (SKILL + `file-handoffs`), `mstar-plan-artifacts` (`tech-debt-rollup`), `mstar-plan-conventions`, `mstar-iteration`, PM Assignment `SDD dir` cue, and `mstar-skill-authoring` (new “Skill-relative script and asset paths” convention).
- Maintainer `.cursor/LOCAL-VALIDATION.md` keeps `skills/…` smoke commands only for this harness repo root, with an explicit note.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.4**.

## [1.8.3] - 2026-08-05

### Harness (omp role-agent dispatch)

- **omp C5 corrected**: after plugin install/link, discovered `agents/*.md` role ids (`product-manager`, `architect`, `fullstack-dev`, `qc-specialist*`, …) are valid live `task.agent` values. Prefer **`agent: "<Execute as role-id>"`**; use generic `task` / `scout` / … only as fallback when the role is absent from the live schema. Using `agent: "task"` while the matching role agent is listed is an anti-pattern.
- **C5b retained**: even when `agent` already matches the role id, Assignment still requires **Act as + skill load** (agent shell ≠ full Morning Star role prompt).
- Updated `skills/mstar-host/references/omp.md` (self-contained C5 + C5b); `_shared/host-role-binding-core.md` is **Kimi/ZCode only** (no omp rows/mentions — other hosts use their own references), plus `parallel-dispatch.md` and `mstar-host` skill description; aligned INSTALL / `docs/cli.md`. Dropped the README “Host notes / 宿主说明” aside so the Use section stays entry-only.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.3**.

## [1.8.2] - 2026-08-05

### Docs (README + host detection)

- **README** (`README.md` + `README_CN.md`): reorder all host tables to the recommended host order (`omp > OpenCode > Cursor > Kimi = ZCode > Codex`); reorganize **Use** section into General (without iteration) → Iteration → Codebase audit.
- **`mstar-host`**: rewrite the host detection table to use **session tool shapes / available commands only** — `*-plugin/plugin.json` files cannot identify the host (they coexist in this source repo and in any multi-host install). Merge the duplicate Cursor detection rows into one keyed on `subagent_type`.
- **Host references**: strip the same plugin-marker clauses from the `Load when` trigger lines of `codex.md` / `kimi.md` / `zcode.md` / `omp.md`; keep tool-shape / observable-command signals only. Path-reference context lines and bridge `plugin is installed` prerequisites are left as documentation (not detection triggers).
- **omp**: document native internal URL schemes (`skill://`, `local://`, `agent://`, `artifact://`, `history://`) in `references/omp.md`.

### CLI

- `zcode` adapter no longer hardcodes a `PLUGIN_VERSION` constant (it had drifted to `1.6.0`). Marketplace entry generation and `doctor`'s ZCode version check now derive the version from `packages/cli/package.json` via a shared `readHarnessVersion()` helper in `utils.ts` (same helper `index.ts` now uses for `--version`). Fixed stale `1.5.6`/`1.6.0` version strings in `INSTALL.md` and the ZCode adapter.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.2**.

## [1.8.1] - 2026-08-05

### Harness (skills + commands optimization)

- **Lossless optimization** of `skills/` and `commands/` per SkillsBench principles (compact bodies, progressive disclosure, dedup to SSOT). No rule, gate, field name, or NEVER bullet altered or dropped — rules move or compress, never disappear.
- **Extract to `references/`**: `mstar-iteration` Phase 3 → `phase-3-iteration-close.md`, Phase 4/5 → `phase-4-5-pr-delivery.md` (body 574 → 384 lines); `mstar-compound` Q1–Q8 + Phase 1–7 → `compound-workflow.md` (275 → 103).
- **Compress**: `mstar-coding-behavior` 216 → 142 (kept The Ladder, `simplify:` marker, minimal-check); `qc-specialist/deep-review-lenses.md` 11 lens checklists → one-liners (155 → 94).
- **Dedup**: anti-pattern lists → `mstar-harness-core` index; new `_shared/leaf-executor-core.md` (Completion Report + Git NEVER across 9 leaf roles); new `_shared/host-role-binding-core.md` + `_shared/plan-mode-bridge-core.md` (de-clone kimi/zcode/omp host files + 5 plan-mode bridges).
- **Commands → thin orchestrators**: 4 commands 943 → 388 lines (−59%); new `mstar-iteration/references/phase5-helper-discovery.md`.
- **Descriptions**: tightened `coding-behavior`, `branch-worktree`, `phase-gates` frontmatter to trigger contracts.
- **Docs**: recommended host order added to `README.md` + `README_CN.md` (`omp ≥ OpenCode ≥ Cursor > Kimi = ZCode > Codex`).
- **Naming**: `Completion Report v2` → `Completion Report` (template unified; version suffix dropped).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.1**.
## [1.8.0] - 2026-08-05

### Harness (codebase audit skill)

- **New `mstar-audit` skill**: read-only advisory workflow adapted from the [improve](https://github.com/shadcn/improve) skill (MIT, © shadcn). Surveys a repo across 9 categories (correctness, security, performance, tests, tech debt, dependencies, DX, docs, direction), vets findings, prioritizes by leverage, and writes self-contained improvement plans to `{PLAN_DIR}/audit-<date>/`. The `improve` `execute`/`reconcile`/`--issues` variants are not imported — mstar's SDD, `status.json`, and residual tracking replace them.
- **New `plan-quality-bar` reference** (`mstar-plan-artifacts/references/plan-quality-bar.md`): shared standard for self-contained plans — verification gates, STOP conditions, drift check, machine-checkable done criteria. Applies to SDD task-briefs, Prepare plans, and audit plans.
- **New `/codebase-audit` command** (`commands/codebase-audit.md`): standalone entry point. Named with `codebase-` prefix to avoid host command conflicts (follows the `iteration-*` convention). Wiring: `mstar-harness-core` Task category `audit` + skill index; `mstar-phase-gates` Plan quality gate; `mstar-sdd` references; `mstar-roles` architect load entry; `pm` skill entry; `iteration-start` §1 Research optional source.
- **Attribution**: improve (MIT, © shadcn) credited in `mstar-audit/SKILL.md` and `plan-quality-bar.md`.

### CLI (`@mstar-harness/cli`)

- **Codex adapter**: `CODEX_PROJECT_COMMAND_NAMES` (renamed from `CODEX_ITERATION_SKILL_NAMES`) now includes `codebase-audit`; project-scoped install materializes it as `.agents/skills/codebase-audit/SKILL.md`.
- **omp adapter**: smoke test and install notes include `codebase-audit`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.0**.

## [1.7.1] - 2026-08-05

### CLI (`@mstar-harness/cli`)

- **omp doctor**: parse `omp plugin list --json` shape `{ npm, marketplace }` (omp 17.x) instead of only array/`plugins`, and match `manifest.name`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.7.1**.

## [1.7.0] - 2026-08-05

### Harness (omp host surface)

- **omp as sixth host surface**: markers `.omp-plugin/plugin.json` + `.claude-plugin/plugin.json` (plugin root = repo root; mounts `./skills/`, `./commands/`, `./agents/`). New `skills/mstar-host/references/omp.md` covering `task`/`ask`/`hub`, filename slash commands (`/iteration-*`), and C5/C5b built-in `task.agent` + role-in-prompt binding. `omp-plan-mode-bridge.md` for `/plan` dual-write. `mstar-host` detect table + `pm` entry + `parallel-dispatch` updated.
- Install: `omp plugin install github:btspoony/mstar-harness` or `omp plugin link` of the local harness checkout; package list name is root `morning-star`.

### CLI (`@mstar-harness/cli`)

- **`omp` install target**: `npx @mstar-harness/cli init --target omp` ensures `~/.mstar/harness` and runs `omp plugin link` (falls back to `omp plugin install github:btspoony/mstar-harness`). `doctor --target omp` checks markers, smoke skills/commands, and `omp plugin list`. `shared-install` `HARNESS_MARKERS` accepts `.omp-plugin/plugin.json`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.7.0**.

## [1.6.1] - 2026-08-04

### Harness (QC = code reviewer, not test runner)

- **L3 Plan QC clarified as diff/logic review**: `mstar-review-qc` boundaries + `qc-specialist*` workflow/shared NEVER — parallel tri-review on a shared `Review cwd` must **not** run test/build/install/lint/typecheck (peer QC `Blocked` from toolchain contention). Coverage is judged from the **diff**, not by re-running suites.
- **L1 / L4 own runtime evidence**: QA `acceptance-only` reuses implementer/CI/prior-QA logs; QC reports are findings, not the test log. PM Assignment anti-patterns and `qa-trigger-matrix` updated accordingly.
- **OpenCode `qc-specialist*` agents**: bash allowlist trimmed to git + lightweight read-only analysis (removed eslint/tsc/ruff/clippy/etc.).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode plugin manifests: **→ 1.6.1**.

## [1.6.0] - 2026-08-03

### Harness (ZCode host surface)

- **ZCode as fifth host surface**: plugin root = repo root via `.zcode-plugin/plugin.json` (mounts `./skills/`, `./commands/`, `./agents/`); no `sessionStart` (ZCode lacks it — PM entry is manual `/morning-star-harness:pm`). New `skills/mstar-host/references/zcode.md` with tool map written against the real ZCode session tools (`Agent` / `AskUserQuestion` / `EnterPlanMode`·`ExitPlanMode` / `TodoWrite` / `Bash` / `Read` / `Edit` / `Write` / `WebSearch` / `WebFetch` / `TaskOutput`·`TaskStop`), reusing Kimi **C5b role-in-prompt binding** (ZCode ships built-in `subagent_type` profiles only). `zcode-plan-mode-bridge.md` for Enter/Exit dual-write.
- **`mstar-host` SKILL.md**: description, detect-host table, and fallback row now include ZCode.

### CLI (`@mstar-harness/cli`)

- **`zcode` install target**: `npx @mstar-harness/cli init --target zcode` registers a `mstar-local` marketplace in `~/.zcode/cli/plugins/known_marketplaces.json` + `marketplaces/mstar-local/marketplace.json`, both pointing at the **`github:btspoony/mstar-harness`** repo source (matches ZCode's built-in marketplace source shape). Project scope also keeps a local `.zcode/plugin-checkout` for agent-file smoke checks. `doctor --target zcode` validates both JSON files + checkout + gitignore. `shared-install` `HARNESS_MARKERS` now also accepts `.zcode-plugin/plugin.json`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode plugin manifests: **→ 1.6.0**.

## [1.5.6] - 2026-07-28

### Harness (residuals)

- **`Findings cleanup: zero-residual | allow-residual`**: plan-level mode to clear QC/QA findings in-session when possible. Formal **iteration Phase 2** defaults to **`zero-residual`** (fix-now + re-review; open R# only for true blocker-defer + Durable Roadmap). Standalone `/pm`, hotfix, and `inline` keep **`allow-residual`**.
- Assignment field + optional `plans[].metadata.findings_cleanup`; SSOT in `mstar-plan-artifacts` Findings cleanup modes; wired through `mstar-review-qc`, PM NEVER / Assignment template, iteration close checklist, QA trigger note, and routing-eval cases.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.6**.

## [1.5.5] - 2026-07-27

### Harness (worktree / L1)

- **Control-path harness under default gitignore**: process artifacts (`plans/`, `iterations/`, `status.json`, `sdd/`, …) stay local; read/write them via absolute **control worktree** paths. Feature worktrees keep product/source edits only — do **not** waive worktree because feature checkouts lack plans, and do **not** treat “no flock” as a worktree waiver (serial plan parallelism only).
- Assignment fields: absolute **`Control harness root`**, control **`Plan Path`** / **`SDD dir`**, feature **`Worktree path`**.
- **`sdd-workspace`**: `MSTAR_CONTROL_ROOT` / optional control-root arg; fail-closed on linked worktrees without `status.json`.
- Routing-eval cases for no-flock serial + gitignore control-path harness.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.5**.

## [1.5.4] - 2026-07-27

### Harness (Cursor host)

- **`mstar-host` Cursor Task invoke schema**: document flat sibling fields (`prompt` + `subagent_type` + `description`) with examples, anti-patterns (nested/stringified JSON, OpenCode `subagent`, MCP wrap, missing `subagent_type`), and a send-time self-check — reduces first-attempt Task parameter-format failures. Pointer from `parallel-dispatch.md`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.4**.

## [1.5.3] - 2026-07-25

### Harness (commands / frontmatter)

- **Frontmatter YAML**: quote `description` fields that contain `: ` so Cursor/plugin discovery does not drop commands/skills (`iteration-loop`, `mstar-branch-worktree`, `mstar-phase-gates`, `mstar-plan-artifacts`, `mstar-review-qc`, `mstar-sdd`).
- **`/iteration-loop` scale**: add **`XL`** = **>4** business plans (`S`/`M`/`L`/`XL`; default still `M`). SSOT: `mstar-iteration` §1.2 + `references/autonomous-direction-lock.md`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.3**.

## [1.5.2] - 2026-07-23

### Harness (git policy + SPECS_DIR)

- **Process vs results git policy**: default tracked under `{HARNESS_DIR}` — `AGENTS.md`, `knowledge/`, `specs/`; default gitignored — `plans/`, `iterations/`, `status.json`, `sdd/`, `archived/`, `notes.json`. Cross-clone handoff = tracked results + root `CONCEPTS.md` / `STRATEGY.md`; promote residuals via compound instead of default `git add` for `status.json` / `plans/`.
- **`{SPECS_DIR}` resolve order**: `{HARNESS_DIR}/specs/` → `docs/specs/` → repo-root `specs/` (skip empty dirs; greenfield creates `{HARNESS_DIR}/specs/`). Legacy read-compat: non-empty `designs/` paths.
- Aligned: `mstar-plan-conventions`, `mstar-plan-artifacts`, `mstar-sdd` file-handoffs, host Plan-mode bridges, bilingual README, `.cursor/LOCAL-VALIDATION.md`.
- **CLI**: `init`/`doctor` append/check the full process gitignore set (see `packages/cli/CHANGELOG.md`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.2**.

## [1.5.1] - 2026-07-22

### Harness (Phase 5 push cadence)

- **Phase 5 push cadence (HARD)**: CI/review findings may be fixed **locally early**, but **`git push` only after** the previous CI **and** review wave on the current head have **fully completed**. After CI settles, new reviews may continue to be fixed locally; **never push while CI is still running** (cancels/orphans AI reviews — wasted tokens, incomplete results). SSOT: `mstar-iteration` §5.1a; aligned `iteration-drive` / `iteration-loop`; core anti-pattern row.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.1**.

## [1.5.0] - 2026-07-22

### Harness (iteration Phase 2 worktree + lease)

- **Phase 2 control worktree** on `spec_integration_branch` plus per-plan **feature worktree** with `execution_lease` / `integration_merge_lease` (same-host exclusive write lock; serial integration merge; `Done` only after successful merge).
- Multi-session cross-plan parallel implement under leases; `Worktree mode: waived` does **not** bypass the cross-plan parallel safety gate; `Plan parallelism: serial` is scheduling-only.
- Routing-eval updates for lease-gated multi-plan parallel and failure modes; bilingual README Phase 2 defaults.

### Harness (Phase 5 helpers)

- **Phase 5 merge-ready helpers**: prefer `babysit` or any `*-babysit` skill; `greploop` is **optional** only when the repo has Greptile/`greploop`. When both apply, run babysit/`*-babysit` first, then optional greploop. Updated `mstar-iteration` §5 pointer + `commands/iteration-drive` / `iteration-loop`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.0**.

## [1.4.0] - 2026-07-17

### Harness (Kimi Code host)

- **Kimi host support**: `.kimi-plugin/plugin.json` (host-folder layout aligned with Cursor/Codex; `sessionStart.skill: pm`); `mstar-host` Kimi reference / Plan-mode bridge; role binding in Agent prompts (built-in `coder` / `explore` / `plan` only).
- **Install**: primary path is Kimi TUI `/plugins install https://github.com/btspoony/mstar-harness` then `/plugins reload` (no CLI `--target kimi`).
- Plugin commands: `/morning-star-harness:iteration-start` · `iteration-drive` · `iteration-loop`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.4.0**.

## [1.3.2] - 2026-07-15

### Harness (Cursor Plan Phase 1 feedback-driven)

- **`/iteration-start` Cursor Plan path**: feedback-driven loop — user gives direction/opinions only; agent explores, recommends, and updates the plan. `grill-me` is deferred until feedback-close and only if blocking gaps remain.
- **Single CreatePlan URI (HARD)**: CreatePlan once per Phase 1 Plan session; subsequent updates edit that same file in place; merge and delete accidental duplicates.
- **`mstar-host` / rule / `mstar-iteration` §1.2**: Phase 1 Plan UX documents feedback-driven updates and recommended branch policy (no silent `main`/`master`).
- **Routing eval v20**: `iteration-phase1-cursor-plan-feedback-driven`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.3.2**.

## [1.3.1] - 2026-07-13

### Harness (iteration package layout)

- **`iterations/<id>/` directory-first**: compass moves to `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` with sibling `guides/` / `specs/` / optional package `README.md`. Root `{ITERATION_DIR}/README.md` indexes **one row per iteration** (no compass + workspace double entries).
- **Legacy read compat**: flat `{ITERATION_DIR}/<id>-delivery-compass.md` remains readable; new writes must use the package path.
- Touches: `mstar-iteration` (+ references), `mstar-compound` package promotion, `mstar-plan-conventions` / `mstar-plan-artifacts` path docs, role shells, `/iteration-start` · `/iteration-drive` · `/iteration-loop`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.3.1**.

## [1.3.0] - 2026-07-11

### Harness (bootstrap absorb)

- **Retire `/mstar-bootstrap` command**: the 7-phase project knowledge bootstrap procedure moves to `mstar-compound-refresh/references/project-knowledge-bootstrap.md`; `mstar-compound-refresh` and `mstar-harness-core` carry short pointers.

### CLI (Codex iteration skills)

- **Project-scoped Codex install**: materializes `iteration-start`, `iteration-drive`, and `iteration-loop` as `.agents/skills/*/SKILL.md` symlinks from bundled harness commands; `doctor` validates links; global install skips with an explicit warning.

### Docs

- **Root `INSTALL.md`**: machine-readable install steps extracted from READMEs.
- **Slim bilingual READMEs**: CLI-first Quick Start; clarify `/iteration-start` → `/iteration-drive` vs `/iteration-loop` usage paths.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.3.0**.

## [1.2.1] - 2026-07-10

### Harness (Cursor Plan mode × Phase 1 staged direction lock)

- **`/iteration-start` Cursor Plan path**: after Boot, Plan mode creates a blank Phase 1 CreatePlan scaffold first, then runs dynamic staged `grill-me` that updates the plan each stage; Review & Edit / lock / integration branch run only after **Build**. Agent / OpenCode keep Research → Explore → grill-me → Write → Review.
- **`mstar-host` Cursor bridge / rule**: document `mstar-iteration` Phase 1 in Plan mode (no command-name reverse refs in skills).
- **`mstar-iteration` §1.2**: host Plan UX may scaffold then converge interactively; non-Plan hosts unchanged.
- **Routing eval v19**: `iteration-phase1-cursor-plan-staged-grill`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.2.1**.

## [1.2.0] - 2026-07-10

### Harness (`/iteration-loop` + autonomous direction lock)

- **`/iteration-loop`**: new PM command for autonomous full Phase 1→5 (cloud-agent friendly). Optional args `direction` + `scale` (`S`\|`M`\|`L`, default `M`); code-first auto direction lock (no grill-me); sequential Review & Edit chain retained; Continuous execution through Phase 5 merge-ready. Distinct from `/iteration-start` (Phase 1 + grill-me) and `/iteration-drive` (Phase 2→5 only).
- **`mstar-iteration` §1.2**: direction lock modes `interactive` | `autonomous`; scale budget counts **business plans only** (harness process excluded); autonomous branch resolve order. Detail → `references/autonomous-direction-lock.md` (skills remain capability providers — no command-name reverse refs).
- **Docs**: README / README_CN / OpenCode package README command tables distinguish start / drive / loop.
- **Routing eval v18**: `iteration-loop-autonomous-direction-lock` — no routine direction yes/no; no grill-me; no silent `main` default; no process plans in scale budget.

### CLI / CI / release

- **OpenCode `init` fast path**: no interactive model picking and no `opencode models` discovery (that call could hang with no feedback). Default writes `$schema` + `@mstar-harness/opencode@latest` only; OpenCode default models apply. Optional `--*-model` flags remain as advanced overrides.
- **CI**: path-filtered builds for `packages/cli`, `packages/opencode`, and bundled `skills`/`agents`/`commands`; includes CLI smoke check + pack.
- **Release**: use Node 24 bundled npm for Trusted Publishing; remove broken `npm install -g npm@latest` on Node 22 (fixes `MODULE_NOT_FOUND: sigstore`); build packages before publish.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.2.0**.

## [1.1.0] - 2026-07-08

### Harness (ephemeral review bundles)

- **Review bundle default**: raw QC/QA process reports now live under `{SDD_DIR}/review/` (gitignored), while tracked handoff artifacts are durable main-plan gate summaries and `{HARNESS_DIR}/status.json` residual findings.
- **Legacy tracked reports**: `{PLAN_DIR}/reports/` is now legacy / explicit audit mode only, not the default QC/QA report target.
- **Iteration compass**: add a `Quality Gate Summary` section for iteration-level QC/QA verdict and residual rollups without replacing per-plan summaries or `status.json`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.1.0**.

## [1.0.6] - 2026-07-08

### Harness (SDD per-task reviewer dispatch)

- **`mstar-sdd`**: pin L2 per-task reviewer to **`subagent_type: generalPurpose`**; forbid `qc-specialist*` at task scope (plan QC tri remains L3 after all tasks).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.6**.

## [1.0.5] - 2026-07-07

### Harness (tiered QA gate + role-scoped QC/QA refs)

- **Tiered QA gate** (`mandatory` | `pm-acceptance` | `report-only`) with PM dispatch matrix (`qa-trigger-matrix.md`); hotfix/small clean backend defaults to `pm-acceptance`; medium+, UI, and residual work still requires mandatory QA.
- **L4 acceptance narrowing** (`qa-engineer/acceptance-gate.md`): evidence reuse from QC consolidated output; no default full test re-run when `QA mode: acceptance-only`.
- **Role-scoped execution refs**: leaf QC → `mstar-roles/references/qc-specialist/`; L4 QA → `qa-engineer/`; **`mstar-review-qc`** slimmed to PM orchestration only.
- **Positive-only skill load lists** per role (what to read) — avoid priming leaf agents to load `mstar-review-qc`.
- **Routing eval v17**: hotfix/small-backend `pm-acceptance`; UI remains `mandatory`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.5**.

## [1.0.4] - 2026-07-07

### Harness (parallel implement worktree gate)

- **New `mstar-branch-worktree/references/parallel-writable-pre-dispatch.md`**: SSOT pre-dispatch checklist for same-repo **≥2 concurrent writable implement** tracks — `git worktree add`, absolute **`Worktree path`**, PM stays on integration branch, emit-zero until ready.
- **`mstar-dispatch-gates`**: **Dual-gate table** — tool concurrency (N invokes in one message) vs same-repo write isolation; clarifies **N invoke ≠ worktree compliance**.
- **`mstar-branch-worktree`**, **`mstar-iteration`**, **`mstar-phase-gates`**, **`project-manager`**, **`dispatch-and-assignment`**, **`fullstack-dev-shared`**: thin pointers to the reference; deduped repeated checklist prose.
- **`mstar-harness-core`**: anti-pattern index entry for parallel implement without worktree.
- **Routing eval v16**: hard-fail parallel implement batches missing per-track **`Worktree path`**; strengthen worktree assertions on parallel dev cases.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.4**.

## [1.0.3] - 2026-07-07

### Harness (iteration continuous execution)

- **`iteration-drive`**: Add **Continuous execution (HARD)** for Phase 2–5 — no routine yes/no check-ins after progress reports; turn must end with in-flight dispatch; per-plan serial implement loop; explicit legal STOP boundaries.
- **`mstar-iteration` §2.6**: Expand **Push discipline (Autonomous Execute)** — continuous execution through Phase 5 merge-ready exit; no confirmation questions between tasks, plans, or phases.
- **`pm` skill**: Restore **Autonomous Execute push** as rule 4; iteration semantics SSOT → **`mstar-iteration`** only (no command names in runtime skills).
- **Skills command-agnostic cleanup**: Remove `iteration-drive` references from runtime `mstar-*` skills (host refs, project-manager, sticky implementer, dispatch-and-assignment).
- **Routing eval v15**: Hard-fail mid-execute user check-ins; new `iteration-drive-continuous-after-plan-wave` case.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.3**.

## [1.0.2] - 2026-07-07

### Harness (iteration artifact boundaries)

- **`mstar-iteration` §1.5.5 / §1.6**: Tighten Phase 1 boundaries — `{SPECS_DIR}/` for locked long-lived specs; `{ITERATION_DIR}/<iteration-id>/` workspace (`guides/`, `specs/`) for iteration-scoped drafts; **no** `{KNOWLEDGE_DIR}/` writes during iteration-start.
- **`iteration-start` / `mstar-dispatch-gates`**: Review & Edit chain — product-manager / architect edit specs + workspace; writing-specialist **specs corpus hygiene** and existing-knowledge archive only.
- **`mstar-compound`**: Mandatory **iteration workspace promotion** at iteration-close — inventory `<iteration-id>/` workspace; promote worthy specs/guides to `{KNOWLEDGE_DIR}/` (structured rewrite, not raw copy).
- **New references**: `iteration-artifact-boundaries.md`, `iteration-corpus-hygiene.md`, `iteration-workspace-readme-template.md`; `knowledge-and-designs.md`, role refs, and `artifact-storage-paths.md` aligned.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.2**.

## [1.0.1] - 2026-07-07

### Harness (SDD iteration-drive + sticky implementer + pm shim)

- **`iteration-drive` / `mstar-iteration`**: Phase 2 explicitly mandates per-task SDD loop (`mstar-sdd` in Boot, `task-brief` → implementer → `review-package` → task reviewer); forbids bulk inline implement Assignments for multi-task plans.
- **Sticky implementer session** (`SDD implementer session: sticky`): optional same dev subagent across tasks via host resume (Cursor Task `resume`); `implementer-session.json` ledger; **task reviewers stay fresh** per task. Docs: `mstar-sdd/references/sticky-implementer-session.md`, `implementer-continuation-prompt.md`.
- **`pm` skill**: thinned to cross-host entry shim (Codex/Cursor `/pm`); iteration lifecycle Boot lives in **`commands/`**; SSOT → `project-manager.md` + topic skills.
- **Assignment / dispatch**: `dispatch-and-assignment.md` SDD vs inline table; `SDD implementer session` field on template.
- **Routing eval v14**: iteration Phase 2 SDD hard-fails; new `sdd-sticky-implementer-multi-task` case.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.1**.

## [1.0.0] - 2026-07-07

### Harness (SDD + plan QC tri-review)

- **New `mstar-sdd` skill**: file handoff, per-task implementer + **task reviewer** (L2), progress ledger under `{SDD_DIR}`.
- **Plan QC with SDD**: **mandatory tri-review** (QC#1/#2/#3 cross-review on branch diff, **N=3**) when **`Execution mode: sdd`** — single-plan **and** iteration. **Not** a lone final single-seat review.
- **Single-seat `qc.md`**: only `Execution mode: inline` / hotfix or explicit user override.
- **Plan template**: `plan.main.md` with Global Constraints, per-task Interfaces, self-review gate; `status.json` optional `sdd_dir`, `task_commits[]` metadata.
- **PM Assignment**: `Execution mode`, `SDD dir`, `Model tier`; implement default SDD for multi-task plans.
- **CLI**: project `init`/`doctor` append/check `.mstar/sdd/` gitignore entries.
- **Routing eval v11**: SDD + mandatory tri-review; inline/hotfix single-seat.

### Breaking changes

1. Multi-task implement defaults to **`Execution mode: sdd`** (single-plan and iteration).
2. **With SDD**: plan QC is **mandatory tri-review** (QC#1/#2/#3); per-task review is **task reviewer**, not QC.
3. **Single-seat `qc.md`** only for `inline` / hotfix or explicit override.
4. New plans: **Global Constraints** + per-task **Interfaces**.
5. `.mstar/sdd/` ephemeral scratch — gitignore required.

### Superpowers v6 note

Mstar adds L2 **task reviewer** per task; L3 **tri cross-review** retained (not v6's single final reviewer only). See `.harness/specs/sdd-1.0.0-design.md`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.0**.

## [0.7.9] - 2026-07-06

### Harness (Assignment plain role ids / OpenCode `@` hygiene)

- **Assignment SSOT**: `dispatch-and-assignment.md` template, PM routing table, and `project-manager.md` Language rule — all role references in Assignment **body** use **plain role ids** (no `@`); host invoke uses task tool **`subagent`** matching `Execute as`.
- **`mstar-dispatch-gates`** and **leaf-executor checklist**: anti-recursion NEVER rules reworded to `role-id` mentions (not `@<role>` literals).
- **`mstar-host/references/opencode.md`**: Role-mention hygiene — Assignment prose vs task-tool dispatch; warnings avoid `@` literals that trigger OpenCode auto-dispatch.
- **Iteration commands**, **`mstar-branch-worktree`**, **`mstar-plan-artifacts`** (plan checkbox duties), **`pm` skill**, and **role NEVER** references aligned on plain ids.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.8 → 0.7.9**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.8] - 2026-07-06

### Harness (iteration Phase 4–5 / PR merge-ready loop)

- **`mstar-iteration` Phase 4–5**: Extend lifecycle to **PR delivery** (Phase 4) and **PR merge-ready loop** (Phase 5) — verify/fix/re-verify until mergeable, required CI green, and review threads resolved (with per-thread comment + resolve after fixes). Loop SSOT stays in `mstar-*`; no back-reference to host commands.
- **`iteration-drive`**: Sequences Phase 2 → 3 → 4 → 5; **Done** only after Phase 5 exit checklist. Optionally discovers **non-`mstar-*`** helper skills (`greploop`, `babysit`) for Phase 5; fallback mode matches babysit gates (CI + reviews).
- **`mstar-harness-core`**: Iteration lifecycle index and anti-pattern for skipping Phase 5 after PR creation; PM load contract covers `mstar-iteration` Phase 1–5.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.7 → 0.7.8**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.7] - 2026-07-04

### Harness (standalone `mstar-*` / decouple third-party runtime)

- **Standalone harness invariant** (`mstar-harness-core`): `mstar-*` skills must not require external skills, CLIs, or MCPs in load order; library/API questions use in-repo Read/Grep first.
- **Bundled `grill-me` for `/iteration-start` only**: added `skills/grill-me/SKILL.md`; command §3 is the sole reference — not in `mstar-*` index or load matrix. `mstar-iteration` §1.2 adds generic **Direction lock** without naming grill-me.
- **Removed third-party coupling from runtime paths**: deleted `library-docs-protocol.md` (Context7), `openviking-memory-plugin.md` (OpenViking); removed Context7 section from `mstar-host`; Open Design integration from `mstar-design-md`; optional MCP table from `mstar-host/references/opencode.md`.
- **`open-harness-principles.md` distilled**: harness terminology table moved into `mstar-harness-core`; AGENTS.md layering → `mstar-plan-conventions/references/harness-bootstrap-and-agents-layering.md`; file removed.
- **`mstar-roles`**: keep **Role → typical topic skills** cross-role matrix; topic index remains in `mstar-harness-core`. **`prompt-engineer`** retains **`skill-creator`** requirement for new/major skill work (`AGENTS.md` documents standalone exception).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.6 → 0.7.7**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.6] - 2026-07-01

### Harness (iteration dispatch / commands–skills layering)

- **Commands vs skills layering**: `iteration-start` and `iteration-drive` own orchestration (boot order, phase state machine, step checklists); `mstar-iteration` and `mstar-dispatch-gates` stay command-agnostic. Removed circular skill ↔ command references.
- **`iteration-start` / `iteration-drive`**: PM invariants, Phase 2→3→PR transition gates, dispatch-turn discipline, Phase 3 PR precondition; `phase-3-iteration-close` host todo when one plan remains.
- **`mstar-iteration`**: Phase transition gates table; §2.5 dispatch-turn rules; compass template fields keyed by Phase 1–3 (not command names).
- **`mstar-dispatch-gates`**: **Specialist review-and-edit dispatch** (generic); Phase 1 chain is **sequential**; anti-patterns for paste-only dispatch and skipped Phase 3.
- **`mstar-host`**: Removed Mode A/B/C supplemental execution paths; canonical invoke dispatch with **`Blocked`** when no callable tool; `codex.md` and `parallel-dispatch.md` aligned.
- **`pm` skill**: Iteration sections deduplicated — single pointer to `mstar-iteration`.
- **Phase 1 Review & Edit chain**: **Sequential** `product-manager` → `architect` → `writing-specialist` (each invoke after prior role’s disk revisions); parallel batch forbidden for this chain.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.5 → 0.7.6**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.5] - 2026-07-01

### Harness (iteration / branch policy)

- **Explicit iteration branch policy**: Formal iterations require recorded `iteration_base_branch`, `spec_integration_branch`, and `target_branch` in compass frontmatter and `status.json` metadata. Agents must not silently default to `main` / `master` for integration branch creation or final PR targets.
- **`iteration-start` / `iteration-drive`**: Grill-me branch confirmation, pre-commit checklist branch fields, §2.0 branch metadata gate, and explicit `git checkout -b <spec_integration_branch> <iteration_base_branch>` when creating the integration branch.
- **`mstar-iteration` §2.3**: Metadata resolution chain (`status.json` → compass frontmatter → ask user); QC `Review range` merge-base uses `target_branch` or PM-specified ref.
- **Compass template**: Add `## Delivery Branch Policy` section; `status-and-residuals.md` documents example metadata JSON.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.4 → 0.7.5**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.4] - 2026-07-01

### Harness (skills / docs)

- **Remove Superpowers dependency from Morning Star runtime**: removed Superpowers install guidance and alignment wording; Morning Star assignments now rely on native dispatch, worktree, plan, review, and evidence contracts.
- **Consolidate execution practices into `mstar-coding-behavior`**: deleted `mstar-execution-practices`; moved review feedback handling into `mstar-coding-behavior`; RCA, test-first checks, and completion evidence now stay in coding behavior while PM gate evidence remains in `mstar-phase-gates` / `mstar-review-qc`.
- **Add `mstar-skill-authoring`**: new Morning Star-native skill authoring guidance for trigger contracts, progressive disclosure, pressure scenarios, and behavior-change evidence. The prompt-engineer role must read it before creating skills, major rewrites, or trigger-description changes.
- **Docs and host adapters**: README / README_CN, OpenCode install docs, role references, and host references no longer require external skill plugins.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.3 → 0.7.4**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.3] - 2026-06-30

### Harness (iteration-close / commands / docs)

- **`mstar-iteration` Phase 3 close gate**: iteration-close is now an explicit independent phase after all plans are `Done`; final plan closure can provide input but does not satisfy close. Close requires compass shape normalization when needed, close entry/exit checklists, compound round, roadmap update, compass frontmatter `status: completed` + `end_date`, and integration-branch commit before PR.
- **Compass template hardening**: New compass templates no longer prefill `end_date`; `## Roadmap Position`, `## Compound Round Summary`, and `## Iteration Retrospective (minimal)` are the expected close-write targets. Legacy prose completion status must be normalized into YAML frontmatter during close.
- **Compound indexing gate**: Each new knowledge doc created in an iteration-close compound round must complete `mstar-compound` Phase 6 and be registered in `{KNOWLEDGE_DIR}/README.md`, including lightweight captures.
- **README / README_CN**: Harness Commands now list `/mstar-bootstrap`, `/iteration-start`, and `/iteration-drive`; Harness Workflow now reflects `iteration-start → per-plan execute loop → iteration-close → PR`; Core Skills table now includes iteration, design, compound, compound-refresh, and strategy skills.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.2 → 0.7.3**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.2] - 2026-06-30

### CLI / Cursor install

- **Cursor plugin path layout**: `mstar-harness init --target cursor` now installs a **real git checkout** at the Cursor plugin path (`git clone` / `git pull`), not a symlink to `~/.mstar/harness`. Cursor does not discover symlinked plugin directories.
- **`doctor --target cursor`**: fails if the plugin path is a symlink; `init` removes an existing symlink and clones.
- **Docs**: `docs/cli.md` § Install path layout; README/CN manual install and maintainer refresh notes updated.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.1 → 0.7.2**. **`@mstar-harness/cli`**: **0.5.3 → 0.5.4**.

## [0.7.1] - 2026-06-30

### Harness (skills / iteration-start)

- **`/iteration-start` Review & Edit chain hard gate**: Step 5 is mandatory before integration branch commit — dispatch `@product-manager`, `@architect`, and `@writing-specialist` via Task (parallel when independent); PM thread must not substitute by performing all specialist edits itself. Done = edited compass/plans/specs + compass `status: locked`, not draft artifacts on disk.
- **`mstar-iteration` §1.6**: Documents the review chain as an integration-branch precondition (skill SSOT); no separate `reports/<iteration-id>/` review files — unlike per-plan QC, iteration review has no downstream audit chain.
- **`skills/pm`**, **`mstar-dispatch-gates`**, **`mstar-harness-core`**: iteration-start dispatch-first rules, anti-patterns, and pre-commit checklist aligned with command §5.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.0 → 0.7.1**. **`@mstar-harness/cli` remains 0.5.3**.

## [0.7.0] - 2026-06-30

### Harness (skills / iteration, compound, strategy, qc, commands)

- **New `mstar-compound` skill**: Knowledge crystallization with Bug/Knowledge dual-track templates, YAML frontmatter schema, 8-question self-diagnosis checklist, overlap detection (update existing docs rather than create duplicates), discoverability check (propose AGENTS.md edits), and CONCEPTS.md vocabulary synergy. Compound executes at **iteration-close**, not per-plan Done.
- **New `mstar-compound-refresh` skill**: Knowledge maintenance — audit/update/consolidate/replace/delete knowledge docs against current codebase, CONCEPTS.md reconciliation.
- **New `mstar-strategy` skill**: STRATEGY.md creation and maintenance as project upstream anchor (vision, technology direction, guiding principles, decision log).
- **New `mstar-iteration` skill**: Full iteration lifecycle management — Phase 1 iteration-start (scope/roadmap lock, compass creation), Phase 2 Autonomous Execute (per-plan dispatch loop: branch → implement → QC → QA → Done → merge, cross-plan progress sync), Phase 3 iteration-close (compound round, roadmap update, retrospective, commit). Autonomous Execute driver moved here from `skills/pm/SKILL.md`; PM skill thinned to role identity, host entry, and dispatch-first rules only.
- **New `/mstar-bootstrap` command**: Distills STRATEGY.md, CONCEPTS.md, and baseline knowledge docs from existing codebase for projects with no/stale knowledge infrastructure (7-phase flow).
- **New `artifact-storage-paths.md`**: Single SSOT for all harness artifact paths under `mstar-plan-conventions`, referenced by all producing skills to prevent path drift.
- **QC deep review lenses**: Replaced persona subagent dispatch with self-applied lens checklists (12 lenses, 6 trigger signals). No subagent dispatch — resolves anti-recursion violation with `mstar-dispatch-gates`.
- **Updated index**: `mstar-harness-core` split lifecycle into per-plan and iteration-level cycles; all skill index tables, `mstar-roles` dependency matrix, and `mstar-phase-gates` per-plan gates updated.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.6.22 → 0.7.0**. **`@mstar-harness/cli` remains 0.5.3**.

## [0.6.22] - 2026-06-27

### Harness (skills / dispatch-gates, roles)

- **Anti-recursion: identity-deprivation framework replaces prohibition-only rules**: Leaf executors (QC reviewers, devs, QA) were still entering a "consider dispatch" intent window because `NEVER` / `MUST NOT` prohibitions require the model to first activate the forbidden action before suppressing it. Fix shifts semantics from "you must NOT use Task" (prohibition) to "you ARE a leaf executor; Task is NOT your tool" (identity + capability deprivation).
  - Assignment template (`dispatch-and-assignment.md`): new **IDENTITY** + **CAPABILITY BOUNDARY** blocks before the `**You MUST NOT:**` list. `Delegation` field moved immediately after `Execute as` for earlier visibility.
  - `mstar-dispatch-gates/SKILL.md`: leaf-executor identity preamble placed between Load order and NEVER list, with explicit cross-reference back to the Assignment's IDENTITY block.
  - `qc-specialist-shared`: `Non-Recursive Dispatch Rule` rewritten as a first-person identity assertion with recursive-dispatch trap recognition ("If you ever think 'this would be more efficient if I dispatched X' — stop").
  - `leaf-executor-checklist`: first-person preamble before checklist items.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`: **0.6.21 → 0.6.22**. **`@mstar-harness/cli` remains 0.5.3**, Cursor / Codex plugin manifests remain **0.6.21**.

## [0.6.21] - 2026-06-26

### Harness (skills / design-md)

- **DESIGN.md YAML frontmatter as SSOT**: `mstar-design-md` templates and spec now use YAML frontmatter as the single source of truth for token values. Template format bumped to 0.1.0. Both light (`DESIGN.md.template`) and dark (`DESIGN.dark.md.template`) templates, the spec reference, completeness checklist, and the Vercel example updated.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, and Cursor / Codex plugin manifests: **0.6.20 → 0.6.21**. CLI: **0.5.2 → 0.5.3**.

## [0.6.20] - 2026-06-26

### Harness (commands)

- **`/iteration-start` Review & Edit Chain**: Changed §5 from "Review Chain" to "Review & Edit Chain". Each role (product-manager, architect, writing-specialist) now reviews AND directly edits the documents rather than only flagging issues. PM only steps in for the final review and lock, no longer burdened with aggregating edits from other reviewers.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.19 → 0.6.20**. **`@mstar-harness/cli` remains 0.5.2**.

## [0.6.19] - 2026-06-26

### Harness (skills / coding-behavior)

- **Distill Ponytail principles into `mstar-coding-behavior`**: Strengthened all four sections with distilled concepts from the Ponytail coding discipline:
  - **§1 Think Before Coding**: Added "Never lazy about understanding" — read the full task and every touched file before editing; a small diff in the wrong place is a second bug, not efficiency.
  - **§2 Simplicity First**: Added YAGNI gate ("does this need code at all?"), The Ladder (7-level decision hierarchy: YAGNI → reuse existing → stdlib → native platform → installed dep → one line → minimal code), "Deletion over addition / Boring over clever", and `simplify:` marker discipline (name the ceiling and upgrade path for deliberate shortcuts).
  - **§3 Surgical Changes**: Added "Bug fix = root cause, not symptom" — before editing, grep every caller; fix once at the narrowest shared point, not only the path the ticket names.
  - **§4 Goal-Driven Execution**: Added "Minimal check for non-trivial logic" — any non-trivial change must leave behind ONE runnable check (assert, minimal demo, or single test); YAGNI applies to tests too.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.18 → 0.6.19**. **`@mstar-harness/cli` remains 0.5.2**.

## [0.6.18] - 2026-06-26

### Harness (commands)

- **`/iteration-start` Boot section**: Add explicit `## 0. Boot` section aligned with `/iteration-drive`. Loads `mstar-harness-core`, `mstar-roles` → `references/project-manager.md`, `skills/pm/SKILL.md` (Host entry + Boot), `mstar-phase-gates` (Prepare), and `mstar-plan-conventions` / `mstar-plan-artifacts` before starting research.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.17 → 0.6.18**. **`@mstar-harness/cli` remains 0.5.2**.

## [0.6.17] - 2026-06-26

### Harness (commands)

- **`/iteration-drive` PR target fix**: Resolve the final PR target branch from iteration metadata (`status.json` → `target_branch`) instead of hardcoding `main`. Defaults to `main` when `target_branch` is not set.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.16 → 0.6.17**. **`@mstar-harness/cli` remains 0.5.2**.

## [0.6.16] - 2026-06-25

### Harness (commands)

- **New `/iteration-drive` command**: Add a command that invokes the PM Autonomous Execute driver (`skills/pm/SKILL.md` § Autonomous Execute driver) to drive all non-`Done` plans to completion. The command checks the three precondition gates first; if Prepare is incomplete, it directs the user to `/iteration-start`. Otherwise, it runs the full implement → QC → QA → Done per-plan loop until every plan is `Done`, then optionally creates a PR from the integration branch to `main`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.15 → 0.6.16**. **`@mstar-harness/cli` remains 0.5.1**.

## [0.6.15] - 2026-06-24

### Harness (commands)

- **New `iteration-start` command**: Add a reusable command (`/iteration-start`) to bootstrap a new harness iteration. The command guides PM through six checkpointed steps: research (structured harness dirs + unstructured glob for `roadmap*.md`, `deferred*.md`, `features*.md` etc.), explore candidate directions for product completeness, lock direction with `grill-me`, write iteration compass and plans, run the review chain (`@product-manager` → `@architect` → `@writing-specialist` → PM lock), and create the iteration integration branch from `main`. Registered for both Cursor (`commands/` auto-discovery) and OpenCode (`harness-commands/` bundled via plugin code).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.14 → 0.6.15**. **`@mstar-harness/cli` remains 0.5.1**.

## [0.6.14] - 2026-06-24

### Harness (skills / design-md)

- **New `mstar-design-md` skill**: Add a specialized skill for creating, auditing, and maintaining project-level `DESIGN.md` design system specifications. Three-level completeness checklist (MVP/Standard/Production) defines progressively what an agent needs from a design system to generate consistent UI without guessing tokens. Includes Vercel Geist as annotated reference, light/dark dual-theme support (`DESIGN.md` + `DESIGN.dark.md` with same token names, different values), and built-in `LEVEL*_PLACEHOLDER` markers for iterative maturity upgrades. Skill ships with full references (`design-md-spec.md` norm, `completeness-checklist.md`, `vercel-example.md`) and templates (`DESIGN.md.template`, `DESIGN.dark.md.template`).
- **Phase gate: DESIGN.md check**: PM Prepare quick-check adds "if plan involves UI work, does DESIGN.md exist and meet the declared completeness level."
- **Role integration**: `mstar-design-md` registered in all relevant role dependencies — architect as primary creator, product-manager for design intent/requirements, frontend-dev and fullstack-dev as consumers (read tokens before implementing styled UI), qc-specialist as verifier (check UI alignment with DESIGN.md), qa-engineer for visual output verification.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.13 → 0.6.14**. **`@mstar-harness/cli` remains 0.5.1**.

## [0.6.13] - 2026-06-20

### Harness (agents)

- **Drop `model: inherit` from role frontmatter**: Remove the `model: inherit` line from all 13 `agents/*.md` files. These agents inherit the default model via the plugin manifest rather than an explicit per-agent override, reducing frontmatter noise and avoiding confusion with model pinning. (Cursor-only frontmatter cleanup.)

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.12 → 0.6.13**. **`@mstar-harness/cli` remains 0.5.1**.

## [0.6.12] - 2026-06-20

### Harness (skills / dispatch gates)

- **Assignment anti-pattern header**: Every PM Assignment now opens with a `**You are a leaf executor. You MUST NOT:**` block containing the most likely dispatch violations for the assignment's situation. PM fills it with context-specific anti-patterns on top of the universal floor (no recursive dispatch, no interpreting routing text as invoke, available ≠ authorized). The `Orchestration Guard` section references this new top block. (`mstar-roles/references/project-manager/dispatch-and-assignment.md`)
- **Leaf executor checklist**: Updated to require reading the `**You are a leaf executor. You MUST NOT:**` block first on every assignment. (`mstar-dispatch-gates/references/leaf-executor-checklist.md`)
- **Dispatch gates**: Added a reference to the new assignment-level anti-pattern block in the anti-recursion section. (`mstar-dispatch-gates/SKILL.md`)

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.11 → 0.6.12**. **`@mstar-harness/cli` remains 0.5.1**.

## [0.6.11] - 2026-06-16

### Cursor plugin / agents

- **Subagent registration**: Reorder all `agents/*.md` frontmatter to Cursor-first schema (`name`, `description`, `model: inherit` before OpenCode `mode`/`tools`/`permission`) so plugin manifest `agents/` are discovered as Task subagents without a separate `~/.cursor/agents/` install step.
- **CLI Cursor install path**: Align global/project plugin symlinks to `morning-star-harness` (matching `.cursor-plugin/plugin.json` `name`).
- **CLI doctor**: Validate plugin agent files exist and use Cursor-first frontmatter.
- **Docs**: Update README (EN/CN), CLI guide, plugin README, LOCAL-VALIDATION subagent smoke test, and `mstar-host` Cursor reference.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.10 → 0.6.11**.
- Bump `@mstar-harness/cli`: **0.5.0 → 0.5.1**.

## [0.6.10] - 2026-06-11

### Harness (skills / agents)

- **Profile B Done compaction (`plans-done.json`)**: Canonical schema is now **`{ "plans": [<plan-id>, ...] }` only** — no rich catalog objects (`title`, `done_at`, `plan_file`, `archived_record`, etc.). Per-plan detail stays in `archived/plans/<plan-id>.json` (a single `plans[]` row snapshot). SSOT: `mstar-plan-artifacts/references/done-compaction.md`.
- **Templates & bootstrap**: Add `templates/plans-done.empty.json`; document Profile B init in `mstar-plan-conventions` harness bootstrap and PM `plan-management.md`.
- **Profile B constraints**: Disallow parallel indexes (`_index.json`, object-array catalogs); migrate legacy `plans-done.json` by rewriting to id list only.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.9 → 0.6.10**. **`@mstar-harness/cli` remains 0.5.0**.

## [0.6.9] - 2026-06-09

### Harness (skills / agents)

- **`pm` (PM orchestration entry)**: Generalize beyond Cursor/Codex `/pm` only — **Cursor/Codex** use `/pm` as `project-manager` launcher and autonomous Execute driver; **OpenCode** switches to PM orchestration when the active agent is not `project-manager`.
- **Autonomous Execute driver**: After Pre-implement **GO**, read `{HARNESS_DIR}/status.json` backlog, checkout the iteration **`spec_integration_branch`**, run per-plan **`create <plan-feature> from integration` → implement → QC/QA → merge back to integration** until all plans are `Done`; set host todos (Cursor `TodoWrite`, Codex `update_plan`, OpenCode UI) before each wave so session scope does not drift.
- **`mstar-roles` (PM shell)**: Cross-reference updated to point at the new `pm` skill sections (host entry, Execute driver, dispatch-first).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.8 → 0.6.9**. **`@mstar-harness/cli` remains 0.5.0**.

## [0.6.8] - 2026-06-04

### Harness (skills / agents)

- **QC fix-round revalidation (default)**: After dev fixes blocking findings, PM dispatches only the QC seat(s) that raised each item (**targeted re-review**), not a blind full tri-review. Reviewers update the **same** report file in place (`## Revalidation`); PM updates the same `qc-consolidated.md`. Full tri re-review requires explicit Assignment `QC re-review: full tri-review` and new `qcN-rev2.md` basenames.
- **QC report naming**: Under `{PLAN_DIR}/reports/<plan-id>/`, use short basenames `qc1.md`, `qc2.md`, `qc3.md`, and `qc-consolidated.md` (no `<plan-id>` prefix in filenames; `plan_id` stays in frontmatter and the directory). SSOT: `mstar-plan-artifacts/references/plan-files-and-reports.md`.
- **Dispatch**: `mstar-dispatch-gates` and `mstar-host` parallel-dispatch allow **N = 1–3** invokes for targeted re-review in one message; initial tri-review remains **N = 3**.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.7 → 0.6.8**. **`@mstar-harness/cli` remains 0.5.0**.

## [0.6.7] - 2026-06-03

### Harness (skills / agents)

- Add a Codex Plan / Goal Mode bridge reference so `/plan`, `update_plan`, `/goal`, goal progress, and thread summaries cannot replace `.mstar/` SSOT or Morning Star Done authority.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.6 → 0.6.7**. **`@mstar-harness/cli` remains 0.5.0**.

## [0.6.6] - 2026-06-03

### Harness (skills / agents)

- Add Codex custom-agent source files under `codex/agents/` so dispatchable Morning Star roles can be installed into Codex's `agents/*.toml` subagent surface; `project-manager` remains entered through `/pm`.
- Change the recommended project `{HARNESS_DIR}` default to `.mstar/` while continuing to recognize `.agents/`, `.plans/`, and `plans/` legacy layouts.

### CLI

- Change Cursor and Codex install flows to maintain a shared local repo at `~/.mstar/harness` and create host-specific symlinks instead of Cursor project submodules or Codex URL-source marketplace entries.
- Link Codex custom agents from `codex/agents/*.toml` into global or project Codex agent directories during `init`, and validate them in `doctor`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.5 → 0.6.6**.
- Bump `@mstar-harness/cli`: **0.4.0 → 0.5.0**.

## [0.6.5] - 2026-06-03

### Harness (skills / agents)

- **Durable Roadmap Gate**: Strengthen `mstar-harness-core`, `mstar-phase-gates`, PM gates, Cursor Plan mode bridge, and product/architecture templates so staged, partial, or temporary work must record a target state and roadmap before implement GO / Done.
- **Coding behavior**: Redefine `Simplicity First` as the smallest durable slice, not a temporary workaround; deferred items must be tracked in plan/status artifacts rather than only in chat.
- **Cursor routing-eval**: Bump routing evals to v8 with `durable-roadmap-required-for-staged-work`, guarding against “do half now, later plan” failures.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.4 → 0.6.5**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.6.4] - 2026-06-03

### Cursor Plan mode × Harness

- **Build resume contract**: Cursor Build is treated as plan resume, not `/pm` replay. Morning Star plans must reload harness context, resume PM orchestration, and dispatch implementation instead of letting the parent Build session edit product code.
- **Cursor routing-eval**: Add `cursor-plan-build-resume` to guard against parent-session implementation before SSOT plan registration, PM Assignment, and host Task dispatch.
- **Cursor plugin manifest**: Register `agents/` in `.cursor-plugin/plugin.json`, matching plugin docs and validation checks.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.3 → 0.6.4**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.6.3] - 2026-06-03

### Harness (skills / agents)

- **`pm` (`/pm`)**: Slim entry skill (~60 lines) with **`/pm`-only rules** — **dispatch-first** (Assignment + invoke per implement batch; parent agent must not write product code; no Task skip for in-thread context), **Autonomous Execute push** as dispatch loops across one iteration (multi-plan), **branch truth** (no silent cwd vs plan/`status.json`). Detailed gates/routing defer to `mstar-dispatch-gates`, `mstar-host`, and `project-manager` references.
- **`mstar-roles` (PM shell)**: `/pm` sessions point at `skills/pm` § `/pm`-only rules` instead of duplicating long prose.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.2 → 0.6.3**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.6.2] - 2026-06-02

### Harness (skills / agents)

- **`pm` (`/pm`)**: **Autonomous Execute push** — after Execute starts (`plan` locked, Pre-implement **GO**), continuously drive the active **iteration** backlog (possibly **multiple** `plan_id`s) through implement → InReview → Done without routine basic yes/no prompts; use PM-recommended defaults; resolve process gates from `mstar-*` skills (`Blocked` only on true conflicts or irreversible scope gaps).
- **`mstar-roles` (PM shell)**: Pointer to `skills/pm` § Autonomous Execute for sessions entered via `/pm`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.1 → 0.6.2**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.6.1] - 2026-06-01

### Harness (skills / agents)

- **`mstar-plan-artifacts`**: Add read-only `scripts/tech-debt-rollup.sh` (jq) to compute `metadata.tech_debt_summary` from open `residual_findings` with PASS/DRIFT check; document as canonical rollup path in `references/status-and-residuals.md` (English).
- **`mstar-roles` (PM)**: Default spread across `fullstack-dev` and `fullstack-dev-2` when **>=2 independent** backend/fullstack units (parallel dual-track or sequential round-robin); single-id collapse requires `single_stream_justified` and documented override.
- **Cursor routing-eval**: New `sequential-backend-batches-rotation` case; tighten `two-parallel-backend-modules` hard_fail for single-dev without justification.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.0 → 0.6.1**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.6.0] - 2026-05-30

### Unified host skill

- **Breaking**: Merge `mstar-host-opencode` and `mstar-host-cursor` into single **`mstar-host`** at `skills/mstar-host/` (platform auto-detect + `references/opencode.md`, `cursor.md`, `codex.md`, `parallel-dispatch.md`, `cursor-plan-mode-bridge.md`).
- Add `references/codex.md` with Codex-specific runtime adaptation for plugin skills, clarify behavior, sandboxed file/shell work, tool discovery, and dispatch limits when no callable multi-agent tool exists.
- Remove `skills-cursor/` and `packages/opencode/skills/`; OpenCode plugin registers only `harness-skills/`. Cursor plugin `skills` array is `./skills/` only.
- Update role/topic references and `rules/mstar-cursor-plan-mode.mdc` paths.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.5.1 → 0.6.0**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.5.1] - 2026-05-29

### Cursor Plan mode × Harness (Cursor plugin)

- **Dual-write bridge**: CreatePlan mirrors to `{HARNESS_DIR}` / `{PLAN_DIR}` SSOT (`.agents/plans/`, `status.json`); fixed bootstrap todos `harness-init`, `spec-register`, `mirror-plan`; per–task-ID commit gate on implement todos. See `skills-cursor/mstar-host/references/cursor-plan-mode-bridge.md`, updates to `mstar-host-cursor`, `pm`, and `mstar-harness-core`.
- **Rules**: Add `rules/mstar-cursor-plan-mode.mdc` (`alwaysApply`); register `"rules": ["rules/"]` in `.cursor-plugin/plugin.json` so plugin rules (including `mstar-entry`) load reliably.
- **Maintainers**: Move pre-release checklist to `.cursor/LOCAL-VALIDATION.md` (removed from `.cursor-plugin/`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.5.0 → 0.5.1**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.5.0] - 2026-05-26

### Codex integration

- Replace the obsolete checked-in `.codex/marketplace.json` path with the supported personal marketplace flow: `~/.agents/plugins/marketplace.json` using a `"source": "url"` entry for this repository.
- Add Codex support to `@mstar-harness/cli`: `init --target codex` writes the personal marketplace entry and `doctor --target codex` validates it.
- Update English and Chinese install docs for Codex CLI install and manual personal-marketplace setup.

### Harness (skills / agents)

- Fix the `/pm` skill frontmatter so the Codex plugin validates cleanly from the repository root.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.4.1 -> 0.5.0**.
- Bump `@mstar-harness/cli`: **0.3.1 -> 0.4.0**.

## [0.4.1] - 2026-05-19

### Harness (skills / agents)

- **`mstar-plan-artifacts`**: Move `templates/` (`status.empty.json`, `notes.empty.json`) from `mstar-plan-conventions` so artifact SSOT and empty-file templates live in one skill; `mstar-plan-conventions` keeps path discovery and init steps with pointers to `mstar-plan-artifacts/templates/`.

### Version alignment

- Bump **0.4.0 → 0.4.1** for monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests. **`@mstar-harness/cli` remains 0.3.1**.

## [0.4.0] - 2026-05-19

### Harness (skills / agents)

- **Topic skill split** (on-demand loading): Add `mstar-phase-gates`, `mstar-dispatch-gates`, `mstar-branch-worktree`, and `mstar-plan-artifacts` (includes `status.json` / residual SSOT; no separate `mstar-status-residuals`); slim `mstar-harness-core` and `mstar-plan-conventions` to entry + pointers; `mstar-phase-gates` and `mstar-branch-worktree` keep full rules in `SKILL.md` (no extra reference layer).
- **Roles** (`mstar-roles`): Per-role **Required Skill Dependencies** in every `references/<role>.md`; hub matrix in `mstar-roles` SKILL.md; PM sub-refs use `mstar-plan-artifacts` for severity SSOT.
- **Hosts** (`mstar-host-cursor`, `mstar-host-opencode`): Load-order wording and QC/worktree pointers aligned with topic skills.
- **Plan directories** (`mstar-plan-conventions`): Formalize `{ITERATION_DIR}` (`{HARNESS_DIR}/iterations/`) and `{KNOWLEDGE_DIR}` (`{HARNESS_DIR}/knowledge/`); document `docs/` vs harness subtree content boundaries (Nexus-aligned); optional `iteration_compass` / `iteration_refs` in `status.json` metadata.
- **Prepare clarify** (now primarily `mstar-phase-gates`; summary in `mstar-harness-core`): `clarify` discipline — shared understanding, explore before asking, recommended answer per question.

### Docs

- **README.md** / **README_CN.md**: Expanded core skill table; note `.harness/` as gitignored maint workspace for specs/plans (not published skills).
- **AGENTS.md**: `.harness/` maint workspace; topic skill routing table; post-change cross-reference check.

### Version alignment

- Bump **0.3.2 → 0.4.0** for monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests. **`@mstar-harness/cli` remains 0.3.1**.

## [0.3.1] - 2026-05-15

### Harness (skills / agents)

- **Plan / Git alignment** (`mstar-plan-conventions`, `mstar-harness-core`): When multiple plans share one **Spec** (`primary_spec`), document a **Spec integration branch** plus per-**plan_id** implementation branches; merge each plan’s work back to the Spec line; **require a PR** (or equivalent controlled merge) before landing that integration line on `main` / the default protected branch (narrow `Branch policy` exceptions unchanged). Adds `spec_integration_branch` and clarified `merge_target` metadata in `references/status-and-residuals.md`, QC/worktree notes in `references/plan-files-and-reports.md`, and a cross-reference in `references/branch-and-worktree.md`.

### Version alignment

- Bump **0.3.0 → 0.3.1** for npm workspaces (`morning-star`, `@mstar-harness/cli`, `@mstar-harness/opencode`) and Cursor / Codex plugin manifests.

## [0.3.0] - 2026-05-14

### Harness (skills / agents)

- **PM role**: Split `project-manager` detail into `skills/mstar-roles/references/project-manager/*.md`; keep a compact orchestrator shell in `references/project-manager.md`.
- **Roles**: Translate `mstar-roles` role references and skill hub to English; reference host adapters by skill name (`mstar-host-opencode`, `mstar-host-cursor`) instead of filesystem paths in role text.
- **AGENTS.md**: Host adapter routing documents skill names and in-repo layout (`skills-cursor/mstar-host` for Cursor).
- **PM routing**: Phase routing pre-flight (short go/no-go) and OpenCode **prerequisite vs dispatch** turn model in `mstar-host-opencode` (paste-only dispatch failure mode).
- **OpenViking (optional)**: Add `mstar-harness-core/references/openviking-memory-plugin.md` — rules when the `memsearch` tool is present; entry from `mstar-harness-core` SKILL.
- **Load contract**: Clarify `mstar-coding-behavior` is required for implement / review / QA / ops roles, not for `project-manager` orchestration-only work (`mstar-harness-core`, `mstar-roles`).

### Docs

- Trim plan bootstrap template sections from `README.md` / `README_CN.md` where superseded by current flows.

### Version alignment

- Bump **0.2.0 → 0.3.0** for npm workspaces (`morning-star`, `@mstar-harness/cli`, `@mstar-harness/opencode`).
- Bump **0.1.0 → 0.3.0** for Cursor and Codex plugin manifests to match the monorepo release line.

## [0.2.0] - earlier

See [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md) for `@mstar-harness/cli` 0.2.0 notes. OpenCode packaging, postinstall bundle of `skills/` + `agents/`, and related fixes landed in the same era as the 0.2.0 CLI release.
