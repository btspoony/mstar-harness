# ADR: Fixed harness root — `.mstar/` under the main worktree, no configurable path

Status: proposed — one release, 4.8, removes every retired selector; no warning-only phase
Date: 2026-11-20

## Problem

The harness root is a process fact, but three mechanisms let it be read as a
path relative to whatever checkout the caller sits in:

1. `writeBootstrapMstarc` always writes `harness_dir` into the tracked
   `.mstarc`. A linked worktree carries that file, so an agent reading the
   declaration composes `<worktree>/.mstar` — a directory that never exists
   under the default gitignore.
2. The discovery probe still falls back to `.agents/`, `.plans/` and `plans/`.
   Those candidates make a wrong root look plausible and let a stray legacy
   directory win over the control root.
3. `MSTAR_HARNESS_DIR`, `opts.harnessDir` and `mstar mcp --harness` accept any
   path. Once supplied, they short-circuit the main-worktree normalization, so
   a worktree-local or out-of-checkout root is honored instead of refused.

The observed failure: a PM session started in a linked worktree looks for
`store.db`, `plans/`, `workflows/` or `sdd/` under its own checkout, finds
nothing, and asks the operator where the main worktree is. Process state is
split or unreadable until someone supplies the absolute control path by hand.

## Proposal

The harness root becomes one fixed location, derived from Git only:

```
<git main worktree root>/.mstar/
```

- No `.mstarc` key, environment variable or CLI option may move it, and no
  candidate chain decides it. `readMainWorktree` is the only input; the
  directory name is fixed to `.mstar`.
- **One release, 4.8.** Every retired selector is refused in the release that
  states this decision. There is no warning-only phase and no major-version
  gate: this project treats a minor as able to carry the contract change, and
  the release notes mark it breaking.
- `harness_dir` is retired. A `.mstarc` that declares it is refused, and the
  refusal names the recovery (delete the line, then `mstar path resolve`).
- Legacy harness candidates (`.agents/`, `.plans/`, `plans/`) are retired in
  the same release. The resolver no longer probes them; a repository that only
  has one is refused with `mstar harness scaffold` and `mstar store upgrade`
  (for an existing store) named as the recovery.
- `MSTAR_HARNESS_DIR` is retired in the same release. Setting it no longer
  selects a root: the value is ignored, and `unset MSTAR_HARNESS_DIR` is the
  recovery that keeps an inherited shell honest.
- `opts.harnessDir` and the CLI `--harness` flag keep only a transport role:
  they must resolve to the same path as `<main>/.mstar`, and any other value is
  refused with the actual and expected paths. They can no longer choose a
  different root. The engine option stays as an internal assertion surface for
  callers that already hold the derived value.
- A CLI launch outside any Git work tree is the one case with nothing to
  derive from. There `--harness` is the only accepted input and must name an
  existing `<dir>/.mstar`; it is used as given, with no equality check. With no
  `--harness`, the command refuses and names the two recoveries: run from
  inside the repository, or pass `--harness <absolute .mstar>`. The
  environment variable is not a fallback for this case — that is what makes
  an inherited value able to root the wrong repository.
- The MCP server carries no root of its own. It is one long-lived service, so
  neither its launch cwd, a connection-level pin, nor the environment names a
  repository. Every call that touches process state supplies `harness` naming
  the control root (absolute `<main>/.mstar`); omission is refused, and a
  value that does not equal the Git-derived root is refused rather than
  adopted. Registration publishes
  `harness` as required for exactly this reason: the host's session cwd is the
  only place the caller knows the repository, and the call is where that fact
  reaches the server.
- `{HARNESS_DIR}` remains a path symbol, and `.mstarc` keeps every other key:
  the corpus defaults (`.agents/knowledge`, `.agents/specs`, `.agents/adr`)
  and the sub-directory keys (`plan_dir`, `sdd_dir`, `iteration_dir`,
  `workflow_dir`, `project_dir`, `review_dir`) are unchanged.
- Scaffold stops writing `harness_dir`; a `.mstarc` it creates carries only
  the keys whose values differ from the defaults.
