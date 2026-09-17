# Maintainer validators and lints

This file indexes the check commands — the ones skill engine-check callouts cite and the ones a gate or a review runs before trusting an artifact. Each is a thin transport over an engine validator: it reads a document, applies that validator's contract, and reports violations. Use it to answer three questions: which command checks this artifact, which skill owns the rules behind it, and what its exit code means.

Behavior that the check's own contract does not cover is owned elsewhere: field schemas by `mstar-artifacts`, phase semantics by `mstar-iteration`, checkout rules by `mstar-branch-worktree`, dispatch fields by `mstar-dispatch-gates`.

## Reading a result

| Code | Meaning |
|---|---|
| `0` | no violations of this check's contract (an empty directory walk prints a "no lintable files" note and still exits 0) |
| `1` | violations or data errors — one row per violation on stderr, each with a stable code; also used for a missing document, an unreadable input, or a resolution failure |
| `2` | usage: missing target, unknown option value, or a path the command cannot classify |

The description-driven commands follow the same convention, with one parser caveat: a missing **required argument** may be reported by the argument parser with exit `1` and a `error: missing required argument '<name>'` line instead of the contract's `2`. Commands that validate their own required arguments print a `usage:` line and exit `2`. Read the message before classifying an exit.

Diagnostics go to stderr in every case; a check that prints a rollup (the tech-debt and lease checks) puts it on stdout.

## Command index

