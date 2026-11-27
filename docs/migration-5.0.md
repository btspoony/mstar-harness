# Migrating to Morning Star 5.0

This page is the operator path from a 4.8.x harness to the 5.0 collaboration authority: what breaks, the exact ladder, a worked cutover with synthetic receipts, how to bind and observe a provider-selected repository, how to rebind, how to back up and restore the split authority, and how to recover from the refusals these flows return. It states the behaviour this build implements; the durable contract is [collaboration-authority.md](specs/architecture/collaboration-authority.md) and the decision record is [the collaboration authority ADR](adr/implemented/architecture/2026-11-21-collaboration-state-authority.md).

Everything below is a command an operator runs. No step needs source knowledge, and no step requires editing a database by hand.

## What breaks in 5.0

**Collaboration state moves out of `{HARNESS_DIR}/store.db`.** Issues, findings, occurrences, transitions, relations, provenance, projects, project bindings, milestones, mirror ledgers, and portable catalog identity move to one user-level SQLite database per canonical repository at `<user home>/.mstar/repos/<host>/<owner>/<repo>/collaboration.db`. `{HARNESS_DIR}/store.db` keeps execution state, projections, host state, execution-side catalog pins, the composite reservations, and the cutover fence ledger.

**The move is a reviewed cutover, not an upgrade.** `store upgrade` advances the execution schema; it never moves collaboration rows. A combined store that still owns those rows refuses runtime collaboration traffic, `store init`, and a fresh `store upgrade` with `collaboration.cutover-required` until the three-verb cutover (`plan`, `apply`, `activate`) publishes the split lane.

**Every checkout must declare a mode.** `.mstarc` carries a `[collaboration]` section with `mode=local`, `mode=mirror`, or `mode=remote` on its own line; the header alone on that line leaves the mode unset. An origin-less repository also declares `repo_id`. A missing, unknown, or unusable mode refuses repository-scoped store verbs rather than guessing.

**The last released 4.8.x build loses repository issue access during the transition.** That build admits execution schemas up to version 19 and reads collaboration rows from `store.db`; after the fence the execution store is at a later schema and holds no collaboration rows, so the old build refuses the store with `store.schema-unsupported` and never opens the separate collaboration database. Issue, catalog, project, roadmap, milestone, and findings reads are unavailable there until a 5.0 build is installed. Plan the cutover as the step that ends 4.8.x access to this repository's collaboration data, and keep the CLI you will run next installed and reloaded before activation.

