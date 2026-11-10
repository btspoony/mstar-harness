# Task → command family index

> **Load when:** choosing which `mstar`/`mstar-harness` family answers a task, or reading the retired-verb map after a usage refusal.

## Index

Start with the intended ordinary action, not a universal preflight chain. The acquired primary coordinator's own reference/current scope token/operation id may be derived where unambiguous; explicit constraints validate. Address row actions with --plan and select workflow when needed. Genuine missing configuration/source facts use revisable prepare; defaults do not require a ceremonial record.
The CLI publishes each command's owning skill itself: a refusal envelope carries `details.skill` and `mstar <family> <verb> --help` ends with a `Skill:` line — read that skill for the semantics. This table owns task→family grouping only.

| Task | Family |
|---|---|
| Read selected row state/configuration/evidence and token | `mstar plan show` |
| Bootstrap/resume the workflow coordinator only | `mstar plan bind` |
| Revise row source metadata and acceptance/cleanup configuration (the Prepare view and its amendments) | `mstar plan prepare` |
| Update progress; capture findings on this plan as linked issues; close one with its disposition | `mstar plan progress`, `mstar plan issue-add`, `mstar plan issue-close` |
| Record Done directly from QC/PM Acceptance and declared-route proof | `mstar plan complete` |
| Register a standalone plan workflow; record delivery evidence | `mstar workflow register`, `mstar workflow evidence` |
| Register an iteration workflow | `mstar iteration register` |
| Close one finished lifecycle (terminal workflow state + root unregister in the current authority) | `mstar status workflow-close` |
| Return a `failed`/`stopped` lifecycle to `running` on the same id under explicit operator authorization (`completed` is never reopened) | `mstar workflow reopen` |
| Validate a coordination document before trusting or replacing it | `mstar status validate` |
| Read the open-issue rollup; enforce a plan's findings-cleanup mode over the issues linked to it | `mstar status tech-debt`, `mstar status findings-cleanup` |
| Initialize a fresh issue/catalog store; upgrade/import recognizable execution state and activate authority; or run staged migration, backup, activation and retirement | the `store` group (`init` / `upgrade` / `migrate` / `backup` / `activate` / `retire`) |
| Preview/apply execution recovery from a store backup; export current execution state | `mstar store execution restore-preview`, `mstar store execution restore`, `mstar store execution export` |
| Read/write/list/delete retained persisted documents (`review` / unrelated `json`); the `residuals` kind refuses and the root/snapshot kinds are outside this surface | `mstar persist get`, `mstar persist write`, `mstar persist list`, `mstar persist delete` |
| Launch argv under a fresh local execution identity; recover a stopped coordinator or explicitly named plan owner (never resume) | `mstar session run`, `mstar session recover` |
| Land or check a QC seat report | `mstar qc validate-report` |
| Validate an Assignment before dispatch | `mstar dispatch validate` |
| Map an execution mode to its QC seat count; assert tri identity | `mstar review seats` |
| Check workflow-entry facts (branch anchors, main residency, integration checkout cleanliness, integration merge lease) or the L1 / L2 pre-dispatch worktree topology | `mstar worktree check` (L1 per-plan gains the lease fact; `--entry` is the workflow-level form) |
| Assert QC / PM Acceptance checkout alignment across seat files | `mstar worktree qc-alignment` |
| Post-merge worktree and branch cleanup (dry-run first) | `mstar worktree cleanup` |
| SDD helpers: workspace, brief, branch diff package, bound launch | `mstar sdd workspace`, `mstar sdd task-brief`, `mstar sdd review-package`, `mstar sdd check-context`, `mstar sdd exec` |
| Evaluate a phase-transition gate; probe push cadence | `mstar iteration gate`, `mstar iteration push-cadence` |
| Resolve the harness / plan / SDD / workflow / project / specs / knowledge / adr dirs; check that resolved result paths are committable and process state stays in the control root | `mstar path resolve`, `mstar path check` |
| Read/export or mutate issues in `{HARNESS_DIR}/store.db` (`add` / `list` / `show` / `occurrence` / `triage` / `close` / `move` / `waive` / `duplicate` / `supersede` / `link` / `export`) | `mstar issue …` |
| Serve the read-only local dashboard (issues, execution/roadmap views, issue-flow chart) on `127.0.0.1` | `mstar dashboard` |
| Discover, import, register, update, link, list, show, export, reconcile or purge a verified producer registration in the harness catalog | `mstar catalog …` |
| Read a project's roadmap authority, preview/apply reviewed Markdown import, revision-guarded content replacement, or export the composed milestone roadmap (reporting transport) | `mstar roadmap show`, `mstar roadmap import`, `mstar roadmap replace`, `mstar roadmap export` |
| Create, update, or assign project milestones (structured roadmap goals); read milestone rollups | the `milestone` group (`add` / `update` / `assign` / `list` / `status`) |
| Detect the active host; resolve a loaded skill root | `mstar host detect`, `mstar host skill-root` |
| Lint harness artifacts by content type | `mstar lint` |
| Lint a skill's frontmatter and five-question body | `mstar skill lint` |
| Validate the role mapping and load-order corpus | `mstar roles validate` |
| Validate a knowledge doc's frontmatter and scope; the knowledge index-row assert is retired (refuses `compound.index.retired` → catalog completeness) | `mstar compound validate` |
| Validate DESIGN.md tokens and parity | `mstar design-md validate` |
| Scaffold the audit review report; run static security checks | `mstar audit scaffold`, `mstar audit secret-scan`, `mstar audit supply-chain` |
| PR-review arithmetic, report path (`--reviews-dir`, default the resolved `{REVIEW_DIR}`), saved-report validation, worktree setup | `mstar pr-review tally`, `mstar pr-review report-path`, `mstar pr-review validate-report`, `mstar pr-review worktree-setup` |
| Bootstrap a harness directory | `mstar harness scaffold` |
| Recover a workspace holding recognized v1/v2 execution sources; standalone file-staging `migrate` is retired | `mstar store upgrade` |
| Discover one command or payload contract | `mstar schema` |
| Draft an offline redacted issue report | `mstar report` |

Per-family detail — refusal codes, JSON envelopes, sequence walkthroughs — is in the references listed at the end. Validator and lint families are indexed in `references/checks-and-lints.md`.
Retired, never live alternatives: `status archive-residuals` / `backlog-register` / `backlog-close` → `status.verb-retired`; removed plan verbs (including `plan residual-add` / `residual-close`) → exit `2`, `command.invalid-input`; `persist … residuals` → `persist.kind-retired`. Capture and disposition use issue verbs, not aliases.

