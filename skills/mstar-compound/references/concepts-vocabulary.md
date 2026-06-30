# CONCEPTS.md vocabulary rules

`CONCEPTS.md` **must** live at the repository root (`<repo-root>/CONCEPTS.md`, same level as `.git/` and `AGENTS.md`), **never** inside `{HARNESS_DIR}` or any subdirectory. It defines the words that mean something specific in this codebase — substrate that `{KNOWLEDGE_DIR}` and `AGENTS.md` can cite without redefinition.

## How terms enter

Two paths:

- **Accretion** — a learning surfaces a term whose meaning wasn't obvious, so it gets defined. Catches *peripheral* terms (friction surfaces them).
- **Seeding** — proactively defines **core domain nouns** the area's declared domain model exposes. Catches *stable-central* terms accretion never reaches.

### What earns a slot

A term qualifies when its meaning here is precise enough that a new engineer would need it defined to follow conversations, tickets, or code. General programming vocabulary does not belong.

### Per entry

- **Definition**: one sentence — what the term means in this domain, what makes it distinct from neighbors.
- A term with non-obvious behavioral rules (lifecycle, cancellation semantics, ownership invariants) earns a second paragraph.
- When retired synonyms exist: `*Avoid:* old-name, other-name`.
- No implementation specifics (file paths, class names, table names), no status/date/owner fields, no version-specific claims.

### Organization

Cluster by domain relationship — entities with their states, processes with their stages. A flat list works when the file is small. Reshape as it grows.

### Flagged ambiguities (tail of file)

When two terms were used interchangeably and the team settled on a distinction, record the resolution as a one-line note.

## One illustrative entry

```markdown
## MyDomain

### Reservation
A future commitment to seat a Party at a specified date and time.
*Avoid:* Booking, appointment

A Reservation owns its Party but does not own a Table — Tables are acquired only when the Party arrives, through a Seating. Lifecycle: Booked → Seated → Completed → No-Show.

### Party
The guests committed to a Reservation. Each Reservation has exactly one Party.
```
