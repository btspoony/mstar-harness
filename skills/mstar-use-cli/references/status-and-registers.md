# Coordination documents and registers

Two coordinated documents carry harness process state, and both are written the same way: the bytes belong to locked engine writers, a replacement needs the version token of the bytes being replaced, and a refusal changes nothing. This file records that write protocol, the lifecycle verbs around it, and the two surfaces that took over the retired project register: the issue store (open items) and its staged migration/activation lifecycle.

Field schemas, section meanings and per-document semantics are owned by `mstar-artifacts`; the capture duty and the register's migration mapping by `mstar-project-governance`; phase and close semantics by `mstar-iteration`. What follows is the CLI face.

## The coordinated write surfaces

| Surface | Path shape | Holds | Store kind |
|---|---|---|---|
| root register | `{HARNESS_DIR}/status.json` | schema version, update timestamp, and the registry of active workflows (id, type, start, directory) | `status`, key `root` |
| workflow snapshot | `{WORKFLOW_DIR}/<workflow-id>/snapshot.json` | one lifecycle: plan rows, coordination blocks, leases, branch anchors, delivery block | `snapshot`, key = workflow id |

The root register is a registry, not a plan store: plan rows live in the snapshot, and a plan's open findings live in the issue store. Nothing is written to two of these documents by one command.

A third legacy document still exists — the project register `{PROJECT_DIR}/<project-id>/residuals.json`. It is **migration history only**: it stays readable for the migration mapping, but it is no longer a write surface, and no command maintains it (see § Open items and § Store lifecycle).

## Protection levels

**Protected** — `status`, `snapshot`. A bare put or delete through the store face refuses with `coordination.direct-write-refused` before writing anything, and that refusal also covers a generic-file alias whose canonical target is one of these documents. The consequence is deliberate: an accidental delete cannot drop the root register, and the store face is never the lifecycle route for a finished workflow.

**Read-only legacy** — the `residuals` kind. It still reads the migrated project register, but a replacement refuses with `coordination.store`: a `residuals.json` is migration history and the issue store is the only findings authority. The same applies to a JSON alias pointing at a register path.

**Unprotected** — the review envelope kind and unrelated generic files. They keep the ordinary put / get / list / delete contract, delete is an idempotent no-op when absent, and there is no confirmation prompt. A review envelope is not a coordination document: its schema and validation belong to the review workflow's owning skill; the store face only persists and reads it.

Enumeration reflects what exists: listing a kind prints its stored keys, one per line ascending, with no header, and an empty kind prints nothing and exits `0`. A missing backing file lists as empty rather than erroring.

## Versioned replacement (pre-activation store face)

A coordinated replacement is two commands, and the token from the first is the only thing the second accepts. This is the **pre-activation** writer for those documents: on a harness whose execution authority is active, the same documents are owned by the coordination verbs (`mstar plan progress`, `mstar workflow amend-prepare`, `mstar status workflow-close`), which take the scope's full execution token instead, and a bare store-face replacement refuses there.

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
- Replacing a coordinated snapshot also needs its bound coordinator envelope; the command checks the session's role, so a plan envelope refuses. The session path must be absolute — a relative one is a usage error, because the engine compares canonical targets.
- After a successful replacement, read again. The token was consumed by the write that used it.

## Lifecycle close

Closing one finished lifecycle is a single verb whose work has a fixed order:

1. consult the registered delivery kind and its recorded evidence;
2. write the terminal snapshot under the snapshot lock;
3. unregister the root entry, idempotently.

```sh
# active: the coordinator's own reference plus the workflow's full execution token
mstar status workflow-close --workflow <id> --session-ref <wire> \
  --expect <full-execution-token> --operation <id> --reason <text> [--harness <absolute-path>] [--json]

# pre-activation only (refused on an ACTIVE authority)
mstar status workflow-close --workflow <id> [--harness <path>] [--ended-at <date>] [--session <path>]
```

Everything that can go wrong is checked before step 2, so a refusal leaves both documents byte-identical:

