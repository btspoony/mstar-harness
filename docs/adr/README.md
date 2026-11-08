# Architecture decision records

Every record here is one decision this repository made **among real alternatives**, filed so a reader finds it without an index: the bucket gives the fate, the class the domain, the date sorts the rest.

## When a record is required

Write one when all three hold:

1. A decision was made or is proposed among real alternatives — something was rejected, or accepted at a cost.
2. Its rationale cannot be reconstructed from the code, tests, or existing docs — "we rejected option B, at the cost of X, and would reconsider if Y" has no other home.
3. It must outlive the plan or PR that produced it — a future contributor has to confront it before reintroducing the bypass.

Exempt: mechanical edits (formatting, renames, dependency bumps, regenerated output), local edits whose whole rationale is visible in the code, tests, or PR description, and decisions already recorded — update or supersede the existing record, never write a second record for the same decision.

## Directory shape

```
docs/adr/{bucket}/{class}/yyyy-mm-dd-topic.md
```

- **Bucket** — the fate: `proposed/`, `implemented/`, `rejected/`.
- **Class** — the domain: `feature/`, `bug-fix/`, `simplification/`, `architecture/`, `process/`, `testing/`. There is no `refactor`: the judge is mechanical — observable behavior changes → `bug-fix` or `feature`; it does not → `simplification`. Adding a class needs a validator change in the same PR.
- **Filename** — the identity: the record's **original** date plus a lowercase kebab topic. It never changes across a lifecycle move; only the bucket directory moves.

## Header and skeletons

The first line is `# ADR: <title>`. The header block also carries one bare line `Status: <bucket> — <why>`, whose bucket must equal the containing directory; the rest of the header (`Date:`, `Scope:`, `Supersedes:` / `Superseded-by:`, a self-path) is free-form.

- `proposed/TEMPLATE.md` — `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, `Risks`.
- `implemented/TEMPLATE.md` — `Problem`, `Decision`, `Alternatives considered`, `Consequences`. `Decision` is present tense ("identity flows through native channels"), never "we will".
- `rejected/` has no third template: it reuses the proposed skeleton's shape with a **frozen body**, but the gate requires only `Problem`, `Proposal` and `Alternatives considered` — the proposal-era `Acceptance criteria` and `Risks` sections are not required of a rejected record. After rejection, problem, proposal and alternatives are never rewritten — only the Status line says why the proposal died.

`Proposal`, `Plan`, `Migration plan` and `Acceptance criteria` are banned as sections of an implemented record: they are proposal-era scaffolding, and a promotion that keeps them is half-finished. Extra sections that are neither required nor banned stay — the contract fixes required and banned, not the whole skeleton.

## Lifecycle

Only two moves exist, each landed as one PR — move, rewrite and Status line together, never a half state:

- **`proposed → implemented`** — move the file, rewrite `Proposal` into a present-tense `Decision`, fold `Acceptance criteria` and `Risks` into `Consequences` (criteria become stated behavior, risks become consequences with their mitigations), delete plan text, rewrite the Status line.
- **`proposed → rejected`** — move the file, freeze the body, put the reason in the Status line.

There is no archive step, and a record never returns to `proposed/`: length and age are discovery aids, never archive criteria, and reversal is a **new** record that supersedes the old one — both-way `Supersedes:` / `Superseded-by:` header lines, with a supersession search over the tree before the new record is written.

An `implemented` record is a live statement of the system, not history: the same PR that changes a path, name, or default the record states also updates the record. That is routine maintenance — no transition, no new record.

## Deliberately absent

- `archived/` — it would make "old" a legal reason to move a record, so rejected bodies would stop being frozen facts and implemented records would stop being kept fresh.
- `INDEX.md` — a second registry to maintain in every PR, and registries drift; the path already carries bucket, class and date.
- Bilingual siblings (`<topic>.zh.md`, `<topic>.i18n.yaml`) — records are English-only, like every tracked page under `docs/`.

## What the gate checks, and what it cannot

`bun run validation:drift` (Guard 12) checks membership, filename shape, `Status` agreeing with the directory, balanced code fences (an unterminated fence fails the record instead of hiding its tail), and the required and banned sections per bucket. The record-format checks walk `{bucket}/{class}/`, so a stray `.md` directly under `docs/adr/` or directly under a bucket root is invisible to them and review catches it rather than CI; the `INDEX.md` ban covers the whole tree, so an index at either level still fails. Two rules no tree walk can check, and both stay review duties:

1. **Why the decision mattered** — `Problem` carries real stakes (what breaks or re-breaks without it), not a restatement of the change. A present heading proves nothing.
2. **Whether the alternatives were real** — `Alternatives considered` lists options genuinely weighed and why each lost, not strawmen built after the fact.

The rejected-body freeze, the same-PR freshness duty, the supersession search and its links, and the title form are review obligations for the same reason: none of them is verifiable from one tree walk.
