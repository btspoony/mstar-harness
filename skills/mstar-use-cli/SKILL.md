---
name: mstar-use-cli
description: Use when a Morning Star agent must choose, run, or interpret `mstar-harness` / `mstar` CLI commands — picking the command family for a task (plan row, lifecycle close, register write, report landing, worktree and lease checks, path resolution), satisfying its current semantic preconditions (harness/control root, cwd, actor/session identity, numeric revision or execution token), or reading exit codes 0 / 1 / 2 and stable refusal codes. Also load it when a topical skill's engine-check callout points at the CLI, or a command refuses for a missing precondition. Recorded digests are provenance, not mutation credentials. Flags and option wording belong to CLI help.
---

# CLI contract (`mstar-use-cli`)

The CLI is the harness's machine surface: gates, coordination writes and validators sit behind it. This skill is the index that says **which family answers a task, what must be true before running it, in what order a sequence goes, and how to read the answer**.

It is deliberately silent in one direction. Command help is generated from the same source that parses the arguments, so it is the only non-drifting owner of flags, option wording and argument shapes. Help cannot express cross-command choice, preconditions, sequence order or refusal meaning — those are what this skill owns.

## Load Order

1. `mstar-harness-core` — lifecycle, gates, authorization and conflict authority; first read whenever it is loaded.
2. The **owning topical skill** for the family about to run (named in the task index below) — it holds the semantics, role boundaries and surrounding workflow.
3. This skill — the CLI transport contract for that family.

Conditional scope: this applies when a CLI binary is on PATH. Where the CLI is absent, the engine-import / prose path declared by each topical skill stays authoritative; do not read the command text here as a load-order dependency, and never use this skill as a substitute for the owning skill's rules.

Add `mstar-host` when the host's tool shapes decide how a command is launched.

## Scope

Load when:

- a CLI command must be run, or output from one must be interpreted;
- a topical skill's engine-check callout pointed here;
- an exit 1 / 2 came back and its meaning is unclear, or a command refused for a reason that looks like a missing precondition;
- a decision is needed between families (read a row, close a lifecycle, register a document, land a report, check a worktree);
- a coordinated action must be written under its current actor/state and numeric revision or execution-token contract.

Do not load for:

- installation, host bootstrap, per-host config — `INSTALL.md` plus `mstar-host`;
- flags, option wording, per-command argument shapes — the CLI help owns them;
- field schemas (`mstar-artifacts`), iteration phase semantics (`mstar-iteration`), checkout rules (`mstar-branch-worktree`), role preset decisions (`mstar-roles`);
- slash commands (`/codebase-audit`, `/iteration-drive`, …). They ship with the host plugin, not the CLI binary; their owning skills (`mstar-audit`, `mstar-iteration`, …) hold their contracts.

## Workflow

### 1. Task → command family


Start with the intended verb and its current help, not a universal preflight chain. On the active route, attempt the sparse intended action — session reference, the caller's independently acquired `--session-id`/`sessionId`, and the caller-owned `--operation` id — and let the engine derive the caller-owned session binding and the plan's current token before requiring any separate read; on a plan mutation supply a full execution token only when you hold it as an explicit constraint, and an explicit plan target only for a genuinely ambiguous choice — workflow-level active writes (registration, evidence, recovery) and a fresh active bind state the full execution token themselves. Pre-activation, supply the session envelope and row revision. A fresh plan-PM bind always states explicit operator `--session-id`. Inspect the `applied`, `partial` or `replayed` receipt; preserve already-applied components only where the verb documents action-local partial semantics. A refusal returns grouped facts naming the one non-derivable input or genuine conflict; ambiguous coordinator plan selection, unavailable authorization and a foreign live holder are never derived or auto-selected. Do not repair state through a separate command before replaying the documented remaining action.
Find the task, run the family, then read its owning skill for the rules around it.