- dangling leases or unfinished plan rows refuse;
- incomplete or absent delivery evidence for the registered kind refuses, and the snapshot stays running with its root entry still registered;
- a **coordinated** workflow refuses a session-less close — it reports that the snapshot is coordinated and that the close needs the authority that owns it. Only that workflow's own coordinator can close it; a plan session's reference is not sufficient. On the active route the close carries its own reason and takes no `--ended-at` (the pre-activation form's `--ended-at` belongs to the file write, and an active call that states it is a usage refusal).
- An uncoordinated workflow closes with or without the coordinator's authority.

Failure between steps 2 and 3 is reported as a partial close. A re-run finishes it, and a fully closed retry rewrites nothing. The close verb is the lifecycle route for a finished workflow: the protected snapshot refuses the generic delete face, and the removed residual-archival command fails and names the issue disposition that replaced it.

## Open items: the issue store

Open findings are issues in `{HARNESS_DIR}/store.db`; the project register above is migration history and no command maintains it. The capture contract, its authorization and the migration mapping live in **`mstar-project-governance`「Issue capture」** — this file only names the transport.

- **Capture** is plan-scoped (`mstar plan issue-add`; active: the plan's full execution token as `--expect` plus `--session-ref`/`--operation`, pre-activation: the row revision as `--expect`; the report names the DB-assigned issue ids and revisions) or unscoped (`mstar issue add`). A recurrence appends an occurrence to the existing issue instead of opening a second one.
- **Close** is a separate authorized act with a terminal disposition: `mstar plan issue-close` on the plan's own linked issue (`--issue`, `--disposition`, `--expect-issue`), or `mstar issue close|waive|duplicate|supersede` unscoped. Each mutation is CAS-guarded by the issue revision, which stays an integer on every transport.
- **The retired verbs are refusals, not aliases.** The old plan-side `residual-add` / `residual-close` verbs and the status-family `backlog-register` / `backlog-close` verbs still parse, refuse, write nothing, and name the issue verb that replaced them. There is no write-through compatibility path and no second store for closed findings.
- **Reading is not a rollup of the registers.** `mstar status tech-debt` prints the store's open-issue rollup and `mstar status findings-cleanup <plan-id>` enforces the plan's mode over its **linked open issues**; a missing, corrupt or staged store refuses (exit 1) instead of reporting an empty rollup.

## Store lifecycle: migration, activation, retirement

The store is not writable until it is activated, and activation is a barrier — not a flag. The `store` group owns the verbs and their flags; what follows is the order and what each step demands.

```sh
mstar store migrate --out <path>              # default: read-only preview manifest (writes no DB)
mstar store migrate --apply --manifest <path> # the explicit reviewed apply → staged store
mstar store backup --out <path>               # quiesced VACUUM INTO point, verified read-only
mstar store activate --manifest <path> --attestation <path>   # the barrier
mstar store retire --manifest <path>          # moves the reviewed legacy sources under a ledger
```

- **`migrate`** previews by default: a reviewable manifest (control root, canonical source paths, byte digests, source-set digest, parsed counts, per-entry dispositions, unresolved mappings, catalog conflicts, index-section retirement ranges) and no DB. The explicit reviewed apply commits the import in one issue/catalog/receipt transaction with a persistent ID mapping, and refuses on source-set or byte drift. The applied store is **staged**: ordinary mutations stay refused, and the legacy registers remain the live capture path.
- **`backup`** writes a quiesced, SQLite-consistent `VACUUM INTO` recovery point (committed WAL frames included) and verifies it by reopening the copy read-only; the receipt records the store identity and the verified row counts. Copying `store.db` alone, without its WAL, is not a backup.
- **`activate`** is the barrier. It requires the reviewed apply receipt to be the **final** one, a compatible-consumer attestation (installed entrypoints and versions, quiesced sessions, the approving operator — never session credentials) and a verified backup; the state flip, the epoch increment and the receipt commit in one transaction. Ordinary mutations work only afterwards, and every command checks epoch and state.
- **`retire`** moves the exact reviewed legacy registers and index sections into `{HARNESS_DIR}/archived/store-migration/<receipt-id>/` under a resumable per-item ledger, after revalidating active identity, epoch, source hashes and catalog digests. A late old-format write refuses `store.legacy-write-detected` and is never deleted; a crash resumes from the ledger to the recorded bytes.

**Readiness guidance (not an action).** These are the readiness checks an operator performs *before* a live activation; running a documentation or source task performs none of them, and no stored flag stands in for them. Activation is an authorized ops act under a recorded, bounded authorization covering the affected installed CLI/plugin upgrades or reloads; credentials and unrelated global configuration stay out of scope. Ready means every compatible consumer is quiesced and then reloaded, upgraded or explicitly excluded, and old software is kept out by that operational barrier — a marker, a chmod or a missing register cannot stop an old binary. If a host cannot reload safely, **stop at that host's exact manual-restart step**, have the user restart, then re-check entrypoint, runtime, version and session identity read-only before activating; until activation succeeds the legacy authority remains in force, and a below-floor runtime or missing capability refuses actionably rather than falling back to JSON.

## Authorization

The protected writes are authorized, not merely gated:

- every coordinated document is written only through the transport that owns it — the scope's execution token plus an independently acquired caller identity on the active route, or the engine-generated session envelope for its own role and scope on the pre-activation route — re-checked inside the lock either way;
- **a reference and a token are not credentials a caller declares or forwards.** The active reference is a lookup into stored session rows; it grants nothing without the independently acquired caller the engine compares in its own transaction. Both the reference and every token stay with the coordinator or PM session: handing one to a leaf executor, or restating a token in a leaf's assignment, is a scope violation regardless of intent;
- **no resume stands in for recovery**, and no recovery stands in for a fresh bind: a stopped owner is replaced by the recovery verb that owns its authority, never by a copied id, a restarted launcher or a hand-edited record;
- the store face's own escape hatches are narrowed: an injected store cannot serve the coordinated surface, and the protected kinds refuse the direct faces entirely.