| Command | What it checks | Owning skill (callout home) | Exit codes |
|---|---|---|---|
| `mstar status validate` | a v2 status root (version + timestamp + registered workflows with per-entry invariants) or one workflow snapshot (schema version, plan rows, lease shapes). v1 input fails closed and points at the migration verb | `mstar-artifacts` | `0` ok · `1` violations / missing or unreadable file |
| `mstar status tech-debt` | residual tech-debt rollup aggregated over every project register (total open, by severity, by target, by plan). Informational: the register is the source of truth, so there is no stored-summary drift check | `mstar-project-governance` | `0` rollup (zero when registers are empty) · `1` project dir not found or resolution failed |
| `mstar status findings-cleanup` | enforces a plan's cleanup mode over its project-register entries, keyed by plan id; an explicit mode wins, otherwise the permissive default. Plans without register entries pass trivially | `mstar-artifacts` | `0` no open-residual violations · `1` one row per violating open residual |
| `mstar status backlog-register` | registers deferred-PR backlog entries in a project register under the status write lock: same-day key bump and entry-id uniqueness inside the lock, with provenance fields filled by the command | `mstar-project-governance` | `0` registered · `1` gate or IO refusal · `2` usage |
| `mstar status backlog-close` | closes one backlog entry in place under the same lock (resolved lifecycle, closure timestamp, closure note); an absent id or key fails loud rather than silently no-op | `mstar-project-governance` | `1` absent entry · `0` closed |
| `mstar status workflow-close` | one finished lifecycle: terminal snapshot plus root unregister. Consults delivery evidence before writing; dangling leases, unfinished rows and incomplete evidence refuse before any write. Order, authorization and partial-close recovery → `references/status-and-registers.md` | `mstar-iteration` (Phase 6 post-merge close) | `0` closed or idempotent re-run · `1` gate or IO refusal · `2` usage |
| `mstar status archive-residuals` | nothing — removed in v3. It exits `1` and names the replacement: close the entry in its project register instead | — (points at `mstar-project-governance`) | `1` always |
| `mstar dispatch validate` | an Assignment document: required header fields, exactly one branch form, then the protected-default-branch gate | `mstar-dispatch-gates`, `mstar-review-qc` | `0` ok · `1` violations · `2` usage |
| `mstar review seats` | maps an execution mode to its QC seat count; with the reviewer list, asserts tri identity | `mstar-review-qc` | `0` ok · `1` violations · `2` usage |
| `mstar worktree check` | pre-dispatch topology at L1: main-worktree residency, the dedicated integration checkout, and the plan's execution-lease feature worktree (existence, branch alignment); the L2 form checks parallel writable tracks | `mstar-branch-worktree`, `mstar-dispatch-gates` | `0` ok · `1` violations · `2` usage |
| `mstar worktree qc-alignment` | that the QC/QA alignment fields (plan id, review range, diff basis) are byte-identical across the given seat files, accepting the separate and the combined label forms | `mstar-branch-worktree` | `0` ok · `1` mismatch or missing field · `2` no files given |
| `mstar worktree cleanup` | guarded worktree and branch cleanup for a workflow: merged-evidence-only branch deletion with active-lease, checked-out, foreign, dirty and non-terminal refusals; a dry run by default that prints one verdict row per candidate | `mstar-iteration` (post-merge close) | `0` valid dry run or successful removals · `1` probe or mutation failure · `2` usage |
| `mstar lease verify` | a plan's execution lease on its snapshot row | `mstar-artifacts` | `0` valid (prints the holder) · `1` missing or invalid |
| `mstar lease verify-integration` | the workflow's integration merge lease when present; an absent lease is a valid unclaimed state | `mstar-artifacts`, `mstar-iteration` | `0` unclaimed or valid · `1` invalid lease · `2` usage |
| `mstar qc validate-report` | a saved QC seat report against its machine-readable contract: frontmatter fields, verdict vocabulary, body/verdict agreement, summary-to-findings count parity, truncation and verdict coherence | `mstar-review-qc` | `0` ok · `1` violations |
| `mstar iteration gate` | the phase-transition gate for a workflow, printing the transition plus its entry and exit checklists; the post-merge form checks local close state (terminal snapshot, no dangling lease, root entry unregistered) and needs no compass | `mstar-iteration`, `mstar-phase-gates` | `0` pass · `1` gate fail or error · `2` usage |
| `mstar iteration push-cadence` | the push gate: never push while CI or a review wave is running | `mstar-iteration` | `0` clear · `1` blocked |
| `mstar lint` | harness artifacts by content type, inferred from the target's name and location: plan files against the quality bar, skills against the frontmatter contract, `STRATEGY.md` against its required sections, task reports against the report triple, code files for markers. Two content types are explicit-only: finding documents and the content-agnostic provenance scan, which reports dated local-instance citations that tracked text must not carry | `mstar-skill-authoring`, `mstar-strategy`, `mstar-sdd`, `mstar-coding-behavior`, `mstar-audit` | `0` ok · `1` violations or file errors · `2` missing target, unknown type, unclassifiable file without a forced type |
| `mstar skill lint` | one skill directory: frontmatter contract (name, trigger-contract description), the five-question body, and the ephemeral-citation scan | `mstar-skill-authoring` | `0` ok · `1` violations · `2` usage |
| `mstar roles validate` | the role mapping and parameter tables against the on-disk references layout, plus the load-order declarations across sibling skills | `mstar-roles` | `0` ok · `1` violations |
| `mstar compound validate` | a knowledge document's frontmatter against its schema; with the knowledge dir, also the README index rows and the document's scope | `mstar-compound`, `mstar-compound-refresh` | `0` ok · `1` violations · `2` usage |
| `mstar design-md validate` | DESIGN.md in a directory: token frontmatter, light/dark parity when the dark file exists, and the completeness level | `mstar-design-md` | `0` ok · `1` violations · `2` usage |
| `mstar path resolve` | the resolved harness, plan, SDD, workflow and project dirs from a start dir; the machine form adds the start dir and a resolution flag | `mstar-conventions` | `0` resolved · `1` no harness dir from that start dir |
| `mstar host detect` | the active host id from a comma-separated list of session tool-shape tokens; prints an ambiguous verdict rather than guessing | `mstar-host` | `0` host id · `2` usage |
| `mstar host skill-root` | the canonical loaded-skill root for one host and skill, optionally with a relative asset path appended | `mstar-host` | `0` prints the root · `1` missing required option · `2` unknown host or empty skill |
| `mstar audit scaffold` / `mstar audit promote` / `mstar audit secret-scan` / `mstar audit supply-chain` | audit planning: scaffold a dated plan directory from a findings file, promote selected plans into the workflow lifecycle (delivery kind declared, never inferred), and the two read-only static scans — credential patterns over tracked files, and supply-chain shape (lockfile, unpinned action refs, PR-head checkout) | `mstar-audit` | `0` ok or clean · `1` findings · `2` usage |
| `mstar pr-review tally` / `mstar pr-review report-path` / `mstar pr-review validate-report` | the PR-review arithmetic and naming contracts: tally computation from findings, local report path resolution, and saved-report validation | `mstar-audit` (pr variant) | `0` ok · `1` violations · `2` usage |
| `mstar plugin validate` | a plugin package against the portable plugin format: root manifest schema, server descriptor when present, and skill discovery (child directory with a matching skill file) | repository maintenance, not a skill callout | `0` conformant · `1` findings |

Two rows write state under a lock — the backlog pair and the lifecycle close. Everything else in this table is read-only, which is what makes the table usable from a review seat: the read-only subset is the whole list minus those three.

## `/codebase-audit` category tokens

The audit command's category token set, used when a run is narrowed to one category (recon first, then that category only):

| Token | Meaning | Default |
|---|---|---|
| `<category>` | Category focus — recon, then that category only: `bug`, `security`, `perf`, `tests`, `tech-debt`, `migration`, `dx`, `docs`, `direction` (plan `Category` field values) | all nine |

## What a green run proves

Each command mirrors one validator, so exit `0` is a statement about that validator's contract and nothing more:

- a structural pass does not prove a command ran, a diff applied, or an artifact is content-correct — those need the evidence the owning skill names;
- a check that skips unreadable inputs passes on what it could read, so pair it with the artifact-level claim the owning skill requires;
- an informational command (the tech-debt rollup) reports a projection of the register; the register stays the source of truth;
- when a check and a gate disagree, the gate's owning skill decides, and the disagreement is a finding to report rather than a check to rerun.
