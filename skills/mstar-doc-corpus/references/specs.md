# Specs — current-state documents

A spec is the normative description of the project **as it is now**. It is the fast query layer for "how does this work today", so it describes state only: no history, no decision narration, no plan.

## Admission (all three hold)

1. **Settled** — the content is locked enough that it is not still being edited casually.
2. **Cross-iteration** — it stays true beyond the change that produced it, not a one-off exploration.
3. **Authoritative** — links to it are the design input for future changes; nothing else restates it.

A repository-wide state that belongs to no plan is admitted under the same skeleton and the same three conditions.

## Write timing

- Record the state at the moment it becomes true — the same change that alters the code, path, default or contract also updates the spec it describes.
- A draft that is still moving stays outside the layer (an iteration package or a plan), and enters `{SPECS_DIR}` only once it is settled.

## Skeleton

Every spec carries these five sections, in this order, so "current state" is reviewable and diffable:

```markdown
# <Layer>: <topic>

## Scope              what this page covers and what it leaves out
## Current state      what is: layering, boundaries, contracts, data flow
## Invariants         constraints a change must not break (verifiable)
## Where it lives      authoritative paths / commands / tables (repo-relative)
## Change obligations which changes must update this page in the same change
```

Extra sections are allowed; an ADR-shaped section (`## Problem`, `## Decision`, `## Alternatives considered`, `## Consequences`, `## Acceptance criteria`, `## Risks`) is not — it turns a state page into a decision record.

## Naming

`<class>/<topic>.md` — the class directory groups related specs (for example `architecture/`, `api/`, `data/`); the topic is a lowercase kebab phrase. No version suffix, no date prefix: one page per topic, and the newest content replaces the old in place.

## Degradation

- **Update in place.** Correct the page; never add a second version of the same topic.
- **Delete when invalid.** A spec whose subject is gone is removed, not kept for reference; Git and the ADR tree carry the history.
- **Latest only.** No history directory, no `-v<N>` suffix, no dated copies inside the tracked tree.
- Local comparison copies, if a tool needs them, live outside the corpus and are gitignored.

## What the validator checks, and what it cannot

`mstar lint <dir> --type specs` (optional) walks the tree and reports: a spec outside a `<class>/` subdirectory or inside a history directory, a missing skeleton section, an ADR-only section, a version suffix or date prefix, an unbalanced code fence, a local harness path or a concrete `plan_id` / `iteration_id`, a `README.md` index that is missing or links a dead target. Factual accuracy — whether the described state still matches the code — is not checkable; it stays a same-change review duty.
