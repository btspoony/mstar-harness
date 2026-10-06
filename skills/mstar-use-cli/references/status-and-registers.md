# Coordination documents and registers

Harness process state belongs to locked engine writers and their current actor, scope and state contracts. Recorded document versions are provenance, not replacement credentials. This file records the lifecycle verbs and the two surfaces that took over the retired project register: the issue store (open items) and its staged migration/activation lifecycle.

Field schemas, section meanings and per-document semantics are owned by `mstar-artifacts`; the capture duty and the register's migration mapping by `mstar-project-governance`; phase and close semantics by `mstar-iteration`. What follows is the CLI face.

For ordinary lifecycle intents use the owning public verb rather than replacing a snapshot as a setup step. Current authority derives coherent projections and action-local prerequisites; protected documents have no raw byte-version replacement recipe here. Preserve an `applied` or `partial` receipt and resolve only its outstanding conflict; do not treat partial success as a mutation-free refusal.

For the open-issue store, discover JSON shapes with `mstar-harness schema CaptureInput`, `OccurrenceInput`, `IssueTriage`, `ClosureEvidence`, and `IssueLink` before `issue add|occurrence|triage|close|waive|duplicate|supersede|link` (the corresponding verb help owns flags). `ClosureEvidence` has disposition-specific required fields; use the schema rather than guessing from a prior refusal. Store reads/export need no write payload. Plan-scoped `issue-add` and `issue-close` are separate authority routes, not substitutes for the unscoped actor's explicit operation and issue-revision inputs.

Complete synthetic `CaptureInput` example (adapt evidence, timestamp and semantic keys to the observed finding; do not copy this observation into a live store):

```json
{
  "projectId": "example-project",
  "title": "Example failed boundary",
  "kind": "bug",
  "severity": "medium",
  "impact": "A user cannot finish the example operation",
  "acceptance": "The operation succeeds for the valid boundary input",
  "sourceIdentity": "example-report:case-1",
  "rootCauseKey": "example-boundary-handling",
  "acceptanceKey": "valid-boundary-operation",
  "occurrenceKey": "example-run-1",
  "sourceKind": "review",
  "location": "src/example.ts:42",
  "observedBehavior": "Valid boundary input was rejected",
  "evidence": ["example scoped observation"],
  "discoveredAt": "2026-01-01T00:00:00Z"
}
```

## The coordinated write surfaces

ACTIVE root/workflow/plan/lease/session authority is `{HARNESS_DIR}/store.db` (`execution_*`), read through `mstar status validate` / `mstar plan show` and written only through public workflow/plan verbs. The table below is the **pre-activation / engine-absent file mapping** of persist kinds, not an ACTIVE write surface.

| Surface | Path shape | Holds | Store kind |
|---|---|---|---|
| root register | `{HARNESS_DIR}/status.json` | schema version, update timestamp, and the registry of active workflows (id, type, start, directory) | `status`, key `root` |
| workflow snapshot | `{WORKFLOW_DIR}/<workflow-id>/snapshot.json` | one lifecycle: plan rows, coordination blocks, leases, branch anchors, delivery block | `snapshot`, key = workflow id |

The root register is a registry, not a plan store: ACTIVE plan rows live in `execution_plans` (pre-activation: snapshot); open findings live in store issues. Persist mappings do not authorize coordinated writes.

A third legacy document still exists — the project register `{PROJECT_DIR}/<project-id>/residuals.json`. It is **migration history only**: it stays readable for the migration mapping, but it is no longer a write surface, and no command maintains it (see § Open items and § Store lifecycle).

## Protection levels

**ACTIVE file-route guard first** — raw root/snapshot/session-file writes and deletes refuse `execution.direct-write-refused`; reads refuse `execution.consumer-not-ready`, including canonical generic-file aliases. Do not retry via `persist json`; use the public verb.

**Pre-activation protected kinds** — `status`, `snapshot` bare put/delete refuse `coordination.direct-write-refused`; aliases do not bypass protection.

**Unconditionally retired** — `residuals` kind refuses `persist.kind-retired`; project residual registers are migration history, not a live persist read/write surface. Register replacement/JSON aliases refuse `coordination.store`. Open findings use issue verbs.