| Task | Family | Owning skill |
|---|---|---|
| Read a plan row: revision, recorded provenance versions, scoped paths, operations allowed now | `mstar plan show` | `mstar-iteration` (scoped drive), `mstar-artifacts` (fields) |
| Claim or resume a scoped session; bootstrap a coordinator session | `mstar plan bind` | `mstar-iteration` |
| Register a reviewed Assignment and release its dependencies | `mstar plan prepare` | `mstar-iteration` |
| Update progress; capture findings on this plan as linked issues; close one with its disposition | `mstar plan progress`, `mstar plan issue-add`, `mstar plan issue-close` | `mstar-sdd`, `mstar-project-governance` (capture contract) |
| Finish a plan (handoff; row stays InReview) | `mstar plan handoff` | `mstar-sdd`, `mstar-artifacts` |
| Transfer execution ownership / return a handoff | `mstar plan accept`, `mstar plan return` | `mstar-iteration` |
| Run the pinned integration and record Done; recover a crashed attempt | `mstar plan integration-start`, `mstar plan integration-accept`, `mstar plan complete`, `mstar plan reconcile` | `mstar-branch-worktree`, `mstar-iteration` |
| Amend an approved Prepare scope | `mstar workflow show-prepare`, `mstar workflow amend-prepare` | `mstar-artifacts` |
| Register a standalone plan workflow; record delivery evidence | `mstar workflow register`, `mstar workflow evidence` | `mstar-artifacts` |
| Register an iteration workflow | `mstar iteration register` | `mstar-artifacts` (lifecycle semantics) |
| Close one finished lifecycle (terminal snapshot + root unregister) | `mstar status workflow-close` | `mstar-iteration` (Phase 6) |
| Validate a coordination document before trusting or replacing it | `mstar status validate` | `mstar-artifacts` |
| Read the open-issue rollup; enforce a plan's findings-cleanup mode over the issues linked to it | `mstar status tech-debt`, `mstar status findings-cleanup` | `mstar-project-governance`, `mstar-artifacts` |
| Run the staged migration into the issue/catalog store, or its backup / activation / retirement | the `store` group (`migrate` / `backup` / `activate` / `retire`) | `mstar-conventions` (store authority vs execution JSON); group help owns verbs and flags |
| Read or replace a coordination document | `mstar persist get`, `mstar persist list`, `mstar persist <kind>` | `mstar-artifacts` |
| Land or check a QC seat report | `mstar qc validate-report` | `mstar-review-qc` |
| Validate an Assignment before dispatch | `mstar dispatch validate` | `mstar-dispatch-gates` |
| Map an execution mode to its QC seat count; assert tri identity | `mstar review seats` | `mstar-review-qc` |
| Verify a plan's execution lease; verify the integration merge lease | `mstar lease verify`, `mstar lease verify-integration` | `mstar-artifacts`, `mstar-branch-worktree` |
| Check L1 / L2 pre-dispatch worktree topology | `mstar worktree check` | `mstar-branch-worktree`, `mstar-dispatch-gates` |
| Assert QC / QA checkout alignment across seat files | `mstar worktree qc-alignment` | `mstar-branch-worktree` |
| Post-merge worktree and branch cleanup (dry-run first) | `mstar worktree cleanup` | `mstar-iteration` |
| SDD helpers: workspace, brief, branch diff package, bound launch, evidence capture | `mstar sdd workspace`, `mstar sdd task-brief`, `mstar sdd review-package`, `mstar sdd check-context`, `mstar sdd exec`, `mstar sdd evidence` | `mstar-sdd` |
| Evaluate a phase-transition gate; probe push cadence | `mstar iteration gate`, `mstar iteration push-cadence` | `mstar-iteration`, `mstar-phase-gates` |
| Resolve the harness / plan / SDD / workflow / project dirs | `mstar path resolve` | `mstar-conventions` |
| Read or write issues in `{HARNESS_DIR}/store.db` (`add`, `occurrence`, `triage`, `close`, `waive`, `duplicate`, `supersede`, `link`) | `mstar issue …` | `mstar-conventions` (store path vs execution JSON); every write requires `--actor` + `--operation-id` and a payload via `--payload` or `--file`; `--expect` is required for `triage`, each terminal disposition, and `link` row-CAS; group help owns verbs and flags |
| Serve the read-only local dashboard (issues, execution/roadmap views, issue-flow chart) on `127.0.0.1` | `mstar dashboard` | None — read-only surface; loopback binding is fixed and command help owns the flags |
| Discover, import, register, query, export or reconcile the harness catalog (project/iteration/plan/document identity, paths, membership, spec/knowledge relations, lifecycle) in `{HARNESS_DIR}/store.db` | `mstar catalog …` | `mstar-conventions` (catalog vs execution JSON; Markdown index rows retired); group help owns verbs and flags |
| Read a project's roadmap authority, preview/apply reviewed Markdown import, revision-guarded content replacement, or export the composed milestone roadmap (reporting transport) | `mstar roadmap show`, `mstar roadmap import`, `mstar roadmap replace`, `mstar roadmap export` | `mstar-project-governance` (single authoring/read/write rule home); group and verb help own flags and payloads |
| Create, update, or assign project milestones (structured roadmap goals); read milestone rollups | the `milestone` group (`add` / `update` / `assign` / `list` / `status`) | `mstar-project-governance` (milestone rules); group help owns verbs and flags |
| Detect the active host; resolve a loaded skill root | `mstar host detect`, `mstar host skill-root` | `mstar-host` |
| Lint harness artifacts by content type | `mstar lint` | `mstar-skill-authoring`, `mstar-coding-behavior`, `mstar-strategy` |
| Lint a skill's frontmatter and five-question body | `mstar skill lint` | `mstar-skill-authoring` |
| Validate the role mapping and load-order corpus | `mstar roles validate` | `mstar-roles` |
| Validate a knowledge doc's frontmatter and scope; the knowledge index-row assert is retired (refuses `compound.index.retired` → catalog completeness) | `mstar compound validate` | `mstar-compound` |
| Validate DESIGN.md tokens and parity | `mstar design-md validate` | `mstar-design-md` |
| Scaffold or promote audit plans; run static security checks | `mstar audit scaffold`, `mstar audit promote`, `mstar audit secret-scan`, `mstar audit supply-chain` | `mstar-audit` |
| PR-review arithmetic, report path, saved-report validation, worktree setup | `mstar pr-review tally`, `mstar pr-review report-path`, `mstar pr-review validate-report`, `mstar pr-review worktree-setup` | `mstar-audit` (pr variant) |
| Bootstrap a harness directory | `mstar harness scaffold` | `mstar-conventions` |
| Migrate a v1 status tree to v2 (one-shot, not a routine step) | `mstar migrate` | `mstar-artifacts` |

