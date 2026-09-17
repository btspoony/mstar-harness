# Coordination documents and registers

Three documents carry harness process state, and all three are written the same way: the bytes belong to locked engine writers, a replacement needs the version token of the bytes being replaced, and a refusal changes nothing. This file records that write protocol and the lifecycle verbs around it.

Field schemas, section meanings and per-document semantics are owned by `mstar-artifacts`; project-register lifecycle rules by `mstar-project-governance`; phase and close semantics by `mstar-iteration`. What follows is the CLI face.

## The three write surfaces

| Surface | Path shape | Holds | Store kind |
|---|---|---|---|
| root register | `{HARNESS_DIR}/status.json` | schema version, update timestamp, and the registry of active workflows (id, type, start, directory) | `status`, key `root` |
| workflow snapshot | `{WORKFLOW_DIR}/<workflow-id>/snapshot.json` | one lifecycle: plan rows, coordination blocks, leases, branch anchors, delivery block | `snapshot`, key = workflow id |
| project register | `{PROJECT_DIR}/<project-id>/residuals.json` | residual and backlog entries keyed by plan id | `residuals`, key = project id |

The root register is a registry, not a plan store: plan rows live in the snapshot, and a plan's residual state lives in the project register. Nothing is written to two of these documents by one command.

## Protection levels

**Protected** — `status`, `snapshot`, `residuals`. A bare put or delete through the store face refuses with `coordination.direct-write-refused` before writing anything, and that refusal also covers a generic-file alias whose canonical target is one of these documents. The consequence is deliberate: an accidental delete cannot drop the root register, and the store face is never the lifecycle route for a finished workflow.

**Unprotected** — the review envelope kind and unrelated generic files. They keep the ordinary put / get / list / delete contract, delete is an idempotent no-op when absent, and there is no confirmation prompt. A review envelope is not a coordination document: its schema and validation belong to the review workflow's owning skill; the store face only persists and reads it.

Enumeration reflects what exists: listing a kind prints its stored keys, one per line ascending, with no header, and an empty kind prints nothing and exits `0`. A missing backing file lists as empty rather than erroring.

## Versioned replacement

A coordinated replacement is two commands, and the token from the first is the only thing the second accepts.

```sh
# 1. read the bytes and their version
mstar persist get snapshot --key <workflow-id> --versioned

# 2. replace exactly those bytes
mstar persist snapshot --key <workflow-id> --expect-version sha256:<64-hex> --file payload.json --session <coordinator-envelope>
```

- The versioned read prints the payload together with its version: the digest of the exact bytes read, or the literal `absent` with a null payload when the document does not exist yet. `absent` is therefore a real token, not a missing value.
- The versioned read requires the local store. An injected module store refuses with `coordination.local-store-required`, because no same-host compare-and-swap is promised on a pluggable store — the coordination surface will not pretend a remote module gives it one.
- The write replaces; it never merges. A token that no longer matches the bytes refuses with `coordination.version-conflict`: someone wrote in between, the edit is lost, and the recovery is to read again and re-apply against the new bytes.
- A protected kind without a token refuses with `coordination.expected-version-required` — a bare put on those kinds is a usage error, not a fast path.
- Replacing a coordinated snapshot also needs its coordinator envelope; the command checks the session's role, so a plan envelope refuses. The session path must be absolute — a relative one is a usage error, because the engine compares canonical targets.
- After a successful replacement, read again. The token was consumed by the write that used it.

## Lifecycle close

Closing one finished lifecycle is a single verb whose work has a fixed order:

1. consult the registered delivery kind and its recorded evidence;
2. write the terminal snapshot under the snapshot lock;
3. unregister the root entry, idempotently.

Everything that can go wrong is checked before step 2, so a refusal leaves both documents byte-identical:

- dangling leases or unfinished plan rows refuse;
- incomplete or absent delivery evidence for the registered kind refuses, and the snapshot stays running with its root entry still registered;
- a **coordinated** workflow refuses a session-less close — it reports that the snapshot is coordinated and that the close needs the coordinator envelope, rather than reporting the plan rows. Only that workflow's own coordinator can close it; a plan envelope is not sufficient. An uncoordinated workflow closes with or without the flag.

Failure between steps 2 and 3 is reported as a partial close. A re-run finishes it, and a fully closed retry rewrites nothing. The close verb is the lifecycle route for a finished workflow: the protected snapshot refuses the generic delete face, and the removed residual-archival command points at the register instead.

## Residual and backlog lifecycle, in place

Entries change state inside their register; no command moves or archives a residual file.

- **Plan-side residuals** are opened and closed by the plan session against its own bucket, each with a row revision and a register version token plus the closure note that carries the evidence. The register version is `absent` for a bucket that does not exist yet, otherwise the digest token of the register's bytes — supply it, or a concurrent write is lost rather than merged.
- **Deferred backlog** is registered and closed through the status family, under the status write lock: entry-id uniqueness and the same-day key bump happen inside the lock, and provenance fields are filled by the command rather than by the caller.
- **Archival is gone.** The removed command exits `1` and names the replacement: set the entry's lifecycle with its closure fields in its project register. There is no second store for closed residuals, and no command that migrates them elsewhere.
- A close that cannot find the entry fails loudly instead of reporting success, so an absent id is never mistaken for an already-closed one.

## Authorization

The protected writes are authorized, not merely gated:

- every coordinated document is written only through an engine-generated session envelope for its own role and scope, re-checked inside the lock;
- the envelope is not a credential a caller declares — it is obtained from the bind verb, and it stays with the coordinator. Handing one to a leaf executor, or restating a revision token in a leaf's assignment, is a scope violation regardless of intent;
- the store face's own escape hatches are narrowed: an injected store cannot serve the coordinated surface, and the protected kinds refuse the direct faces entirely.
