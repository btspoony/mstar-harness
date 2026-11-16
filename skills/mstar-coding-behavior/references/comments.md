# Comments

A comment is an input to the next change: whoever edits the line reads it before reasoning about the code. It earns its place by stating what the code cannot show, and it fails by teaching something false or by licensing a pattern nobody bounded.

## Failure modes

1. **Drift** — the comment still states the old contract after the code moved. The next reader trusts it and changes the wrong thing.
2. **License** — a label (`simplify:`, `temporary`, `TODO`) is read as permission to repeat the pattern, so a bounded shortcut becomes the house style.
3. **Substitute** — the comment says what the code already says, or explains a known-bad pattern instead of the code being corrected. Two descriptions of one behavior diverge, and the code is the one that runs.

## MUST

| Case | What keeps it |
|---|---|
| External constraint — a platform, protocol or third-party behavior the code cannot choose | It appears nowhere in the file |
| Contract pointer — the one path to the spec, ADR or issue that owns the rule | It resolves at HEAD, and the owner is not restated |
| Bounded shortcut — `simplify: <limit>, <when to upgrade>` | It records a ceiling and a bound |
| Generated marker — "do not edit, regenerate from X" | It prevents an edit the generator would undo |
| Public-API contract types cannot express — unit, ordering, ownership, aliasing | It states an obligation a caller relies on |
| Uncheckable ordering or safety constraint — a required sequence no test or lint can see | It is the only surface the actor reads at that step |

## MUST NOT

| Case | Why |
|---|---|
| Restating the code or its signature | The types and the body already say it |
| Justifying a known-bad pattern | Correct the code, or bound the shortcut in the marker form |
| Commented-out code | It is a live sample that the pattern is current; the file's history is the archive |
| An ownerless `TODO` | No name, issue reference or removal path means nobody removes it |
| Change-log comments | What the previous version did belongs to history, not to the code |
| A stale comment | The edited line contradicts it, so it now misleads |
| An untracked future promise | No marker, owner or tracking entry means no one is held to it |

## MAY

| Case | Bound |
|---|---|
| History | Only when it explains why the current design is the way it is — the design, not the change that made it |
| A performance number | Only with the measurement source, so a later reader can re-measure instead of trusting a number |

## Checkable vs judgement

A check can see: marker tokens with no tracking reference, commented-out blocks, a marker whose ceiling or bound is missing, and a marker the diff copies into a new site. A check cannot see whether the comment still holds, whether it restates the code, or whether a shortcut is genuinely bounded. The first set is lint territory; the second is review territory, and rewording a rule does not move it between them. Of the first set, only a label without its bound is a gating violation: an ownerless `TODO` and a commented-out block are advisory markers that no gate reads, so a clean lint run says nothing about them.

## Drift rule

A change that edits a line verifies the adjacent comment in the same edit: delete it when the code now shows the behavior, correct it when the contract moved, never leave both versions for the next reader to reconcile. Editing code without reading its comment is how drift starts.

## Markers

Labels: `simplify: <ceiling>`, and `temporary` written `temporary:`, `temporary —` or `temporary -` — never the bare adjective, and a bare quoted token (`` `simplify:` ``, `"simplify:"`) names the label without being a marker. Each label is bounded by an `upgrade: <when>` clause or by a removal/tracking reference (`#123`, `status.json`, `plans/<file>`), stated on the label line or anywhere in the same comment block; the tracking entry is the task's plan or issue.

The marker never licenses the pattern: once its ceiling is exceeded, its bound is gone, or the pattern is copied into a new site, it is a defect to report, not a documented decision. A marker without that bound is a comment that licenses repetition — delete it with the code it excused, or add the bound.

The gate reads `packages/` and `scripts/` (`mstar lint <root> --type code`); a marker elsewhere is unenforced, so check it in review.
