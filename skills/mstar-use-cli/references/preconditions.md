# Preconditions

Most CLI friction is a precondition, not a syntax error: the command was right, the root was wrong, the cwd answered a different question, or a token came from an earlier state. This file collects the preconditions every family shares, in the order they must be established, and what each missing one looks like when it fails.

This is a diagnostic map, not a mandatory setup ladder. Invoke the intended public action first: current authority derives associated root, own binding and available CAS state, and records entailed prerequisites with that action. Provide only non-derivable actor identity, explicit target/authorization, or a real competing choice. Read an `applied`/`partial`/replay receipt before deciding whether any repair is needed; a partial result preserves committed components.

## 1. Which harness root

Commands that touch harness state resolve a harness directory first. Resolution starts from an explicit value and falls through to discovery:

1. an explicit override — the command's own root option, or the harness-dir environment variable (a `.mstarc` declaration in the repository config file is the same tier);
2. otherwise the documented probe: the harness directory, then any legacy harness directory, then the legacy plan directories;
3. otherwise nothing resolves.

The probe walks up from the start directory but **never crosses the workspace root**, and for a linked checkout the workspace root is the worktree itself. So a feature worktree cannot discover the control harness by walking up — process documents are gitignored and simply are not there.

Two resolutions coexist in the CLI and can disagree from the same cwd:

| Resolution | Derived from | Consequence |
|---|---|---|
| process root | the main worktree of the repository, not the checkout the process sits in | a command run inside a linked worktree still addresses the control harness |
| local probe | the process cwd, bounded by the workspace root | a feature worktree resolves whatever harness-shaped directory *it* happens to carry, or nothing |

That is the trap worth wiring into habits: **never assume cwd discovery addresses the control harness.** Where a stray legacy harness directory exists in the worktree, the local probe resolves it and reports success against the wrong root; where none exists, the same command fails against a directory the operator never chose.

Use the path-resolution command to see what the current cwd actually resolves before running anything that reads or writes process state, and name the root explicitly whenever the process may sit outside the control checkout — the root option, the environment override, or a positional control root where the command takes one.

Failure shapes: no resolvable root exits `1` and prints a guidance line naming the bounded probe, the start directory and the bootstrap verb. A linked checkout whose main worktree cannot be read refuses explicitly rather than degrading to local artifacts. A resolution that succeeds is not proof it chose the root the run intended.

## 2. Control root vs feature worktree

| Lives in | Content |
|---|---|
| control root (main worktree) | plan files, the root register, workflow snapshots, project registers, SDD scratch and review bundles |
| feature worktree | the product source changes under review |
| tracked results | knowledge and specs — they follow Git, so they are visible from every worktree |

Consequences:

- coordinator verbs belong to main-worktree residency, or to the recorded integration worktree for the integration steps; running them from a product checkout is a precondition failure, not a convenience;
- a command run from the feature worktree that needs process state must name the control root explicitly;
- the reverse also holds: writing product files from the control checkout mixes the two domains, and a worktree check will notice.

## 3. cwd neutrality

Git-derived checks derive the main worktree, the branch and clean-state facts from the **process cwd**. Inside a linked worktree that derivation answers a different question than the one the snapshot recorded, so a check can pass or fail for reasons unrelated to the workflow.

- Run topology and residency checks from a neutral cwd — the control checkout.
- SDD helpers that resolve a workspace take a control-root argument or an environment override, and fail closed from a linked checkout whose control register cannot be read.
- Treat the cwd as an input, like a flag: if the same command gave two answers, the cwd is the first thing to check.

## 4. Identity and the execution authority

A harness has two separate authority records: `store_meta.authority_state` governs issue/catalog operations, while `execution_meta.authority_state` selects the coordination route. Use `mstar status validate` to discriminate. Its `state` is `active`, `legacy`, or `unreadable`. Only `active` supports normal coordinated operations; `legacy` provides the upgrade entry resolved per observed files (an existing store uses `mstar store safe-upgrade`; legacy files without a store use `mstar store init` followed by `mstar store safe-upgrade`); `unreadable` reports what could not be read and how to make it readable.