**Unprotected** — the review envelope kind and unrelated generic files. They keep the ordinary put / get / list / delete contract, delete is an idempotent no-op when absent, and there is no confirmation prompt. A review envelope is not a coordination document: its schema and validation belong to the review workflow's owning skill; the store face only persists and reads it.

Enumeration reflects what exists: listing a kind prints its stored keys, one per line ascending, with no header, and an empty kind prints nothing and exits `0`. A missing backing file lists as empty rather than erroring.

## Protected document writes

Use the supported coordination/lifecycle action for the current authority, not a raw protected-document replacement recipe. Protected snapshot/status targets and retired residual registers keep their writer/actor boundary. A versioned read may expose a digest or `absent` as historical information; neither is a mandatory mutation flag or a consumed byte-CAS token. Current semantic validation, lock/transaction behavior, numeric revisions and active execution tokens remain separate requirements.

## Lifecycle close

Closing one finished lifecycle is a single verb whose work has a fixed order:

1. consult the registered delivery kind and its recorded evidence;
2. write terminal workflow state in the ACTIVE execution store (pre-activation: snapshot lock);
3. unregister the root entry, idempotently.

```sh
# active: the coordinator's own reference plus the workflow's full execution token
mstar status workflow-close --workflow <id> --session-ref <wire> \
  --expect <full-execution-token> --operation <id> --reason <text> [--harness <absolute-path>] [--json]

# pre-activation only (refused on an ACTIVE authority)
mstar status workflow-close --workflow <id> [--harness <path>] [--ended-at <date>] [--session <path>]
```

Read the action-local receipt: ACTIVE close acts on store rows, not file bytes; pre-activation file-route refusal leaves the protected documents unchanged.

