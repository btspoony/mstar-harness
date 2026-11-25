---
module: engine (document front matter reader and document schema)
date: 2026-11-26
problem_type: architecture_pattern
category: architecture-patterns
severity: high
applies_when:
  - "a Markdown document carries machine-read declarations that several validators consume"
  - "replacing per-consumer front matter parsers with one shared reader"
  - "a reader gains a profile for one document family while another family keeps a wider subset"
tags: [frontmatter, parsing, diagnostics, validation, shared-reader]
---

# One front matter reader, explicit profiles, document-relative diagnostics

## Context

Agent-authored process documents — plans, assignments, briefs, acceptance reports — carry declarations that validators read. Three separate parsers had grown: a permissive host loader, a flat compass parser that kept scalar text, and a lint parser that joined continuation lines into `description`. The same document could therefore mean different things to different consumers, and each parser had its own edge behavior: some accepted `key:value` without a space, some stripped quotes differently, some refused an inner bracket and some did not.

A shared reader replaces all three. The design decisions that matter are not the grammar itself but the boundaries around it.

## Guidance

1. **One structural pass, many projections.** Parse bytes into a value tree plus per-key metadata (`value`, raw scalar text, line, kind) in a single pass. Consumers project what they need; no consumer re-scans the document with a regex. A second line scan is a second parser even when it looks like an adapter.

2. **Profiles, not forks.** A `document` profile accepts nested maps and block scalars because host agent files carry `tools:`/`permission:` maps. A `flat` profile accepts root scalars, flow arrays and block lists, and refuses a nested map or block scalar with its line. One scanner, one refusal vocabulary, two accepted subsets.

3. **Preserve the weaker parser's semantics when adopting it.** A shared reader that is stricter than the parser it replaces is a behavior change, not a refactor. When the old compass parser skipped empty flow items, stripped boundary quotes, or kept `true`/`42` as strings, the flat profile must do the same; otherwise a previously valid compass becomes a refusal. Cover each restored shape through the public entry point, not only through the module helper.

4. **Document-relative line numbers.** The reader receives extracted front matter text, but the operator reads the file. Add the fence offset once, in the failure constructor, and test against a real fenced document's line. An off-by-one here makes every downstream diagnostic unreliable.

5. **First complete closing fence wins.** The closing `---` must be a complete line. A regular expression with an optional inner group can backtrack past an empty header and consume a later horizontal rule, swallowing the body. Scan lines instead of relying on greedy/lazy alternation, and treat a lone `\r` at end of input as content, not as a fence terminator.

6. **Own data properties at every hop.** Assign parsed keys through a `setOwn` helper (or `Object.defineProperty`) at the reader level and at every adapter that copies keys into a new object. `__proto__` is a valid bare key; plain assignment either drops it or rewrites the prototype.

7. **Refusals must be actionable.** Each rejection names the source, the line, the offending text, and the accepted correction ("quote a literal value", "align the item with the first item of its list"). A generic "unsupported line" leaves the operator with no repair; a host loader must also pass the file path it already knows instead of a constant label.

8. **A schema validator is a consumer, not a second grammar.** It calls the reader, checks required/optional/enums against raw entries, and reuses the owning module's classifiers (review-seat roster, audit-category rule) instead of copying them. Duplicated classification drifts the first time a seat is added.

## Consequences

- Adding a document kind means a schema table, not a parser.
- A stricter profile is a deliberate, tested contract, not an accidental regression.
- Diagnostics become stable enough for an agent to self-repair from the refusal text.
- The remaining cost is that each profile's accepted subset must be kept explicit and tested through its public entry point; a shape the tests do not exercise can drift silently.
