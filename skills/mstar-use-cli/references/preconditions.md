# Preconditions

Most CLI friction is a precondition, not a syntax error: the command was right, the root was wrong, the cwd answered a different question, or a token came from an earlier state. This file collects the preconditions every family shares, in the order they must be established, and what each missing one looks like when it fails.

This is a diagnostic map, not a mandatory setup ladder. Invoke the intended public action first: current authority derives associated root, own binding and available CAS state, and records entailed prerequisites with that action. Provide only non-derivable actor identity, explicit target/authorization, or a real competing choice. Read an `applied`/`partial`/replay receipt before deciding whether any repair is needed; a partial result preserves committed components.

## 1. Which harness root

Commands that touch harness state resolve a harness directory first. The root is fixed: **`<git main worktree root>/.mstar/`**. It is derived from Git only; no `.mstarc` key, environment variable or candidate chain moves it.

- `harness_dir` is retired: a `.mstarc` may still declare it, the value is parsed and ignored, and the root stays `<main>/.mstar`. No file edit is required.
- `MSTAR_HARNESS_DIR` is retired: the value is read and ignored, never selects a root, and needs no `unset`.
- `.agents/`, `.plans/` and `plans/` are never probed or adopted; a repository whose only harness is one of them is not an error — it simply resolves no harness root. `mstar harness scaffold` (then `mstar store upgrade` for an existing store) is how a root comes into existence.
- A CLI process outside any Git work tree names the root with `--harness <absolute .mstar>`; without it the command refuses and names both recoveries.

A linked checkout resolves the main worktree's `.mstar`; its own `.mstarc` is a tracked copy whose layout declaration does not move the root.

Two resolutions coexist in the CLI and can disagree from the same cwd:

| Resolution | Derived from | Consequence |
|---|---|---|
| process root | the main worktree of the repository, not the checkout the process sits in | a command run inside a linked worktree still addresses the control harness |
| local probe | the process cwd, bounded by the workspace root | a feature worktree resolves whatever harness-shaped directory *it* happens to carry, or nothing |

That is the trap worth wiring into habits: **never assume cwd discovery addresses the control harness.** Where a stray `.mstar/` exists in the worktree, the local probe reports it; the effective root still comes from the control checkout, and legacy `.agents/` / `.plans/` / `plans/` directories are never adopted at all.

Use the path-resolution command to see what the current cwd resolves before running anything that reads or writes process state. Its top-level members are the **effective** answers: in a linked checkout `harnessDir` is the control harness, `linkedWorktree: true`, and `controlRoot` / `controlHarnessDir` name the main checkout and its harness. The checkout's own probe is reported beside them under `local` — read it only to diagnose why a local artifact exists, never as the process root. Name `controlHarnessDir` explicitly for an MCP call, or for a CLI launch outside Git; a CLI inside Git derives it from the main worktree.

Failure shapes: no resolvable root exits `1` and prints a guidance line naming the fixed root, the start directory and the bootstrap verb. A linked checkout whose main worktree cannot be read refuses explicitly rather than degrading to local artifacts. A resolution that succeeds is not proof it chose the root the run intended.

## 2. Control root vs feature worktree

| Lives in | Content |
|---|---|
| control root (main worktree) | plan files, the root register, workflow snapshots, project registers, SDD scratch and review bundles |
| feature worktree | the product source changes under review |
| tracked results | knowledge and specs — they follow Git, so they are visible from every worktree |

Consequences:

- coordinator verbs belong to main-worktree residency, or to the recorded integration worktree for the integration steps; running them from a product checkout is a precondition failure, not a convenience;
- a CLI command run from the feature worktree derives the control root through Git; an MCP call must name it explicitly;
- the reverse also holds: writing product files from the control checkout mixes the two domains, and a worktree check will notice.

## 3. cwd neutrality

Git-derived checks derive the main worktree, the branch and clean-state facts from the **process cwd**. Inside a linked worktree that derivation answers a different question than the one the snapshot recorded, so a check can pass or fail for reasons unrelated to the workflow.

- Run topology and residency checks from a neutral cwd — the control checkout.
- SDD helpers that resolve a workspace take a control-root argument or an environment override, and fail closed from a linked checkout whose control register cannot be read.
- Treat the cwd as an input, like a flag: if the same command gave two answers, the cwd is the first thing to check.

## 4. Identity and the execution authority

A harness has two separate authority records: `store_meta.authority_state` governs issue/catalog operations, while `execution_meta.authority_state` selects the coordination route. Use `mstar status validate` to discriminate. Its `state` is `active`, `legacy`, or `unreadable`. Only `active` supports normal coordinated operations; for `legacy`, the supported one-command upgrade is `mstar store upgrade --operator <name>`, which opens or creates the store and imports recognizable execution records; `unreadable` reports what could not be read and how to make it readable.

On `active`, writes use the independently acquired caller identity, the addressed scope's full execution token, and an operation id. The session reference names a stored session row; it is not a bearer credential.

CLI --session-id constrains independently acquired identity; declared host identity inputs remain transport-owned, never inferred from session-reference bytes. Pre-activation coordinator bootstrap requires explicit --session-id; file resume is read-only and never a new identity. ACTIVE reference/token/operation defaults may be derived from own current coordinator context when unambiguous. No per-row bind or Assignment input exists.

- On `active`, writes use the independently acquired caller identity, the addressed scope's full execution token, and an operation id. The session reference names a stored session row; it is not a bearer credential.
- The root registration token is read from `mstar status validate`'s `.token`; a workflow token is read from its `.workflows[]` entry there (or an authoritative workflow read); a plan token is read from `mstar plan show` for that plan. These are distinct token kinds (`root`, `workflow`, `plan`) and cannot be substituted for one another (`execution.token-kind`).
- Session reference contains storeId, epoch, workflowId, coordinator role and sessionId, never planId. It is produced by workflow coordinator bind/recovery, not row admission.
- The caller identity is independently acquired for each invocation; it is never read from a session file or carried by the reference. No force flag, takeover, holder input, or lease-release verb exists.
- Nothing here is a credential to pass on. Session references and tokens stay with the coordinator or PM that holds them.

## 5. Token kinds and lifetime

| Token | Read from | Lifetime |
|---|---|---|
| Root execution token | `mstar status validate` → `.token` | Registration CAS; consumed by that write |
| Workflow execution token | `mstar status validate` → matching `.workflows[]` entry, or an authoritative workflow read | Workflow-scoped writes; consumed by that write |
| Plan execution token | `mstar plan show` → addressed plan's token | Plan-scoped writes; consumed by that write |
| Operation id | The caller's choice | Replay key for exactly one intended operation |
Tokens are distinct CAS constraints. Use the mutation's new token or derive current own context; an explicit stale token refuses. Row/schema revisions, byte digests and timestamps are not execution tokens.

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