- dangling leases or unfinished plan rows refuse;
- incomplete or absent delivery evidence for the registered kind refuses, and the snapshot stays running with its root entry still registered;
- a **coordinated** workflow refuses a session-less close — it reports that the snapshot is coordinated and that the close needs the authority that owns it. Only that workflow's own coordinator can close it; a plan session's reference is not sufficient. On the active route the close carries its own reason and takes no `--ended-at` (the pre-activation form's `--ended-at` belongs to the file write, and an active call that states it is a usage refusal).
- An uncoordinated workflow closes with or without the coordinator's authority.

Failure between steps 2 and 3 is reported as a partial close. A re-run finishes it, and a fully closed retry rewrites nothing. The close verb is the lifecycle route for a finished workflow: the protected snapshot refuses the generic delete face, and the removed residual-archival command fails and names the issue disposition that replaced it.

## Open items: the issue store

Open findings are issues in `{HARNESS_DIR}/store.db`; the project register above is migration history and no command maintains it. The capture contract, its authorization and the migration mapping live in **`mstar-project-governance`「Issue capture」** — this file only names the transport.

- **Capture** is plan-scoped (`mstar plan issue-add`; active: `--session-ref`/`--operation` under the caller's independently acquired `--session-id`/`sessionId`, the execution token supplied only as an explicit constraint — on plan operations an omitted one is derived by the engine from the plan's own read; pre-activation: the row revision as `--expect`; the report names the DB-assigned issue ids and revisions) or unscoped (`mstar issue add`). A recurrence appends an occurrence to the existing issue instead of opening a second one.
- **Close** is a separate authorized act with a terminal disposition: `mstar plan issue-close` on the plan's own linked issue (`--issue`, `--disposition`, `--expect-issue`), or `mstar issue close|waive|duplicate|supersede` unscoped. Each mutation is CAS-guarded by the issue revision, which stays an integer on every transport.
- **The retired verbs are refusals, not aliases.** The old plan-side `residual-add` / `residual-close` verbs and the status-family `backlog-register` / `backlog-close` verbs still parse, refuse, write nothing, and name the issue verb that replaced them. There is no write-through compatibility path and no second store for closed findings.
- **Reading is not a rollup of the registers.** `mstar status tech-debt` prints the store's open-issue rollup and `mstar status findings-cleanup <plan-id>` enforces the plan's mode over its **linked open issues**; a missing, corrupt or staged store refuses (exit 1) instead of reporting an empty rollup.

## Store lifecycle: migration, activation, retirement

`store init` creates a fresh active issue/catalog store; `store upgrade` opens/creates the store, imports recognizable execution state, activates authority and reports skipped inputs. Neither requires routine `activate` afterwards. The sequence below is the **staged migration** route; `activate` consumes its reviewed apply and attestation, not an init receipt. Initialization semantics → `mstar-conventions`.

```sh
mstar store migrate --out <path>              # default: read-only preview manifest (writes no DB)
mstar store migrate --apply --manifest <path> # the explicit reviewed apply → staged store
mstar store backup --out <path>               # quiesced VACUUM INTO point, verified read-only
mstar store activate --manifest <path> --attestation <path>   # the barrier
mstar store retire --manifest <path>          # moves the reviewed legacy sources under a ledger
```

- **`migrate`** previews a reviewable manifest and no DB; reviewed apply commits issue/catalog/receipt import into a staged store. Ordinary mutations remain refused until activation. Source identity/path/state requirements remain; legacy project registers stay migration history and are never a live capture path.
- **`backup`** writes a quiesced, SQLite-consistent `VACUUM INTO` recovery point (committed WAL frames included) and verifies it by reopening the copy read-only; the receipt records the store identity and the verified row counts. Copying `store.db` alone, without its WAL, is not a backup.
- **`activate`** is the barrier. It requires the reviewed apply receipt to be the **final** one, a compatible-consumer attestation (installed entrypoints and versions, quiesced sessions, the approving operator — never session credentials) and a verified backup; the state flip, the epoch increment and the receipt commit in one transaction. Ordinary mutations work only afterwards, and every command checks epoch and state.
- **`retire`** moves the reviewed legacy registers and index sections into `{HARNESS_DIR}/archived/store-migration/<receipt-id>/` under a resumable per-item ledger, checking active identity, epoch, current paths and item state and preserving copy-before-remove ordering. Content-digest changes alone do not refuse retirement or replay. An unreviewed register path still refuses `store.legacy-write-detected`; resume uses current item/path/state facts and archive presence, not recorded-byte equality.

Execution migration apply/activate/retire requests no longer take `manifestHash`, activation no longer takes `coverageDigest`, and restore no longer takes `acceptLossDigest`. Generated manifest/coverage/loss digests remain historical diagnostics only. Use current verb help for the remaining actor, authorization, identity, path, state and numeric revision inputs; no digest-confirmation flag or replacement seal is required.

**Readiness guidance (not an action).** These are the readiness checks an operator performs *before* a live activation; running a documentation or source task performs none of them, and no stored flag stands in for them. Activation is an authorized ops act under a recorded, bounded authorization covering the affected installed CLI/plugin upgrades or reloads; credentials and unrelated global configuration stay out of scope. Ready means every compatible consumer is quiesced and then reloaded, upgraded or explicitly excluded, and old software is kept out by that operational barrier — a marker, a chmod or a missing register cannot stop an old binary. If a host cannot reload safely, **stop at that host's exact manual-restart step**, have the user restart, then re-check entrypoint, runtime, version and session identity read-only before activating; until activation succeeds the legacy authority remains in force, and a below-floor runtime or missing capability refuses actionably rather than falling back to JSON.

## Authorization

The protected writes are authorized, not merely gated:

- every coordinated document is written only through the transport that owns it — the scope's execution token plus an independently acquired caller identity on the active route, or the engine-generated session envelope for its own role and scope on the pre-activation route — re-checked inside the lock either way;
- **a reference and a token are not credentials a caller declares or forwards.** The active reference is a lookup into stored session rows; it grants nothing without the independently acquired caller the engine compares in its own transaction. Both the reference and every token stay with the coordinator or PM session: handing one to a leaf executor, or restating a token in a leaf's assignment, is a scope violation regardless of intent;
- **no resume stands in for recovery**, and no recovery stands in for a fresh bind: a stopped owner is replaced by the recovery verb that owns its authority, never by a copied id, a restarted launcher or a hand-edited record;
- the store face's own escape hatches are narrowed: an injected store cannot serve the coordinated surface, and the protected kinds refuse the direct faces entirely.