On `active`, writes use the independently acquired caller identity, the addressed scope's full execution token, and an operation id. The session reference names a stored session row; it is not a bearer credential.

For CLI commands, `--session-id` takes precedence over `MSTAR_HOST_SESSION_ID`; the environment value is also an accepted identity input for active-registration commands and plan/assignment binds. Session identity is attribution, not authorization, on active token-authorized writes. The legacy pre-activation coordinator bootstrap (`plan bind --coordinator`) remains explicit-only: its session identity must come from `--session-id`, not the environment. Legacy `plan bind --resume` ignores ambient environment identity and refuses a declared identity (explicit `--session-id` or host-supplied identity). MCP session identity is supplied by the host per call, except legacy `plan bind --resume`, which refuses declared identity and ignores ambient environment identity.

- On `active`, writes use the independently acquired caller identity, the addressed scope's full execution token, and an operation id. The session reference names a stored session row; it is not a bearer credential.
- The root registration token is read from `mstar status validate`'s `.token`; a workflow token is read from its `.workflows[]` entry there (or an authoritative workflow read); a plan token is read from `mstar plan show` for that plan. These are distinct token kinds (`root`, `workflow`, `plan`) and cannot be substituted for one another (`execution.token-kind`).
- A session reference is produced by the active bind or recovery verb, encoded as `exec-session-v1:` plus base64url canonical JSON containing `storeId`, `epoch`, `workflowId`, `role`, `sessionId`, and `planId`.
- The caller identity is independently acquired for each invocation; it is never read from a session file or carried by the reference. No force flag, takeover, holder input, or lease-release verb exists.
- Nothing here is a credential to pass on. Session references and tokens stay with the coordinator or PM that holds them.

## 5. Token kinds and lifetime

| Token | Read from | Lifetime |
|---|---|---|
| Root execution token | `mstar status validate` → `.token` | Registration CAS; consumed by that write |
| Workflow execution token | `mstar status validate` → matching `.workflows[]` entry, or an authoritative workflow read | Workflow-scoped writes; consumed by that write |
| Plan execution token | `mstar plan show` → addressed plan's token | Plan-scoped writes; consumed by that write |
| Operation id | The caller's choice | Replay key for exactly one intended operation |

Tokens are not interchangeable. Read again after every successful mutation; never treat a row revision, document byte version, schema version, or timestamp as an execution token.

## 6. Diagnose an actual conflict

Run the requested intent first. If it cannot establish a unique target, root, caller or foreign-holder disposition, use the refusal to identify that one missing fact; do not execute every row below as preflight. For an action-local partial receipt, preserve applied components and resolve its named remaining conflict rather than replaying the whole sequence. Recorded byte versions do not authorize replacement or require hash repair.

| Conflict | Operator input only when needed |
|---|---|
| ambiguous root or target | choose the correct associated workflow/plan or control root |
| foreign live holder or stopped owner | authoritative stop/transfer evidence and authorization |
| caller identity unavailable | acquire the correct independent identity; never infer it from a reference |
| checkout/Git fact required by integration | use the recorded integration checkout or report unavailable Git fact |

## 7. When a precondition cannot be met

- If the CLI itself is absent, the engine-import and prose path declared by the owning topical skill governs. Fail closed with install or upgrade guidance rather than reconstructing a coordinated write by hand.
- Never close the gap by editing a coordination document directly: the protected documents refuse it, and where they do not, the write silently bypasses the lock, the token check and the session authorization that the verb would have applied.
- Never substitute a weaker check for a blocked one. Report the missing precondition — the exact command, root, cwd or token — and let the owner resolve it; a run that could not establish its preconditions has no result to report.
