---
name: mstar-use-cli
description: Use when a Morning Star agent must choose, run, or interpret `mstar-harness` / `mstar` CLI commands — picking the command family for a task (plan row, lifecycle close, register write, report landing, worktree and lease checks, path resolution), satisfying the preconditions a family needs (harness root, control root, neutral cwd, session envelope, version tokens), reading exit codes 0 / 1 / 2 and stable refusal codes, or running the versioned read-modify-write handshake. Also load it when a topical skill's engine-check callout points at the CLI, or when a command refused and the cause looks like a missing precondition. Flags and option wording are never restated here — the CLI help owns them.
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
- a coordinated document must be written — versioned replacement, token-aware retry.

Do not load for:

- installation, host bootstrap, per-host config — `INSTALL.md` plus `mstar-host`;
- flags, option wording, per-command argument shapes — the CLI help owns them;
- field schemas (`mstar-artifacts`), iteration phase semantics (`mstar-iteration`), checkout rules (`mstar-branch-worktree`), role preset decisions (`mstar-roles`);
- slash commands (`/codebase-audit`, `/iteration-drive`, …). They ship with the host plugin, not the CLI binary; their owning skills (`mstar-audit`, `mstar-iteration`, …) hold their contracts.

## Workflow

### 1. Task → command family

Find the task, run the family, then read its owning skill for the rules around it.

| Task | Family | Owning skill |
|---|---|---|
| Read a plan row: revision, byte versions, scoped paths, operations allowed now | `mstar plan show` | `mstar-iteration` (scoped drive), `mstar-artifacts` (fields) |
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
| Capture, list, show, occurrence, triage, terminal disposition, link, or export issues in `{HARNESS_DIR}/store.db` | `mstar issue …` | `mstar-conventions` (store path vs execution JSON); group help owns verbs and flags |
| Serve the read-only local dashboard (issues, execution/roadmap views, issue-flow chart) on `127.0.0.1` | `mstar dashboard` | None — read-only surface; loopback binding is fixed and command help owns the flags |
| Discover, import, register, query, export or reconcile the harness catalog (project/iteration/plan/document identity, paths, membership, spec/knowledge relations, lifecycle) in `{HARNESS_DIR}/store.db` | `mstar catalog …` | `mstar-conventions` (catalog vs execution JSON; Markdown index rows retired); group help owns verbs and flags |
| Read a project's roadmap authority, preview/apply reviewed Markdown import, revision-guarded content replacement, or export transport | `mstar roadmap show`, `mstar roadmap import`, `mstar roadmap replace`, `mstar roadmap export` | `mstar-project-governance` (single authoring/read/write rule home); group and verb help own flags and payloads |
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

### 2. Precondition ladder

Take the rungs in order. Each one fails closed: a command that cannot establish a rung refuses instead of silently falling back to a different root or a different identity.

1. **Root.** Every command that touches harness state resolves a harness directory, and two resolutions exist: a *process root* derived from the main worktree (so a command run inside a linked worktree still addresses the control harness) and a *local probe* that walks up from the cwd, bounded by the workspace root. They can disagree from the same cwd, and a linked worktree usually carries no harness root of its own. Read `mstar path resolve` first when unsure, and name the root explicitly (`--harness <absolute-path>`, `MSTAR_HARNESS_DIR`, or the positional control root where the command takes one).
2. **Residency.** Coordinator verbs belong to the main worktree — or to the recorded integration worktree where a sequence says so. Product edits stay in the feature worktree; process documents stay in the control root.
3. **cwd neutrality.** Git-derived checks derive the main worktree and branch facts from the process cwd. Run them from a neutral cwd so the derivation matches what the snapshot recorded.
4. **Identity.** Which transport a coordinated write takes is decided by the harness's execution authority, never by mixing flags. **Active** (canonical): the caller identity is independently acquired for the invocation, and the write carries `--session-ref <wire>` + the scope's full execution token as `--expect` + `--operation <id>`. **Pre-activation** (only while that authority is not active): `--session <absolute-json>` names the engine-generated envelope obtained from the bind verb, with a row revision as `--expect`. A reference is a lookup, not a bearer credential, and no reference or token may be forwarded to a leaf. There is no force, no takeover, no holder or role input, and no lease-release verb; a resume is read-only and is never recovery.
5. **Tokens.** Never interchangeable: the scope's full execution token on the active route (`mstar status validate` prints the root and per-workflow tokens), the pre-activation row revision and snapshot byte version (both from `mstar plan show --json`), and the issue revision a scoped issue close echoes back as `--expect-issue` (from `mstar plan issue-add` or `mstar issue show`).
6. **Re-read after a refusal.** Refusals are mutation-free; a stale token is recovered by reading again, never by forcing or retrying blind.

