# ADR: The complete Markdown document is the roadmap authority

Status: implemented — `project_roadmaps` stores one exact document per project; projections are disposable and never authoritative.

Date: 2026-10-02

Scope: the roadmap domain in `packages/engine/src/roadmap-store.ts`, its store schema, the `mstar roadmap` command family, and every consumer that reads roadmap content.

## Problem

Roadmap content was split across mutable goal and milestone tables, a projection that could be rebuilt, and a file fallback. Each copy could disagree about the same project, a line-oriented parser lost content it did not model, and a projection refresh could change what a reader saw without any content revision. There was no single answer to "what is this project's roadmap".

## Decision

- `project_roadmaps` holds one row per project: `project_id` primary key, `project_kind` constrained to `project`, `content_markdown` (the entire validated UTF-8 document, including frontmatter), `content_hash` (SHA-256 of those bytes), a positive `revision`, and `updated_at`. There is no independently writable parsed-content table.
- Reads derive frontmatter, direction, goals, milestones and ordered sections purely from the stored bytes. Goal identity is `(projectId, revision, ordinal)`; no goal id survives a replacement by inference. Unknown or optional content is preserved, not dropped by a serializer. Repeated headings and a preamble are retained.
- Writes are whole-document replacements with explicit expectations: `absent` for creation, a positive roadmap revision for replacement, and the observed project revision. One transaction asserts the active store and schema, project identity, both revisions and content validity, publishes the record and receipt, and advances the shared store revision once. A stale revision refuses `roadmap.revision-conflict`.
- Store operations reuse the existing receipt mechanism with a roadmap domain discriminator. An exact replay returns the committed receipt; reusing an operation id for another request or domain refuses.
- Migration 6 creates `project_roadmaps` and drops the disposable `projection_roadmaps` table. Projection producers, selectors, readers and clearing entries are removed; the projection format is bumped so old generations rebuild through the normal invalidation path. Lossy projection rows are never copied into authority.
- There is no fallback reader. A missing, staged or corrupt store, a schema mismatch or a missing project is visible and mutation-free.
- Import is reviewed: preview reads the source read-only, captures its canonical path and hash, validates the content and project id, and returns the observed revisions. Apply re-reads the source at the write boundary and imports its current valid content; the reviewed hash is recorded as provenance, not enforced as a lock, so an edit between preview and apply is imported as the current file. Missing source and project mismatch refuse; a post-commit edit is merely a changed transport file.
- `mstar roadmap show | import | replace | export` is the transport. `import` previews by default and requires the reviewed file, `--apply` and an operation id to commit. Export is reporting and history, not a live authority or backup; restoration is an explicit reviewed import.
- Public failures are stable `roadmap.*` codes, exported from the package entry point so CLI and dashboard consumers classify by code rather than by message.

## Alternatives considered

- **Separate mutable goal and milestone tables.** Rejected: they duplicate the document, drift from it, and lose content the schema does not model.
- **A per-goal mutation API.** Rejected: the document is the user's content; whole-document replacement with a revision guard is smaller and lossless.
- **Projection as authority.** Rejected: a projection is disposable by definition and its refresh would silently change the answer.
- **File fallback or dual writing.** Rejected: two authorities need reconciliation and make absence ambiguous.
- **Adapting the projection's line regex as the parser.** Rejected: it is lossy by construction; the body is parsed with the established Markdown/GFM packages.
- **Treating an unmappable or missing record as an empty roadmap.** Rejected: absence, corruption and a successful empty answer are different facts.

## Consequences

- Round-trip fidelity is testable from the stored bytes; full-content display does not depend on a presentation convenience.
- The roadmap revision is independent of the catalog revision; both are required on replacement, and neither is advanced by an unrelated write.
- Operational upgrades need an operator-authorized backup and quiesced consumers. After a schema/content upgrade, an old binary cannot safely be rolled back onto the newer store; recovery is a consistent backup restore or a forward fix.
- Legacy v1/v2 roadmap seeds are transport candidates only. They are never live authority and are never imported implicitly by an issue/catalog or execution activation.
- A corrupt, missing or stale revision is a visible refusal, never a fallback. An edited source is imported as current content: preview is a review aid, not protection against unreviewed changes.