Per-family detail — refusal codes, JSON envelopes, sequence walkthroughs — is in the references listed at the end. Validator and lint families are indexed in `references/checks-and-lints.md`.

### 2. Conflict diagnostics (not a preflight chain)

Use `references/preconditions.md` when the intended verb refuses for a required fact. The refusal's grouped facts identify the one genuinely missing or conflicting input — ambiguous root/target, foreign live holder, unavailable authorization; supply a real competing choice or the owner's authorization evidence only for those. On plan mutations the derived session binding and token need no separate read, while the caller's independently acquired identity and the caller-owned operation id stay required on every active write; workflow-level active writes and a fresh active bind state the scope's full execution token themselves. A stale explicit token or raw-replacement byte version requires a fresh read. Do not make `persist` or rebind a routine prerequisite for an ordinary lifecycle action. A refusal's commit state is action-local: read the receipt to learn what committed — the engine's coordinated plan-route refusals are transactional (no row, receipt or counter change), and an action-local partial receipt records its applied components — then replay only the documented remaining action.

### 3. Lifecycle shape

The public lifecycle verbs remain `handoff → accept → [iteration integration-start → operator merge → integration-accept] → complete`; a standalone development row completes from accepted handoff, while report-only follows its registered completion policy rather than inventing Git integration. Use current verb help for supported arguments and inspect the receipt after each intent. `return` and `reconcile` address their specific failed/crashed attempt; neither is a universal preparatory repair. `references/plan-and-workflow.md` describes role boundaries and exceptional conflicts.

`complete` releases only the row's lease on the standalone route and both leases on the iteration route; a standalone workflow remains running until delivery evidence and workflow close. `repair-delivery-source` is only for a pre-fix snapshot whose registered source branch equals its target, never normal progress.

## Decision Rules

