# Iteration package README (template)

Optional **prose** README inside `{ITERATION_DIR}/<iteration-id>/`. Copy when the package has more than a few files beyond `delivery-compass.md`.

It is a guide, not a register: which documents exist, where they live, what kind they are and who owns them is catalog data (contract §1/§4). Nothing here is a duty — there is no "add a row when you add a file" obligation. Read registration state with `mstar catalog list` / `mstar catalog show`; legacy index rows are proposed read-only by `mstar catalog discover` and applied after review with `mstar catalog import`. Authority → `mstar-conventions` SKILL.md § Markdown 索引退役 and `references/artifact-storage-paths.md`.

```markdown
# <iteration-id>

Iteration package — `delivery-compass.md` + specs/guides. Not `{KNOWLEDGE_DIR}/`. Worthy content is **promoted** at iteration-close via `mstar-compound`.

## Orientation

- `delivery-compass.md` — scope, plans, acceptance criteria, branch policy.
- `guides/<name>.md` — <purpose>
- `specs/<name>.md` — <purpose>

## Promotion log (annotated at iteration-close)

| Source | Promoted to | Date | Notes |
|--------|-------------|------|-------|
| | | | |
```

**Content of the copied README**: a one-line package description, prose pointers to the files a reader should open first, and the `Promoted to:` annotations written at iteration-close. It carries no Kind/Status columns and no one-row-per-document table — document registration belongs to the catalog, not to this file.
