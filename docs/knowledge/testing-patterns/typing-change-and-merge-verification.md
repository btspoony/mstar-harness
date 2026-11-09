# Verifying typing changes and integration merges

Two related traps, both observed in one iteration. Neither is caught by the checks people naturally reach for.

## Trap 1: a "type-only" commit still needs a behaviour diff

A commit submitted to make a package type-check is not exempt from behaviour review. Observed: a commit described as type-only made the package compile (48 pre-existing diagnostics fixed, root cause `rootDir` conflicting with a cross-package source import) **and also**:

1. removed a model-identity guard while the function still stamped a fixed model name, so a response from the wrong model was silently accepted and relabelled;
2. replaced a request body with a defensive copy, so the transmitted bytes were no longer the caller's buffer while the existing transport test asserted object identity.

Both were caught by **running existing tests** and by **an independent seat re-reading the diff** — not by the commit message, and not by the type checker.

**Practice**

- Diff a typing commit against its predecessor for *behaviour*, not just for compilation. The honest form of this is a line-by-line question: "does this change what the program does for any input?"
- A type narrowing that changes an allocation, an aliasing relationship, or a comparison is a behaviour change. Say so in the commit message.
- When a copy or conversion is introduced, decide the contract: is the value snapshotted or aliased? Document it, and make the test assert the contract rather than an incidental identity. Before keeping an isolation copy, show what isolation it buys — if nothing observes the difference, prefer the boring no-copy form.
- Do not let a fix smuggle a second change. If a repair needs an unrelated behaviour tweak, land it separately.

## Trap 2: an existing test that nobody runs protects nothing

The model-guard regression above was covered by a test that already existed. It failed the moment anyone ran the package. The test was not missing — the *running* was.

**Practice**

- Run the whole affected package, not only the files a task happens to name. A scoped run proves what you chose to check.
- Treat "which tests did you run" as part of the evidence: a scoped green run is not a package-level claim.

## Trap 3: a merge verified against named files is not verified

An integration merge of three plan branches was verified by the resolver against the four test files named in its instructions. All four passed. A whole-package run then found **two failures** in a fifth file: the merge had silently lost part of a reconciliation guarantee (an empty-receipt case no longer raised its accounting error). One of the two conflicting sides' edits had been resolved away.

**Practice**

- After resolving conflicts, run the **whole affected package**. Conflict resolution correctness is not represented by the files that happen to be named in the task.
- When two branches disagree about the same function's behaviour, that is a design decision, not a merge mechanic. Take the **stricter** option, say so in the commit message, and record the decision — never invent a third behaviour to dodge the conflict.
- Cross-plan semantic conflicts are invisible to per-plan acceptance. Two plans can each pass their own QC and QA while disagreeing about the same function; the disagreement only appears after merging and running the merged tests. Budget for that step.
- When the same behaviour has two contradictory expectations inside one test file, do not let the implementer pick whichever makes the suite green. Establish provenance (`git log -S`, `git blame`), decide which expectation is stale, and have an independent seat confirm.

## Trap 4: reading state while someone else writes it

A QA seat read an issue store, found a critical still open, and failed the plan. The critical had been closed between the read and the report. The verdict was correct for the state it saw.

**Practice**

- When a verdict depends on mutable external state, re-read immediately before reporting, and record the read time so a reader can tell "still open" from "was open when read".
