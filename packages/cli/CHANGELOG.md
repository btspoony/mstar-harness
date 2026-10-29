# Changelog

All notable changes to the `@mstar-harness/cli` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

## [4.1.2] - 2026-10-29

### Changed

- Iteration dashboard reads now tell the execution truth: `IterationDTO` carries `executionLifecycle` (`active` / `completed` / `stopped` / `failed` / `none`), derived from the iteration workflow instead of the catalog row, and `projects` lists every linked project.
- Iteration plan membership is the union of the compass frontmatter `plans:` ids and the catalog `plan belongs-to iteration` links, de-duplicated and sorted; a declared plan missing from the catalog stays visible with its `catalog-missing` badge. No link-backfill migration ships — the read union is the membership record, and `mstar catalog reconcile` is unchanged.
- The projection now also covers terminal **iteration** workflows, so finished iterations answer their execution state instead of "no execution"; terminal plan workflows do not widen the projection and the workflows list keeps its active-registration membership. A projection format bump rebuilds the published generation on the next read (store schema gains migration 14, `compass-plan-membership`).
- `mstar iteration register --project` is repeatable: each occurrence publishes one `iteration belongs-to project` catalog link (the project must already be registered — the catalog refuses dangling relations), and the first value stays the snapshot's project record. Later add/remove uses the existing `mstar catalog link` family. Iteration registration now also registers its plan rows as catalog plan entities, because the membership links may not dangle.
- New engine writer `removeMilestone` removes an empty milestone and refuses `milestone.not-empty` (naming the reassignment recovery) while issues remain. No new CLI verb family.
- **Leaf-seat shell signal (#548):** a leaf/subagent session now carries its seat into the shell transport, closing the "leaf launches the CLI under the parent's ambient identity" gap for leafs that use their shell normally. The dsh plugin registers a `shellEnv` contributor exporting `DSH_MSTAR_LEAF_SEAT=1` on leaf executions (the shared `isLeafSeatHeader` predicate — one leaf rule), omp prefixes `export MSTAR_LEAF_SEAT=1;` onto a task session's bash calls, and the CLI reads either marker and attests `leafSeat: true` on every coordinator **registration** tuple it hands the engine (bind, recover, register, adopt, close, reopen and the seat-addressing reads — a leaf-permitted write such as `workflow-note.append` is deliberately left unstamped), so the engine's `coordination.leaf-seat` refusal fires on the CLI transport. Boundary: the marker is an environment channel — a leaf that deliberately strips it (`env -u`) before invoking the CLI is still indistinguishable, and non-`1` values are ignored, never a leaf claim.

- Version alignment with harness **4.1.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.1.2**.

## [4.1.1] - 2026-10-28

### Changed

- Version alignment with harness **4.1.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.1.1**.

## [4.1.0] - 2026-10-27

### Harness

- Rewrote the standalone `mstar dashboard` on the shared layer: the browser entry is React consuming `@mstar-harness/ui`, Preact and `htm` are gone with their last importer, and the build takes its CSS from the bundle's single asset output instead of a hand-maintained stylesheet. The generated artifact stays byte-deterministic **from the repo root and from `packages/cli`** (the generator now anchors to the package instead of inheriting the caller's working directory), and `NODE_ENV` is defined so React ships at 137 KB rather than 332 KB.
- All five destinations and their detail views now mount shared screens: Overview reads the new aggregated `/api/overview` in one snapshot, the four lists keep their state machines and the address-bar round-trip, and **Projects** carries the roadmap as a feature of a project alongside that project's Issues and Iterations. `#roadmap` is removed rather than aliased, and `mstar dashboard --project <id>` now seeds the first address, so a scoped launch opens that project's Issues list instead of the whole store. Back and Escape both leave a record detail with the reader's filters intact and do nothing on a list, so Escape in a search box never navigates away and discards what was typed; on a project detail both step out to that project's Roadmap.
- The list read reports only what it has: previous rows stay painted while the next page is in flight, so typing in a filter never unmounts the search box (a failed read still replaces them); a projection generation is required only by the views whose rows the projection builds, so a fresh store or a failed first projection renders the store's own rows instead of `unavailable`; a workflow page that the store holds more of says "showing N of M" rather than looking complete; and the **Any** disposition clears the filter instead of rewriting itself to open.
- Language and theme switches persist their choice, fall back on unreadable storage, and `<html lang>` follows the resolved locale. The chosen colour scheme paints the page canvas and the inherited text colour as well as the component surface, so a dark selection does not leave a light page behind dark components. The skip link moves focus to the main landmark instead of navigating, and the shell's chrome strings resolve through the dictionary rather than being derived from route ids.
- Deleted `packages/cli/web/views/` and the two files that only referenced each other; a green suite that exercised an unpublished file is gone with them.
- The **issue detail screen now renders the six panels the prototype has and §8.1 had removed**: `Identity keys`, `Source`, `Occurrences`, `Disposition history`, `Relations` and `Provenance`. The data was never missing — `store-read.ts` already returned `occurrences`, `transitions`, `relations`, `provenance`, `provider` and `identityKey`; the view model forwarded sixteen fields and stopped. The screen is now the prototype's two columns (`detail-grid` at `1.15fr : 1fr`, measured identical at 1440 px and collapsing to one column at 720 and 375), and its nine blocks carry the prototype's `.sec` rhythm rather than a class name that appeared in no stylesheet.
- The **relation read joins the other end's title**, so the `Title` column is the joined issue's own title instead of a permanent dash, and an unknown project states `null` dates instead of empty strings that read as recorded blanks.
- **Four class names that no stylesheet defined are gone**: `fact-block` (the issue detail's nine blocks, which had therefore lost every separator), `detail-text` (four paragraphs), `screen-sub` (the overview subtitle) and `attribution` (the iteration list's note). A new `bun run --cwd packages/ui check:classes` scans every component for a `className` literal absent from `tokens.css`, `base.css` and `product.css` and fails on one.
- The **gate track names its five steps** (`Start · Execute · Close · PR delivery · Merge ready`) — `copy.gateStepLabels` existed in both dictionaries and was read by nothing, so the track printed `step 1 of 5 … step 5 of 5` — and the **milestone counts cell reads `retired of total · N open`** (`5/14 · 9 open`), where it had rendered `resolved of total` with no tail, understating progress on every milestone with retired-but-unresolved issues.
- Fixed **every container query in the product being dead**. The CSS-module pass
  rewrites a named query's prelude into a per-module hash
  (`@container pane_8f31a`), while the single `container: pane / inline-size`
  declaration stays in the global sheet under the plain name, so nothing matched and
  the 400–900px pane rendered the wide layout squeezed. Component and screen queries
  are now **unnamed** (`@container (max-width: 619px)`); the collapse, the
  two-column fold and the chrome stacking all work again. `build-web.test.ts` asserts
  the emitted artifact carries no named container query, and the component-layer suite
  asserts no module writes one.
- Gave the **list tables declared column widths**. `table-layout: fixed` split an
  undeclared column set evenly, so eight columns of ~90px each rendered `I-…`, `d…`
  and `● runningplan…`; and the collapse rule's positional 20%/80% widths zeroed the
  *third* primary column on screens that have one. Each list now declares a px width
  for every column but the title (which takes the remainder), `DataTable` computes a
  floor of *declared + 120px*, the card body scrolls inside itself rather than
  squeezing a column below its identity, and the collapsed form hides secondary
  columns by rule with their facts on the row's second line. The `<colgroup>` is gone
  so a hidden column leaves no width behind it. Measured at a 400px container: narrowest
  cell 80–112px, zero truncated cells, no page overflow.
- Added the **pane frame** to the shared layer (`MS_PANE_HEAD_CLASS`,
  `MS_PANE_BODY_CLASS`): the prototype's surface band closed by a hairline, and the
  body's closing inset. The dsh seat mounts both inside its pane (the tab strip stays
  the pane's top edge), and the dashboard's window header is the same band — its
  `currentColor` border is now the shared hairline. `DESIGN.md` records the narrow-band
  decision: the prototype defines no narrow list, so the product chooses priority
  columns below 619px, declared widths above it, and a scroll floor as the net.
- Made a screen title **own its row below the collapse floor** and truncate inside the frame.
  A title squeezed beside the summary stacked a two-glyph CJK title one glyph per line, and a
  `max-content` floor then let a long title escape its pane instead (measured 852px in a 360px
  frame). The head now wraps and the title takes the full row; its floor is zero and an ellipsis
  marks what does not fit.
- Made the collapsed second line the **same activation target** as its record: it now carries
  the row's pointer handler, hover and cursor, while the tab stop and the key handler stay on
  the main row, so keyboard order is still one stop per record. `DESIGN.md` records what the
  extra `<tr>` costs (a screen reader hears two rows per record) and where it stops (list
  variant, below 620px, one spanned cell, facts non-interactive).
- Extended the **render gate** to the bands that were never tested: 760px and 420px
  for all five destinations, asserting no squeezed cell, a card that fills its
  container, a title that is not truncated, prose that wraps at 10+ characters per
  line, reachable and labelled header controls, no page overflow, and — the anchor that
  separates a real collapse from an overflow — no sideways scroll inside the table's
  card. One catalog iteration is seeded so the Iterations screen has a table to squeeze.
- Gave every list table the **prototype's own column widths** and made the wide pane stop
  squeezing: the Issues table at 720px cut its last column at the pane edge and rendered
  `dsh-inte…` and `imp…`. The widths now follow `design-v1.html:1196-1198` (id 86, project 128,
  kind 112, severity 100, disposition 104, last activity 116, rounded to what the product's
  identifiers need), the title absorbs the remainder, and the floor for the flexible column is
  96px instead of 120px. Measured at 720: table 678px in a 678px card, seven whole columns, the
  title the widest at 146px. The milestone column became **wide-only** (`wide: true`): hidden
  below 900px of container, never restated on the second line, because the prototype's sidebar
  shows seven columns and the eighth is what pushed the table past its card.
- Put every list's columns in the **prototype's order** — the Issues table read
  `ID | Title | Severity | Disposition | Kind | Project | Last activity` where the prototype reads
  `ID | Title | Project | Kind | Severity | Disposition | Last activity`
  (`design-v1.html:1199-1207`), and Projects led with the title where the prototype leads with
  the id (`:1757-1762`). Widths travel with their facts. The render gate now asserts the
  sequence, not just its length.
- Made the residual panel the prototype's **compact two-column tally**
  (`design-v1.html:2424-2434`): two severities per row with the count right-aligned, one column
  below 480px, and the reconciling total in the panel's meta slot (`26 open · all projects`)
  instead of a plain five-row list.
- Made the Overview **one vertical run of full-width sections at every width**, in the
  prototype's sidebar order (active workflow, residuals, milestones, the latest iteration)
  instead of a two-column grid whose second card squeezed prose one glyph per line at 1900px.
- Inset the **pane's head band** through the shared shell: `.ms-pane-head` carries the
  prototype's `padding-inline: 12px` nav inset (`design-v1.html:487`) on its surface + hairline,
  so the dsh pane's nav no longer touches the pane's edges. The dashboard's window header mounts
  the same class and keeps its own 20px gutter, which is what the prototype's window header
  uses. The host's tab strip stays the pane's top edge.
- Extended the render gate with the anchors those deviations would have caught: every list's
  column count and the absence of table overflow at 720px, the Overview as one full-width run at
  720 and 1900, and the head band's horizontal inset.
- Added the **card primitive** to `@mstar-harness/ui` (`Panel`, `PanelHead`, `PanelBody`, `PanelFoot`) and put every list screen inside it: the dashboard's Issues screen is now the filter card **and** the table card, and Overview, Workflows, Iterations and Projects are cards instead of bare sections. The surface, the hairline border, `--ms-radius-md` and the head/body/foot insets come from the prototype's own rules rather than from each screen. The frame around the screens (max width, gutter, title scale) lives in the shared base layer, and **both** hosts that mount these screens now anchor it: the dashboard on its root and the dsh panel on its product scroller — the dsh seat had none, so its screens rendered unframed.
- Added the **summary line** above the table — result count, the **selected** disposition with its project scope, and the ordering, in one sentence — and the short list-cell date (`10-24 09:06`) from one formatter, `formatShortDate`. The project span is stated only when the page holds the whole result set: a partial page cannot count projects it never saw.
- Replaced the shell's two native `<select>`s with the prototype's **segmented language group** and **theme icon button**: real buttons, labelled from the dictionary, `aria-pressed` for state, and two icon shapes instead of a colour swatch, so the choice survives forced colours. Both wrap at narrow widths instead of disappearing.
- Unified the timestamp form: one formatter (`formatDate`) prints `2026-10-23 09:14` everywhere a timestamp appears — detail lines included — while list cells drop the year and the seconds.
- Added the **render gate** (`packages/cli/test/render-gate.test.ts`): it starts the dashboard on an ephemeral port, drives a real browser over the five destinations and a detail screen at a fixed viewport, writes the PNGs under `.tmp/render-gate/`, and asserts the cards, the summary line, the dot-only tone rule, the header control pair and the date form. It skips cleanly when no browser is on `PATH` (`Bun.which("agent-browser")`), so no CI job depends on one.
- Restored the **issue-flow trend** to the Overview: two cumulative step lines drawn from
  `overview.issueFlow` (captured solid, retired dashed, so greyscale keeps them apart), the
  first/middle/last date axis, a legend carrying the dated and recorded open counts, the
  dated-history gap note, and the same buckets as a `Dated history` table in a disclosure. The
  read model never changed — only the view was missing. Fewer than two dated buckets renders the
  shared empty arm and a failed read renders the unavailable arm with the store's reason, so an
  empty chart is never drawn.
- Made the Overview **two columns above 900px**, `minmax(0, 1.85fr) minmax(0, 1fr)` as the
  prototype has it: work and its trend left, residuals and milestones right, the latest iteration
  across both. Below the floor it is the sidebar's single run in the same order. The previous
  single-column form was read from the prototype's narrow presentation.
- Restored the prototype's **plan table** under the active workflow: the summary line (id, type,
  phase, `Open workflow`), the branch chain, and five columns — `Plan | Title | Status | Progress |
  Done` — one row per plan, with the workflow's own count above them. `Progress` prints the
  store's note: a note that *is* a fraction is drawn as `3/6` with its bar, prose stays prose, and
  an empty note reads `Records no progress.` — no percentage is invented. The DTO already carried
  every field; the row model had been discarding them.
- Extended the render gate: the column ratio at 1900 and 1280, the fold at 720, the trend's two
  series and its text alternative, an unavailable flow member rendering the unavailable arm, and
  the plan table's five column keys, its two rows, its row height against `--ms-row-h`, and the
  branch chain.

- Version alignment with harness **4.1.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.1.0**.

