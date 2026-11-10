---
module: packages/engine workflow notes ledger + packages/dsh agent-flow ledger (append path and readers)
date: 2026-09-23
last_updated: 2026-11-09
problem_type: logic_error
category: logic-errors
severity: high
plan_id: "<plan-id>"
symptoms:
  - "An accepted ledger record exists on disk but no reader ever returns it"
  - "No error is raised at write time and the append reports success"
  - "The damaged bytes and the lost record form one unparseable line"
root_cause: "An unterminated final fragment (a writer that died mid-line) was treated as a line boundary by the append path, so the next accepted record was concatenated onto the damaged line and the whole merged line became unparseable, hiding the accepted record from every reader"
resolution_type: code_fix
tags:
  - jsonl
  - append-only
  - torn-tail
  - silent-loss
  - crash-recovery
  - agent-flow
---

# A torn JSONL tail swallows the next accepted record

## Problem

Append-only JSONL ledgers assume each record ends with a newline. A writer that dies mid-line leaves a final fragment **without** a terminator. Appending the next record onto that fragment produces a single unparseable line, so the fragment and the just-accepted record are both discarded by every reader — with no error anywhere and a successful append reported for a record that is now invisible.

## Symptoms

- The writer returns success; the byte count on disk grows; readers never see the new record.
- The ledger's visible content is short by one accepted record with no warning, no counter and no refusal.
- Reading the raw file shows the damaged fragment and the new record concatenated into one malformed line.

## What Didn't Work

- **Reader-side tolerance alone.** Skipping unparseable lines keeps readers alive but does not recover the accepted record that was merged into the damaged one — the loss happened at write time, and the reader has nothing left to parse.
- **Truncating or rewriting the fragment.** The fragment's bytes are the only evidence of what was lost; deleting them destroys evidence and is not idempotent against a concurrent writer holding the same file.
- **Re-appending the lost record as a new identity.** The record's identity was already accepted and may already be referenced; a duplicate identity is a different defect, not a repair.

## Solution

Guarantee the record boundary **at the write boundary**, without reading the tail and without repairing or truncating anyone's bytes. The live form (`packages/engine/src/execution-ledgers.ts`, `commitLedgerFrame`) is: **every frame carries an unconditional leading LF** and lands in one `O_APPEND` write.

```ts
// Every frame — including the one that creates the leaf — carries one leading LF.
const line = Buffer.concat([Buffer.from("\n", "utf8"), frame]);
const written = writeSync(fd, line, 0, line.length, null);
if (written !== line.length) throw new ExecutionLedgerError(
  "execution-ledgers.append-short",
  `only ${written} of ${line.length} bytes ... the partial bytes stay in place and are never repaired or truncated in a peer's name.`,
);
fsyncSync(fd);
```

The leading LF is unconditional for three reasons the source states: the leaf is not private between `open` and `write` (a peer can create it or extend it with a partial record in that window), a boundary decided from the open alone would fuse this record to an unterminated line, and a boundary written into a leaf that already ended with LF — or a freshly created empty leaf — is an empty line, which readers skip. Note this is *not* the same repair as reading the last byte and appending a newline: that needs a read plus a stable tail, and it does not survive a peer writing between the read and the append.

The size-gated compaction runs **after** the append, and an over-ceiling append runs its frame and compaction as one critical section under the store's own `BEGIN IMMEDIATE` write lock (`withWorkflowNotesMaintenanceLock`); no filesystem lockdir family participates. Retention and compaction bounds for that same ledger are in `architecture-patterns/append-only-ledger-bounds.md`.

## Why This Works

The invariant "a torn tail can never consume a subsequent accepted record" can only be enforced where the append happens. A leading LF makes the boundary a property of the record's own bytes rather than a property of the file's prior state, so no read, no lock and no coordination with the previous writer is needed: whatever precedes the frame, the frame ends with an LF and therefore occupies its own line. The fragment stays visible as an unrecoverable damaged line rather than as an invisible trap, and a short append is reported rather than silently completing. Repair at read time cannot achieve this, because by then the accepted record's bytes are already merged into the damaged line.

**Live readers** treat "bytes after the last LF" as their own skippable span (`normalizeWorkflowNotesCoverage` reports it as the unaccepted tail), so the display-level guarantee is real and separately stated. The DSh agent-flow ledger this defect was found in no longer uses JSONL at all: `packages/dsh/src/gates/agent-flow.ts` reads and writes the SQLite native ledger (`appendDshLedgerRow` / `readDshLedgerWindow`), so "no JSONL, cursor, index, archive, compaction, file-lock, or runtime file-fallback state participates in event processing".

## Prevention

- Any append-only line format gets the same treatment: make the record boundary a property of the record's own bytes (a leading LF), keep the fragment's bytes, and report a short append instead of completing it.
- Keep the two properties separate in tests: (a) an unparseable tail refuses rather than being silently dropped, and (b) a replay heals without duplicating an accepted id. The torn-tail case must fail pre-fix — a case that passes with the repair reverted proves nothing (`testing-patterns/load-bearing-regression-proof.md`).
- Distinguish cut positions: a cut after a complete id is an advisory refusal with nothing durable moved; a cut *inside* the id lets the record land once with the fragment byte-identical.
- Treat "the reader skips malformed lines" as a display-level guarantee, never as a durability guarantee — the pairing is what makes silent loss impossible.
