# ADR — architecture decision records

A record is one decision the project made **among real alternatives**, filed so a reader finds it without an index: the bucket gives the fate, the class the domain, the date sorts the rest. A record states the decision and why the alternatives lost — never the system the decision left behind.

## When a record is required

All three hold:

1. A decision was made or is proposed among real alternatives — something was rejected, or accepted at a cost.
2. Its rationale cannot be reconstructed from the code, tests or existing docs ("we rejected option B, at the cost of X, and would reconsider if Y" has no other home).
3. It outlives the change that produced it — a future contributor has to confront it before reintroducing the bypass.

Exempt: mechanical edits (formatting, renames, dependency bumps, regenerated output), local edits whose rationale is visible in the code, tests or a change description, and decisions already recorded — update or supersede the existing record instead of writing a second one.

## Directory shape

```
{ADR_DIR}/{bucket}/{class}/yyyy-mm-dd-topic.md
```

- **Bucket** — the fate: `proposed/`, `implemented/`, `rejected/`, `archived/`.
- **Class** — the domain: `feature/`, `bug-fix/`, `simplification/`, `architecture/`, `process/`, `testing/`. There is no `refactor`: the judge is mechanical — observable behavior changes → `bug-fix` or `feature`; it does not → `simplification`.
- **Filename** — the record's **original** date plus a lowercase kebab topic. It never changes across a lifecycle move; only the bucket directory moves.

## Header and skeletons

First line `# ADR: <title>`. The header also carries one bare line `Status: <state> — <why>`, whose state equals the containing bucket for `proposed/`, `implemented/` and `rejected/`; an archived record keeps `Status: implemented — …` and gains an `Archived:` line instead. `Date:`, `Scope:`, `Supersedes:` / `Superseded-by:` and a self-path are free-form.

```markdown
# ADR: <title>
Status: proposed — <why this is not settled yet>
Date: <yyyy-mm-dd>

## Problem                    <what breaks or breaks again without a decision>
## Proposal                   <the change, future tense>
## Alternatives considered     <each real option and why it lost>
## Acceptance criteria         <what would make the proposal done>
## Risks                       <what the proposal costs>
```

```markdown
# ADR: <title>
Status: implemented — <why this is now the standing decision>
Date: <yyyy-mm-dd>

## Problem                    <the same stakes, unchanged>
## Decision                   <present tense: how the system works now>
## Alternatives considered     <the same real options and their losses>
## Consequences               <what it costs, and how each risk is borne>
```

- `rejected/` has no third skeleton: it reuses the proposed shape with a **frozen body**, and only `Problem`, `Proposal` and `Alternatives considered` are required of it. After rejection, those three are never rewritten — only the Status line says why the proposal died.
- `Proposal`, `Plan`, `Migration plan` and `Acceptance criteria` are banned as sections of an implemented record: they are proposal-era scaffolding, and a promotion that keeps them is half-finished. Sections neither required nor banned stay.

## Lifecycle

Three moves exist, each landed as one change — move, rewrite and header together, never a half state:

- **`proposed → implemented`** — move the file, rewrite `Proposal` into a present-tense `Decision`, fold `Acceptance criteria` and `Risks` into `Consequences`, delete plan text, rewrite the Status line.
- **`proposed → rejected`** — move the file, freeze the body, put the reason in the Status line.
- **`implemented → archived`** — move the file to `archived/<class>/` with its filename unchanged, leave its Status line as it is, and add `Archived: YYYY-MM-DD — <reason>` immediately below it.

Archive admission requires all three: the decision is fully superseded or its mechanism is gone; it no longer guides future work; it retains historical value. Failing the third means **delete the record**, because a tree should keep nothing that no longer earns its place. Length and age are discovery aids, never archive criteria.

An archived record is frozen: no body edits, no Status rewrite, no maintenance of its outbound links. `proposed/` and `rejected/` never archive — a rejected proposal is already a frozen fact. A record never returns to `proposed/`.

## `superseded` is not `archived`

A superseded record is still a true statement about the system and has a replacement: it stays in its live bucket with both-way `Supersedes:` / `Superseded-by:` lines, and a supersession search over the tree precedes the new record. An archived record is no longer authority at all; active prose may link into it only to cite history. An implemented record is a live statement: the change that alters a path, name or default it states also updates the record — routine maintenance, no transition, no new record, until it is archived.

## Deliberately absent

- `INDEX.md` — a second registry to maintain on every change, and registries drift; the path already carries bucket, class and date.
- Bilingual siblings (`<topic>.zh.md`, `<topic>.i18n.yaml`) — records are single-language, like the rest of the tracked corpus.
- A decision list or counts page — the tree is the list.

## What a validator can check, and what it cannot

The project's validator, if any, can check membership, filename shape, `Status` agreeing with the directory (plus an `Archived:` line and `Status: implemented` for `archived/`), fence balance, and the required and banned sections per bucket. Two rules no tree walk can check, and both stay review duties: whether `Problem` carries real stakes instead of restating the change, and whether `Alternatives considered` lists options genuinely weighed rather than strawmen built afterwards. The body freezes, the same-change freshness duty for live records, the supersession links and the title form are review obligations for the same reason.
