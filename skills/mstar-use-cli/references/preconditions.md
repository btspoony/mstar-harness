# Preconditions

Most CLI friction is a precondition, not a syntax error: the command was right, the root was wrong, the cwd answered a different question, or a token came from an earlier state. This file collects the preconditions every family shares, in the order they must be established, and what each missing one looks like when it fails.

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

A harness has one execution authority, and its state selects the transport every coordinated write takes. **Active** is the canonical route: the caller identity is **independently acquired** for the invocation (never a flag, never read from a session file, never carried by the reference), and the write carries a `--session-ref` (a stored session row — a lookup, not a bearer credential), the scope's **full execution token** as `--expect`, and the caller's own `--operation` id as the replay key. A copied or stale reference under another identity refuses in the engine's own caller comparison.

- **Pre-activation (file route, only while that authority is not active):** the session envelope is engine-generated, obtained from the bind verb, addressed by absolute path, and re-checked against its document inside the write lock — the caller's word about who it is counts for nothing. A coordinator identity is **explicitly acquired**, never generated: a plain local operator states `--session-id`, and a managed host bootstraps through its own host-owned entry (→ the active host reference under `mstar-host`) instead of a shell call. The inherited session-id environment variable is a declared input form for a **plan/assignment** bind only — it never authorizes a coordinator bootstrap. A missing or mismatched one refuses (`coordination.identity-missing` / `coordination.identity-mismatch`); no bind mints an id as a fallback. On an ACTIVE harness these forms refuse with `execution.consumer-not-ready` rather than being reinterpreted.
- **Resume is read-only on both transports** (`mstar plan bind --execution --resume-ref <wire>`, or the pre-activation `mstar plan bind --resume <absolute-json>`): it reports context and never reacquires ownership, never re-identifies the caller and never restarts execution. **Resume is never recovery.**
- An abandoned or unreachable owner is repaired by the verb that owns its authority: while the execution authority is active, `mstar session recover` (named prior holder or explicit `--unowned`, stop attestation, the workflow's exact token, an operation id); on the pre-activation side, the guarded Prepare recovery (`references/plan-and-workflow.md` § Prepare coordinator recovery) with the prior envelope's address, both byte versions, the operator's reason and authorization reference, and a stop assertion naming the recorded holder. Hand-editing a session file or a coordination document is never a path.
- There is no force flag, no takeover, no holder or role input, and no lease-release verb.
- One coordinator per workflow; a second bootstrap of the same workflow refuses.
- **Nothing here is a credential you may pass on.** A session envelope, a session reference and any token stay with the coordinator or PM session that holds them: handing one to a leaf executor — or restating a token in a leaf's assignment — breaks the scoped boundary even when the resulting command would have succeeded.
- A relative session path is a usage error at every entry point; absolute is required because the engine compares canonical targets.

## 5. Tokens

| Token | Read from | Lifetime |
|---|---|---|
| execution token (active CAS) | a read of the addressed scope — `mstar status validate` prints the root and per-workflow tokens, a plan/workflow read returns that scope's token | consumed by the write that uses it; a revision integer is a pre-activation input and never becomes an execution token |
| operation id (active replay key) | the caller's own choice | an exact retry replays the recorded receipt; a changed request against the same id refuses |
| row revision (pre-activation) | the plan read verb's machine output | consumed by the transition that uses it; read again for the next one |
| register version | the same read: `absent`, or the digest of the register's bytes | consumed by the residual write that uses it |
| document byte version | the versioned store read, or the amendment's read verb | consumed by the replacement that uses it |

They are not interchangeable. A row revision is not a document version, a register version is not a snapshot version, an execution token is neither, and a schema version or a timestamp is none of the three. Supplying the wrong kind fails validation or refuses; supplying a consumed one refuses as stale. The recovery is identical in both cases: read again.

## 6. Order of establishment

Establish the rungs top-down. Each fails closed, so a lower rung is never silently satisfied by a guess about a higher one.

| Rung | Establish by | If missing |
|---|---|---|
| root | path resolution, then an explicit root where discovery is ambiguous | exit `1` with the probe guidance, or worse: a successful command against the wrong root |
| residency | run from the control checkout, or from the recorded integration checkout for integration steps | a gate refusal describing an unexpected checkout or branch |
| cwd | neutral for Git-derived checks | a check whose verdict disagrees with the recorded snapshot |
| identity | acquire it independently for this invocation (the active transport; the reference is a lookup, not a credential), or explicitly (`--session-id`, or the host-owned entry on a managed host) with the bound session's absolute envelope on the pre-activation route | a usage refusal naming the identity channel, or an engine refusal naming the required role or the missing identity (`coordination.identity-missing`, `coordination.identity-mismatch`) |
| tokens | read the value the consuming command expects, immediately before it — a full execution token plus the caller's operation id on the active route; a row/register/byte version on the pre-activation route | a refusal for a missing or stale token, or a usage refusal for a revision integer where an execution token is required |
| mutation | only then run the write | — |

## 7. When a precondition cannot be met

- If the CLI itself is absent, the engine-import and prose path declared by the owning topical skill governs. Fail closed with install or upgrade guidance rather than reconstructing a coordinated write by hand.
- Never close the gap by editing a coordination document directly: the protected documents refuse it, and where they do not, the write silently bypasses the lock, the token check and the session authorization that the verb would have applied.
- Never substitute a weaker check for a blocked one. Report the missing precondition — the exact command, root, cwd or token — and let the owner resolve it; a run that could not establish its preconditions has no result to report.
