# Calibrated Examples

Every passage here is invented: a warehouse label-print daemon that shares no name, number, mechanism or incident with any real service, change or review. Judge them as fixtures and take the principle, not the wording — a matched phrase is not the test.

Word counts are whitespace-separated tokens, given so you can watch them fail to decide anything. In every triple the balanced form is neither the shortest nor the longest, and the counted pairs go both ways.

## How to read a triple

Each triple is `over-trimmed / over-detailed / balanced`. The over-trimmed form is what a compression pass produces — shorter, minus a guarantee, condition or ownership boundary the original carried, and looking like an improvement in the diff. The over-detailed form is what a drafting pass produces — every fact still present, wrapped in the session that produced it. The balanced form keeps the propositions and drops the vantage.

The `Survives:` line under each triple names the propositions the balanced form still makes. Anything the over-detailed form says that the list does not cover was vantage rather than fact.

## 1. Change narration

A buffer replaced a per-frame disk write, and the file has to state what the buffer now does.

**over-trimmed** — 13 words

```text
Frames are buffered in memory and flushed to the spool file on shutdown.
```

**over-detailed** — 57 words

```text
Frames used to reach the spool file one at a time, but after the review round the writer no longer does that: the old per-frame path is gone and frames now sit in memory, flushed to the spool file on shutdown or once the buffer holds 512 frames, and no frame reaches the disk before that flush.
```

**balanced** — 28 words

```text
Frames are held in memory and flushed to the spool file on shutdown or once the buffer holds 512 frames. No frame reaches the disk before that flush.
```

Survives: where frames are held, both flush triggers, the 512-frame bound and the negative guarantee that nothing reaches the disk before a flush. The change story and the review round were vantage.

## 2. Reviewer-addressed justification

A bounds-checked read follows the parser, and the comment has to say why the read cannot go out of range.

**over-trimmed** — 6 words

```text
The width read here is safe.
```

**over-detailed** — 40 words

```text
This cast is correct because the parser has already rejected every frame whose declared width exceeds the 200-byte buffer, so the width read here is always in range, which is the argument the last review round asked for and settled.
```

**balanced** — 21 words

```text
The parser rejects any frame whose declared width exceeds the 200-byte buffer, so the width read here is always in range.
```

Survives: the precondition established upstream, the 200-byte bound and the consequence for this read. The argument that the code is correct, and who accepted it, were vantage.

## 3. Hedged planning residue

Attempts are capped, nobody measured the cap, and the number is a choice rather than a derived bound.

**over-trimmed** — 5 words

```text
Retries stop after three attempts.
```

**over-detailed** — 34 words

```text
Retries currently stop after three attempts, which nobody has measured and is probably fine for now; the queue owner can revisit the number later if the printer queue gets deeper or if someone complains.
```

**balanced** — 25 words

```text
Retries stop after three attempts. The cap is unmeasured; the queue owner can revisit it if the printer queue gets deeper or if someone complains.
```

Survives: the cap, the admission that it is unmeasured, the owner, and the owner's optional renegotiation under both of its triggers. The hedge words, the version stamp and the revisit's timing were vantage; the over-trimmed form is the trap here — it keeps the number and drops the admission, making an arbitrary policy read as derived.

## 4. Suppression justification that must be kept

A suppression is required prose on every surface; the balanced form keeps the reason and only corrects a false one.

**over-trimmed** — 3 words

```text
// oxlint-disable-next-line no-await-in-loop
```

**over-detailed** — 51 words

```text
// oxlint-disable-next-line no-await-in-loop -- the queue must drain one label per open call, and the disable is a false positive: the awaits in this loop are independent. This came up in the last review round, when the parallel version reordered jobs and the reviewer asked for the loop to be serialised.
```

**balanced** — 18 words

```text
// oxlint-disable-next-line no-await-in-loop -- the queue must drain one label per open call; concurrent awaits reorder printer jobs.
```

Survives: which rule is suppressed, the obligation that forces the sequential await, and the ordering consequence of concurrent awaits. The review round and who asked were vantage; the claim that these awaits are independent is the one proposition replaced rather than dropped — the suppression and a true reason both stay, and deleting either is the one failure this class never earns.

## Delete/keep pairs

### Pair 1 — the longer passage is kept

Deleted — 24 words

```text
The settle delay was added while chasing the duplicate-label bug; it is longer than the delay that used to sit on the old path.
```

Kept — 38 words

```text
Without the 30 ms settle delay before the next open call, the driver re-attaches the finished job and prints the label twice (measured: one duplicate in five jobs at 12 ms, none in 2,000 jobs at 30 ms).
```

Decided by: the kept passage states the present consequence of removing the delay and the measurement that fixes the constant — a counterfactual anyone can test — while the deleted one states only how the constant arrived.

### Pair 2 — the shorter passage is kept

Deleted — 40 words

```text
The ID scheme went through a few iterations: the first version counted from the print position, the second reset a per-printer counter, and the current one adds a random prefix, which is the arrangement everyone settled on after the duplicates.
```

Kept — 10 words

```text
Generated label IDs are never reused after a printer reset.
```

Decided by: the kept sentence carries a negative guarantee a caller depends on, and the deleted passage narrates how the scheme was chosen; its only surviving fact — random prefix, per-printer counter — belongs in the schema, not in the ID generator's comment.

## What the pairs prove

Both directions were decided by enumerating propositions, not by counting. A passage with a testable consequence survives at 38 words and one with none dies at 24; a negative guarantee survives at 10 words and a design history dies at 40. Counting tokens alone gets both pairs backwards.