- **Canonical binary is `mstar-harness`.** `mstar` is a short alias that shares its bin namespace with an unrelated third-party npm package of the same name: outside an environment where the harness package is installed, invoking the short alias through a package runner resolves via the registry to that other tool, and co-installing both packages globally silently overwrites the `mstar` shim — last install wins. Prefer the canonical name in scripts, CI and anything a reader might copy out of context.
- **Exit codes: `0` ok, `1` engine refusal, `2` usage.** `0` includes idempotent no-ops and read-only reads. `1` carries a stable machine code; a refused call's commit state is action-local and stated by its receipt. `2` is a usage error — unknown flag, missing required argument or option, malformed or relative path where an absolute one is required, unreadable payload.
- **Flags come from the CLI help, never from this skill.** Run the group help, or the verb help, before guessing an option; the group help is also the authority for which verbs exist at all.
- **Refusal semantics are action-local.** A refusal's commit state belongs to that one action: read the receipt instead of assuming. The engine's coordinated plan-route writes refuse transactionally — a refused operation there writes no row, receipt or counter change, so its recovery is a read of current state, never an undo. Where a verb documents action-local partial application, components already committed stay committed — the receipt names them, and the documented remaining action is replayed as its own operation, not the whole sequence. A stale explicit token is recovered by re-reading the addressed scope and retrying with the fresh token. There is no force, no replace and no takeover flag to escalate to.
- **Submitted evidence digests record provenance, not immutable report bytes.** Later report edits, including appended sections, do not invalidate the handoff by hash and require no return, re-signing or resealing. Current semantic QC/QA, acceptance, ownership and evidence-path requirements still apply; `return` remains an ownership/state action, not a byte-repair step.
- **Streams are per command and per mode — observe them, never infer from the family.** A verb's machine surface (the `--json` form, or a verb whose output is a machine object such as `persist get`) writes that object to **stdout**, failure and refusal objects included, so neither the exit code nor the family tells you which stream carried the bytes. On the human surface a success is usually one short line on **stdout** (`<path>: OK`, `host: <id>`), though some verbs leave stdout empty and put the readable summary on **stderr**; usage errors and most refusal diagnostics go to **stderr**, and one command can split inside itself — machine rows on stdout, the human headline on stderr. No split holds for every command and no enumeration is reliable, so never assume a command's failure text is on stderr: where a pipe depends on it, read the actual output or that command's help. The exit code is the verdict; an empty stdout is not by itself a failure signal.
- **The CLI you run may not be the code you read.** The globally installed binary runs the *published* engine build, and even a workspace entry point resolves the engine's **built output**, which can lag its source until that package is rebuilt — so a fix present in the engine source can be absent from the very command you are testing. Install health, and a healthy setup check, prove neither. When a result contradicts source you just read, rebuild or re-resolve before concluding the source is wrong, and follow the version-alignment path in `mstar-harness-core`. The same caution covers a repository's own generated bundles: a checkout can be mid-flight between source and artifact.
- **Never write a lifecycle state or a lease by editing a document.** Done and lease release go through the completion verb; the protected coordination documents refuse direct writes by design.
- **Never hand a reference or a token to a leaf.** Session envelopes, session references and every token — the active execution token and operation id included — are coordinator/PM material; the scoped-drive rules in `mstar-iteration` own that boundary.
- **Never substitute recovery for resume or resume for recovery.** A resume is read-only; a stopped owner is replaced only by the recovery verb that owns the current authority.
- **A validator's `OK` is a statement about its own contract only.** Exit 0 means no violations of that check — not that the content is correct, complete or current.

## Evidence

A CLI claim is proven when:

- the command was actually run, or the result is a machine object a command produced this round — not a recollection of documentation;
- the exit code matches the family contract, and a `1` is reported with its stable code and message;
- preconditions were explicit: absolute paths, an explicit root wherever discovery is ambiguous, the transport's authority stated (an independently acquired identity with a session reference on the active route — on plan mutations the engine derives the caller-owned binding and the current token, while workflow-level writes and a fresh active bind state the scope's full token —, or a session envelope obtained from the bind verb on the pre-activation route), and any explicitly supplied token held only as a fresh constraint;
- no refusal was retried with a stale token — a stale explicit token was refreshed by re-reading the addressed scope;
- commands quoted in a plan, report or handoff are re-runnable as written, with real absolute paths or visibly-marked placeholders;
- for a validator, the cited check is the one that covers the claim being made.

## References

| Open | When |
|---|---|
| `references/plan-and-workflow.md` | plan / workflow families: verb and role boundaries, refusal codes, JSON envelopes, the completion sequence, the CAS read-modify-write shape |
| `references/status-and-registers.md` | `status.json` root and workflow snapshot: write surfaces, protection levels, versioned replacement, close order; the retired residual register (migration history) and the store-issued open items that replaced it |
| `references/checks-and-lints.md` | maintainer validators and lints that skill callouts cite: what each checks, its owning skill, its exit codes |
| `references/preconditions.md` | harness-root resolution, control root vs feature worktree, neutral cwd, session identity, tokens, and how each missing precondition presents itself |

Command help is the flag reference. Installation and host setup live in `INSTALL.md` and `mstar-host`.
