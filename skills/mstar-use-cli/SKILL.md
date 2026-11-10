---
name: mstar-use-cli
description: "Use when choosing, running or interpreting `mstar`/`mstar-harness` CLI commands: family selection, semantic preconditions (control root, cwd, identity, revision/token), exit codes and refusal codes."
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

Start with the intended ordinary action, not a universal preflight chain. The CLI publishes each command's owning skill (`details.skill` on refusals; `Skill:` in `--help`). Full task→family table, retired-verb map, and notes → **`references/task-family-index.md`**. Validator/lint families → `references/checks-and-lints.md`.


### 2. Conflict diagnostics (not a preflight chain)

Use `references/preconditions.md` when the intended verb refuses for a required fact. The refusal's grouped facts identify the one genuinely missing or conflicting input — ambiguous root/target, foreign live holder, unavailable authorization; supply a real competing choice or the owner's authorization evidence only for those. On plan mutations the derived session binding and token need no separate read, while the caller's independently acquired identity and the caller-owned operation id stay required on every active write; workflow-level active writes and a fresh active bind state the scope's full execution token themselves. A stale explicit token requires a fresh read; recorded byte versions impose no replacement constraint. Do not make `persist` or rebind a routine prerequisite for an ordinary lifecycle action. A refusal's commit state is action-local: read the receipt to learn what committed — the engine's coordinated plan-route refusals are transactional (no row, receipt or counter change), and an action-local partial receipt records its applied components — then replay only the documented remaining action.

### 3. Lifecycle shape

The primary coordinator's ordinary prepare/progress/complete operations replace ownership-transfer completion. Iteration complete verifies the already-performed serial merge; standalone development verifies registered source without integration inputs; report-only follows its registered policy without fabricated Git or a fulfilment payload. All retain QC/PM Acceptance and their distinct outer delivery/close obligations. No per-row execution lease or bind exists.

Complete writes Done/evidence/ownership atomically and releases applicable integration exclusion; exact replay preserves timestamps. Retry the same intended action with current facts rather than introducing another protocol. Parameters/recovery → references/plan-and-workflow.md.

## Decision Rules

- **The command→skill pointer is published by the CLI.** It is derived from the command definitions (`details.skill` on refusals, a `Skill:` line in CLI help); do not restate the mapping in this skill or any document.
- **Canonical binary is `mstar-harness`.** `mstar` is a short alias that shares its bin namespace with an unrelated third-party npm package of the same name: outside an environment where the harness package is installed, invoking the short alias through a package runner resolves via the registry to that other tool, and co-installing both packages globally silently overwrites the `mstar` shim — last install wins. Prefer the canonical name in scripts, CI and anything a reader might copy out of context.
- **Exit codes: `0` ok, `1` engine refusal, `2` usage.** `0` includes idempotent no-ops and read-only reads. `1` carries a stable machine code; a refused call's commit state is action-local and stated by its receipt. `2` is a usage error — unknown flag, missing required argument or option, malformed or relative path where an absolute one is required, unreadable payload.
- **Flags come from the CLI help, never from this skill.** Run the group help, or the verb help, before guessing an option; the group help is also the authority for which verbs exist at all.
- **Refusal semantics are action-local.** A refusal's commit state belongs to that one action: read the receipt instead of assuming. The engine's coordinated plan-route writes refuse transactionally — a refused operation there writes no row, receipt or counter change, so its recovery is a read of current state, never an undo. Where a verb documents action-local partial application, components already committed stay committed — the receipt names them, and the documented remaining action is replayed as its own operation, not the whole sequence. A stale explicit token is recovered by re-reading the addressed scope and retrying with the fresh token. There is no force, no replace and no takeover flag to escalate to.
- Evidence digests record provenance, not immutable report bytes. Explanatory report edits need no hash repair or resealing; current semantic QC/PM Acceptance, source proof and evidence-path requirements still apply. No ownership-transfer repair action remains.
- **Streams are per command and per mode — observe them, never infer from the family.** A verb's machine surface (the `--json` form, or a verb whose output is a machine object such as `persist get`) writes that object to **stdout**, failure and refusal objects included, so neither the exit code nor the family tells you which stream carried the bytes. On the human surface a success is usually one short line on **stdout** (`<path>: OK`, `host: <id>`), though some verbs leave stdout empty and put the readable summary on **stderr**; usage errors and most refusal diagnostics go to **stderr**, and one command can split inside itself — machine rows on stdout, the human headline on stderr. No split holds for every command and no enumeration is reliable, so never assume a command's failure text is on stderr: where a pipe depends on it, read the actual output or that command's help. The exit code is the verdict; an empty stdout is not by itself a failure signal.
- **The CLI you run may not be the code you read.** The globally installed binary runs the *published* engine build, and even a workspace entry point resolves the engine's **built output**, which can lag its source until that package is rebuilt — so a fix present in the engine source can be absent from the very command you are testing. Install health, and a healthy setup check, prove neither. When a result contradicts source you just read, rebuild or re-resolve before concluding the source is wrong, and follow the version-alignment path in `mstar-harness-core`. The same caution covers a repository's own generated bundles: a checkout can be mid-flight between source and artifact.
- **Never write a lifecycle state or a lease by editing a document.** Done and lease release go through the completion verb; the protected coordination documents refuse direct writes by design.
- **Never hand coordinator context to a leaf:** session references/envelopes, CAS tokens and operation IDs stay with the primary PM; leaf tasks carry only owned scope/paths/evidence.
- **Never substitute recovery for resume or resume for recovery.** A resume is read-only; a stopped owner is replaced only by the recovery verb that owns the current authority.
- **A validator's `OK` is a statement about its own contract only.** Exit 0 means no violations of that check — not that the content is correct, complete or current.

## Evidence

A CLI claim is proven when:

- the command was actually run, or the result is a machine object a command produced this round — not a recollection of documentation;
- the exit code matches the family contract, and a `1` is reported with its stable code and message;
- preconditions were explicit: absolute paths, an explicit root wherever discovery is ambiguous, the transport's authority stated (an independently acquired identity with a session reference on the active route — on plan mutations the engine derives the caller-owned binding and the current token, while workflow-level writes and a fresh active bind state the scope's full token), and any explicitly supplied token held only as a fresh constraint;
- no refusal was retried with a stale token — a stale explicit token was refreshed by re-reading the addressed scope;
- commands quoted in a plan, report or handoff are re-runnable as written, with real absolute paths or visibly-marked placeholders;
- for a validator, the cited check is the one that covers the claim being made.

## References

| Open | When |
|---|---|
| `references/plan-and-workflow.md` | plan / workflow families: verb and role boundaries, refusal codes, JSON envelopes, the completion sequence, the CAS read-modify-write shape |
| `references/status-and-registers.md` | ACTIVE store authority, lifecycle close, issue store and read-only historical status/snapshot inputs; authorization and native database recovery |
| `references/checks-and-lints.md` | maintainer validators and lints that skill callouts cite: what each checks, its owning skill, its exit codes |
| `references/preconditions.md` | harness-root resolution, control root vs feature worktree, neutral cwd, session identity, tokens, and how each missing precondition presents itself |

Command help is the flag reference. Installation and host setup live in `INSTALL.md` and `mstar-host`.
