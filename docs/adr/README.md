# Architecture decision records

Every record here is one decision this repository made **among real alternatives**, filed so a reader finds it without an index: the bucket gives the fate, the class the domain, the date sorts the rest.

## When a record is required

Write one when all three hold:

1. A decision was made or is proposed among real alternatives — something was rejected, or accepted at a cost.
2. Its rationale cannot be reconstructed from the code, tests, or existing docs — "we rejected option B, at the cost of X, and would reconsider if Y" has no other home.
3. It must outlive the plan or PR that produced it — a future contributor has to confront it before reintroducing the bypass.

Exempt: mechanical edits (formatting, renames, dependency bumps, regenerated output), local edits whose whole rationale is visible in the code, tests, or PR description, and decisions already recorded — update or supersede the existing record, never write a second record for the same decision.

A record is the history of a change, not a description of the system it left behind: it states the decision and why the alternatives lost. The current state that decision produced — layers, boundaries, contracts, data flow, current paths and commands — belongs to `docs/specs/`, which the same PR keeps true to the code. A record that merely needs its stated paths refreshed is a freshness edit, not a new decision.

## Directory shape

```
docs/adr/{bucket}/{class}/yyyy-mm-dd-topic.md
```

- **Bucket** — the fate: `proposed/`, `implemented/`, `rejected/`, `archived/`.
- **Class** — the domain: `feature/`, `bug-fix/`, `simplification/`, `architecture/`, `process/`, `testing/`. There is no `refactor`: the judge is mechanical — observable behavior changes → `bug-fix` or `feature`; it does not → `simplification`. Adding a class needs a validator change in the same PR.
- **Filename** — the identity: the record's **original** date plus a lowercase kebab topic. It never changes across a lifecycle move; only the bucket directory moves.

## Header and skeletons

The first line is `# ADR: <title>`. The header block also carries one bare line `Status: <state> — <why>`, whose state must equal the containing bucket for `proposed/`, `implemented/` and `rejected/`; an archived record keeps `Status: implemented — <why>` and carries an `Archived:` line instead (see Lifecycle). The rest of the header (`Date:`, `Scope:`, `Supersedes:` / `Superseded-by:`, a self-path) is free-form.

- `proposed/TEMPLATE.md` — `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, `Risks`.
- `implemented/TEMPLATE.md` — `Problem`, `Decision`, `Alternatives considered`, `Consequences`. `Decision` is present tense ("identity flows through native channels"), never "we will".
- `rejected/` has no third template: it reuses the proposed skeleton's shape with a **frozen body**, but the gate requires only `Problem`, `Proposal` and `Alternatives considered` — the proposal-era `Acceptance criteria` and `Risks` sections are not required of a rejected record. After rejection, problem, proposal and alternatives are never rewritten — only the Status line says why the proposal died.

`Proposal`, `Plan`, `Migration plan` and `Acceptance criteria` are banned as sections of an implemented record: they are proposal-era scaffolding, and a promotion that keeps them is half-finished. Extra sections that are neither required nor banned stay — the contract fixes required and banned, not the whole skeleton.

## Lifecycle

Three moves exist, each landed as one PR — move, rewrite and header together, never a half state:

- **`proposed → implemented`** — move the file, rewrite `Proposal` into a present-tense `Decision`, fold `Acceptance criteria` and `Risks` into `Consequences` (criteria become stated behavior, risks become consequences with their mitigations), delete plan text, rewrite the Status line.
- **`proposed → rejected`** — move the file, freeze the body, put the reason in the Status line.
- **`implemented → archived`** — move the file to `archived/<class>/` with its filename unchanged, leave `Status: implemented — …` as it is, and add `Archived: YYYY-MM-DD — <reason>` immediately below that line.

Archive admission requires all three conditions:

1. The decision is fully superseded, or the mechanism it decided on is gone.
2. It no longer guides future work.
3. It retains historical value.

Failing (3) means **delete the record, not archive it**: Git keeps the bytes, and the tree keeps nothing that no longer earns its place. Length and age are discovery aids, never archive criteria.

An archived record is frozen: no body edits, no Status rewrite, and no maintenance of its outbound links, because the pages it cites are free to change without it. `proposed/` and `rejected/` records never archive — a rejected proposal is already a frozen fact, and a proposal that will not be implemented is rejected or deleted instead.

`archived/` is distinct from `superseded`. A superseded record is still a true statement about the system that has a replacement: it stays in its live bucket with both-way `Supersedes:` / `Superseded-by:` header lines, and a supersession search over the tree precedes the new record. An archived record is no longer authority at all. Active prose may link into it only to cite history, never as the statement of what the system does now; a later decision that revisits its subject states its own rationale rather than inheriting the old one.

A record never returns to `proposed/`. An `implemented` record is a live statement of the system, not history: the same PR that changes a path, name, or default the record states also updates the record. That is routine maintenance — no transition, no new record, and it stops applying once the record is archived.

## Deliberately absent

- `INDEX.md` — a second registry to maintain in every PR, and registries drift; the path already carries bucket, class and date.
- Bilingual siblings (`<topic>.zh.md`, `<topic>.i18n.yaml`) — records are English-only, like every tracked page under `docs/`.

## What the gate checks, and what it cannot

`bun run validation:drift` (Guard 12) checks membership, filename shape, `Status` agreeing with the directory for the three live buckets (and an `Archived:` line, with `Status: implemented`, for `archived/`), balanced code fences (an unterminated fence fails the record instead of hiding its tail), and the required and banned sections per bucket. The record-format checks walk `{bucket}/{class}/`, so a stray `.md` directly under `docs/adr/` or directly under a bucket root is invisible to them and review catches it rather than CI; the `INDEX.md` ban covers the whole tree, so an index at either level still fails. Two rules no tree walk can check, and both stay review duties:

1. **Why the decision mattered** — `Problem` carries real stakes (what breaks or re-breaks without it), not a restatement of the change. A present heading proves nothing.
2. **Whether the alternatives were real** — `Alternatives considered` lists options genuinely weighed and why each lost, not strawmen built after the fact.

The rejected-body and archived-body freezes, the same-PR freshness duty for live records, the supersession search and its links, and the title form are review obligations for the same reason: none of them is verifiable from one tree walk.