## [4.0.9] - 2026-10-24

### Changed

- Version alignment with harness **4.0.9**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.9**.

## [4.0.8] - 2026-10-24

### Changed

- **A launched child can no longer address a workflow its identity does not declare (I-000866).** `mstar session run` refuses when the inherited identity names another workflow, and the command now participates in the adapter's coordinator-seat scope gate, so the requested workflow must be the one the launch declares.
- **A launch requires a current-epoch coordinator binding (I-000867).** `mstar session run` compares the binding epoch with the authority epoch and refuses a superseded holder with a recovery pointing at `mstar session recover`.
- **A committed iteration registration replays after its documents change (I-000868).** The reviewed-compass and plan-document proofs now run after the operation replay lookup in both registration producers and in the CLI transport, so an identical retry returns its receipt even when the compass or plan markdown was emptied, removed or edited; a new operation id still refuses and writes nothing.
- **Saved registrations keep replaying after the upgrade.** The request identity canonicalizes the plan-row pointers exactly as the previous release did and keeps only the compass spelling lexical; replay accepts both that fingerprint and the pre-upgrade one, so an unchanged retry returns its saved receipt (explicit or derived operation id) instead of `execution.operation-conflict`. A derived id is also computed over the pre-upgrade identity and looked up under both, so a receipt recorded for a non-canonical compass spelling replays too.
- **A symlinked `--harness` no longer refuses a valid absolute compass.** `iteration register` hands containment to the producer's real-path proof, so an absolute `--compass-ref` under a symlinked harness and an external alias onto an in-root compass register, while an escaping pointer is still refused.
- **A relative control root is refused, never resolved against the launch directory.** `MSTAR_HARNESS_DIR` must now be an absolute path: a relative value refuses the MCP connection at startup with `mcp.control-root-unresolved`, naming the cause and the absolute-path recovery, because the server's launch directory is the host's and never anchors a caller's root. A per-call `harness` selector follows the same rule as `--harness`: a relative value is a named refusal instead of a launch-directory resolution, so a root selector can no longer double-join through the invocation workspace. The refusal recovery text no longer offers the relative form.
- The mcp `--harness` help and the dsh README document the absolute-only rule.
- **`session.run` launches under the caller's verified live coordinator binding and mints no identity.** The launch resolves the claimed session id from `--session-id` or the inherited identity channel and requires it to be the running lifecycle's live coordinator; any other state refuses `session.run-unbound` with the recovery that state actually accepts (ownerless → `plan bind`, foreign/live holder → audited `session recover`, paused → lifecycle resume, failed/stopped → `workflow reopen`, completed → a new lifecycle, unregistered → `workflow register`). No session row or lease is written, and the child carries the verified identity in `MSTAR_EXECUTION_IDENTITY`.
- An MCP connection publishes no caller identity by default, so a `session.run` call must advertise the id it claims: the launcher opts in with `--trust-caller-session-id` and the call supplies `sessionId`. The `mcp --seat` help and the leaf-seat refusal now name that verified binding instead of a minted identity.
- **Every dev-command path argument now resolves from one base** (`resolveCliPath(value, context.cwd)`, #537): a relative input is discovered from the invocation workspace's project root — the nearest `package.json`, preferring one declaring `workspaces`, and the workspace itself when no marker exists — so `audit`, `pr-review`, `persist`, `harness scaffold`, `path resolve`, the project plugin root, `store --out` and `iteration gate --compass` answer like the validation family instead of joining the raw workspace directory. Absolute arguments still pass through unchanged, and a run from a monorepo member now reaches the same files as a run from the root.
- Removed the leftover unused imports in the audit family and the dsh host adapter.

- Version alignment with harness **4.0.8**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.8**.

## [4.0.7] - 2026-10-23

### Changed

- **The `plan progress` / `plan issue-add` / `plan issue-close` recoveries now name argument shapes their decoder accepts.** Payload values are advertised as inline JSON strings (`--progress '<json-progress-object>'`, `--entries '<json-array>'`), and the `issue-close` route names its required `--expect-issue` revision together with the evidence `--file`; the previous `--entries <issues-file>` named a file where an inline array is decoded, and `issue-close` omitted the CAS member the verb refuses without.
- **The regression is the replayed invocation, not its wording.** `packages/cli/test/plan-coordination.test.ts` reads each verb's own refusal, extracts the advertised `mstar …` sentence, binds its placeholders against the fixture and runs exactly that; all three succeed in one invocation.

- Version alignment with harness **4.0.7**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.7**.

## [4.0.6] - 2026-10-23

### Harness

- **The shipped dsh row opts in to caller session identity.** It now passes `mstar mcp --trust-caller-session-id` (omp's row already did), so the per-call `sessionId` selector is published on the dsh connection and an identity-bearing action — `plan progress`, `plan complete`, `workflow register/evidence/phase`, `session recover`, `workflow-note.append` — runs on the MCP surface instead of being pushed to the CLI. Before this, the dsh row did not pass the flag, so every such action refused with "requires an acquired runtime session identity" while the native surface covered only plan bind, audit report validation and execution clear. The flag stays the deployment's explicit statement that it owns the connection's trust boundary: a connection launched without it still publishes no selector and still refuses a supplied one.
- **On an opted-in connection the value is a bearer identity, and the docs say so.** `executionContextFor` turns `sessionId` into `context.caller`, the engine resolves the caller's OWN coordinator binding from it, and the optional `--expect` token is derived when omitted — so knowing a live session id is enough to act as that session. Authorization is that binding row plus the CAS token; no binding lookup, role check or CAS check is weakened. The ADR, both package READMEs, the bundle comment and the two host references state this instead of calling the value mere attribution.
- **Store-level commands are CLI-only.** Every `store.*` command (`init`, `upgrade`, `migrate`, `backup`, `activate`, `retire`, `execution.restore`, `execution.restore-preview`, `execution.export`) is no longer published on the MCP connection: they move or reshape the whole store, including `execution_sessions` rows whose `session_id` is a bearer identity on an opted-in connection, and that payload cannot be redacted without making a backup unrestorable. They are operator work against a checkout, not runtime work. MCP carries the runtime surface — plans, workflows, issues, ledger reads.
- **The identity-missing refusal and the `mstar schema` MCP requirement now name a route the caller can actually use**: `sessionId` on a `--trust-caller-session-id` connection (the shipped dsh and omp rows), `--session-id` or `MSTAR_HOST_SESSION_ID` on the CLI (dsh shells also export `DSH_SESSION_ID`, which the CLI reads), otherwise the native tool or the CLI. The shared sentence no longer claims `--expect` authorizes every command: `workflow-note.append` takes a `sessionRef` and has no `--expect` input.
- **A refusal no longer hands out a working identity.** `coordination.identity-mismatch` used to echo the ACTIVE holder's `sessionId` in its message, `current_facts`, `needed` and `details`; it now reports the holder's state and epoch only. Once the selector is published, that echo was a directly replayable input for a coordinator-scoped write.

- Version alignment with harness **4.0.6**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.6**.

## [4.0.5] - 2026-10-22

### Changed

- **Install-mode `init` refuses a failed newer-version global update.** When a newer published CLI was chosen and the global install failed, `init` now ends with the refusal and its recovery route for every install-mode target — including the adapters that install their plugin through the host's own CLI/TUI and ignore `initFlags`, where no plugin version is ever known. Previously only that case printed the failure and exited 0, leaving the CLI on PATH at the running version while the run reported success.
- **The MCP server publishes one tool per command family instead of one per command.** `tools/list` was the largest fixed cost of every agent session: 113 tools and 173,340 characters of description + input schema (189,881 for the payload-composed input view), 66% of that description text being a `CLI: mstar … --flags` usage line a tool caller cannot run. Each family now publishes one `mstar_<family>` tool with a required `action` selecting a real command, a merged field set derived from the command descriptors, and a compact description (purpose, one line of required fields per action — including the exactly-one selector a union action such as `schema` requires — the `<family>.<action>` id shape `mstar_schema` accepts, and a payload pointer where the action has one). A shared field name whose per-action declarations disagree on type or enumerated values is not published for the whole tool; the description names it "varies by action" and `mstar_schema` carries each action's shape, so `tools/list` never advertises a request a later action refuses. Measured on the same probe: 113 tools → 33, description + input schema 173,340 → 32,670 characters. Output schemas are no longer published (154,471 → 0), so the old publication was 327,811 characters including them (~91k tokens) against 32,670 today (~9.1k tokens).
- **Admission is unchanged; the published family schema is enforced as an index of what each action takes.** Every call still resolves to its command's own descriptor and composed schema, so validation strictness, aggregated refusals and launcher-default propagation (`defaultHarness`) behave exactly as before; an unknown or missing `action` refuses with the family's real action list, every supplied top-level key no family member accepts, and the recovery — a key is not reported as invalid while some member still accepts it. Because a family publishes the UNION of its members' fields while admission validates the selected member's strip-mode schema, a top-level key that action does not accept now refuses before admission with a usage envelope naming the fields it does take and the recovery — a sibling action's field or a typo was previously dropped without a diagnostic, and a dropped FILTER reads as an applied one (an unfiltered page returned to a caller that asked for a filter). A session selector's refusal joins the same envelope (naming the actions that accept it) instead of short-circuiting it, a `payload` object's internals stay the selected action's own payload schema, and a family derives its tool name from the definition's authored `cli.path[0]` — the segment `mstar_schema --family` accepts, asserted equal to the id prefix across every definition — so the published name and the `mstar_schema` recovery cannot point at different families. The family field index and the rendered CLI/payload contract read a union input through one shared `anyOf` + `oneOf` traversal, and the `plan` family purpose states the bind asymmetry: the MCP action writes the engine row only, while a dsh-coordinating session that needs dsh-local ledger attribution uses the native `mstar_plan_bind`. `mstar_schema` remains the field-detail authority, and `renderCommandContract` no longer spends MCP description budget on CLI usage syntax.
- **Identity injection is decided per selected `action`, not per family tool.** A folded family publishes its `sessionId` selector ONCE for the whole tool, so the `omp` `mcp-identity` extension filled the host id into every call of a mixed family — and the CLI refuses a selector the selected action does not declare, so every non-identity action of such a family (`mstar_status` → `tech-debt`, `mstar_milestone` → `list`, …) was unusable on OMP, refused with a "drop `sessionId`" recovery the hook undid on the next call. The extension now reads the per-action answer from the published `x-mstar-selectors` index and passes a call whose action declares no selector through untouched; when the action DOES declare it, the host id still replaces any caller-supplied value. The CLI publishes that index on every family with a selector, stating exactly the accepting actions its own refusal names.
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

- Version alignment with harness **4.0.5**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.5**.

## [4.0.4] - 2026-10-20

### Changed

- **`harness.scaffold` resolves from the invocation workspace and the pinned harness root.** The handler no longer defaults its root from `process.cwd()`: it uses the `InvocationContext` cwd (an explicit `path` still wins and is resolved against that cwd). Under `mstar mcp --harness <absolute path>`, an omitted `path` scaffolds that exact pinned harness dir verbatim — custom root names included, and ahead of `MSTAR_HARNESS_DIR` or a workspace `.mstarc` — instead of re-discovering a root under `dirname(harnessRoot)`, so a launch checkout and its `.gitignore` are left untouched. Regressions drive two workspaces through the production MCP assembly.
- **An identity-locked MCP connection refuses identity override.** A server launched with `--identity-env` (a scoped per-agent mount) publishes no session selector on its tools and strips a caller-supplied `sessionId` before admission, so every call runs under the connection identity the launcher declared — a caller can no longer pass a valid foreign session id and act inside that identity's authority. Generic unbound connections keep the documented per-call `sessionId` selector. A locked connection always has a resolved identity: a declared channel whose variable is unset or blank resolves no session id, so that connection stays generic (the per-call selector remains its identity channel) and one launch-time line names the variable, the cause and both recoveries instead of locking a connection with no identity at all. A declared value the engine's safe-session-id rule refuses — not one safe path component `[A-Za-z0-9._-]+`, not `""`, `.`, `..` or a value containing `/` or `\`, or longer than the engine's `SESSION_ID_MAX_LENGTH` ceiling — likewise resolves no identity: it stays unlocked and warned rather than locking an identity no identity-consuming call could use, and its launch-time line states the rule and the correct-the-variable-or-drop-`--identity-env`-and-relaunch recovery without echoing the rejected value. The declared identity is resolved once when the connection is created, so the lock can neither outlive the identity it locks nor appear after the connection became generic. A locked connection's published tool metadata also omits the session selector everywhere — the input properties, `x-mstar-requirements`, the rendered `CLI:` usage token and the caller-supplied section — so the contract an agent reads never asks for a parameter the tool does not publish and silently strips; a generic connection still publishes it.
- **The `MSTAR_HARNESS_DIR` recovery works everywhere the refusal names it.** The engine's harness-root resolution honours a non-blank `MSTAR_HARNESS_DIR` before its linked-checkout refusal, so the recovery the MCP control-root refusal advertises also resolves on a linked checkout whose main worktree cannot be read.

- Version alignment with harness **4.0.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.4**.

## [4.0.3] - 2026-10-18

### Changed

- **`mstar mcp --identity-env <NAME>` declares the default session-id channel.** When the flag is present, the stdio resolver reads the named environment variable (empty/whitespace ignored), satisfies a required `sessionId` selector at admission, and supplies `resolved.sessionId`; a per-call `sessionId` still wins. Without the flag the server reads no environment identity, so the existing "ignore ambient identity" contract is unchanged. A malformed declared value is not repaired: it reaches the same safe-session-id guard as a per-call value and refuses loudly. The declared default applies to the whole connection, so per-caller identity needs an explicit `sessionId` or its own scoped mount.
- **`mstar mcp --harness <absolute path>` pins the control root.** When the mounting process names a root, every call uses that path verbatim as `resolved.controlRoot` instead of probing `process.cwd()`; without the flag the existing cwd probe is unchanged. A relative path is a usage refusal (exit 2) whose message names the absolute requirement. This lets one installed plugin serve many repositories without hard-coding a checkout. The flag also sets the **server-owned default** root for every registered command's own root selection, not only `controlRoot`; a command that declares a per-call `harness` accepts an explicit override, while the `persist` family always uses the invocation's server root (the pin, or the cwd probe when unpinned) and takes no per-call harness; the delivery mount contract launches the MCP server with it (see `packages/dsh/bundle/README.md`). The pin also sets the invocation's **workspace root** to the pinned harness's parent directory, so commands that derive paths from their working directory — `audit.scaffold` deriving `{REVIEW_DIR}` when no `--reviews-dir` is passed, a relative `--dir` or findings path — land under the pinned harness instead of the launch cwd; unpinned keeps `process.cwd()`.
- **`DSH_SESSION_ID` is a CLI session-identity source.** The resolver now reads the native dsh execution id between the launcher-minted `MSTAR_EXECUTION_IDENTITY` and the legacy ambient `MSTAR_HOST_SESSION_ID`: precedence is `--session-id` > minted tuple > `DSH_SESSION_ID` > `MSTAR_HOST_SESSION_ID` (empty/whitespace ignored). The native value resolves with `sessionIdSource: "env"` and carries no execution tuple, so a dsh-hosted agent reaches the CLI without the per-command `/mstar-execution` workaround; the session-identity help paragraph names the same order.
- Identity-scrubbing test harnesses now pin the native channel out alongside the legacy ones, so their "no identity" and host-fallback cases stay hermetic on a dsh host.
- **`dsh-llm-fallbacks` pin bumped `0.6.6` → `0.6.7`**: the two hand-written literals move together — the `@mstar-harness/dsh` devDependency (`packages/dsh/package.json`) and the CLI install-spec constant (`packages/cli/package.json` → `mstar.dshLlmFallbacks`, read by `init` / `doctor --target dsh`) — and the lock re-resolves the row to `0.6.7` with the registry integrity for that version. `0.6.7` keeps the same peer set as `0.6.6` (the `^0.2.1-rc.2` dsh cohort, `@deepseek-ai/cordis` `^4.0.5`, `@deepseek-ai/schemastery` `^3.18.5`, `react` `^18.2.0`), so the workspace peer line already matches it; its only service-surface change is additive (a dispatch-role getter plus role-projection exports), none of it consumed by mstar — the structural mirror and its real → view type gate need no change. Nothing upgrades an already-installed host: `doctor --target dsh` reports an older row `drifted` until `init --target dsh` re-adds the pinned spec. Workspace verification: `tests/peer-deps.spec.ts` 7 pass, the `fallbacks-*` suites 53 pass (60 tests across the scoped 7-file set, zero skips), and both type gates (`typecheck:src` and `typecheck:tests`) exit clean.
- **`init` is now a pure install:** it never reads, creates or appends the project `.gitignore`, so the host-specific install paths (`.cursor/plugins/morning-star-harness`, `.codex/agents/*.toml`, `.agents/skills/<name>`, `.zcode/plugin-checkout`) simply stay untracked.
- Removed the `doctor` findings that demanded those ignore entries — the `cursor`, `codex` and `zcode` project checks plus the now-unreachable omp gitignore list.
- `mstar-harness harness scaffold` is unchanged and still emits the canonical `.gitignore` snippet; run it (or add entries yourself) when you want the harness artifacts ignored.

- Version alignment with harness **4.0.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.3**.

## [4.0.2] - 2026-10-18

### Changed

- **`dsh-llm-fallbacks` pin bumped `0.6.5` → `0.6.6`**: the two hand-written literals move together — the `@mstar-harness/dsh` devDependency (`packages/dsh/package.json`) and the CLI install-spec constant (`packages/cli/package.json` → `mstar.dshLlmFallbacks`, read by `init` / `doctor --target dsh`) — and the lock re-resolves the row to `0.6.6`. `0.6.6` requires a `^0.2.1-rc.2` host, so the pin completes only on that cohort line: the lock still carries the older transitive `@deepseek-ai/dsh-client-ui-plugin-manager@0.2.0-rc.2` copy (with nested `dsh-timeout` / `dsh-typert-protocol` / `dsh-brand` at `0.2.0-rc.2`), because `packages/dsh` declares no direct peer for that name. Nothing upgrades an already-installed host: `doctor --target dsh` reports the older row `drifted` until `init --target dsh` re-adds the pinned spec. Workspace verification covers the direct pinned row and the peer/type gates: `tests/peer-deps.spec.ts` 7 pass, the `fallbacks-*` suites 53 pass, and both `typecheck` gates (`typecheck:src` and `typecheck:tests`) exit clean.

- Version alignment with harness **4.0.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.2**.

## [4.0.1] - 2026-10-16

### Changed

- `init` no longer reports success for a failed host install: a refused link, install, or build step ends with a non-zero exit that names the cause and a recovery.
- omp install is deterministic about a pre-existing plugin tree (removes a stale entry through a supported route before linking, verifies the installed version), and no longer passes a scope flag the install path ignores.
- The omp coordinator tool's session parameter uses the two-argument `record` form, so the tool schema constructs under every host shim probed.
- A dsh incompatibility refusal now names the runtime, the plugin spec, and dsh's own `allow-version` recovery instead of relaying the rejection alone.
- Version values come from `package.json` at runtime; the Bun-version gate and version-comparison tests are gone.
- `init` installs the published `@mstar-harness/cli` latest globally when a newer version than the one running is published, and warns with both versions when they differ: a cached `npx` resolution can otherwise run an older CLI, and every step of `init` — including the global install — used to follow that older version. The registry probe is bounded, skipped by `--dry-run`, and silent when offline, so it never blocks or fails an init.
- **A repeat `store upgrade` over an unchanged legacy source is an ordinary success again.** The execution importer's only replay path matched the caller's operation id, which the CLI mints fresh per invocation (`randomUUID()`) and never reports back, so a second upgrade of an already-imported tree always hit the native-id collision refusal and demanded `--ack-skip-workflow` for every already-imported id. The importer now also reads the store's **own retained import receipts**: every committed import already writes a `store_operations` row whose `result_json` carries the consumed `sourceDigest` and the `importedIds` it committed, and that table is never pruned. A colliding id a receipt for **these exact source bytes** already lists is a **proven replay** — the run imports nothing, requires no acknowledgement, and reports each such id in `dispositions` as already held by the native authority from an import of these exact bytes. This is the provenance policy the change settles: a same-ID match is a replay only when stored provenance proves the same source.
- **Unproven collisions are unchanged.** An unrelated workflow that merely shares the id, or a legacy source whose bytes changed after the recorded import (a different `sourceDigest`), still refuses `execution.migration-conflict` naming `--ack-skip-workflow <that id>`, and its unmatched-acknowledgement usage error (exit 2) is untouched. Receipt candidates are shape-validated in JS (an object whose `sourceDigest` string equals the current digest plus an `importedIds` array of strings) rather than trusted because the JSON happens to mention the digest, and the lookup is never keyed on the caller's operation id. Guard order is preserved: unmatched acknowledgement → unsafe-source refusal → collision handling.
- **A replay must now prove the input that SHAPED the rows, not only the bytes.** `sourceDigest` covers only the legacy bytes a run read, while `--delivery` declarations and `--ack-skip-compass` acknowledgements change what the conversion produces without touching those bytes — so a repeat over unchanged bytes could previously accept a *different* declaration and discard it silently, leaving the native row as the earlier import left it. The receipt therefore also records an `inputDigest` over the normalized declarations (sorted by lift id, fixed key order) and compass acknowledgements (sorted). A run carrying **neither** still replays on the byte proof alone, so receipts written before this field existed keep working; a run carrying **either** needs the receipt to record the same `inputDigest`, and otherwise the id stays an unproven collision. That refusal now states only what the evidence supports — the retained receipt does not prove the earlier import consumed this input, so this run does not treat the id as a proven replay and leaves the native rows unchanged — alongside the existing `--ack-skip-workflow <id>` recovery. No new refusal code, table, migration or flag.
- **`MinimalImportResult.verdict` is widened to `"upgraded" | "nothing-to-import"`** (additive), mirroring the DSH importer's existing vocabulary: a run that commits rows keeps reporting `upgraded` with its `imported` count, while a run that commits none but proves at least one replay reports the already-current state. `docs/commands.md` § Store CLI upgrade and recovery describes the proven-replay outcome and keeps `--ack-skip-workflow` for unproven collisions.

- Version alignment with harness **4.0.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.1**.

## [4.0.0] - 2026-10-15

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
- Historical R3 (3 calls, pass) and intermediate R4 (initialize infrastructure error, 0 calls) evidence remain archived in their respective run directories; R4 predates the initialize-response fix.
- Refreshed current acceptance evidence in `eval/r5-guess-path/` on full SHA `3c0f0eea8c9f6298d701e472da81f2a8ffd8de73`: the local-built-CLI stdio MCP guess path recorded 3 calls (failed near-miss, catalog recovery, corrected call), graded pass, with run/report exit 0.
- Made the evaluator driver clone-portable: it derives repository root from `import.meta.url`, accepts `MSTAR_SKILL_EVAL_REPO_ROOT` and `MSTAR_SKILL_EVAL_DURABLE_DIR`, and records the current full SHA and built CLI identity/help hash. From a clone, run `bun run --cwd packages/cli build && bun scripts/skill-eval/run-bounded-resolution-real.ts`.
- **model compliance stays unverified (scripted client, no LLM)**.
- Re-freeze the skill-eval closure inventory onto reachable `origin/main` (`c42c16b4`): the prior BASE revision was unreachable after a history rewrite. The BASE-tree owner hashes now match that reachable revision, while current-byte hashes remain pinned. For anchors already absent from this BASE, the check guards against reintroduction rather than proving their historical removal. The current file contains 35 tests; the historical 37-test count is not a requirement for the repaired gate. This closure check is manual-run only because CI does not execute `scripts/skill-eval`; drift or reintroduction is surfaced only by a local run (#357).
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
- `plan complete` now advertises the argument shape its own parser accepts: the refusal recovery names `--file <absolute-evidence.json>`, so following it verbatim completes the plan instead of being rejected as invalid JSON.
- `session run` keeps the child exit code its admission assigned: a missing executable surfaces the admitted `127` in the `session.child-exit` envelope instead of a generic launcher exit 1.
- `status workflow-close` re-run against a lifecycle this control root already recorded as `completed` and unregistered is the documented idempotent re-run — exit 0 with an explicit nothing-to-close receipt — while a foreign scope and any recorded outcome other than the requested `completed` keep refusing.
- A dashboard service stopped by `SIGTERM` exits with the signal's own status (`128+15`) instead of the start receipt's `0`.
- The CLI stdin reader is bounded and self-cleaning: every settle path detaches its listeners and pauses the stream, and a non-interactive stream that delivers nothing refuses (`command.stdin-unavailable`) instead of holding the command open forever, while an interactive terminal keeps its read.
- Refuse to replace symlinked or non-regular OpenCode config paths, recover incomplete shared harness checkouts with one preserved-and-recloned attempt, and roll back partial ZCode marketplace writes.
- Added **`@mstar-harness/opencode-v2`** — the OpenCode **2.x** native plugin package, authored on the pinned `@opencode/plugin` **2.0.26** SDK. It registers the same bundled `mstar-*` skills, role agents, and iteration commands through the V2 native editor surface, and its `write`/`edit`/`subagent` gates **refuse for real** through the typed `Tool.Error` channel (the V1 package's warn-only no-refusal-channel limitation does not apply here). `patch`, `shell`, and Code Mode stay explicit non-claims; installed-host behavior is unverified.
- Made `mstar init --target opencode` / `doctor --target opencode` **generation-aware**: `--opencode-generation <v1|v2>` always wins; a real install otherwise probes `opencode --version` (major ≥ 2 → `@mstar-harness/opencode-v2`, 1.x → `@mstar-harness/opencode`); probe failure refuses with the flag recovery — no silent v1 fallback — and `--dry-run` previews with probes skipped (an unresolved generation is annotated, never guessed). Config markers are a consistency guard only.
- The V2 config write set keeps the V1 key untouched and preserves user values: plural `plugins` with owned-slot dedupe, `agents.<role>.model` only when supplied, a non-destructive `mcp.servers["morning-star"]` merge, and `$schema` preserved — never invented.
- Docs: new `packages/opencode-v2/README.md` + `INSTALL.md`, dual-generation pointers in the OpenCode (V1) package docs, the V2 section in the `mstar-host` OpenCode reference, and the root README install row.
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
- **One severity vocabulary: `critical | high | medium | low | nit`.** The wrong `info` value had spread into the residual/issue severity axis — the engine SSOT, residual validation, CLI payloads and rollups, the dsh view/schema, and the `mstar-artifacts` reference — so every severity site names `nit` again and `info` is refused as an out-of-enum value.
- **Stored severities are converted by a new schema migration**, never by hand-edited rows: it rebuilds the `issues` table with the `nit` CHECK and rewrites the stored `info` values to `nit` while copying, preserving every row. Earlier migration statements and the `warning → low` legacy read normalization are unchanged.

- Version alignment with harness **4.0.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.0**.

- Updated the committed ZCode hook regression to assert that a `status.json` write without an execution store is refused; retired workflow verbs are covered as absent from CLI help.

## [3.11.2] - 2026-09-19

### Changed

- Version alignment with harness **3.11.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.2**.

## [3.11.1] - 2026-09-18

### Harness

- **Host session identity now reaches the engine on OMP**: the `@mstar-harness/omp` model-handoff extension revises every `bash` tool call of its session to carry the host session id in `MSTAR_HOST_SESSION_ID` — overwriting any caller-supplied value under that name, `bash` only, nothing injected for a host session with no id, and no engine or harness write, notice or state — and a fresh `mstar plan bind` resolves its identity **`--session-id` → `MSTAR_HOST_SESSION_ID` → the engine-generated id** — the injected variable is the fallback (trimmed; empty or whitespace-only counts as absent) — so the engine session id and the host session id are one identifier for the readiness and start-authority comparisons. The generated default and every comparison are unchanged: an absent or foreign association still refuses (the readiness `binding-invalid` code, the existing start-authority codes), and `--resume` never re-identifies — it refuses `--session-id` as a usage error.
- **`bindPlanSession` adopts a caller-supplied `sessionId`** on both fresh-bind variants (coordinator and plan scope), keeping `randomUUID()` when none is supplied. The id names the session envelope's file, role-scoped at `{WORKFLOW_DIR}/<workflow-id>/sessions/<role>-<session-id>.json` (`<role>` ∈ `coordinator` / `plan-pm`) — so one host session may hold the coordinator envelope and a plan-pm envelope of one workflow under the same shared id — and is therefore validated as a single safe path component (non-empty, no separator, not `.`/`..`, at most 128 characters) and refused with the new, additive `coordination.invalid-session-id` before any write; a re-used id is still refused by the exclusive envelope creation with the existing `coordination.session-mismatch`.
- Updated `skills/mstar-host/references/omp.md` with the anchor-side session-identity association contract.

- Version alignment with harness **3.11.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.1**.

## [3.11.0] - 2026-09-18

### Harness

- Audit scaffold findings files now preserve what the auditor supplied: the CLI parser maps `description` → `impact`, keeps explicit `confidence` and `evidence` (previously discarded), and accepts optional `fingerprint`, `trace`, and `severity` metadata plus structured `{file, line?, description}` evidence locations, with documented absent-field defaults (`MED` confidence, `[]` evidence). A new deterministic engine gate `validateAuditFindingGates` (fingerprint grammar/uniqueness/ordering, `severity.overall ≤ severity.impact`, trace topology, safe typed paths, visible-text predicates, credential rejection on opaque fields) runs inside `scaffoldAuditPlan` before any file is written; invalid findings exit 2 with field-path diagnostics and no partial output. Legacy string-evidence input remains supported. The durable field contract is published in `skills/mstar-audit/references/finding-format.md` (§ Machine-readable findings file), the scaffold engine-check callout in `references/codebase-audit.md` was updated for the real gates and their limits, and the five-state attack wording in `mstar-audit` SKILL.md was tightened to its four actual dispositions.
- `mstar worktree cleanup` merge-evidence probing is now bounded: evidence bases resolve once, membership sweeps run at most once per distinct base OID with an immutable in-pass memo — no per-pair `merge-base --is-ancestor` spawns; `--verbose` adds per-pair ancestry diagnostics without changing candidates or decisions.
- The default candidate scope is now the selected workflow's recorded claims; pass `--all-workflows` for the previous full sweep, and `--worktree <path>` additionally narrows branch candidates to the asserted worktrees' exact recorded owners.
- Added **`registerIterationWorkflow`** to the engine: a sibling of `registerPlanWorkflow` that creates the `type: "iteration"` snapshot (compass ref, three branch anchors, Todo plan rows with §1.5-derived `iteration_refs` / `spec_integration_branch` / `merge_target` metadata) plus the root `status.json` entry inside one create-only, root-lock section — version-exact rollback, byte-preserving orphan recovery, and no change to the standalone plan producer.
- Added the **`mstar iteration register`** CLI verb so an iteration can be registered from any checkout with no engine import (exit `0` ok / `1` engine refusal / `2` usage); `mstar workflow register` is unchanged.
- Made the new path discoverable: `mstar-iteration` §1.5 now names the verb instead of a bare engine call, and `mstar-use-cli` indexes the iteration-registration family (its `mstar-harness-core` topic-index row was already wired in d7aca2f6).

- Version alignment with harness **3.11.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.0**.

## [3.10.3] - 2026-09-17

### Changed

- Added a **route-specific standalone completion path**: a `type: plan` / `development` workflow now reaches row `Done` from its own registered `branch.source` / `branch.target` instead of requiring an integration branch, while the iteration route keeps its mandatory integration anchors and the delivery-evidence ordering gate is unchanged.
- Added the guarded, identity-only **`plan repair-delivery-source`** operation: it corrects a pre-existing snapshot whose registered delivery source is wrong, deriving the replacement only from that row's accepted handoff and changing nothing else — never `Done`, never delivery evidence, statuses or leases.
- Gave the **QA seat the same budget-stop and truncation contract as the QC seats** (`Truncated coverage:` emitted only when the bound actually stopped expansion) and one mandatory report-landing obligation that reads identically in the role reference and the review-bundle naming table.
- Bound the **L2 task-review output** to an always-on `${SDD_DIR}/task-N-review.md`, distinct from and never overwriting the implementer's `task-N-report.md`, and aligned every named producer and consumer on that basename.
- Published both completion routes and the legacy-only repair across the CLI reference, the runtime lifecycle contract, the state/residual reference and the PM plan-management reference.

- Version alignment with harness **3.10.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.3**.

## [3.10.2] - 2026-09-17

### Changed

- Version alignment with harness **3.10.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.2**.

## [3.10.1] - 2026-09-17

### Changed

- Version alignment with harness **3.10.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.1**.

## [3.10.0] - 2026-09-16

### Changed

- Close now **consults the registered delivery kind's evidence before writing the terminal snapshot** (seam S3): a `development` workflow without its compound disposition, PR identity or PM-recorded verified-merge evidence, and a `verification/report-only` workflow without the fulfilment of its registered completion policy, refuse the close with zero writes — the workflow stays `running`, registered and resumable. The read-only Phase-6 gate runs the same consultation, so gate and close never disagree.
- Added the authorized recording seam `mstar workflow evidence --workflow <id> --file <payload.json> [--session <path>]` plus the snapshot `delivery` evidence block: stage-by-stage recording under the snapshot lock, coordinator-gated exactly like the close (a coordinated workflow is written only for its own bound envelope) and idempotent — re-recording identical evidence rewrites nothing.
- SDD admission accepts only an **active registered row** as registration evidence: a plan id retained solely in a terminal snapshot is now refused with `sdd.context.plan-not-registered` like an unregistered one, so a completed plan id can no longer be reused by riding its own history. Roots without a v2 register keep the legacy standalone policy.
- `mstar workflow register --branch-source` now records **`branch.source`** instead of `branch.base`; `branch.base` keeps its protected-base semantics (cleanup Rule 2 protected refs, L1 main-worktree residency fallback), so a standalone plan's delivery branch is no longer pinned as an undeletable protected ref.
- `mstar migrate --delivery-kind` declares exactly **one** lifted lifecycle: a v1 tree whose lift would stamp that single declaration onto 2+ ACTIVE standalone plans is refused as usage (exit 2, plan ids listed, zero writes) and migrates in **batches of one declared plan**. The declaration is one delivery identity (kind + delivery anchors + completion policy), so it can no longer be copied onto lifecycles it does not describe; terminal (`completed`) lifts stay exempt from the count, as before.
- `mstar workflow evidence --declare-kind` now **fills a MISSING delivery anchor only**: a supplied `--branch-source`/`--branch-target` equal to the registered value restates it (idempotent), while a conflicting value is refused with the field named (`branch.source` / `branch.target`) and zero writes. The one-time backfill of a historical kind-less snapshot can therefore never re-point it at a different delivery than the anchors it already registers.
- Added the guarded **Prepare workflow amendment** (`showPrepareWorkflow` / `amendPrepareWorkflow`; CLI `mstar workflow show-prepare` / `amend-prepare`) — a coordinator-only entry that appends approved unique Todo plan rows and records the reviewed integration checkout plus the sole editable `execution_policy.plan_parallelism`. Both raw-byte CAS tokens (snapshot and reviewed compass) are required even on the first amendment, refusals are mutation-free with `coordination.prepare-amendment.{stale,invalid-patch,not-prepare,execution-started,duplicate-plan,invalid-plan,compass-mismatch,invalid-worktree}`, every existing row and unknown field is preserved by value, and there is no force or replacement-snapshot path.
- Documented the entry in `docs/cli.md` (flags, patch payload, refusal codes, exit codes, stop conditions) with pointers from `mstar-artifacts` and `mstar-iteration`.

- Version alignment with harness **3.10.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.0**.

## [3.9.4] - 2026-09-15

### Changed

- `plan bind --resume` now refuses a `--harness` override with a usage error (exit 2, no I/O) instead of silently dropping it — the `--assignment` form already rejects that mix, and the session envelope pins the harness root on its own.
- Fixed the plan-coordination CLI store pin: the `--workflow/--plan` bind form now pins the `--harness` override (only a top-level `--harness` was read, so the store pinned the cwd-resolved root and the bind was refused with `coordination.path-mismatch`), and coordinator transitions now pin the session root **before** the live-handoff pre-check reads the row — a linked checkout whose session envelope names the control root is no longer refused by an unpinned read.
- Added load-bearing cases for both: a bind run from a directory with no resolvable harness, and an accept run from a linked worktree whose stale-id variant proves the pre-check now reaches the pinned store.

- Version alignment with harness **3.9.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.4**.

## [3.9.3] - 2026-09-15

### Changed

- Added a **provenance-citation finder** to the engine: `findProvenanceCitations` reports dated plan/iteration id tokens and dated local-harness deeplinks in tracked text. Example slugs, version tokens, placeholder shapes, plain dates and undated layout lines are never reported, and sdd deeplinks stay owned by the existing ephemeral-citation check.
- Exposed the scan on the CLI as `mstar lint --type provenance <target>`: an explicit-only content type (inference never selects it) that applies the finder to the target file or the directory walk's calibrated text face (`.md`/`.ts` — ordinary-named docs like `README.md` are collected too), with unchanged exit semantics (1 = citations found, 2 = usage). `docs/cli.md` registers the new `--type` value.

- Version alignment with harness **3.9.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.3**.

## [3.9.2] - 2026-09-14

### Harness

- Added a **round-bounding dispatch gate**: when `Execute as` is a review seat (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`, `code-reviewer`, `qa-engineer`) or `Task category` is `audit`, the Assignment must declare both **`Budget (review / QC seats)`** and **`Return shape (review / QC seats)`**. `mstar dispatch validate` now fails such an Assignment when either field is absent, empty, or `N/A`, naming the missing field; implement / ops / docs rounds are unaffected. Only field **presence** is checked — the field values are prose and are never parsed.
- Added **`validateQcReport`** (`@mstar-harness/engine`) and **`mstar qc validate-report <report.md>`** for plan-QC seat reports. The gate checks that the report opens with `---` frontmatter carrying the required `qc` fields, that the frontmatter `verdict` is an enum member and agrees with the body verdict line, that each `## Summary` tally matches the number of entries in its `## Findings` section, that the verdict follows from those counts (no `Approve` with an open Critical or Warning; any `Unconfirmed` count requires the `Unconfirmed` verdict), and that a present `Truncated coverage:` line is never reported as `Unconfirmed` — a cap stop is a scope cut, not a failed evidence channel. Undecidable cases stay silent rather than guessing.
- The report gate reads the **last** verdict line, and `## Summary` is the report's **single current count** — an in-place revalidation refreshes `## Summary` and `## Findings` rather than appending a second tally, so a revalidated report is judged on its current state and every count rule shares one source.
- Both gates read only the Assignment **header region** / the report's **frontmatter**: the dispatch gate stops at the first `## Task` heading, `---` rule or single-`#` heading, so field lines quoted in the task body neither satisfy it nor disable it (a body `**Execute as**: scout` no longer turns the writable gate off); the report gate reports `qcreview.report.unclosed-frontmatter` (high) when the opening `---` is never closed, since the body would otherwise be read as frontmatter and the field and body rules could not be decided.
- Wired the checks into the runtime skills: one Engine-check callout in `mstar-review-qc` § 席位预算与截断, pointers from `qc-specialist-shared.md` and the QC report template, and the round-bounding bullet in `mstar-harness-core` § 定向执行与验证边界 now names both required Assignment fields.
- No audit-chain behaviour, verdict vocabulary, severity semantics, register schema, or existing report contract was changed.

- Version alignment with harness **3.9.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.2**.

## [3.9.1] - 2026-09-14

### Fixed

- `mstar worktree cleanup` no longer aborts on an unrelated workflow's broken snapshot, and no longer drops that snapshot's safeguards. A sibling whose JSON parses but fails validation enters the safety set in **degraded form** — only protective declarations survive (branch base/integration/target, lifecycle worktree path, merge/execution leases, row ownership metadata) with lifecycle and row states forced non-terminal, so it can only ADD keep/refuse verdicts. A sibling that cannot be parsed at all leaves the safety set incomplete, so every removal is withheld as `cleanup.refuse.unreadable-snapshot` (the plan still prints whole) unless the operator asserts `--ignore-unreadable-snapshots`. The selected snapshot stays fail-loud (exit 1), and no broken snapshot is ever repaired, rewritten or removed. Contract documented in `mstar-branch-worktree`「Worktree / branch cleanup」.

- Version alignment with harness **3.9.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.1**.

## [3.9.0] - 2026-09-13

### Fixed

- Cleanup now re-probes local branches released by deferred integration worktree removal, deleting merged branches in one apply while preserving refusal guards and evidence-base deletion ordering.
- Escaped remaining Unicode literals in worktree validation, SDD discovery and evidence diagnostics without changing runtime text or matching behavior, restoring the ASCII source gate.
- Escaped em dashes in worktree check and cleanup CLI literals to satisfy ASCII source checks while preserving runtime messages.
- Install Codex custom agent TOMLs as regular files so discovered roles can load. Re-running init replaces expected legacy links and backs up differing regular files before refresh; doctor detects links and source drift. Update installation and dispatch guidance to require successful named-role invocation.
- Added the **Phase 6 post-merge close engine gate** (`evaluatePostMergeClose`): a pure, additive local-state check over the terminal snapshot shape, leftover leases and root-status unregister, with stable `PHASE6_*` codes; `mstar iteration gate --phase 6 --workflow <id>` evaluates it without `--compass`.
- The Phase 6 gate now validates the root `status.json` with the full v2 root validator (`validateStatusV2`, structure-only): a malformed registry (non-v2 version, missing `updated_at`, malformed `workflows[]` entries) fails closed as `PHASE6_INVALID_ROOT` instead of false-PASSing when the workflow id is absent; `/iteration-start` and the README commands table now state the auto-continue completion at Phase 6 post-merge close (same Done definition as `/iteration-drive`).
- Added a **pure SDD test-evidence contract** in the engine: record schema + validation (`validateSddEvidenceRecord`), artifact verification (`verifySddEvidence`), deterministic two-pass input snapshot digests (`evidenceInputDigest`) and first-match reuse applicability (`assessSddEvidenceReuse`) that keeps integrity, process outcome, input applicability and coverage as four separate outputs — unknown dependency/runtime/environment scope stays uncertain and is never silently a reuse candidate.
- Added scoped **`mstar sdd evidence capture|verify`** CLI commands: one recorded execution of an already-authorized check retains literal argv (no shell), separate raw stdout/stderr logs, the tagged outcome and bounded input/tool/environment fingerprints under `{SDD_DIR}/evidence/<run-uuid>`; every retry gets a new run id. Read-only verify never re-runs the recorded child, reports integrity-only without `--target`, and emits a candidate/changed/uncertain verdict with `--target`. Capture supports POSIX linux/darwin in v1 with bounded logs, inputs, snapshots and timeout; the old `sdd exec` and manual scoped-check reports are unchanged.
- Wired the handoff into the skill corpus: PM publishes the fixed capture request, developers capture authorized checks, QC reviews code/coverage without executing, and QA maps acceptance criteria to the retained record (with an explicit AC/run/integrity/outcome/applicability/coverage/gap table) instead of repeating child commands.
- Added the **guarded `mstar worktree cleanup` verb** with the pure `planWorktreeCleanup` engine planner: dry-run by default prints `verdict | kind | ref | reason` per worktree/branch candidate; `--apply` removes eligible worktrees (ordinary `git worktree remove`, never force), re-probes/re-plans, then deletes newly unchecked-out branches (`git branch -d`, never `-D`) and runs expected-OID `--force-with-lease` remote compare-and-delete. Active leases, branches checked out anywhere and foreign ownership refuse; protected refs are never removed (default and `branch.base` refs are kept, non-terminal owners refuse); merged evidence is a hard precondition (squash-only residue is retained and reported, never force-deleted).
- Wired the two cleanup timing lanes into the skill corpus: a new **`mstar-branch-worktree`「Worktree / branch cleanup」** contract home (ownership from snapshot row metadata/retained track Assignments or verified `--worktree` assertions — never naming inference), a same-round post-merge call in `mstar-iteration` Phase 2 (a Done plan is eligible while its parent iteration still runs), and the Phase 6 §6.4 call after terminal close + PR merged.
- Worktree dirtiness now counts ignored files: an ignored-content worktree (e.g. a local-only `.env`) is refused (`cleanup.refuse.dirty-worktree`) instead of being removed.
- `--apply` defers the branch-deletion cwd host (typically the terminal integration worktree) to a last removal pass: other eligible worktrees are removed first, then `git branch -d` runs from the evidence-base checkout, and the deferred integration worktrees are removed last — plan branches merged only into the integration branch (squash-merge era) now delete instead of refusing on the main worktree.
- Unify active lifecycle branch checks across hosts, retain parallel track ownership, bound SDD Git probes, and preserve integration-cwd workflow selection.
- Isolated the evidence output-cap test in a captured CLI subprocess, verifying complete forwarding and capped log storage without flooding the test runner's live output.

- Version alignment with harness **3.9.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.0**.

## [3.8.3] - 2026-09-12

### Changed

- Scope local verification and review to changed behavior, parallelize independent work, and keep routine QA on targeted unit evidence; full local suites require explicit user authorization.
- Accept explicit `scoped-check` evidence for documentation and policy changes without invented test files, while preserving executable-change test evidence.
- Add the independent `mstar-e2e` workflow and `/amazing-e2e-check` entry, including Codex project command installation, for explicitly requested browser, device, and installed-deployment scenarios.

- Version alignment with harness **3.8.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.3**.

## [3.8.2] - 2026-09-12

### Changed

- **`dsh-llm-fallbacks` upgraded `0.4.1` → `0.5.2`** (the line adapted to `@deepseek-ai/dsh-*` `^0.1.5-rc.2`): the dsh devDependency, the new `@mstar-harness/engine` `DSH_LLM_FALLBACKS_VERSION` export, and the CLI `init --target dsh` install spec are the EXACT `0.5.2`. Two hand-written literals only (`packages/dsh/package.json` + the engine export); the CLI adapter and the dsh tests import the export, and a lockstep test fails if the two ever drift.
- **The 0.5.x role-identity delivery composes with mstar's own persona channel.** The plugin resolves the Assignment `**Execute as**:` role and delivers that role's persona on the child's start; mstar already delivers its native `SubagentStartRequest.persona`, and an explicit caller-set `request.persona` WINS in both (each side returns early when a persona is already present) — an Assignment-header persona is never replaced after the bump.
- **Upstream preset roles shrank on this line.** `presetRoles` no longer bundles `designer` / `librarian`: 5 preset ids, so the seeded taxonomy union is 13 mstar ids + 5 presets = 18 (was 20). The coexistence and boot-order drift anchors follow the installed upstream value, so the next preset change fails those suites instead of drifting silently.
- 0.5.2 provides its `llm-fallbacks` service INSIDE `ctx.inject(['settings'], …)` — a composition without a `settings` service applies the plugin but registers no service (the real dsh app always composes `dsh-settings-file`). The consumed nine-key service surface is unchanged.
- **The dsh `init` / `doctor` install surface is version-aware for the fallbacks row.** A profile whose `dsh-llm-fallbacks` install is not the pinned version (an operator `link:` checkout from the previous line included) is reported `drifted` by `doctor --target dsh` (exit 1, both versions named) instead of `mounted` + healthy, and `init --target dsh` re-adds the pinned spec instead of reporting `skipped-existing` — the upgrade path from the previous pin, documented in `INSTALL.md` / `docs/cli.md`.

- Version alignment with harness **3.8.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.2**.

## [3.8.1] - 2026-09-11

### Changed

- Version alignment with harness **3.8.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.1**.

## [3.8.0] - 2026-09-10

### Changed

- Version alignment with harness **3.8.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.0**.

## [3.7.3] - 2026-09-10

### Changed

- Version alignment with harness **3.7.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.3**.

## [3.7.2] - 2026-09-09

### Changed

- Version alignment with harness **3.7.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.2**.

## [3.7.1] - 2026-09-09

### Changed

- **CLI ↔ plugin version drift is now visible in one command, for every supported host**: `mstar-harness doctor --target <host>` compares the running CLI version against the installed Morning Star plugin with per-host local discovery (opencode package cache, cursor plugin checkout manifest, codex/omp `plugin list --json`, zcode plugin cache, dsh profile node_modules across all profiles, kimi `$KIMI_CODE_HOME/plugins/managed`; highest semver wins) and prints one directional prompt — CLI newer → per-host plugin update hint, plugin newer → update the global CLI (`npm i -g @mstar-harness/cli@latest`) — as an informational note that never becomes a doctor error or changes the exit code; the `mstar-harness-core` version-drift contract now states all-host coverage.
- `kimi` joins the supported install targets with a minimal adapter: doctor reports the resolved `$KIMI_CODE_HOME/plugins/managed` location without requiring the kimi binary; init is notes-only — plugin install and update go through the Kimi TUI `/plugins install`.
- **Marketplace manifests now pin the plugin version.** `.claude-plugin/marketplace.json` and the root `marketplace.json` carry `version` on the `morning-star-harness` plugin entry, and both manifests joined the release version surfaces — `release:prepare` bumps them at `plugins[0].version` and `release:validate` gates them there, so a ZCode marketplace refresh can detect newer releases.
- **ZCode bootstrap marketplace entry carries `version`.** The CLI seeds the entry with the CLI release version; ZCode's marketplace refresh overwrites the seed with the repo-shipped manifest. Doctor deliberately does not gate on version skew — a snapshot newer or older than the installed CLI is the update signal itself, not an unhealthy marketplace.
- **Worktree gates now distinguish Git checkout identity from physical path nesting.** A real linked worktree created inside the control checkout (the documented `.worktrees` layout) passes the L1 pre-dispatch check and the bound SDD execution context; the same control checkout, a plain subdirectory of it, or a symlink alias of it is refused — even when the declared branch equals the control branch. Git-probe failure fails closed with the existing bounded timeout.
- **The control checkout root is derived by git probe, not `dirname(harness)`.** `resolveSddExecutionContext` resolves the real repository top-level of the declared harness root (`git rev-parse --show-toplevel`, bounded and fail-closed), so a `.mstarc`/override nested harness like `<control>/state/.mstar` gates the same-checkout isolation identically in standalone and active-lease contexts; an unresolvable root fails closed.
- **One shared checkout-identity predicate.** `l1PreDispatchCheck`, `assertControlVsFeaturePath` and `resolveSddExecutionContext` (the `sdd.context.feature-in-control` gate) share `isDistinctCheckout` (canonical per-worktree git dir comparison) — no `.worktrees` name special-case, no duplicated containment rule, and the control-harness-inside-feature, path-escape, lease and branch protections are unchanged.

- Version alignment with harness **3.7.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.1**.

## [3.7.0] - 2026-09-08

### Changed

- Hardened CLI path handling after a deep static-security scan: relative `--output` values containing `..` segments are now rejected instead of escaping the project root; agent-plugin install validation requires the plugin root to be a real directory and builds manifest/MCP/skill component paths by literal joins; lint target collection and tracked-file listing build child paths from guarded readdir entry names; owned PR-review artifact paths are constructed as single-segment names beside the worktree.
- skill-eval is now fully automated / test-driven: the argv CLI dispatchers (`scripts/skill-eval/index.ts`, the `manifest.ts` stage entry) were removed and the harness is invoked programmatically through its exported stage functions (`prepareManifest`, `executeManifest`, report builders); process spawn stays isolated in the `node-launch.ts` adapter with `manifest.cli.path` validated (absolute local path, no URL scheme or control characters) and realpath-normalized before launch; `canonicalJson` key ordering no longer relies on array `sort()` and is pinned by byte-stability equivalence tests.
- SDD handoffs now carry an absolute destination contract: fresh/resume/reviewer prompts cite the absolute control harness root, feature worktree/cwd, plan, brief/report and context file; native hosted subagents observe pwd/branch before writing, and the handoff states explicitly that a later deliberate `chdir`, absolute-path write, or host-native edit tool (`apply_patch`) is not blocked.
- New bound SDD execution surface (spec A3): `mstar sdd exec --context <context.json> -- <argv>` launches CLI children with cwd bound to the feature worktree (no shell, exit 1 gate / 2 usage / 127 not-found / 128+n signals); `mstar sdd check-context` gates `source|artifact|launch` seams; `task-brief`/`review-package` accept `--context` to validate destinations before mkdir/write and emit absolute paths. A causal replay suite reruns the historical relative-source write raw (wrong-primary reproduced) vs bound (feature-only) on disposable fixtures.
- Engine exports: `resolveSddExecutionContext`, `checkSddAction`, `runInSddContext` — bounded action checks reusing the existing lease/branch/path machinery; no new global hardening and no sandbox claim.
- **One skill-lint classification policy across hosts**: CLI `mstar skill lint`, dsh skill-lint gate and drift Guard 5 now consume the shared Engine classifier `classifySkillLint` (exact `mstar-harness-core` → five-question exempt, `mstar-skill-authoring` → strict authoring, other `mstar-*` → runtime aliases, everything else → strict authoring). Identity is the resolved skill-directory basename — never the YAML `name` — so shipped runtime skills no longer receive conflicting dsh/CLI judgments; frontmatter and ephemeral-citation checks stay active in every profile and dsh content-blind repair behavior is unchanged.
- **Real-corpus parity + drift sensitivity evidence**: before/after lint decisions recorded on the shipped corpus (pre-fix dsh failed 15/20 `mstar-*` skills in authoring mode; candidate dsh, CLI and Guard 5 all pass the 18 runtime skills with 0 violations), plus red probes proving an intentionally mismatched classification or a removed real heading fails the corpus guard.
- ZCode plugin cards now show the Morning Star **icon and display name**: the repo-shipped marketplace manifests (`.claude-plugin/marketplace.json`, root `marketplace.json`) and the CLI `zcode` bootstrap snapshot carry `icon` + `displayName` for the `morning-star-harness` entry.
- Bundled **ZCode plugin hooks** (`hooks/hooks.json`): **SessionStart** injects a compact harness-workspace context ({HARNESS_DIR} + `status.json` summary + `mstar-harness-core` load pointer; silent no-op outside harness workspaces), and **PreToolUse (Bash)** adds a deterministic git gate backing `mstar-branch-worktree` — blocks direct commits on the default protected branch (`MSTAR_ALLOW_DEFAULT_BRANCH_COMMIT=1` escape) and bare `git push --force` (`--force-with-lease` required; `MSTAR_BRANCH_GUARD=off` disables the hook).
- Documented the icon + hooks behavior in `INSTALL.md` (ZCode sections) and `mstar-host` → `references/zcode.md`.

- Version alignment with harness **3.7.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.0**.

## [3.6.3] - 2026-09-06

### Changed

- Replaced static synthetic credentials in security tests with locally generated disposable values (random tokens, locally signed JWTs, in-memory RSA and OpenSSH keys), preserving every detection and redaction assertion without requiring an OpenSSH executable. CLI coverage now also asserts a tracked token is found and its value never printed.
- Reworded the placeholder-masking comment in the engine audit source and the mstar-audit prompt-injection rules to state the invariant without quoting attack phrasing; paired before/after classification checks keep the defensive behavior identical.

- Version alignment with harness **3.6.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.3**.

## [3.6.2] - 2026-09-05

### Changed

- Added a **PR review time-budget system**: engine constant table `PR_REVIEW_TIER_BUDGETS` (wall-clock target + per-seat caps per tier) is the numeric SSOT, rendered as a budget block in `prReviewSeatPrompt` seat prompts.
- Added a **`mstar pr-review budget`** CLI command printing the per-tier budget table (`quick`/`default`/`deep`) for humans and drift checks.
- Added a **Budget column and a time-budget degradation ladder** (①read-depth ②seat topology ③display, with a never-degrade list) to `mstar-audit` PR-review prose and the `/amazing-pr-review` command.

- Version alignment with harness **3.6.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.2**.

## [3.6.1] - 2026-09-03

### Changed

- Shipped repo-side ZCode marketplace manifests (`.claude-plugin/marketplace.json`, with root `marketplace.json` as fallback) so ZCode's `github`-source marketplace refresh can discover the catalog in-repo — previously refresh failed with `Marketplace manifest not found in GitHub repo`. Plugin entries use the `github` source with no pinned version; install-time versions come from `.zcode-plugin/plugin.json`.
- Aligned the `zcode` adapter: the local marketplace snapshot written by `init` no longer pins a plugin version, and `doctor` accepts version-less plugin entries (a successful ZCode refresh overwrites the snapshot with the repo manifest).

- Version alignment with harness **3.6.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.1**.

## [3.6.0] - 2026-09-03

### dsh

- **`dsh-llm-fallbacks` upgraded to `0.4.1`** (the line adapted to `@deepseek-ai/dsh-*` `^0.1.2-rc.1`): the repo's devDependency and the dsh adapter's install spec are now the EXACT `0.4.1` (no caret). The unpinned add previously forwarded the dsh CLI's own manifest spec (`^0.3.5`), whose dist re-exports `installSettingsSection` from `@deepseek-ai/dsh-settings` — an export the rc.1 line removed — breaking the installed-artifact boot; the installed dsh e2e specs now also pin the fallbacks add and extend the shipped-surface probe to the native persona channel (`internal/get` + `request.persona`), so a published dist built on the superseded additive-section path is re-added pinned to the repo version instead of silently booting stale.
- Both dsh install e2e specs run green end to end against the real registry (previously failing on the `^0.3.5` re-export break).
- **New `@mstar-harness/omp` npm package**: `omp plugin install @mstar-harness/omp` now works without any local build — the omp hook + six `mstar_*` tools are bundled with the engine **inlined** (zero runtime `@mstar-harness/engine` resolution), fixing `Cannot find package '@mstar-harness/engine'` on third-party installs. Docs (`INSTALL.md`, `README.md`/`README_CN.md`, `mstar-host` omp reference) and the CLI omp adapter now prefer the npm install path; the maintainer `omp plugin link` path is `<repo>/packages/omp` (needs `bun install && bun run engine:build && bun run --cwd packages/omp build` in the checkout).
- **BREAKING (intended)**: repo-root `hooks/` and `tools/` moved into `packages/omp/src/` — the omp hook/tools are now omp-only package surfaces. Anyone relying on repo-root `hooks/pre/mstar-gates.ts` / `tools/mstar_*` paths must use the package (`packages/omp/src/…` sources, `<pkg>/hooks/` + `<pkg>/tools/` in the installed npm tree). The maintainer `omp plugin link` path is now `<repo>/packages/omp` (built) — linking the repo root no longer provides the runtime gates.

- Version alignment with harness **3.6.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0**.

## [3.6.0-alpha.4] - 2026-09-03

### Changed

- **PR review diff snapshot**: `mstar pr-review worktree-setup` now pins the review diff basis to a snapshot file beside the sidecar (`<parent-of-worktree>/.<wt-dirname>.prreview.diff`, printed as `diffFile` in setup output; `null` for `--diff` / `--working-tree` modes) so every Stage 1/2 seat reads one pinned diff instead of re-running git — `mstar pr-review seat-prompt` passes it through as `--diff-file` and the prompt gains a "read the pinned diff snapshot FIRST" ingredient; cleanup removes the snapshot with the sidecar, and snapshot capture is wrapped in the worktree rollback so a failed setup never orphans a worktree.
- **Worktree convention + ownership**: review worktrees now default under `<repoRoot>/.worktrees/review-…` (the `mstar-branch-worktree` convention; `.worktrees/` is added to `.git/info/exclude` when the target repo does not ignore it) instead of a sibling directory beside the repo, and `worktree-cleanup` only deletes files whose identity (dev/ino/mtime, link count) matches the snapshot recorded at setup — a replaced or foreign file at the snapshot path is left in place, and a pre-existing sidecar makes setup refuse with a `worktree-cleanup` hint instead of deleting it.

- Version alignment with harness **3.6.0-alpha.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.4**.

## [3.6.0-alpha.3] - 2026-08-31

### CLI

- Codex installs now use a repo-bundled marketplace: the harness repo ships `.agents/plugins/marketplace.json` (name `mstar-repo`, plugin root = repo root), and `npx @mstar-harness/cli init --target codex` registers it via `codex plugin marketplace add btspoony/mstar-harness --ref main`. Install with `codex plugin add morning-star-harness@mstar-repo`; refresh snapshots with `codex plugin marketplace upgrade`. `doctor --target codex` validates the marketplace registration via the codex CLI and reports legacy `personal` marketplace entries as a migration note; Codex custom-agent `.toml` symlinks continue to come from the shared `~/.mstar/harness` checkout.

- Version alignment with harness **3.6.0-alpha.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.3**.

## [3.6.0-alpha.2] - 2026-08-31

### Changed

- Version alignment with harness **3.6.0-alpha.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.2**.

## [3.6.0-alpha.1] - 2026-08-31

### Changed

- Version alignment with harness **3.6.0-alpha.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.1**.

## [3.5.1] - 2026-08-28

### Changed

- Version alignment with harness **3.5.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.5.1**.

## [3.5.0] - 2026-08-28

### Harness

- Added a pluggable **ArtifactStore** for JSON coordination docs: `status.json`, workflow snapshots, and project residuals now persist through `ArtifactStore.put` / `get` (default `FsStore` keeps the existing `{HARNESS_DIR}` paths and atomic-write semantics). Integrations can mount their own store in-process via `setArtifactStore` or per-command via `MSTAR_STORE_MODULE` / `--store` — filesystem paths only, URI schemes are rejected before `import()`.
- Added `mstar-harness persist <kind> --key <key> [--file <path>|--stdin] [--store <module>] [--schema <id>]` and `mstar-harness persist get <kind> --key <key> [--store <module>]` for `status` / `snapshot` / `residuals` / `review` / `json`, running the existing kind validators before put.
- `mstar-harness init` now auto-installs the **matching-version** `@mstar-harness/cli` globally after a successful run, so the `mstar-harness` binary lands on PATH for engine-check commands. The install is skipped when the PATH version already matches, is fail-soft on npm errors (init still exits 0), and can be opted out with `--no-global-cli`; `--dry-run` prints the would-run `npm i -g` command without executing it.
- `mstar-harness doctor` now prints a non-fatal CLI-on-PATH note (missing / mismatch / match) for every target.
- Added a first-class **review JSON kind** (`mstar.review/v1`): `synthesizeReview` folds vetted findings into a validated envelope (verdict/tally from `computePrTally`), `mstar-harness persist review` validates the envelope before put (inspector M1 vocab rejected), and `pr-deep-review` / `amazing-pr-review` Stage 3 must persist the envelope — the Markdown report is the optional human copy.
- Made `FsStore.put` **fail loud on unpersistable envelope schemas**: a doc carrying an envelope `schema` id is now rejected with a canonical error instead of being silently dropped (FsStore persists `doc.payload` only); payload-internal `schema` fields are unaffected.
- Added optional **`ArtifactStore.list?(kind)`** enumeration: stores that cannot enumerate decline by omitting the member (callers probe `typeof store.list === "function"`, same pattern as `delete?`); `FsStore` implements it via the single kind→path table (missing backing file → `[]`, keys sorted ascending, every listed key round-trips through `get`, `json` kind throws the canonical usage error).
- Added the **`persist list <kind>`** CLI face: prints stored keys only (one per line, ascending, no header); `json` is rejected as a usage error before enumeration, and an injected store without `list` exits 2 (probed, never a TypeError).
- Added **`persist get --validate`**: reuses the put-gate validators on the fetched payload — stdout stays payload JSON only; notes (`validation: ok` / `json: parse-only`) and violations go to stderr; a miss or an invalid document exits 1.
- Added the **`persist delete <kind> --key <key>`** CLI face: idempotent (absent key is a no-op, exit 0, prints `deleted <kind>/<key>`), no confirmation prompt; an injected store without `delete` exits 2.

- Version alignment with harness **3.5.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.5.0**.

## [3.4.1] - 2026-08-27

### Changed

- Version alignment with harness **3.4.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.4.1**.

## [3.4.0] - 2026-08-27

### Harness

- Deterministic static checks from the audit security review are now mechanical engine code with CLI entry points: `mstar audit secret-scan [path]` walks git-tracked files read-only through `scanSecrets` and prints `{file, line, type}` findings (never values), exiting 1 on any hit; patterns cover provider key shapes (AKIA/ASIA, sk-ant-, ghp_/github_pat_, sk_live_, sk-, xox[baprs]-, JWT, private-key blocks), never-commit filenames (`.env*`, `*.pem`, `*.key`, `id_rsa`, credentials/service-account JSON, git-credentials), CI/IaC leak shapes (Actions plaintext `env:` map entries and same-line assignments, Docker `ENV`/`ARG`, Terraform `password =`), while safe placeholders (`${ENV_VAR}`, `process.env.X`) are excluded. `mstar audit supply-chain [path]` runs `supplyChainChecks`: lockfile-missing / lockfile-duplicate across the known lockfile set, `action-unpinned` (`@main`/`@latest`, trailing-comment tolerant, SHA pins clean), and `pull_request_target-head` PR-head checkout; reachability triage stays with the reviewer.
- Credential patterns now have a single source of truth: `WHOLE_MATCH_PATTERNS` / `VALUE_PATTERNS` in `packages/engine/src/audit.ts` back both `redactSecrets` and `scanSecrets`, reconciling the engine-vs-prose drift — the engine table gained fine-grained GitHub PATs (`github_pat_`) and Stripe live keys (`sk_live_`). `scaffoldAuditPlan` wires `redactSecrets` over finding evidence/description so scaffolded plans honor the redaction promise, and `security-review.md` §6 collapses its duplicated pattern list to an engine-check pointer at `mstar audit secret-scan`, keeping only discipline prose.
- Programmatic deferred-PR backlog registration: `mstar status backlog-register` / `mstar status backlog-close` replace the hand-rolled python lock protocol in `skills/mstar-audit/references/pr-review.md`. The engine `appendProjectRegisterEntries` / `closeProjectRegisterEntry` run inside `withStatusWriteLock` with atomic temp+rename writes (crash-safe, fail-loud validation); same-day key bump (`-2`, `-3`, …) and entry-id uniqueness are enforced inside the lock (B-9).
- PR-review deterministic arithmetic and naming contracts moved from LLM hand-computation into tested engine code, exposed as the new `mstar pr-review` command group: `tally` (locked-formula tally/verdict/score + verbatim two-line chat header from accepted findings JSON), `report-path` (local-report/evidence filename resolver with same-day `-r2`/`-r3` collision escalation and never-fabricated SHAs), and `validate-report` (saved-report frontmatter validation: verdict-from-tally, score recompute, comments tri-state). `mstar-audit/references/pr-review.md` § Tally / § Local report archive naming / § Output shape now carry engine-check callouts pointing at these commands.
- PR-review external side effects became tested engine code behind new `mstar pr-review` commands: `post` (builds the GitHub Review plan via `planReviewPost` — owner/repo parsed from the PR url only, never `headRepository`; `event` locked to the literal `COMMENT`; `commit_id = headRefOid`; at-most-once 422 fallback folding exactly the rejected inline comments into the body), `worktree-setup` / `worktree-cleanup` (collision-free branch naming via `pickReviewBranchName`, explicit-refspec fetches, `preflightChangeset` gates where untracked-only changesets count, sidecar-guarded cleanup that removes the tree, prunes and deletes exactly the recorded review branch behind the report-saved gate), `size` (`prReviewSizing` ~100/~300/~1000 bands + Stage-1 seat plan, split advice, file-size watch) and `seat-prompt` (`prReviewSeatPrompt` skeletons: Hard Rules 4/5 verbatim, payload-return contract, no-verdict/no-post clauses, `<domain>-<seat>` slugs). Finding docs gained a programmatic hook: `mstar lint --type finding` backed by `validateFindingDoc` (`### [CATEGORY-NN]` numbering, category/effort/risk/confidence enums, evidence `path:line` shape; Merge-class presence/enum/placement with `--pr-variant`).

- Version alignment with harness **3.4.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.4.0**.

## [3.3.0] - 2026-08-25

### Changed

<!-- CN block intentionally omitted — engine/cli changelogs are EN-only; root bullets reused per .changes/README.md -->
- **Audit index security dispositions in `scaffoldAuditPlan`** (engine): the README index renderer now emits the documented **Needs verification** and **Hardening & checked notes** sections (new `needsVerification` / `hardeningChecked` options). On re-runs without those options, previously rendered entries are carried over from the existing README, so hand-added or earlier-run security leads, hardening notes, and checked-and-clean records survive the index rebuild instead of being silently dropped.
- **`mstar audit scaffold` accepts security dispositions** (cli): the findings file now also accepts an object form `{findings: [...], needsVerification?: [{lead, how, evidence?}], hardeningChecked?: [{kind, text}]}` (bare array still supported) and passes the dispositions through to the engine renderer, so CLI-scaffolded audit indexes include the security sections exactly as documented in `mstar-audit/references/security-review.md`.
- Added **`mstar harness scaffold [path]`** (default cwd): one-shot harness bootstrap — engine `scaffoldHarness` now also prebuilds `projects/_default/` (`roadmap.md` with valid `validateRoadmap` frontmatter + `## Direction` placeholder, and an empty `residuals.json` passing `validateProjectRegister`); the CLI appends the canonical `.gitignore` snippet when absent, writes a minimal `.mstar/AGENTS.md` when absent, and prints a created/skipped summary. Idempotent — re-running on an initialized tree only creates missing pieces.
- `mstar harness scaffold` is now `.mstarc`-aware: it scaffolds into the `.mstarc`-declared `harness_dir` (or the `MSTAR_HARNESS_DIR` override), lands `projects/_default/` under the resolved `project_dir`, and prints the resolved harness/project dirs. The canonical `.gitignore` snippet is appended only for the default `.mstar/` layout — custom harness layouts skip it. The fence now splices `.mstar/**` BEFORE existing `!.mstar/…` re-includes when the broad rule is missing (gitignore last-match-wins), keeping the re-includes effective.
- `mstar path resolve` failure guidance now points to `mstar harness scaffold` instead of `mstar init`.

- Version alignment with harness **3.3.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.3.0**.

## [3.2.6] - 2026-08-24

### Changed

- Version alignment with harness **3.2.6**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.6**.

## [3.2.5] - 2026-08-24

### Changed

- Version alignment with harness **3.2.5**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.5**.

## [3.2.4] - 2026-08-24

### Changed

- Version alignment with harness **3.2.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.4**.

## [3.2.3] - 2026-08-24

### Changed

- Version alignment with harness **3.2.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.3**.

## [3.2.2] - 2026-08-24

### Changed

- Version alignment with harness **3.2.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.2**.

## [3.2.1] - 2026-08-24

### Changed

- Version alignment with harness **3.2.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.1**.

## [3.2.0] - 2026-08-23

### Changed

- Version alignment with harness **3.2.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.0**.

## [3.1.3] - 2026-08-23

### Harness

- **`mstar audit promote` (CLI)**: selected audit plans can now enter the v2 workflow lifecycle as `type: plan` — `promoteAuditPlans` writes the workflow snapshot (`{HARNESS_DIR}/workflows/<id>/snapshot.json`, one Todo `PlanRow` per selected plan, `id` + `title` + `file`) **before** registering the workflow in root `status.json`, so the snapshot-before-register invariant holds. `--plans` accepts the README Plan column id, stem, or basename; `--workflow` defaults to the `audit-<date>` dir basename; `--harness` defaults to the resolved `{HARNESS_DIR}`. Promote stays an explicit post-selection action — the audit itself never registers (advisory contract preserved).
- **Engine**: `promoteAuditPlans` exported from `@mstar-harness/engine` (titles come from the audit README index, falling back to `readPlanFileSummary`).
- **Harness skills**: `mstar-audit` Handoff step 1 now names `mstar audit promote <audit-dir> --plans <ids>` as the first-class v2 path (manual `mstar-plan-artifacts` wording kept as fallback).
- **Unified the three CLI `execFileSync` wrappers** into a single `runCliCommand` helper (`packages/cli/src/exec.ts`): `runCommand` (shared-install), `runOmp` (omp), and `runDsh` (dsh) are now thin calls with today's defaults — no public signature or behavior change. Timeout / env / dry-run can no longer drift independently across the wrappers; `runDsh` keeps its `env: process.env` + `timeout` contract (dsh PATH injection in tests).
- **Engine git env-pin regression test (test-only)**: `packages/engine/test/exec-env.test.ts` now detects any git `execFileSync` call whose options carry an empty env (`env: {}` / `env: { PATH: "" }`) across `path.ts` / `sdd.ts` / `worktree.ts` — production env handling is untouched.
- **audit-004 validator CLI surface closure verification**: the five validator commands (`mstar status tech-debt`, `mstar status findings-cleanup <plan-id>`, `mstar lease verify-integration`, `mstar worktree qc-alignment`, `mstar host skill-root`) were smoke-verified runnable against the repo fixtures from the dist build (`node packages/cli/dist/mstar-harness.js`), each exiting per its documented semantics; no command code changed. Residual `20260816-audit-004-validator-cli-surface` moves to in-place `lifecycle: resolved` with the smoke evidence referenced.

- Version alignment with harness **3.1.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.3**.

## [3.1.2] - 2026-08-21

### Changed

- Version alignment with harness **3.1.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.2**.

## [3.1.1] - 2026-08-20

### Changed

- Version alignment with harness **3.1.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.1**.

## [3.1.0] - 2026-08-20

### Changed

- Version alignment with harness **3.1.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.0**.

## [3.0.1] - 2026-08-20

### Changed

- Version alignment with harness **3.0.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.0.1**.

## [3.0.0] - 2026-08-20

### Harness

- Harness dir is uniformly `.mstar/` across the repo: maintenance docs moved under `.mstar/docs/`, the legacy maintenance root is gone, and probe/override docs no longer reference a legacy root name. `harnessDir` / `MSTAR_HARNESS_DIR` semantics unchanged — explicit override wins; probe order stays `.mstar/` → `.agents/` → `.plans/`/`plans/`.
- `drift-lint` roadmap-citation exemption now recognizes `.mstar/`-prefixed citations (gitignored roadmap/ADR docs); engine/dsh/opencode source citations updated to the new path.
- `.mstarc` now supports every harness directory symbol under `[config]`: `plan_dir`, `sdd_dir` (per-plan base), `iteration_dir`, `knowledge_dir`, `specs_dir` (authoritative — skips the candidate chain) alongside `harness_dir`. The engine resolvers (`resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir`) honor them from the nearest `.mstarc` at the harness dir or its parent; `mstar_path_resolve` reports the knowledge dir too.
- `.mstarc` `[config] enforcement=hard|soft` declares the repo hard-gate policy (invalid values ignored). Precedence: explicit Config > Assignment `Enforcement: hard` header flag (dispatch only) > `.mstarc` > iteration compass > warn-only — `.mstarc` `soft` is a local rollback against a hard compass, `hard` hardens flag-less dispatches and gates. New engine `resolveMstarcEnforcement` / `resolveRepoEnforcement`; dsh gates, opencode hook and omp hook now compose the repo policy.
- New gitignored repo-local config **`.mstarc`** (`[config] harness_dir=<dir>`) lets repos with a non-default harness root declare it programmatically — `resolveHarnessDir` honors it above probing (explicit `opts.harnessDir` / `MSTAR_HARNESS_DIR` still win), `sddWorkspace` follows, and the canonical `.gitignore` snippets (engine / CLI init fence / plan-conventions) ignore `.mstarc` by default. Resolution order SSOT updated in `mstar-plan-conventions` § {HARNESS_DIR} 解析顺序.
- Tracked `*.ts` / `*.md` files no longer cite gitignored harness artifacts (paths under `.mstar/` — status.json, plans/, sdd/, iterations/, knowledge/, references/, archived/, docs/): engine/host/test comments and docs now reference `{HARNESS_DIR}` / the consumer default or drop the local path; the drift-lint `.mstar/`-citation exemption is removed (the guard now enforces the rule), and AGENTS.md codifies it.
- **v3 workflow lifecycle schema (engine)**: lifecycle state moved from root `status.json` `plans[]`/`residual_findings` into per-workflow snapshots (`{HARNESS_DIR}/workflows/<id>/snapshot.json`, `validateWorkflowSnapshot`) and project registers (`{HARNESS_DIR}/projects/<id>/residuals.json`, `validateProjectRegister`); the v2 root keeps only `version` / `updated_at` / active `workflows[]`. New dir resolvers `resolveWorkflowDir` / `resolveProjectDir`.
- **`mstar migrate` (CLI)**: one-shot v1→v2 tree migration (`migrateHarnessTree` / `applyMigratePlan`) — archives the v1 root to `archived/status.v1.json`, lifts every lifecycle into `workflows/<id>/snapshot.json`, seeds the project register + roadmap, replaces the root with the v2 commit point; idempotent re-run no-op; `--dry-run` prints the step plan and surfaces apply-time validator violations as warnings; exit codes 0/1/2; `--path` defaults to the resolved `{HARNESS_DIR}`.
- **CLI/tools/hook hard cutover to v2 inputs**: `status validate` (v2 root or snapshot), `status tech-debt` / `status findings-cleanup` (project register), `lease verify` / `lease verify-integration` / `iteration gate` / `worktree check` (workflow snapshot via `--workflow <id>`), `path resolve` (+ workflow/project dirs); `status archive-residuals` removed (error stub names the register close flow); `tools/mstar_*` and the omp/opencode Gate 1 hooks validate the three v3 coordination documents, with lazy-loaded P1-only engine exports so a stale published engine degrades to a warning instead of dropping the hook/tool.

- Version alignment with harness **3.0.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.0.0**.

## [2.4.1] - 2026-08-17

### Changed

- Version alignment with harness **2.4.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.4.1**.

## [2.4.0] - 2026-08-17

### Changed

- **dsh install target**: `npx @mstar-harness/cli init --target dsh` now installs the full dsh capability in one command — it runs **two independent** `dsh plugin --profile web add` calls (`@mstar-harness/dsh` first, then `dsh-llm-fallbacks`; never folded into a patch file). `doctor --target dsh` reports each plugin row as `uninstalled` / `disabled` / `mounted` and exits non-zero on any uninstalled or disabled row. `--no-fallbacks` (dsh target only) skips the `dsh-llm-fallbacks` row; `--dry-run` previews without probing or executing; re-runs are idempotent (already-installed rows skipped). README pair, `INSTALL.md`, and `docs/cli.md` updated.
- **CLI `mstar` bin alias**: `@mstar-harness/cli` now installs a second executable, `mstar`, alongside the canonical `mstar-harness` — both map to the same `dist/mstar-harness.js` entry, so the two names are interchangeable (pinned by a new manifest test). `commands/` citations now use `mstar-harness` (version-proof: the long name exists in every released version; the short alias ships with this release), and `docs/cli.md` plus the README pair note the alias. **Caution**: `mstar` is a shared bin namespace — an unrelated third-party npm package named `mstar` claims the same command name, so bare `npx mstar …` only resolves to this CLI where `@mstar-harness/cli` is installed; keep the canonical `mstar-harness` in scripts and use the long name on any collision. Existing global installs obtain the `mstar` shim on their next upgrade: `npm i -g @mstar-harness/cli@latest` (or the bun equivalent) re-links all declared bins.
- **Drift-lint bin-prefix guard**: `validation:drift` now checks the binary prefix of every backticked CLI citation in Engine-check callouts against the declared `bin` names from `packages/cli/package.json` (the manifest is SSOT), so citing a nonexistent executable (e.g. a typo like `mstarr`) fails drift-lint instead of silently passing while the subcommand paths validate.
- **CLI path resolution**: relative path args on the six dev commands (`skill lint`, `lint`, `dispatch validate`, `compound validate`, `design-md validate`, `audit scaffold`) now resolve against the workspace/project root instead of the process cwd — `MSTAR_CLI_PROJECT_ROOT` env override (set by the root `cli:dev` wrapper), else the nearest ancestor `package.json` declaring `workspaces` (monorepo root; array, npm single-glob string like `"./packages/*"`, or object form), else the nearest `package.json` (single-package project root), else cwd-relative terminal fallback. Documented invocations like `bun run cli:dev skill lint skills/mstar-audit` (or `bun run --cwd packages/cli dev skill lint skills/mstar-audit`) now find repo-root skills from any cwd; absolute paths are unchanged.
- **Five-question lint runtime mode**: `lintFiveQuestion(body, mode?)` now supports `mode: "runtime"` (default `"authoring"`, non-breaking) with a locked `RUNTIME_HEADING_ALIASES` table — heading synonyms (e.g. `process`/`playbook` for Workflow, `hard rules`/`门禁` for Decision Rules, `output format`/`证据` for Evidence, `dependencies`/`关系` for References) that count as the canonical sections for shipped topic skills. `mstar skill lint` selects runtime mode for `mstar-*` skill dirs except `mstar-skill-authoring` (always authoring/strict); `mstar-harness-core` prints an explicit **exempt** row for the five-question checklist. Greenfield (authoring) lint still demands canonical headings.
- **Runtime corpus alignment**: 15 shipped `mstar-*` topic skills gained minimal annotations/thin sections (Evidence ×13, Workflow ×9, References ×6, plus `mstar-host`'s load-order/decision-rules gaps) derived from existing material — every runtime skill now passes runtime-mode five-question lint; `mstar-audit` needed zero edits. `skills/mstar-skill-authoring/SKILL.md` documents the alias map (runtime-mode semantics stay SSOT: aliases exempt mechanical lint, not content).
- **drift-lint Guard 5 (five-question corpus smoke)**: `bun run validation:drift` now loads every shipped runtime `skills/mstar-*/SKILL.md` (excluding `mstar-harness-core` and `mstar-skill-authoring`), strips frontmatter, and runs `lintFiveQuestion` in runtime mode — deleting a Step-3 aligned heading or losing runtime alias coverage fails CI (audit finding 5).
- **`mstar-skill-authoring` strict self-lint**: the fence-aware heading scan exposed the standard's own `SKILL.md` as a fence false-green (five-question coverage came only from the `## 默认 Body 结构` template code fence), so real `## Workflow` / `## 6 条作者原则（Decision Rules，必须遵守）` / `## 验证门控（Evidence，原则 4 + 6）` sections now answer the five questions honestly and `mstar skill lint skills/mstar-skill-authoring` passes strict (authoring) mode.
- **`mstar roles validate`**: new CLI command exposing the mstar-roles skill-dir checks — a thin mirror of the dsh seam `validateRolesState`: `validateRoleMapping` on the roles dir plus `lintLoadOrder` over every sibling `mstar-*` skill, with unreadable siblings skipped best-effort. Defaults resolve through the project-root path resolution (`--roles-dir` → `skills/mstar-roles`, `--skills-dir` → its parent); exit 0 prints OK + counts, violations exit 1 with one row each. `skills/mstar-roles/SKILL.md` engine-check callout now cites the CLI command.
- **drift-lint Guard 4**: roles/load-order corpus guard in `scripts/drift-lint.ts` (plan 003 Task 2) — `lintLoadOrder` over every `skills/mstar-*/SKILL.md` text (each must declare `mstar-harness-core` in a Load Order / First action section) plus `validateRoleMapping` on `skills/mstar-roles` (mapping / parameter tables must resolve against the on-disk `references/*.md` layout); CI drift-lint now fails on role-table or load-order regressions.
- **Import-only validator CLI surface**: five new maintainer commands exposing engine validators that skill callouts previously cited as import-only — `mstar status tech-debt [path]` (`techDebtRollup`; prints the rollup and PASS/DRIFT vs stored `metadata.tech_debt_summary`, exit 1 on DRIFT), `mstar status findings-cleanup <plan-id>` (`findingsCleanupGate`; mode resolution via Assignment/metadata `zero-residual`, else `allow-residual`), `mstar lease verify-integration` (`validateIntegrationMergeLease`; unclaimed lease = OK, distinct from `lease verify`), `mstar worktree qc-alignment <assignment-file>...` (`assertQcAlignment`; byte-identical `plan_id` / `Review range` / `Diff basis` across QC tri + QA Assignments), and `mstar host skill-root --host <id> --skill <name> [--rel <path>]` (`resolveSkillRoot`). Engine-check callouts in `mstar-plan-artifacts` (incl. `references/status-and-residuals.md`), `mstar-iteration`, `mstar-branch-worktree`, and `mstar-host` now cite the CLI forms.
- **Fix wave (QC F-001/F-002/F-003/F-005)**: `worktree qc-alignment` now also parses the canonical combined `**Review range / Diff basis**:` label (one value fills both range fields; separate labels still win per-field), `host skill-root` rejects an empty `--skill` value as usage (exit 2), the `pi`/`dsh` skill-root shapes and null/tombstone lease fail path now have regression tests, and the help/docs exit tables align commander missing-option (exit 1) vs unknown-host (exit 2).

- Version alignment with harness **2.4.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.4.0**.

## [2.3.0] - 2026-08-16

### Harness

- **SDD fix-round mechanics**: `mstar-sdd` gains four mechanical rules for PM fix-wave dispatch and close-out — an **unverified round counts** (a fix round without verification evidence — reviewer not confirmed / report not on disk — is not clean; re-check and count the round, never enter the convergence branch), **full re-entry** (the next fix dispatch carries all open findings, including last round's unverified items; never slice a subset), **capped cross-round excerpt** (from round ≥2 the dispatch brief carries an excerpt of prior rounds' findings and dispositions — advisory ~500 words/round, ~1500 total, suggested values not hard limits), and **honest non-convergence** (open findings at wave close are listed in detail with an explicit re-feed-to-next-round or transfer-to-residual disposition — never silently closed). Folds Candidate C5 into `mstar-sdd` SKILL.md "After all tasks" + `references/file-handoffs.md` cross-reference (the per-task fix loop applies the same mechanics).
- **Residual fail-loud handoff contract**: `mstar-plan-artifacts` `status-and-residuals.md` now requires findings to pass engine validation before R# registration — `validateResidual` per entry and `validateStatus` for the whole file; malformed entries (non-object, missing any of the nine required fields id/title/severity/source/scope/decision/owner/target/tracking, or severity outside the enum) are **rejected** — fix and rewrite, never silent pass-through, downgrade-write, or write-then-patch. Folds Candidate C6; the architect-verified D-3 branch (covered-but-untested) is closed by backfilled non-object rejection regression tests in `packages/engine` at both the `validateResidual` level and the `validateStatus` aggregate level (engine suite 658 pass / 0 fail) — zero source diff, no new public API.
- **CLI `dispatch validate` non-ASCII literal fix**: bun-executed CLI bundles misdecode raw multi-byte UTF-8 in regex/string literals, so a legal `Branch policy: direct on main — <reason>` (em-dash) was reported as two false violations. Source literals across 20 `packages/engine` + `packages/cli` src files are escaped to `\uXXXX`, a post-build dist escaper guarantees bundle-level ASCII (bun build re-normalizes string escapes), a bundle-smoke regression test covers em-dash + ASCII separators, and `bun run lint:ascii-literals` plus a CI step guard against recurrence. The guard covers `packages/engine` + `packages/cli` source and the CLI dist bundle; the opencode dist bundle is not wired to the escaper — it is not run as a large bun bundle.
- **Regression-fixation paired-evidence reference**: new `mstar-skill-authoring/references/regression-fixation.md` — real artifact as test subject (built bundle / command sequences, not a source import), mock host hooks, dual-path assertion consistency, and fix solidification (reproduce → FAIL → fix → PASS → into the regression set); zero external dependencies, explicitly an optional heavy weapon (default stays P6 before/after + application case). SKILL.md gains the References pointer and syncs its verdict enum to the 4-value SSOT (Approve | Request Changes | Needs Discussion | Unconfirmed).
- **Ephemeral-citation lint (engine)**: new `findEphemeralCitations` scans skill text for short-lived citations — concrete task artifacts (`task-<digits>-(brief|report|fix-report|diff)`, incl. dot form `task-N.diff`) and SDD deeplinks (`.mstar/sdd/` / `.agents/sdd/` + concrete first segment) — while discriminating placeholder forms (`task-N-report`, `<plan-id>`, `{SDD_DIR}/…`, `.mstar/sdd/**` path globs): zero false positives on the current `skills/` corpus.
- **CLI `skill lint`**: third checklist `skill lint (ephemeral citations)` wired into `mstar skill lint` after the five-question checklist; each citation reports as a `skill.ephemeral.<kind>` violation (line + match + placeholder rewrite fix) and sets exit 1.
- **drift-lint guards**: docs audit-enum set-equality (docs/cli.md `<category>` row and README category-focus lists vs the engine `AUDIT_CATEGORIES` — catches fabricated tokens like `deps` and omissions like `bug` / `direction`), README.md / README_CN.md same-commit bilingual pairing over the push range, and a skills-corpus ephemeral guard reusing `findEphemeralCitations`; plus a `citesKnowledgeConventions` exemption for harness-local knowledge citations.
- Internal `@mstar-harness/engine` devDependencies in cli/opencode/dsh now use the `workspace:*` protocol; the release-prep engine-spec sync step was removed.

- Version alignment with harness **2.3.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.3.0**.

## [2.2.0] - 2026-08-13

### Changed

- **engine**: `resolveHarnessDir` now stops at the workspace root (roadmap §7c defect fix) — the upward probe keeps walking only while `dir` is at or below `opts.workspaceRoot`, so a harness dir above the workspace (e.g. the global `~/.mstar` CLI-install root) is never returned. The default boundary is the git top-level of the start dir (sync `git rev-parse --show-cdup`; non-git start falls back to the start dir itself — probes only itself, never upward; deliberate tightening). Explicit overrides (`opts.harnessDir` / `MSTAR_HARNESS_DIR`) short-circuit before the boundary and keep their authority.
- **Sync upstream v2.1.1**: merged the upstream `mstar-harness` v2.1.1 line into the dev-dsh branch — adds the `code-reviewer` role (read-only L2 SDD task reviewer / audit executor; replaces `generalPurpose` as the SDD per-task review seat, with generic fallback only when the role agent is absent on the host), ships the canonical default-ignore harness `.gitignore` format (`.mstar/**` + tracked re-includes `AGENTS.md` / `knowledge/` / `specs/`) across the engine, CLI `init` fence and bundled skills, and aligns all 11 version surfaces to 2.1.1.
- **engine**: `emitGitignoreSnippet` / `validateGitignore` / `HARNESS_PROCESS_GITIGNORE` now emit the default-ignore + re-include format instead of the flat per-directory ignore list; `ROLE_MAPPING` grows to 14 ids with `code-reviewer`.
- **bundle-assets**: re-synced `packages/dsh/harness-skills` / `harness-commands` from the merged `skills/` tree — the 6+ upstream-touched bundled skills and all `mstar-host/references/*.md` host adapters (cursor/kimi/omp/opencode/zcode) now carry the v2.1.1 wording (SDD task reviewer → `code-reviewer`).

- Version alignment with harness **2.2.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.2.0**.

## [2.1.1] - 2026-08-12

### Harness

- Canonical `.gitignore` snippet now default-ignores the whole harness dir (`<dir>/**`) and re-includes only the tracked results (AGENTS.md, knowledge/, specs/) — new process subdirectories are ignored automatically.

- Version alignment with harness **2.1.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.1.1**.

## [2.1.0] - 2026-08-12

### Changed

- Version alignment with harness **2.1.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.1.0**.

## [2.0.6] - 2026-08-10

### Changed

- Version alignment with harness **2.0.6**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.6**.

## [2.0.5] - 2026-08-10

### Changed

- Version alignment with harness **2.0.5**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.5**.

## [2.0.4] - 2026-08-09

### Changed

- Version alignment with harness **2.0.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.4**.

## [2.0.3] - 2026-08-09

### Changed

- Version alignment with harness **2.0.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.3**.

## [2.0.2] - 2026-08-08

### Changed

- Version alignment with harness **2.0.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.2**.

## [2.0.1] - 2026-08-08

### Changed

- Version alignment with harness **2.0.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.1**.

## [2.0.0] - 2026-08-08

### Changed

- Added the **`@mstar-harness/engine`** package scaffold: a version-aligned workspace library (`zod` + `ajv`, `node:*` only, no `bin`) with a typed `ValidationResult` + `readHarnessVersion()` placeholder core, wired into the release surface list (10 → 11), changelog assembly, and root workspaces.
- **Engine hardening (QC fix wave, slice 1)**: lease location/orphan/dual-write verify (`lease.verify.*`) moved into `@mstar-harness/engine` (CLI `mstar lease verify` is now a thin wrapper); `archiveResiduals` gained a plan-id path-traversal guard, the status write lock, and append dedup; `withStatusWriteLock` gained an ownership guard (never removes another writer's lockdir), a `holder.pid` crash-diagnosis file, and fast-fail reentrancy detection; `readHarnessVersion` reads the module's own manifest first (published installs no longer regress to `0.0.0`); `tech-debt-rollup` parity now mirrors jq `//` exactly (`false`/`0` edges tested against the bash oracle); residual closed-lifecycle completeness (`closed_at` + `closure_note`) and plan-row `Done` ⇒ no-lease invariants added. Release prep now ensures the `@mstar-harness/engine` registry row + package-history link in root changelog heads.
- **Harness Workflow Engine positioning (iteration v2.0.0)**: unified engine-first descriptions across the 7 plugin manifests and the 4 package manifests; added `workflow-engine` / `workflow-enforcement` / `deterministic-workflow` / `harness-workflow` keywords to the root plugin manifest; re-framed README.md / README_CN.md around deterministic workflow gates enforced by a TS engine (not prompts alone) with judgment staying in `mstar-*` skills, plus a What-ships table (Harness Workflow Engine / mstar CLI / `mstar-*` skills / host adapters).

- Version alignment with harness **2.0.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.0**.

### Changed

- `mstar dispatch validate` derives the default-branch gate branch FROM the Assignment's own branch forms (create-form name / Working branch / Branch policy branch), with `--branch` / `$MSTAR_WORKING_BRANCH` as context fallbacks (qc2 W-1 / qc3 F-2); read-only roles (scout/explore) skip both branch gates (qc3 F-1).
- Local `parseBranchPolicyDirectOnBranch` removed — CLI consumes the engine's single branch-form grammar (`parseAssignmentBranchForms` / `parseBranchPolicyDirectOnBranch`) (qc1 F-001).

## [1.8.9] - 2026-08-07

### Changed

- Added a portable **Agent Plugins v1.0.0** manifest (`plugin.json`) at the repo root, aligned with the CLI release surface (`skills/` is the Agent Skills component), plus `mstar-harness plugin validate` to check the package (including `mcp.json` / `skills/`) against the Agent Plugins v1.0.0 spec.

- Version alignment with harness **1.8.9**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.9**.

## [1.8.8] - 2026-08-06

### Changed

- Version alignment with harness **1.8.8**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.8**.

## [1.8.7] - 2026-08-06

### Changed

- Version alignment with harness **1.8.7**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.7**.

## [1.8.6] - 2026-08-06

### Changed

- Version alignment with harness **1.8.6** (no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.6**.

## [1.8.5] - 2026-08-06

### Changed

- omp `init` post-install note: Host adapter now `mstar-host → references/omp.md` (`skill://…`) instead of consumer-cwd `skills/mstar-host/…`.
- Version alignment with harness **1.8.5**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.5**.

## [1.8.4] - 2026-08-06

- Version alignment with harness **1.8.4** (skill-relative script path docs; no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.4**.

## [1.8.3] - 2026-08-05

- Version alignment with harness **1.8.3** (omp host docs prefer live-schema role `task.agent`; no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.3**.

## [1.8.2] - 2026-08-05

- Derive ZCode marketplace/`doctor` version from `packages/cli/package.json` via shared `readHarnessVersion()` (remove drifted hardcoded `PLUGIN_VERSION`).
- Version alignment with harness **1.8.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.2**.

## [1.8.1] - 2026-08-05

- Version alignment with harness **1.8.1** (no CLI API change; bundled skills/commands optimization landed at the harness layer).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.1**.

## [1.8.0] - 2026-08-05

- **Codex adapter**: `CODEX_PROJECT_COMMAND_NAMES` (renamed from `CODEX_ITERATION_SKILL_NAMES`) now includes `codebase-audit`; project-scoped install materializes it alongside iteration commands. Global-scoped install warning updated.
- **omp adapter**: smoke test (`COMMAND_SMOKE`) and install notes include `codebase-audit`.

## [1.7.1] - 2026-08-05

- Fix omp doctor plugin detection for `omp plugin list --json` `{ npm, marketplace }` shape.
- Version alignment with harness **1.7.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.7.1**.

## [1.7.0] - 2026-08-05

- Add **`omp`** install target (`packages/cli/src/adapters/omp.ts`): link/install Morning Star into omp plugins; doctor validates markers + `omp plugin list`.
- Version alignment with harness **1.7.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.7.0**.


## 1.6.1

- Version alignment with harness **1.6.1** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.6.1**.

## 1.6.0

- **New `zcode` install target**: `init --target zcode` registers a `mstar-local` marketplace (github source) in `~/.zcode/cli/plugins/{known_marketplaces.json, marketplaces/mstar-local/marketplace.json}`; `doctor --target zcode` validates both JSON files + checkout + gitignore. Project scope keeps a local `.zcode/plugin-checkout` for smoke checks. `SUPPORTED_TARGETS` now includes `zcode`; `shared-install` `HARNESS_MARKERS` also accepts `.zcode-plugin/plugin.json`.
- Version alignment with harness **1.6.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.6.0**.

## 1.5.6

- Version alignment with harness **1.5.6** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.6**.

## 1.5.5

- Version alignment with harness **1.5.5** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.5**.

## 1.5.4

- Version alignment with harness **1.5.4** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.4**.

## 1.5.3

- Version alignment with harness **1.5.3** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.3**.

## 1.5.2

- Project `init`/`doctor` (Cursor/Codex project scope): append/check full harness **process** gitignore set under `.mstar/` and legacy `.agents/` (`archived/`, `iterations/`, `plans/`, `sdd/`, `notes.json`, `status.json`). Results paths (`knowledge/`, `specs/`, `AGENTS.md`) are not forced gitignored.
- Version alignment with harness **1.5.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.2**.

## 1.5.1

- Version alignment with harness **1.5.1** (Phase 5 push cadence; no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.1**.

## 1.5.0

- Version alignment with harness **1.5.0** (iteration Phase 2 worktree/lease + Phase 5 babysit-first helpers; no CLI API change in this bump).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.0**.

## 1.4.0

- Version alignment with harness **1.4.0** (Kimi host installs via Kimi TUI `/plugins install`; no CLI `--target kimi`).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.4.0**.

## 1.3.2

- Version alignment with harness **1.3.2** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.2**.

## 1.3.1

- Version alignment with harness **1.3.1** (iteration package layout; no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.1**.

## 1.3.0

- Codex project install: materialize `iteration-start`, `iteration-drive`, and `iteration-loop` as `.agents/skills/*/SKILL.md` symlinks; `doctor` validates links; global install skips with warning.
- Version alignment with harness **1.3.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.0**.

## 1.2.1

- Version alignment with harness **1.2.1** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.2.1**.

## 1.2.0

- OpenCode `init` fast path: schema + plugin only; no interactive model picking / no `opencode models` discovery (avoids silent hangs). Optional `--*-model` flags remain as advanced overrides.
- Version alignment with harness **1.2.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.2.0**.

## 1.1.0

- Version alignment with harness **1.1.0** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.1.0**.

## 1.0.6

- Version alignment with harness **1.0.6** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.6**.

## 1.0.5

- Version alignment with harness **1.0.5** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.5**.

## 1.0.4

- Version alignment with harness **1.0.4** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.4**.

## 1.0.3

- Version alignment with harness **1.0.2** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.2**.

## 1.0.1

- Version alignment with harness **1.0.1** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.1**.

## 1.0.0

- Project `init`/`doctor`: append/check `.mstar/sdd/` and `.agents/sdd/` gitignore entries for SDD scratch.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.0**.

## 0.5.4

- **Layout fix**: Cursor global/project plugin paths are **real git checkouts** (`git clone` / `git pull`), not symlinks to `~/.mstar/harness`. Cursor does not discover symlinked plugin directories.
- `doctor --target cursor` fails if the plugin path is a symlink; `init` removes an existing symlink and clones.
- `~/.mstar/harness` remains the shared checkout for Codex marketplace local source and agent symlinks.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.2**.

## 0.5.1

- align Cursor global/project plugin symlinks to `morning-star-harness` (matching plugin manifest `name`)
- validate plugin `agents/*.md` use Cursor-first frontmatter in `doctor --target cursor`

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.11**.

## 0.5.0

- maintain a shared local harness checkout at `~/.mstar/harness` for Cursor and Codex install flows
- change Cursor global/project installs to symlink host plugin paths to `~/.mstar/harness`
- change Codex installs to local-source marketplace entries and symlink `codex/agents/*.toml` into global/project Codex agent directories
- validate the local repo, marketplace entry, and Codex agent symlinks in `doctor --target codex`

## 0.4.0

- add `codex` target support in `init` and `doctor`
- write/update `~/.agents/plugins/marketplace.json` with a `"source": "url"` personal marketplace entry for Codex
- validate Codex personal marketplace metadata in `doctor --target codex`

## 0.3.1

- Version alignment with monorepo **0.3.1** (no CLI API change in this bump; see root changelog for harness/docs).

## 0.3.0

- Version alignment with monorepo **0.3.0** (no CLI API change in this bump; see root changelog for harness/docs).

## 0.2.0

- add target adapter architecture for CLI flows
- add `cursor` target support in `init` and `doctor`
  - `global`: install plugin via symlink at `~/.cursor/plugins/local/morning-star-harness`
  - `project`: install plugin via symlink at `.cursor/plugins/morning-star-harness`
- keep `opencode` model-driven init flow with schema/plugin/model validation
- default `--scope` behavior to `project` when not provided
- add standalone CLI docs at `docs/cli.md` and document target-based usage