Full treatment of every rung, including the failure each one produces: `references/preconditions.md`.

### 3. Two canonical sequences

Both are protocol shapes, not scripts — supply the placeholders, take the flags from the family's help.

Protected document, versioned read-modify-write (**pre-activation store face**; on an ACTIVE authority the coordination verbs own these documents):

```sh
# 1. read the current bytes and their version token
mstar persist get snapshot --key <workflow-id> --versioned

# 2. modify the payload locally, keeping the document's schema intact

# 3. replace it against exactly that token (nothing is merged)
mstar persist snapshot --key <workflow-id> --expect-version sha256:<64-hex> --file payload.json --session <coordinator-envelope>
```

`status` always uses the key `root`; the `residuals` kind still reads the migrated project register but refuses a replacement — that register is migration history and open items are store issues. For a document that does not exist yet the token is the literal `absent`.

Plan completion, coordinator side, after the plan session handed off. Every write runs under an independently acquired identity and takes the scope's full execution token, read immediately before the call:

```sh
mstar plan handoff --session-ref <plan-pm-wire> --file handoff.json --expect <plan-token> --operation handoff-1
mstar plan accept  --session-ref <coordinator-wire> --plan <plan-id> --handoff <live-handoff-id> --expect <plan-token> --operation accept-1

# iteration route only (type: iteration, or any non-standalone workflow)
mstar plan integration-start  --session-ref <coordinator-wire> --plan <plan-id> --handoff <live-handoff-id> --expect <plan-token> --operation int-start-1
git merge --no-ff --no-edit <source-sha>          # operator action, in the recorded integration worktree
mstar plan integration-accept --session-ref <coordinator-wire> --plan <plan-id> --handoff <live-handoff-id> --expect <plan-token> --operation int-accept-1

# both routes end here; a standalone development plan completes straight from the accepted handoff
mstar plan complete --session-ref <coordinator-wire> --plan <plan-id> --handoff <live-handoff-id> --expect <plan-token> --operation complete-1
```

Pre-activation the same sequence swaps `--session-ref <wire>` for `--session <absolute-json>` and the full token for a row revision, and drops `--operation`; those forms refuse on an ACTIVE harness rather than being reinterpreted.

`complete` releases only the row's lease on the standalone route and both leases on the iteration route; a standalone workflow stays running until its delivery evidence and the workflow close. `mstar plan return` handles a failed attempt; `mstar plan reconcile` finishes an attempt after a crash without a second merge — on the standalone route it only replays an already-completed row. `repair-delivery-source` exists solely for pre-fix snapshots whose registered source branch wrongly equals the target. Every `--expect` comes from a fresh read, because the previous call consumed it. Per-step preconditions and failure behavior: `references/plan-and-workflow.md`.

## Decision Rules

- **Canonical binary is `mstar-harness`.** `mstar` is a short alias that shares its bin namespace with an unrelated third-party npm package of the same name: outside an environment where the harness package is installed, invoking the short alias through a package runner resolves via the registry to that other tool, and co-installing both packages globally silently overwrites the `mstar` shim — last install wins. Prefer the canonical name in scripts, CI and anything a reader might copy out of context.
- **Exit codes: `0` ok, `1` engine refusal, `2` usage.** `0` includes idempotent no-ops and read-only reads. `1` carries a stable machine code and leaves authoritative bytes unchanged. `2` is a usage error — unknown flag, missing required option, malformed or relative path where an absolute one is required, unreadable payload.
- **The argument parser can exit 1 for a missing required argument**, which lands inside the refusal range: the message reads `error: missing required argument '<name>'`. Read the message, not only the number, before treating an exit as a gate refusal or as a usage error. Commands that validate their own required arguments print a `usage:` line and exit 2 even for a missing argument, so the two shapes coexist in the same CLI.
- **Flags come from the CLI help, never from this skill.** Run the group help, or the verb help, before guessing an option; the group help is also the authority for which verbs exist at all.
- **Refusals are mutation-free, so they are recoverable by reading.** Re-read the document, then retry with fresh tokens. There is no force, no replace and no takeover flag to escalate to.
- **A submitted handoff pins the bytes of the reports it names.** The digest is taken at submission, so any later edit to a cited report — even appending a section — invalidates it, and completion then refuses with a stale-evidence code naming the mismatching path. Finish every evidence file before handing off; if one genuinely has to change afterwards, `return` the handoff and re-sign it rather than completing against the old pin.
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
- preconditions were explicit: absolute paths, an explicit root wherever discovery is ambiguous, the transport's authority stated (an independently acquired identity with a session reference and full execution token on the active route, or a session envelope obtained from the bind verb on the pre-activation route), and tokens read from the command that will consume them;
- no refusal was retried with a stale token — after a refusal the document was re-read;
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
