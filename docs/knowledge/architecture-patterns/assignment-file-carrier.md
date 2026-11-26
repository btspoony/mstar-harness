---
module: assignment dispatch (engine resolver, dsh/opencode/omp gates)
date: 2026-11-26
problem_type: architecture_pattern
category: architecture-patterns
severity: high
applies_when:
  - "an Assignment is carried as a file and referenced from an agent prompt"
  - "a host gate must refuse a retired body-label Assignment or an out-of-home pointer"
  - "several stages (decision, handoff, ledger) read the same declaration"
tags: [assignment, frontmatter, dispatch, containment, host-gates]
---

# Assignment as a file carrier: one parse, one verdict, one home

## Context

An Assignment used to be prompt prose whose fields a gate reconstructed with a header-region scan. The fields are now front matter in a file, and the prompt carries `Assignment file: <absolute path>` on its first non-blank line. Hosts differ in whether they can block a tool call, so the same engine decision is consumed by a gate that can veto and by one that can only report.

## Guidance

1. **The pointer binds the whole input or nothing.** Match the pointer grammar only on the first non-blank line. A pure pointer reads the file; a pointer plus any other non-blank content is `ambiguous`; a pointer-like line quoted inside an inline document is inert. A gate must not treat "contains a pointer line" as "is a pointer".

2. **Containment is by resolved home, not string prefix.** Build the candidate homes (plan, iteration, workflow, plus the read-only flat home), canonicalize both sides, and refuse an out-of-home file. A null harness root refuses the pointer; it never skips the check. Refuse a non-regular file before reading, so a FIFO cannot hang a hook.

3. **Two distinct bases.** The pointed file's directory anchors a source-relative `worktree_path`; the session/control checkout anchors Git discovery and the base/ref checks. Passing the file directory as "the checkout" silently re-points every subsequent Git command.

4. **One parse per decision.** Parse the resolved document once into entries and thread them (with the derived plan id) through the decision, the role/preset path, the handoff and the ledger. A stage that re-reads the file can disagree with the verdict that already ran, and it turns one malformed input into three parses.

5. **A missing fence is not a document.** A header that opens and never closes declares nothing. Refuse it and write no ledger row — do not attribute a role or a task category read from an unclosed block. A closed fence is the positive proof the declaration exists.

6. **Retired format is terminal on every blocking surface.** A body-label prompt is a recognized deprecated shape; it refuses with both recoveries (front matter, or pointer), before role exemptions, presets and soft-enforcement tiers. A host with no refusal channel reports the same violation as advisory and says so in its contract; the limitation is disclosed, never papered over.

7. **Parallel work is a list, control work is not.** Parallel tracks are declared as flat `worktree_path`/`working_branch` lists (one file, many branches). A control-domain Assignment refuses a list outright: a control write must pass one checkout/relative-target check, not several.

## Consequences

- A gate decision is a pure function of a single parsed document, so the record and the verdict cannot disagree.
- Host capability differences are explicit; a test can assert a refusal on dsh/omp/v2 and an advisory line on opencode v1.
- The cost is that the pointer is positional: a prompt that prefixes a greeting before the pointer parses as inline and fails, so the hand-off wording must state "first non-blank line".