- The PM role's default load path states the rule: before reading or writing
  process state, resolve `controlHarnessDir` with `mstar path resolve`; a
  linked checkout's `.mstarc` declares a layout but its `.mstar/` does not
  exist. The text points at the existing precondition reference rather than
  restating it.

Migration is explicit, never automatic: a store is SQLite state and is not
moved by a path resolver. Every refusal names `mstar store upgrade` and
`mstar harness scaffold`.

## Alternatives considered

- **Prompt text only.** Rejected: the same misread has already recurred, and
  nothing mechanical prevents a future agent or a hand-written script from
  composing the cwd-relative path.
- **Rename the key to `harness_dir_name` and require one path segment.**
  Rejected: it still does not say which checkout is the base, so
  `<worktree>/.mstar` remains the natural composition. It also keeps a second
  source of truth for a fact Git already answers.
- **Keep `harness_dir` but validate that it sits under the main worktree.**
  Rejected: two declarations of the same fact, and the tracked worktree copy
  still misleads every reader that does not run the validator.
- **Remove every path key from `.mstarc`.** Rejected as out of scope: the
  corpus and sub-directory keys describe tracked results and layout choices
  that Git cannot derive, and removing them would break repositories that
  legitimately place specs or ADRs outside `.agents/`.
- **Keep `MSTAR_HARNESS_DIR` as the one explicit override.** Rejected: an
  inherited environment variable is process-global and invisible at the call
  site, so it silently roots unrelated repositories and worktrees at the same
  harness, or roots one repository at a worktree path. A declared CLI pin
  (`--harness`) is at least visible in the launch configuration; the
  environment variable is not.
- **Support a harness outside the checkout.** Rejected by this decision: a
  process root outside the repository has no Git identity to compare, which is
  exactly the ambiguity being removed. A deployment that needs it keeps a
  separate repository root instead.

## Acceptance criteria

- Inside a linked worktree, `mstar path resolve` reports `harnessDir` equal to
  `<main>/.mstar`, `linkedWorktree: true`, and no command creates a `.mstar/`
  under the worktree.
- A `.mstarc` carrying `harness_dir` is refused, with a recovery that names
  the exact line to delete.
- A repository whose only harness is `.agents/` is refused, with
  `mstar harness scaffold` / `mstar store upgrade` named in the message.
- `MSTAR_HARNESS_DIR` never selects a root: setting it to a worktree or an
  out-of-repo directory leaves the Git-derived `<main>/.mstar` in force, and
  `unset MSTAR_HARNESS_DIR` is the documented recovery.
- A command launched outside any Git work tree runs when `--harness` names an
  existing `.mstar`, and refuses with both recoveries when it does not; the
  same launch with `MSTAR_HARNESS_DIR` set is unaffected (the value is ignored).
- An MCP call that omits `harness` is refused, and an MCP call naming a linked
  worktree's `.mstar` is refused with the Git-derived control root in the
  message. No MCP launch form (`--harness`, environment) changes either
  outcome.
- `mstar harness scaffold` in a new repository writes a `.mstarc` without
  `harness_dir`.
- The PM required-reading path contains the control-root-first rule and links
  to `mstar-use-cli/references/preconditions.md`.
- `bun run validation:drift` passes, and the affected engine, CLI and host
  suites cover the worktree, legacy-layout, explicit-selector and scaffold
  cases.

## Risks

- **Existing repositories break on the 4.8 upgrade.** The release notes mark
  the change breaking, every refusal names a recovery, and no store is moved
  automatically.
- **Out-of-checkout and shared-state harness layouts disappear.** This is the
  decision's cost; the migration is to keep the harness inside the main
  worktree.
- **MCP deployments that pinned the connection must inject per call.** After
  retirement the root reaches the server only through the call's `harness`
  field, so a host integration must fill it from the session cwd. The refusal
  names that replacement; forgetting it fails the call rather than rooting the
  connection somewhere unexpected.
- **Downstream hosts resolve roots themselves.** `dsh` has its own
  `HarnessResolver` surface and must adopt the same rule in the same release,
  or the hosts diverge.
- **There is no fallback phase.** A repository that relies on any retired
  selector fails at its first command after the upgrade; the refusal is the
  only signal, so its recovery text is part of the contract.

