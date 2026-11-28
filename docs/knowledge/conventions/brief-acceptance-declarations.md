---
module: process-document producers and validators (engine sdd, commands lint)
date: 2026-11-26
problem_type: convention
category: conventions
severity: medium
applies_when:
  - "a producer writes a front matter declaration that a validator will read back"
  - "adding a lint type that delegates to an existing document schema"
  - "sweeping a corpus for a retired document form"
tags: [frontmatter, producers, lint, brief, sweep]
---

# Producers must round-trip through the same reader as their consumers

## Context

The brief writer, the acceptance lint and the corpus sweep all sit on the same declaration layer. Three defects recur when a producer and its validator are written independently: the producer emits a header the reader cannot decode, it reads its input twice and mixes snapshots, and a sweep's classification quietly absorbs live positive cases.

## Guidance

1. **Validate before writing; refuse on the spot.** A producer assembles the header and runs the same document schema the consumer will use. If it would refuse, the producer refuses before `mkdir`/write and names the file and line. An emitted artifact that its own validator rejects is worse than no artifact.

2. **Quote only when the reader would misread.** A path or id is written raw unless the shared reader would decode it differently (`null`, a leading `[`, a `#`). Round-trip the value through the reader in the test; do not blanket-quote (a quoted `"null"` becomes the string `null`) and do not counter-pin the unquoted form in the plan text.

3. **One snapshot per artifact.** Read the source once; derive every declaration (id, body slice, files) from that one content value. A file read for the id and another for the body can pair a new id with an old slice. The module already exposes a content-taking reader for this.

4. **Scan the body, not the whole file.** Task headings, list entries and section boundaries are body constructs. A `## Task` line inside front matter or a fenced example is not a task; scan `extractFrontmatterAndBody(content).body` and track fence state.

5. **De-duplicate in insertion order.** A `Set` preserves the order a reviewer reads and is linear; a repeated `indexOf` is quadratic and silently reorders nothing but cost.

6. **A delegated lint type owns target and recovery.** When a new `--type` reuses a schema, it must also state its target shape (a file, not a directory — refuse an empty sweep) and keep its own type in the recovery command. A recovery that drops `--type` re-runs a different check.

7. **A sweep classifies every hit.** Define the allowed classes up front — refusal fixture, documented removal sentence, live positive-admission fixture that quotes the retired form deliberately, dead code removed — and record each hit's class. A "zero hits" claim that excludes live positive fixtures is false; a dead helper is not a refusal.

8. **Never pin serialization in a permanent test.** Assert parsed fields, ordered values and boundaries; show byte preservation as one-off acceptance evidence. A whole-header or full-slice equality is a snapshot the next wording change breaks without a behavior change.

## Consequences

- A produced document is readable by construction, because it passed the reader before it was written.
- A lint type cannot silently validate nothing.
- A corpus sweep is auditable: every remaining occurrence has a reason and an owner.
