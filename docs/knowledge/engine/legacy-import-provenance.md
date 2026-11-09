# Legacy execution import: proven replay versus an unproven ID collision

**Kind**: Knowledge (Bug track) · **Status**: implemented · **Feeds**: anyone maintaining `store upgrade` / legacy execution import

## Symptom that leads here

On a control root whose recognized legacy execution sources were **already imported**, a second `mstar store upgrade --operator <name>` refuses:

```
[execution.migration-conflict] … the retained legacy source(s) for "<every workflow id>" already exist(s) in the
native execution authority; an upgrade never overwrites, deletes or silently omits an existing native workflow.
Rerun store upgrade with `--ack-skip-workflow <all of those ids>` …
```

Nothing about the workspace changed between the two runs, yet the operator must acknowledge every already-imported id as an import **loss**, so the receipt records losses for imports that in fact completed.

## Why the designed replay did not fire

The importer has exactly one replay path: a retained **operation receipt** matched by the caller's `operationId` plus an identical request hash. The command surface mints that id per invocation (`randomUUID()`), and it is never reported back to the caller — so "genuine same-operation replay" is **unreachable through the public entry**. Every repeat upgrade therefore reaches the collision decision as a first attempt.

Do not conclude from this that collisions should stop refusing. The settled policy is narrower: *a same-ID match is a replay only when stored provenance proves the same source; otherwise the collision refuses explicitly with a named recovery, and proven replays are reported in dispositions.*

## The rule that decides

```
colliding id  →  listed by a retained import receipt for THIS source digest?
                 yes → proven replay: report it in dispositions, import nothing, require no acknowledgement
                 no  → unchanged refusal, its `--ack-skip-workflow <id>` recovery, and its usage guard
```

Provenance is the store's own durable record that a previous operation imported exactly these bytes:

| Field in the retained receipt | Meaning |
|---|---|
| `sourceDigest` | digest over the legacy source bytes that run consumed |
| `importedIds` | the workflow ids that run committed from those bytes |

Candidate receipts are shape-validated as a unit (object, `sourceDigest` **equal** to the current digest, `importedIds` an array whose every member is a non-empty string). A malformed array must reject the whole candidate — salvaging members per element lets a damaged receipt prove an import.

## Where the provenance lives, and why that matters

- **`store_operations` is the durable receipt/ledger the import writes into.** Its rows are not pruned by workflow cleanup: the pruned table is `execution_operations`, whose retention is workflow-scoped (see *Execution receipts lifecycle* alongside this document).
- Provenance is therefore already recorded for any store that imported with a build that persisted `sourceDigest` — no re-import, no backfill, and no second ledger is needed to answer a repeat upgrade.
- The report shape mirrors the DSH host-state importer's existing vocabulary: a run that commits rows is `upgraded`; a run that commits none but proves at least one replay is `nothing-to-import`.

## Provenance must cover every input that shapes the rows, not just the bytes

A receipt's `sourceDigest` covers the legacy **bytes** a run consumed. That is not the whole import input: caller input can change what the import converts and writes even when the bytes are identical. For the v1 route the `--delivery` declarations do exactly that — the declared delivery kind and branch fields are written onto the lifted snapshot — and a compass acknowledgement changes which compasses are scanned, hence which lifecycles and standalone rows the conversion produces.

So the retained receipt also records an **input digest** over the normalized conversion-shaping input (declarations sorted by lift id with a fixed key order, plus sorted compass acknowledgements), and the proof rule is:

```
current run carries NO conversion-shaping input
   → the byte digest alone proves (this is what keeps receipts written before the field existed usable)
current run DOES carry such input
   → the receipt must record the SAME input digest; otherwise the id stays an unproven collision
```

Without that second branch, rerunning unchanged bytes with a **different valid declaration** returns `nothing-to-import` while the native row keeps the earlier, immutable delivery configuration: the caller's own instruction is silently discarded. Inputs that do **not** shape rows — workflow acknowledgements (they only dispose a refusal), host-state acknowledgements (a later phase), the operator name, the operation id, the control root — deliberately stay out of the digest; an id that shapes nothing must not be able to invalidate a legitimate proof.

**Audit before assuming.** Enumerating "which inputs can change a converted or written row?" is part of any change here; an input covered by neither digest is an unproven input, not a safe omission.

## State only what the evidence proves

The refusal for an input-unproven collision may say that the retained receipt **does not prove** the earlier import consumed this input, and that this run therefore does not treat the id as a proven replay and leaves the native rows unchanged. It must **not** say what the earlier import did or did not do ("the row was not shaped by it"): a receipt written before the input field existed proves nothing either way, and may perfectly well describe an import that used the very same input. Absence of proof is not proof of absence — in a user-facing refusal this is a correctness claim, not a style choice.

## Alternatives that were considered and rejected (do not re-derive)

- **"Every recognized source collides, so skip them all."** A matching id is not proof of a prior import; an independently registered native workflow can share an id. This silently suppresses an import and re-opens a resolved defect. The protective rule exists precisely because collisions and replays are indistinguishable without recorded provenance.
- **Proving a replay from the source bytes alone while the caller also supplies conversion-shaping input.** The bytes do not describe that input, so a changed-but-valid declaration is discarded in silence (see the section above). The receipt must record the shaping input too.
- **Early-return on "schema version is already current."** The command is schema activation **and** retained-source import **and** DSH host-state import; a current schema proves nothing about the other two.
- **A second, derived provenance row or a new table.** The receipt ledger already carries the needed facts; an extra write path would compete with it and need a migration.
- **Heuristic identity matching (id / type / date / header).** Deliberately forbidden as a replay proof.

## Boundaries (fail safe, and say so)

- **No retained receipt** (imported by an older build, restored from a pre-receipt image, or the row is otherwise gone) → the previous refusal stands, with its `--ack-skip-workflow <id>` recovery. Missing provenance fails safe; it never fabricates a replay.
- **Legacy bytes changed since the recorded import** → a different `sourceDigest` → refuse. Provenance is about the exact bytes, never about a name.

## How to verify a change here

Drive the real entry twice over one unchanged fixture legacy root under **different** operation ids and assert: run 1 imports and reports `upgraded`; run 2 reports `nothing-to-import` with `imported: 0`, a per-id proven-replay disposition, and no `skipped` loss entry; native rows and legacy bytes byte-identical. Then edit one legacy source and assert the next run refuses again and the named acknowledgement still recovers.
