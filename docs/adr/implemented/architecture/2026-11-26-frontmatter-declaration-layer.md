# Front Matter as the Declaration Layer for Process Documents

Status: Accepted
Date: 2026-11-26
Supersedes: —
Superseded-by: —

## Context

Process documents — plans, Assignments, SDD briefs, PM acceptance reports — carried machine-read declarations in body labels. Three parsers read the same bytes differently, and five body heuristics (plan header labels, Assignment header region, task headings, progress lines, ADR status lines) reconstructed fields that a validator then re-checked. Agents with different context reliably produced shapes one consumer accepted and another refused.

## Decision

1. **Front matter is the only machine-read declaration layer.** Document-level fields (ids, branches, execution mode, delivery kind, status, gate, verdict) live in a fenced front matter block. Body content stays human-readable.
2. **One strict reader** replaces the three parsers: a flat YAML subset (scalar, one nested map, flat flow array, `|`/`|-` block scalar), refusing any other line with source, line and a correction. Document-relative line numbers, first-complete-fence termination, own-property assignment, and a regular-file guard are part of the contract.
3. **One document schema validator** owns required/optional/enum fields per kind: `plan`, `assignment`, `sdd-brief`, `pm-acceptance`.
4. **A plan declares in front matter only**; body labels are not read. A body-label plan refuses.
5. **An Assignment is a file carrier.** The prompt carries `Assignment file: <absolute path>` on its first non-blank line; the resolver accepts three write homes (plan → iteration → workflow) plus the read-only flat `{HARNESS_DIR}/assignments/`, and refuses an out-of-home, non-regular or ambiguous source.
6. **Retired body-label Assignments are terminal** on every blocking host. A host without a refusal channel reports the same violation as advisory and the limitation is disclosed.
7. **Producers round-trip through the reader.** A produced header passes the consumer's schema before it is written; values are quoted only when the reader would misread them; one source snapshot feeds every derived field.

## Consequences

- A declaration has one source and one reader; consumers cannot disagree.
- Agent-authored documents fail with a field-level diagnostic and a named recovery instead of a silent empty list.
- In-flight body-label documents must migrate; the refusal is explicit and names both the front matter and pointer forms.
- The cost is that a pointer is positional and a new document kind needs a schema table rather than a parser.