**Project milestones lose their calendar date.** The `target` column is replaced by `effort_sessions` — null ("unestimated") or a count of standard sessions of at least 1. An existing target becomes **unestimated**: it is not converted, because a date is not a measure of work, and it is not recoverable from the new column. A `local` or `mirror` lane carrying the old column reaches the new shape through `store upgrade` (rung 1); a `remote` cache is derived observation state and follows the reviewed `remote bind` ([Remote binding](#remote-binding-and-first-observation)). The milestone timeline orders by `ordinal`, and no surface states a calendar target for a project milestone.

**The roadmap domain is gone.** 4.x is the last line that can run `mstar roadmap export`: export the roadmap text before you upgrade, because the 5.0 `mstar store upgrade` removes the domain, and afterwards nothing reads or writes a roadmap. The document's facts have owners elsewhere — open work in the issue store, goals as milestone records, the per-iteration position in the compass — and a project's planning order now lives in the local, gitignored `{HARNESS_DIR}/planboard.md`, whose drift `mstar planboard check` reports. The board is never mirrored and never sent to a provider; it is local to the control checkout and lost with it. The 4.8.x build refuses the upgraded store, so the export has to happen on the old build.

**There is no automatic rollback and no dual-write window.** After publication the source's collaboration rows survive only in the verified pre-fence image the fence recorded. Reverting to the old layout is a manual operator decision made from that image, not a verb.

## Before you start

Every verb below that takes a target names it explicitly: pass an absolute `--harness <abs>` for this checkout's harness directory — the directory that holds `store.db`, normally `<repository>/.mstar`. It is the operation target, never discovered from the working directory. Two verbs in this page take no target: `mstar path resolve` discovers its scope from the directory it starts in, and `mstar schema --command <verb>` is a discovery verb that prints the shape of one document.

- Node.js >= 24.18.0 must be the runtime (the CLI needs native `node:sqlite`).
- Read access to the canonical Git origin is required: identity, mode, and — in `remote` mode — the protected selector ref `refs/heads/mstar-collaboration-authority` are resolved from the live remote.
- Stop every writer before the reviewed cutover: other CLI invocations, host sessions, hooks, dashboards, and any editor plugin that opens the store. The fence asserts that you did.
- Keep a recovery point of the combined store yourself. `mstar store backup` cannot do it yet: it publishes the verified pair only for an `ACTIVE` collaboration authority, and a combined store has none. Stop every handle first, then copy `{HARNESS_DIR}/store.db` with its `-wal` and `-shm` sidecars using a SQLite-safe copy (for example `sqlite3 {HARNESS_DIR}/store.db ".backup '<abs-copy>.db'"`, or `VACUUM INTO`). Keep that copy until the cutover is published. `activate` additionally retains its own verified pre-fence image; see [Backup and restore](#backup-and-restore).

Confirm the resolved scope before doing anything irreversible:

```bash
mstar path resolve
```

The `collaboration` block names the repository key, the mode, and the database path the checkout will use. `controlRoot` names the control checkout; linked worktrees share it.

## The ladder

Run the rungs in order and read each result before taking the next action. An accepted step is exit 0 with a receipt; a refusal is exit 1 with a code and a recovery line; a malformed or unreadable `--input`/`--attestation` document is usage (exit 2) and mutates nothing.

### Rung 1 — advance the execution schema

```bash
mstar store upgrade --harness <abs> --operator <name>
```

On a combined store this advances the execution schema to this build's version and then refuses `collaboration.cutover-required`, naming the cutover route. That refusal is the expected outcome, not a failure: the execution half must reach the cutover's source floor before `plan` can read it. The collaboration rows are untouched and still belong to `store.db`.

If a retired held claim requires the operator's full stop document, the upgrade refuses `store.upgrade-attestation-missing`; build that document with `mstar schema --command store.upgrade`, then rerun `mstar store upgrade --harness <abs> --operator <name> --attestation <abs-json>`.

If the combined store still holds an open mirror run, the advance refuses `store.upgrade-sync-run-open` before the schema passes the last version the released 4.8.x build admits — only that build settles a run in a combined store. Settle or take over the named run(s) with the 4.8.x build's `mstar issue-sync apply --harness <abs> --project <project-id> --results <file|->` against this same control root (`--take-run` with an empty result list for a dead holder), then rerun this rung. Nothing was modified.

A lane recorded at an older version than this build admits refuses `collaboration.upgrade-required` on an ordinary read, write, or `store init`; one written by a newer build refuses `store.schema-unsupported` instead. For a `local` or `mirror` lane the recovery is this same verb; for a `remote` lane it is the reviewed bind (see [Remote binding](#remote-binding-and-first-observation)), because a cache is derived observation state and is never upgraded in place. A newer lane has no recovery here but the matching newer build (see [Rebind and rebind refusal](#rebind-and-rebind-refusal)).

### Rung 2 — reviewed plan

```bash
mstar store collaboration plan --harness <abs> --out <abs-manifest>
```

The verb inspects the combined source read-only and writes a manifest: `version`, `manifestId` (a digest of the body), the frozen source generation (`storeId`, `epoch`, `schemaVersion`, `revision`, `catalogRevision`), `repoKey`, `mode`, `sourceDigest`, per-table row counts, and `blockers`. It creates nothing else. The same document is printed in the envelope as `data`, and with `--out` it is also written to the path named by `data.manifestFile`.

Exit 0 covers two different outcomes, so read the envelope before you trust a file. `--out` is create-only: an existing file is never overwritten, and the operation itself still succeeds. In that case the envelope carries the fresh manifest as `data` with `manifestFile: null` and `reportError.code: "store.report-not-published"`; an older manifest stays untouched at the path you named, and applying it would apply the old review. Use a fresh `--out` path for every plan, and before reviewing or applying, open the written file and confirm its `manifestId` equals the envelope's `data.manifestId`. When `manifestFile` is null, nothing was written — never fall back to a file that happens to be at the path. Tracked as open issue `I-001234`.

Review the manifest as the record of what will move. `blockers` is not advisory, and it is frozen into the manifest: an open mirror run or an unsettled catalog journal entry appears there, and `apply` and `activate` refuse that manifest with `collaboration.cutover-not-quiescent` before they read the source's current state — so clearing the blocker does not make the reviewed manifest usable. Settle each named blocker with its own verb, then run `mstar store collaboration plan --harness <abs> --out <abs-manifest-2>` again and review the new manifest; the recovered route is always a fresh plan.

A source below the cutover floor refuses `collaboration.cutover-required` and names rung 1; a source that already fenced refuses `collaboration.cutover-conflict` and points at its recorded pre-fence image, because there is nothing left to plan.

### Rung 3 — apply

```bash
mstar store collaboration apply --harness <abs> --manifest <abs-manifest>
```

`apply` re-derives the manifest digest (a hand-edited manifest is refused), re-checks the scope against `repoKey`/`mode`, refuses a non-empty blocker list, and stages a verified copy of the frozen rows into the canonical target under the source write lock. The receipt is `phase: "verified"`.

The target holds one staged slot per manifest. An identical staged receipt is reused; a target that already progressed past verification, an activation another operator holds, or a source whose rows changed since review refuses `collaboration.cutover-conflict` or `collaboration.stale-binding`. Nothing is restaged over it — finish or recover the activation that owns the target.

### Rung 4 — activate with the operator attestation

Activation is the only publication step, and it is where the operator asserts that the old writers are gone.

```bash
mstar store collaboration activate --harness <abs> --manifest <abs-manifest> \
  --operator <name> --attestation <abs-attestation>
```

The attestation is a JSON document bound to this activation, this build, this control root, and this exact source generation. Its accepted fields are closed: an undeclared field (a token, a session secret) refuses `store.attestation-invalid` instead of travelling into the receipt.

```json
{
  "version": 1,
  "attestedAt": "<RFC3339 instant>",
  "operator": { "actor": "<same value as --operator>", "authorizationRef": "<who approved this cutover>" },
  "consumers": [
    {
      "entryId": "<stable id for the coordinator entry>",
      "kind": "coordinator",
      "entrypoint": "<absolute path of the installed CLI entry that opens the store>",
      "runtime": "node",
      "runtimeVersion": "<the Node version that entry runs on>",
      "version": "<the build version performing this activation>",
      "current": true,
      "disposition": "reloaded"
    }
  ],
  "stoppedSessions": [
    { "sessionId": "<a session this source records>", "host": "<host name>", "state": "stopped" }
  ],
  "cutover": {
    "repoKey": "<manifest.repoKey>",
    "mode": "<manifest.mode, local or mirror>",
    "controlRoot": "<the absolute --harness directory>",
    "sourceStoreId": "<manifest.source.storeId>",
    "sourceEpoch": "<manifest.source.epoch>",
    "schemaVersion": "<manifest.source.schemaVersion>",
    "stoppedHandles": [
      { "kind": "process", "id": "<a process you stopped>" },
      { "kind": "host", "id": "<a host you stopped>" }
    ],
    "allHandlesStopped": true
  }
}
```

Field rules that the validator enforces, so a refused document is diagnosable without reading source:

- `version` is `1`; `attestedAt` parses as an instant; `operator.actor` equals `--operator`; `operator.authorizationRef` is nonblank.
- `consumers` is non-empty, exactly one entry has `current: true`, and that entry is `kind: "coordinator"`. `kind` is one of `cli`, `host-plugin`, `hook`, `coordinator`; `disposition` is one of `reloaded`, `upgraded`, `excluded:not-this-control-root`, `excluded:no-store-access`, `excluded:superseded-binary`; `runtime` must be `node`, and `runtimeVersion` must meet the workspace's declared `engines.node` floor.
- The current consumer's `version` must equal the version of the build running the verb.
- `stoppedSessions` entries use `state` `stopped` or `reloaded`, and each named session must exist in the source; a live source session the document does not stop refuses.
- `cutover` is required for this verb. Its `repoKey`, `mode`, `controlRoot`, `sourceStoreId`, `sourceEpoch`, and `schemaVersion` must match the manifest and the running checkout exactly. `stoppedHandles` must name at least one handle of kind `process`, `session`, `host`, or `consumer`, and `allHandlesStopped` must be the literal `true` — the fence has no OS-level handle inventory, so this sentence is the operator's own statement.

`activate` is two durable steps, not one transaction. It first takes or verifies the retained pre-fence image of the combined source, before any fence work begins. Then, in one source transaction under SQLite write exclusion, it re-proves the reviewed manifest and the source snapshot, advances the source schema if needed, writes the fence row in the execution store, and drops the moved collaboration tables. The target publication follows as its own step. A crash between them therefore leaves a durable intermediate state: the source is fenced and no target is active. The receipt moves `verified` → `source-fenced` → `active`.

A crash before the fence leaves a restageable attempt. A crash after a committed fence is finished by re-running the same `activate`, which reuses the persisted fence and commits only the missing publication. There is no rollback to infer from the receipt: once the fence commits, the source no longer owns the collaboration rows, and the verified pre-fence image is the only copy of them. `collaboration.cutover-unconfirmed` means the fence outcome itself could not be proven — inspect the persisted fence record, the retained image, and the source's schema and tables; never retry blindly and never treat the source as unchanged.

An attestation that is structurally unusable — wrong version, missing field, contradictory current consumers, a cutover block naming another root or generation, or a source session left live that the document does not stop — refuses `store.attestation-invalid` before a byte is written. An attestation that is well-formed but attests an incomplete installation barrier — no consumer, no current coordinator, a consumer below the runtime floor, or a disposition other than `reloaded`/`upgraded`/an explicit exclusion — refuses `store.activation-blocked` and leaves the combined source as the sole authority.

### Rung 5 — the split authority

After a successful activation the checkout is bound: `{HARNESS_DIR}/collaboration-binding.json` records the repository key, mode, store id, epoch, and `active` state. From then on:

- execution state is `{HARNESS_DIR}/store.db`;
- collaboration state is the user-level `collaboration.db` printed by `mstar path resolve`;
- the source's collaboration rows exist only in the pre-fence image under the harness `archived/` tree, and no runtime path reads them.

A fresh clone or a replacement checkout may read the resolved authority before it is bound, but every write refuses until it is. Bind it deliberately:

```bash
mstar store collaboration adopt --harness <abs> --expect-store <store-id>
```

`adopt` verifies the canonical scope, the lane metadata, and the recorded publication lineage for that exact live store and epoch, writes nothing but this checkout's binding, is idempotent for the same binding, and refuses a staged authority, a foreign checkout, a missing or ambiguous lineage, or a claim naming another generation. `store init` never adopts an active authority — it initializes execution only.

A bound checkout admits only the generation it recorded: a different repository key, mode, store id, or epoch refuses `collaboration.stale-binding` for reads and writes alike, so a replacement generation at the same key and mode is adopted deliberately rather than read by drift. Editing `.mstarc` or the origin never re-points a bound checkout.

## A worked cutover

The receipts below follow the shape of this repository's own cutover, with every identifier, digest and timestamp replaced by a synthetic placeholder of the same form and the row counts made illustrative. The real receipts are the PM acceptance record for that cutover and are not tracked here. They are not a second cutover and not a template to replay: each document is what the corresponding rung returned, so you can compare your own run against a known shape.

**Rung 1 refused with `collaboration.cutover-required` after advancing the execution schema.** That refusal is the expected progress marker, not a failure: the collaboration rows still belonged to `store.db`, and no cutover verb had run yet.

**The first plan was blocked, and the recovery was a fresh plan.** The first manifest named an unsettled catalog journal entry in `blockers` (`collaboration.cutover-not-quiescent`). Settling that blocker did not make the manifest usable, because `blockers` is frozen into the reviewed document; the next command was a new `plan` to a new `--out` path, not a re-run of `apply`. The reviewed result was:

```json
{
  "version": 1,
  "manifestId": "1f2e3d4c5b6a79880a1b2c3d4e5f6071",
  "source": {
    "storeId": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    "epoch": 2,
    "schemaVersion": 21,
    "revision": 1204,
    "catalogRevision": 57
  },
  "repoKey": "github.com/btspoony/mstar-harness",
  "mode": "local",
  "sourceDigest": "5c0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
  "counts": { "issues": 96, "occurrences": 128, "relations": 4, "project_milestones": 2, "project_roadmaps": 1 },
  "blockers": []
}
```

**`apply` returned `phase: "verified"`**, naming the same manifest and a target generation that did not exist before this cutover:

```json
{
  "manifestId": "1f2e3d4c5b6a79880a1b2c3d4e5f6071",
  "phase": "verified",
  "source": { "storeId": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "epoch": 2, "schemaVersion": 21, "revision": 1204, "catalogRevision": 57 },
  "target": { "repoKey": "github.com/btspoony/mstar-harness", "mode": "local", "storeId": "4d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a", "epoch": 1 },
  "verifiedAt": "2026-01-15T10:00:00.000Z",
  "replayed": false
}
```

**`activate` then returned `phase: "active"`** for the same manifest and target. `fencedAt` is 42 seconds after `verifiedAt`, and `activatedAt` follows `fencedAt` by a fraction of a second — the two durable steps, in order, on one run:

```json
{
  "manifestId": "1f2e3d4c5b6a79880a1b2c3d4e5f6071",
  "phase": "active",
  "source": { "storeId": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "epoch": 2, "schemaVersion": 21, "revision": 1204, "catalogRevision": 57 },
  "target": { "repoKey": "github.com/btspoony/mstar-harness", "mode": "local", "storeId": "4d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a", "epoch": 1 },
  "verifiedAt": "2026-01-15T10:00:00.000Z",
  "fencedAt": "2026-01-15T10:00:42.185Z",
  "activatedAt": "2026-01-15T10:00:42.246Z",
  "replayed": false
}
```

Read the three documents as one story. The `manifestId` is identical in all three, so the document that was reviewed is the one that was staged and published. The source generation (`storeId`, `epoch`, `schemaVersion`, `revision`, `catalogRevision`) is identical in all three, so nothing moved underneath the fence. The target is one new store id at epoch 1, created by this cutover. `replayed: false` on both receipts records that each half wrote its own record; `replayed: true` means the verb reused the record already held for that same manifest digest — a resumed activation, or a repeated `apply` of an identical manifest — and the reused `verifiedAt` is the original one, not the time of the second run.

## Remote binding and first observation

`remote` mode selects the provider project set named by the protected Git selector, and this checkout's database becomes a verified observation cache plus an intent ledger — never authority. This section covers binding during a migration; the day-to-day procedure, the outbox verbs, and the refusal map belong to the remote collaboration guidance ([skills/mstar-remote-collaboration/SKILL.md](../skills/mstar-remote-collaboration/SKILL.md), with `references/host-lane.md` § Refusal recovery).

Declare it in the control checkout's `.mstarc`:

```ini
[collaboration]
mode=remote
```

Then:

```bash
mstar store collaboration remote status --harness <abs>
```

`status` reports the checked selector commit, generation, and phase, this checkout's binding state (`bound` or `unbound`), and per-project scope, revision, completeness, `asOf`, and freshness. It creates and changes nothing and prints no provider content, but it is not read-free: it checks the live selector ref and reads this checkout's binding and cache metadata, and fetches nothing from the provider. A selector that cannot be checked at the origin refuses `remote.selector-unavailable` — a failed lookup is never read as absence. Restoring read access is the recovery for an unreadable origin, not for an unpublished one: if the origin carries no selector ref at all, creating or advancing `refs/heads/mstar-collaboration-authority` is an authorized host action outside this migration, and `bind` refuses until a readable selector exists.

Verify each selected project through the host's approved Linear tools — exact workspace, team, project, and the required capabilities — then submit the reviewed batch:

```bash
mstar store collaboration remote bind --harness <abs> --input <abs-json>
```

The document shape is published by `mstar schema --command store.collaboration.remote.bind`; read `data.descriptor.payloadSchemas.inputDocument` rather than copying a field list. In outline the batch names `version`, the checked `selectorCommit` and `generation`, and a `checks` array with exactly one entry per selected project, each carrying the exact provider tuple, journal anchor, `checkedAt`, and a `verified` outcome with the reader/writer identity and the five capabilities (`fullRead`, `appendOnly`, `exactLookup`, `fieldFidelity`, `privateAudience`). A negative outcome is one of `unavailable`, `scope-mismatch`, `denied`, `revoked`, `unsafe-fidelity` and refuses `remote.unavailable`, `remote.scope-mismatch`, `remote.denied`, `remote.revoked`, or `remote.unsafe-fidelity`.

`bind` accepts a check only inside the freshness window: `checkedAt` must be within 60 seconds of the process and never in the future, otherwise `collaboration.observation-stale`. An accepted bind creates the private cache, or advances an existing one, and publishes the v3 binding.

**A pre-current remote cache is replaced by the bind, never upgraded in place.** The replacement runs only when the old cache holds no unsettled outbox intent — every `remote_outbox` row is `confirmed` or `abandoned`. A cache that holds one is refused with `remote.effect-pending` and left unchanged. The refusal names the cache, the count of unsettled intents, and one line per unsettled state — that state's oldest operation id plus the verbs it needs — and instructs: `Settle every state listed below, then rerun the same bind.` A `conflict` row is settled by preparing its reviewed replacement with `outbox-resolve`, then dispatching that repair with `outbox-dispatch` and recording its confirming receipt with `outbox-receipt`; an `unconfirmed` row is read with `outbox-show` and that attempt's evidence recorded with `outbox-receipt` or `outbox-reconcile`; an `enqueued` row is dispatched with `outbox-dispatch`, or abandoned with `outbox-abandon` when it is proven unsent.

Those outbox verbs take the one write lane that still admits a below-current cache, restricted to the outbox surface, so the settlement runs on the cache the refusal names — where the intent's attempt id, frozen request and receipts are recorded. Only two rows need the rebuild instead: a row whose recorded state contradicts its recorded evidence in a way the outbox verbs cannot repair in place, and a row whose recorded `resolvedBy` link is damaged. A confirmed repair that only lacks its recorded receipt is settled in place with `outbox-receipt`, not rebuilt. That rebuild is the ordinary bootstrap: stop every checkout bound to the cache, settle every other state the refusal lists first, move the cache file aside under a retained name instead of deleting it, then bootstrap again. The replacement path's own evidence is narrower: it preserves the predecessor for the replacement window as a hard link `.replaced-<pid>-<uuid>.db` beside it, so an interrupted replacement never loses it; that link is removed once the successor is published, and no durable copy of the predecessor is promised.

**An observe document whose milestones still carry `target` is refused.** The milestone rows ride the observation's `snapshot.project.milestones`, never the bind: a bind's document is the check batch (`version`, `selectorCommit`, `generation`, `checks`) and carries no project snapshot. Each milestone row must carry `effortSessions` — null or an integer of at least 1. A row that still carries `target` refuses `remote.input-invalid` at `submission.snapshot.project.milestones[i].target` (the path prefix follows the verb) with the fixed text: `"target" is retired; submit "effortSessions" as null or an integer of at least 1 (a count of standard sessions). Nothing was written.` Resubmit the observation with `effortSessions`; the document shapes stay published by `mstar schema --command store.collaboration.remote.observe` and `mstar schema --command store.collaboration.remote.bind`.

Observation follows the bind, one project per submission, using the current revision from `remote status --project <project-id>`:

```bash
mstar store collaboration remote observe --harness <abs> --input <abs-json>
```

The document shape is `mstar schema --command store.collaboration.remote.observe`; it names `version`, `selectorCommit`, `generation`, one `check`, `expectRevision`, and the project `snapshot`. Traverse the bound scope completely, following the provider's pagination. A verified check without a snapshot refuses `collaboration.observation-incomplete`; a snapshot the portable representation cannot hold refuses `remote.unsafe-fidelity` and durably marks the addressed cache unavailable instead of serving stale bytes. Observation never adopts an issue.

After the first complete observation, required views, counts, rollups, and gates answer from the admitted snapshots or refuse `remote.unavailable`, `collaboration.observation-incomplete`, or `collaboration.observation-stale`. They never fall back to local rows or answer zero for an unobserved project. An unmarked provider issue is visible as `kind: "provider-only"` with `issueRef: null` and is never counted, given a disposition, closed, or adopted.

Adoption is explicit and by provider identity:

```bash
mstar store collaboration remote adopt-issue --harness <abs> --project <local-project-id> \
  --issue <provider-issue-uuid> --operation <uuid> --input <abs-json>
```

Use the exact observed unmarked provider UUID, never a display id or title. Exit 0 returns `state: "enqueued"` — one durable intent, not an adoption and not provider success. An already marked issue, or a reference already bound to another provider issue, refuses `remote.scope-mismatch`.

Remote writes are durable intents, and the CLI performs no provider call. The outbox verbs (`outbox-pending`, `outbox-show`, `outbox-dispatch`, `outbox-receipt`, `outbox-reconcile`, `outbox-resolve`, `outbox-abandon`), their flags, and their state machine are owned elsewhere: the [remote collaboration guidance](../skills/mstar-remote-collaboration/SKILL.md) for the procedure and `mstar schema --command store.collaboration.remote.<verb>` for each input document. Read the shape there rather than a copy here. Two qualifications matter during a migration:

- **No durable intent, no write.** A write is reported only after its intent is committed to the outbox. When the intent cannot be persisted — no bound lane, or a cache whose outbox tables are absent or incomplete — the verb refuses (`collaboration.stale-binding` for the unbound lane, `collaboration.unreadable` for the damaged cache), creates no table and no intent, and issues no send permit, so nothing reaches the provider. Repair the scope and the binding (`mstar path resolve`, then `remote bind` or `adopt`) and submit the write again; never retry the same write into a different lane.
- **`outbox-show` discloses metadata once access is stale.** It returns the frozen request only while the addressed project's verified access check is current; afterwards it reports the intent with `disclosure: "metadata"`. A withheld request is therefore not evidence that the intent was lost — re-verify and re-observe that project before concluding anything about the attempt.

Ordinary business verbs in a remote checkout freeze their normalized event and refuse `remote.effect-pending` with the operation id, state, and confirmed components; a composite reports `collaboration.operation-partial` while its provider half is unconfirmed. Replaying the identical business verb under the same operation id returns its recorded result once the intent is `confirmed`. `issue-sync` refuses a remote checkout.

### Switching local or mirror to remote

A lane the repository already published as `local` or `mirror` is retired only by the reviewed transition: the checked *active* selector must name that generation as its `previous` and carry a `cutover` with `sourceFenced: true` and no pending operations. `remote bind` then proves the canonical lane is exactly the checkout's recorded predecessor, renames it to `collaboration.retired-<storeId>-<epoch>.db` beside itself, and only after that creates the cache and publishes the v3 binding. An unfenced selector refuses `collaboration.stale-binding` and retires nothing.

## Rebind and rebind refusal

A rebind continues the cache this checkout is bound to. The checked selector must name the recorded generation (or a committed newer cache generation) as its `previous`, with a fenced, pending-free transition; the batch must name the checked commit and generation and carry one current positive check per selected project.

These are the refusal shapes, all `collaboration.stale-binding`, and each one names the fact that disagreed:

- the batch names a selector commit or generation other than the checked one;
- the checked selector generation is `draining`, not `active` — reconcile the transition first;
- the checkout records a newer generation than the batch names (a bind never downgrades a generation);
- the same generation is claimed by a different selector commit;
- the cache is absent while the checkout records an earlier generation — a missing cache never substitutes for lineage, so the selector must name the record with a fenced transition before anything is created;
- the lane under the canonical path is another store id or epoch — a bind never retires another generation;
- a `local`/`mirror` predecessor lane exists but the selector does not supersede it with a fenced, pending-free cutover.

A lane recorded at a version **older** than this build admits refuses `collaboration.upgrade-required` in every mode: an older `local`/`mirror` predecessor is upgraded with `store upgrade`, while an older remote cache is never upgraded in place — the reviewed `bind` replaces a pre-current cache. The newer direction is different: a store or cache written by a build newer than this one refuses `store.schema-unsupported`, and the reviewed `bind` does not replace it. The only recovery there is the matching newer build; no verb on this page migrates a newer lane down.

## Backup and restore

**Before the cutover there is no pair to take.** `mstar store backup` proves it is copying one stable generation of both domains, and it refuses (`collaboration.backup-incomplete`) unless the collaboration authority is `ACTIVE` — a combined store is not. Two supported things are available instead:

- your own SQLite-safe copy of the combined `{HARNESS_DIR}/store.db` (with its `-wal`/`-shm` sidecars), taken with every handle stopped, as described in [Before you start](#before-you-start);
- the image `activate` retains for you: before it fences, it takes or verifies a pre-fence image of the combined source under `{HARNESS_DIR}/archived/store-migration/backups/collaboration-cutover-<manifestId>.db`, verifies it against the frozen manifest's generation and rows, and records it on the fence. After the fence, the moved collaboration rows survive only in that image.

**After activation, a repository backup is a verified pair**, never one image sold as a backup:

```bash
mstar store backup --harness <abs> --out <abs-manifest>
```

The verb refuses (`collaboration.backup-incomplete`) unless the collaboration authority is `active`, no composite reservation is prepared in the execution root, and no effect in the lane is unacknowledged or mid-activation. It copies both domains with their own SQLite snapshots into private files beside the manifest, re-opens and verifies each against its own bytes and row counts, proves each generation held still across its own snapshot window, and publishes the manifest last. `--out` must name a new path; image names without a manifest are an interrupted attempt and are never blessed as a pair.

Restore is create-only and addresses an absent target:

```bash
mstar store collaboration restore --harness <abs> --backup <abs-manifest> \
  --operator <name> --attestation <abs-attestation>
```

The supplied manifest is the pair's authority: the receipt must equal it, each image must still describe the generation the manifest records, the same causal and quiescence boundary must hold, and the addressed checkout must be able to own the authority. The verb stages a private copy, advances an image older than this build on that copy only, bumps the restored epoch, records the restore receipt in the same transaction, and publishes create-only. An existing live, staged, corrupt, or foreign authority refuses `collaboration.cutover-conflict` — it is never overwritten, quarantined, or deleted. When a previous attempt of the same restore already published, that generation is repaired and served instead of reported as a conflict.

A `remote` checkout cannot restore provider authority from a local image: the verb refuses `collaboration.mode-unavailable` and points at the reviewed bind and a complete observation. `mstar store execution export`, `restore-preview`, and `restore` remain explicitly execution-only and never touch collaboration.

The attestation for a restore is the same document without the `cutover` block: `version`, `attestedAt`, `operator.actor` matching `--operator`, at least one consumer with exactly one `current` coordinator, and `stoppedSessions`.

## Recovering from each refusal class

Exit 1 is a domain refusal with a code, a message naming the disagreed fact, and a `Recovery:` line. Exit 2 is usage: the document or flag was malformed and nothing was mutated. The rows below cover the refusals this page's own flows return, not every code the build can emit: the host lane's full map is `references/host-lane.md` § Refusal recovery in the [remote collaboration guidance](../skills/mstar-remote-collaboration/SKILL.md), and the tracked contract is the [collaboration authority spec](specs/architecture/collaboration-authority.md).

| Code | Meaning | Recovery |
| --- | --- | --- |
| `collaboration.repo-identity-unresolved` | Git could not derive the canonical identity (unreadable Git, an unsafe or non-portable origin, disagreeing fetch origins, or a bad `repo_id`). | Fix the origin or the `[collaboration] repo_id` in `.mstarc`, then re-resolve with `mstar path resolve`. |
| `collaboration.config-unreadable` | `.mstarc` is a symlink, a directory, non-regular, unreadable, or has an unusable parent. | Make it a readable regular file, then rerun the same verb. |
| `collaboration.mode-required` / `collaboration.mode-invalid` | No mode, an empty mode, or an unsupported mode. | Write `mode=local`, `mode=mirror`, or `mode=remote` on its own line in `[collaboration]`. |
| `collaboration.mode-unavailable` | The verb is a local-domain entry in a `remote` checkout, or a restore in `remote` mode. | Use the remote boundary (`remote status|bind|observe`) or the reviewed bind; local rows never stand in for provider authority. |
| `collaboration.not-initialized` | No collaboration database at the resolved path. | `remote`: complete a fresh access check and observation for the selected scope, then the reviewed `remote bind`; `store init` and `store upgrade` never repair or create a remote cache. `local`/`mirror`: `mstar store init --harness <abs>` for a fresh scope, `mstar store upgrade --harness <abs> --operator <name>` for file-era state, or `store collaboration restore` from a verified pair. |
| `collaboration.not-active` | The lane is `staged`, not published. | `remote`: recovery carries current verification, never a stale document — re-verify the scope (a fresh access check per selected project, and a fresh complete observation where the scope or revision moved) and run the reviewed `remote bind` with it, which publishes a fresh staged lane and resumes its own interrupted one; where the scope was never published, run the reviewed `store collaboration apply` then `activate` sequence for that manifest, then `bind`. `store init` never publishes an authority. `local`/`mirror`: run `store collaboration activate` for its reviewed activation; adoption also refuses a staged authority. |
| `collaboration.upgrade-required` | The lane is older than this build admits. | `mstar store upgrade --operator <name>` for a local/mirror lane; the reviewed `remote bind` for a pre-current remote cache. |
| `collaboration.unreadable` | The file is present but invalid, corrupt, inaccessible, or another store's. | Re-resolve with `mstar path resolve`; repair access or restore a verified pair into an absent target rather than editing bytes. |
| `collaboration.stale-binding` | The recorded binding, the lane metadata, or the checked selector disagrees with the resolved scope. | Re-resolve, correct the origin or mode, and either `store collaboration adopt --expect-store <store-id>` or complete the reviewed `remote bind`. A bound checkout is never retargeted by editing its mode. |
| `store.schema-unsupported` | The store or cache's schema is newer than this build reads — the normal state for a released 4.8.x build after the fence, and for any lane a newer build wrote. | Install the build that wrote it and rerun; nothing was modified, and a reviewed `bind` never replaces a newer cache. |
| `store.upgrade-attestation-missing` | A retired held claim needs an explicit stop document. | Build it with `mstar schema --command store.upgrade` and rerun with `--attestation`. |
| `store.upgrade-sync-run-open` | The advance would pass the last schema the released 4.8.x build admits while the combined store still holds an open mirror run, and only that build settles a run there. | Settle or take over the named run(s) with the 4.8.x build's `mstar issue-sync apply --harness <abs> --project <project-id> --results <file|->` naming this same control root (`--take-run` with an empty result list for a dead holder), confirm the store holds no `sync_runs` row, then retry `mstar store upgrade --harness <abs> --operator <name>`. Nothing was modified; after this build's advance neither build can settle the run. |
| `store.report-not-published` | The operation completed, but the `--out` report was not published — most often because a file already exists at that path, since reports are create-only. | The operation's own result stands; nothing was lost. Re-run only to obtain a file, with a fresh `--out` path, and check that `manifestFile`/`receiptFile` is non-null. Never apply a manifest that was already sitting at the path. |
| `store.runtime-unsupported` | The running runtime does not provide native `node:sqlite` (Node.js below 24.18.0, or another runtime). | Rerun with Node.js >= 24.18.0 on `PATH`; retrying on the same runtime reproduces the refusal, and nothing was modified. |
| `store.attestation-invalid` | The attestation document cannot be used: wrong version, missing or ill-typed field, undeclared field, two current consumers, a non-coordinator current consumer, a build/version or cutover-block disagreement, or a live source session the document does not stop. | Fix the document as named; no byte was written. Build through `mstar schema --command store.collaboration.activate`. |
| `store.activation-blocked` | The document is well-formed but the barrier is incomplete: no attested consumer, no current coordinator, a consumer below the Node floor, a consumer whose disposition is not `reloaded`/`upgraded`/an explicit exclusion, or a session the document itself declares as running or queued. | Stop and reload the named consumers, and declare each stopped session as `stopped` or `reloaded`. An omitted live session is a document error (`store.attestation-invalid`), not this code. The previous authority remains sole authority. |
| `collaboration.cutover-required` | A combined store still owns collaboration rows. | Rung 1 (`store upgrade`) then `plan`, `apply`, `activate`. |
| `collaboration.cutover-not-quiescent` | Open mirror work or an unsettled catalog journal entry is frozen into the reviewed manifest. | Settle each named blocker with its own verb, then `mstar store collaboration plan` again and review the new manifest — `apply`/`activate` refuse the old one before reading current state. |
| `collaboration.cutover-conflict` | Another activation owns the target, the manifest was already fenced or restaged, a manifest is not this build's plan output, or the local cutover lock is held or malformed. | Preserve both sides; finish or recover the owning activation, confirm no cutover process runs on the host named by the lock, or re-plan with a correct manifest. |
| `collaboration.cutover-unconfirmed` | The fence transaction did not complete cleanly or its rollback could not be proven. | Do not retry blindly and do not treat the source as unchanged: inspect the persisted fence record, the retained pre-fence image, and the source's schema and tables. |
| `collaboration.operation-partial` | A composite operation's execution half or provider half is outstanding. | Replay the same operation id to finish the outstanding delta; never start a second id for the same work. |
| `collaboration.acknowledgement-pending` (warning) | The effect committed but its acknowledgement never landed. | Replay the same operation id to repair the acknowledgement only. |
| `collaboration.observation-incomplete` | The admitted snapshot does not cover the required scope, or a verified check carried no snapshot. | Complete the provider traversal and re-observe. |
| `collaboration.observation-stale` | The access check or traversal start is outside the 60-second window, or dated in the future. | Recheck access with the host and re-observe from a fresh traversal. |
| `collaboration.backup-incomplete` | The pair is not one verified snapshot window: a manifest exists at `--out`, images lack a pair claim, a generation moved during the copy, the authority is not active, or the supplied receipt is not the manifest. | Settle open work, confirm the collaboration authority is `ACTIVE`, then take a new pair with `store backup --out` naming a new path. A combined (pre-cutover) store has no pair to take — use the recovery point described in [Backup and restore](#backup-and-restore). |
| `remote.selector-unavailable` | The origin could not be asked, or published no readable selector. | Restore Git access to the canonical origin and to the protected selector ref, then re-check `remote status` and continue with `bind`/`observe`. Read access alone does not create a ref the origin never published; that requires the authorized selector publication described above. |
| `remote.unavailable` | No usable admitted observation for the required scope. | Establish the reviewed bind if missing, traverse the bound scope, and submit `remote observe`. |
| `remote.scope-mismatch` | A verified scope disagrees with the binding, a check is missing or duplicated, or an adoption targets a marked issue or an already-bound reference. | Correct the scope, or use the exact observed unmarked identity and an unbound reference; never title-match. |
| `remote.denied` / `remote.revoked` | A negative host check reports denied or revoked access. | Restore authorized access, re-verify the selected scope, and re-observe. |
| `remote.input-invalid` | The submitted document is structurally wrong for that verb. | Read the shape from `mstar schema --command <that verb>` and resubmit to the same verb; a refused document records nothing. |
| `remote.unsafe-fidelity` | The provider cannot preserve the meaning this build must keep. | Refuse remote mode for that project; never drop fields. The addressed cache is invalidated rather than served. |
| `remote.effect-pending` | An ordinary business write froze an intent without a confirmed effect; the same code also refuses a bind whose cache holds unsettled outbox intent. | For a business write: dispatch and settle the receipt, then replay the identical operation under the same id only after confirmation. For a bind: settle every state the refusal lists (the outbox verbs above) and rerun the same bind — see the bind refusal paragraph above. |
| `remote.intent-not-found` | Unknown operation id. | Read `outbox-pending` and address the id it names; never invent one. |
| `remote.dispatch-refused` | The intent is not dispatchable in its recorded state. | Read it with `outbox-show`; supply a reviewed resolution's fork observation, reconcile an uncertain send, or re-observe a moved base. Never reuse a dispatched id. |
| `remote.operation-conflict` | The operation id already holds a different request, kind, or generation. | Inspect with `outbox-show`; for a conflicted fork prepare the replacement with `outbox-resolve`. |
| `remote.effect-abandoned` | The provider intent was abandoned, so a composite can never complete as admitted. | The reservation is declined, not paused: confirmed components are durable and never re-sent. Correct the named cause and reissue the write under a NEW operation id; if some components confirmed, the new request carries only the entries that did not settle. |
| `remote.effect-mismatch` | The confirmed provider effect does not carry what the frozen request asked for — the reviewed catalog rows and links for a registration, the disposition for an issue closure — so no execution binding or plan acknowledgement was recorded from it. | `outbox-show` the settled replacement. A registration checks only the reviewed rows and links: each reviewed row must carry the same portable content, and each reviewed relation exactly one edge, so settle only the reviewed rows/links the settled journal publishes differently or omits — re-observing and reissuing alone leaves the registration blocked by `catalog.duplicate`. A closure is checked on its disposition: an open settlement is retried with the issue's current revision, while a terminal one stands and the issue must be deliberately reopened before a new closure is admissible. Then re-observe the project and reissue the same verb under a NEW operation id against that current revision; the settled effect is never re-sent. |

## Limits you must plan around

**Cross-authority project moves and relations are not in 5.0.** Moving an issue between projects whose authorities differ — the staged move, interruption recovery before membership switches, and `IssueRef`/history preservation across authorities — is unproven and not implemented. `moveIssue` refuses a `remote` checkout with `collaboration.mode-unavailable`, and no verb stages or completes a cross-authority move, so nothing on this page depends on one. Cross-authority relation resolution is likewise absent: the ADR requires that a relation whose target cannot be resolved across authorities stay visible as unresolved rather than absent, but that behaviour is a requirement for the deferred iteration, not an observable you can rely on in this build. Only the refusal boundary is asserted — the observed issue, selector, and binding are unchanged and no intent is recorded — and this is tracked as open issue `I-001235`.

**Live provider behaviour is unverified.** The remote lane, the private cache, the outbox, and the sandbox handoff are proven against a controlled host fixture — two sandboxes with separate `HOME` and workspace, a local bare Git origin, and in-process provider state. Live Linear permissions, field-fidelity and privacy limits, exact event round-tripping, Git server protection of the selector ref, and operational sender exclusion remain unverified until a separately authorized release or operational acceptance. Do not treat this page as a claim about a specific workspace.

**Durability is per mode, and only `remote` is rebuildable from the provider.** In `local` and `mirror` the user-level `collaboration.db` is the authority: it is untracked, machine-local, and not carried by a clone, so a provider record or a Git commit can never rebuild it. Its durability is the `store backup` pair you keep and a restore into an absent target; if that database and every pair copy are lost, the authority is gone, and `mirror` delivery does not change that — a confirmed mirror delivery is a separate outcome from the local commit, not a second copy of it. In `remote` the authority is the bound provider project, and durability is exactly two surviving copies: the provider's confirmed records and pushed Git. A remote checkout's private cache is a rebuildable observation, never a backup, and the recovery sequence is the ordinary bootstrap — clone the tracked branch, `remote status`, verified `remote bind`, `store init` for a fresh execution lane, then a complete `observe`. If the provider, the pushed branch, and the local `HOME` are all lost, the remote collaboration picture is unrecoverable, and the host handoff reports that as `remote.handoff-unavailable` — a host report, not a CLI exit — naming the `missing` and `recovered` components (`provider`, `git`) and `recoverable` as `true` (a surviving copy is proven), `false` (its copies are proven gone), or `null` (neither proven nor disproven). A visible native issue without its MStar marker is not the confirmed record, and a Git result another ref still reaches is not that branch's handoff.

**This page does not describe a release.** It documents migration behaviour implemented on the 5.0 line. Release preparation, version bumps, changelog assembly, ADR promotion, milestone delivery, and publication are separate, later actions; nothing here promises them.
