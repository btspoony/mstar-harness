# Comments

A comment is an input to the next change: whoever edits the line reads it before reasoning about the code. It earns its place by stating what the code cannot show, and it fails by teaching something false or by licensing a pattern nobody bounded.

## Failure modes

1. **Drift** — the comment still states the old contract after the code moved. The next reader trusts it and changes the wrong thing.
2. **License** — a label (`simplify:`, `temporary`, `TODO`) is read as permission to repeat the pattern, so a bounded shortcut becomes the house style.
3. **Substitute** — the comment says what the code already says, or explains a known-bad pattern instead of the code being corrected. Two descriptions of one behavior diverge, and the code is the one that runs.

## MUST

A non-documentation comment passes the lint in one of four shapes: a marker (`simplify:`, `shortcut:`, `temporary:`) together with its bound — a removal/tracking reference (`#123`, `status.json`, `plans/<file>`), or for `simplify:`/`shortcut:` an `upgrade:` clause — a contract pointer — `see` plus its target (`docs/…`, `plans/…`, `ADR-<n>`, `#<n>`, `issue <n>`, `contract §`, a URL) or that target alone, a declared prefix (`why:`, `invariant:`, `safety:`, `note:`), or `@generated`; a `TODO`/`FIXME` is a fifth only with a tracking reference and only when it opens the comment content (`// TODO:`, `* TODO(`, `# TODO:`) — a marker named mid-sentence is prose, and `see` without a target is prose, not a pointer. A bare label is not a shape: it licenses the pattern without bounding it, so the lint rejects it. A `/** … */` block whose next non-empty line starts with `export` is documentation and exempt; the same block above anything else is not.

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
| Commented-out code | It is a live sample that the pattern is current; the file's history is the archive. Detected in C-family comments only; a hash-dialect block is out of scope |
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

A check can see: marker tokens with no tracking reference, commented-out C-family blocks, a marker whose ceiling or bound is missing, and a marker the diff copies into a new site. A check cannot see whether the comment still holds, whether it restates the code, or whether a shortcut is genuinely bounded. The first set is lint territory; the second is review territory, and rewording a rule does not move it between them. Whole-tree, only a label without its bound is a violation: an ownerless `TODO` and a commented-out block are advisory markers there, so a clean whole-tree run says nothing about them. Under `--diff-base` the ratchet reads the same markers and fails them on a touched line, so an ownerless `TODO` or a commented-out block a change adds does gate (see § Ratchet). The commented-code check parses each candidate run with `vm.Script`, so a block left in TypeScript-only syntax (`: T`, `export`, top-level `return`) is not detected at all — a known gap of this gate, accepted while the shipped engine bundle carries no TypeScript parser (the `shortcut:` marker on `parsesAsScript` records the upgrade path). Both that finding and an untracked `TODO` are advisory: they ride in a result's `markers` (the CLI prints neither), the whole-tree bound gate never fails them, and only the unclassified-shape rule fails such a line when the ratchet touches it. Hash-dialect files (shell, Python, Ruby) are out of scope: the check reads C-family comment runs only.

## Gate steps and range

CI runs the gate as two steps. The **bound gate** walks both roots whole (`mstar lint packages --type code` and `mstar lint scripts --type code`) and fails only on a marker that lost its bound — so a pre-existing unbounded marker in a file a change merely touches still fails, because that step's range is the corpus, not the diff; an unclassified comment carrying no marker stays advisory there. The **ratchet** (`mstar lint <file> --diff-base <ref>`) reads only the changed lines of the changed files, so a pre-existing unclassified comment on an untouched line of a touched file passes; its comparison base is the pull request's base, and on a merge queue the group's own base, so a group is judged by the increment it adds rather than by every pull request batched into it. The asymmetry is intended: a marker is a licence and must be bounded wherever it stands, while prose on a line nobody edited is the existing corpus rather than this change's debt.

The advisory corpus is measured, never estimated. On 2026-11-18 the two bound-gate commands above reported 14,021 unclassified comments under `packages/` (766 code files) and 821 under `scripts/` (58 files) — 14,842 in total; on 2026-11-20 the Linear transport deletion removed roughly 1,500 lines of commented engine code, a genuine cleanup that lowered the `packages/` floor and left `scripts/` untouched. That cleanup was measured twice on its own commit, before any comment was reclassified: 13,392 under `packages/` on CI and 13,445 in a developer checkout, a few-dozen-comment environment delta. The classification pass that followed this change, moving touched prose into the declared shapes, then measured 13,292 with the same command, because a classified comment no longer counts here. On 2026-11-22 the changed-lines classification over the collaboration series (commit `be885a003`) measured 12,826 under `packages/` and 818 under `scripts/` with the same commands, another genuine cleanup, so the record reads in sequence — 13,392 / 13,445 before classification, 13,292 after the first pass, 12,826 after the second — and the `packages/` floor sits at 12,800, deliberately below the smallest of them: a floor's job is not to pin a measurement that moves with every edit and differs between environments. It is a collapse detector — a scanner regression drops the count by orders of magnitude, not by tens — not an equality assertion. CI asserts a floor **per root**: 12,800 for `packages/`, 800 for `scripts/`, with the summed count printed beside them as the human-readable total. A per-root floor is the point: one root's scanner can collapse while the other keeps a shared total above a single threshold, and the collapsed root is exactly what such a threshold would miss. Both assertions are floors on purpose — an added comment, the normal state of this corpus, never trips them, while a detector or collector regression that silently stops finding comments does. Re-measure with the two commands and lower a floor only when its root is genuinely cleaned, never to accommodate a change.

## Drift rule

A change that edits a line verifies the adjacent comment in the same edit: delete it when the code now shows the behavior, correct it when the contract moved, never leave both versions for the next reader to reconcile. Editing code without reading its comment is how drift starts.

## Markers

Labels: `simplify: <ceiling>` and its spelling `shortcut:`, and `temporary` written `temporary:`, `temporary —` or `temporary -` — never the bare adjective, and a bare quoted token (`` `simplify:` ``, `"simplify:"`) names the label without being a marker. A `simplify:` or `shortcut:` marker is bounded by an `upgrade: <when>` clause or a removal/tracking reference (`#123`, `status.json`, `plans/<file>`), stated on the label line or anywhere in the same comment block; `temporary:` is bounded only by that reference — an upgrade clause says when the shortcut goes, not who removes a workaround. The tracking entry is the task's plan or issue.

The marker never licenses the pattern: once its ceiling is exceeded, its bound is gone, or the pattern is copied into a new site, it is a defect to report, not a documented decision. A marker without that bound is a comment that licenses repetition — delete it with the code it excused, or add the bound.

The gate reads the code files under `packages/` and `scripts/`, selected by extension (`mstar lint <file>`); a marker elsewhere is unenforced, so check it in review.

**Ratchet:** the existing corpus is advisory, but the change is not. `mstar lint <file> --diff-base <ref>` resolves the merge base of `<ref>` and HEAD and keeps only the findings whose comment lines that diff touches, a block counting when any line inside it moved; every such finding is a violation, so a change that adds or modifies an unclassified comment fails while an untouched one never does, and the `unclassified comments: <n>` count on stderr is the change's own. New or edited prose must take a shape; no bulk rewrite is implied. A comment is one unit — a `/* … */` block reads all its lines together, so a marker on any line classifies the whole block, and splitting it into lines is not a way to pass.
