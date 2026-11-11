# Knowledge document format

A knowledge document captures engineering experience and method — a pattern, a lesson, a how-to, an analysis technique, a validated trade-off. It never describes the project's current state (that is a spec) and never narrates a decision's alternatives (that is an ADR).

## Path

```
{KNOWLEDGE_DIR}/<category>/<slug>.md
```

- `<category>` is one of the directory names in `references/category-mapping.md`, chosen from the document's `problem_type`; the frontmatter `category` field must match the directory.
- `<slug>` is a lowercase kebab phrase naming the problem or the guidance, with no date prefix and no version suffix. Update the page in place; keep a `<slug>-v<N>.md` copy only when an old version is genuinely needed for comparison, and never inside a tracked tree without a catalog row marking it `superseded`.

## Frontmatter

Every document opens with a `---`-fenced YAML block. `references/schema.yaml` is the field SSOT — this table is an index of it, not a second contract.

| Field | Kind | Note |
|-------|------|------|
| `module` | string, required | module, component or area affected |
| `date` | `YYYY-MM-DD`, required | date documented |
| `problem_type` | enum, required | determines the track (bug vs knowledge) and the category |
| `category` | string, required | directory name under `{KNOWLEDGE_DIR}` |
| `severity` | enum, required | `critical` / `high` / `medium` / `low` |
| `symptoms`, `root_cause`, `resolution_type` | required on the bug track | observable symptoms, fundamental cause, kind of fix |
| `applies_when` | optional on the knowledge track | conditions where the guidance applies |
| `plan_id` | optional | registered plan identity, when one exists |
| `tags` | optional array | search keywords, lowercase, max 8 |
| `last_updated` | `YYYY-MM-DD`, optional | added when an existing document is revised |
| `related_components` | optional array | other components involved |

## Tracks and sections

The track follows `problem_type` (`references/category-mapping.md`): **bug** documents an incident-level fix, **knowledge** documents durable guidance. The section structure of each track is `assets/knowledge-skeleton.md` — write to that skeleton for the track you chose.

## What this file does not cover

Capture judgement (whether a candidate is worth writing — the Q1–Q8 self-check, its decision matrix, overlap detection) and maintenance verdicts (Keep / Update / Consolidate / Replace / Delete) are the capture and maintenance workflows' business, owned by **`mstar-knowledge`**; this page only fixes the shape of what those workflows produce. Frontmatter validity is checkable with the optional `mstar compound validate <doc>`.
