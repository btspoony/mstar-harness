# dsh workflow scripts — canonical read-only fan-out templates

Copy-paste templates for the dsh **`workflow`** tool (`@deepseek-ai/dsh-tool-workflow`, mounted by the
shipped agent presets; the `ptc` preset disables it). Use them for **read-only** fan-out of **N ≥ 3**
seats — plan QC tri, large-repo audit categories, `/amazing-pr-review deep` seats. House rules and the
operator path live in skill **`mstar-host`** → `references/dsh.md` § Read-only fan-out via the `workflow`
tool; this file holds only the scripts, their `meta`, and their `args`.

## How to call

One `workflow` tool call carries three JSON/JS parameters:

- `script` — a plain-JavaScript body (NOT TypeScript, NO `export const meta` statement), top-level
  `await` allowed, ending with `return <JSON value>`.
- `meta` — plain JSON identity: `name` (short kebab-case), `description`, optional `whenToUse`,
  optional `phases[] = { title, detail? }`. `phase()` calls and `agent({ phase })` strings match
  `phases[].title` by exact string.
- `args` — plain JSON object exposed to the script verbatim as the `args` global.

Script hooks: `agent(prompt, opts?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`,
`log(message)`, `args`. `agent()` opts are exactly `label`, `phase`, `schema`, `provider`, `model` —
anything else (including the deferred agent-type selector and `effort` / `isolation`) is rejected
loudly and kills the script. With `schema` the child resolves to the validated object; on child
failure `agent()` resolves `null` (`parallel()` maps a throwing thunk to `null` the same way). No
filesystem, network, timers or Node APIs; concurrency and total-agent caps apply; the parent turn
blocks until the whole run settles.

Supported `schema` subset (object-rooted): `type`, `properties`, `required`, `additionalProperties`,
`items`, `enum`, `const`, `oneOf`, plus the ignored annotations `description` / `title` / `default` /
`examples`. Anything else (`pattern`, `format`, numeric bounds) is fatal.

Every `agent()` prompt below opens with the Assignment header (`## Assignment` + `Execute as` /
`Delegation` / `Task category`) — header first, because the engine reads only the header region, and
the role persona is resolved from `Execute as` (`packages/dsh/src/gates/role-persona.ts`). Children are
delegated children: approval is pinned to `never`, so a seat must never depend on writing files —
return everything in the result payload.

| Operator path | Script | `meta.name` | Seats |
|---|---|---|---|
| Plan QC tri (`Execution mode: sdd`) | § 1 | `mstar-qc-tri` | 3 (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`) |
| `/codebase-audit` large-repo category fan-out | § 2 | `mstar-audit-fanout` | 9 (one per audit category) |
| `/amazing-pr-review deep` | § 3 | `mstar-pr-seats` | 3–4 (2–3 domain + optional cross-domain security) |
| Any 1–2 read-only delegation | — | — | keep `subagent` — no script, no `workflow-run` node |

## 1. `mstar-qc-tri` — plan QC tri-review

Three independent read-only QC seats over one review range; each returns a verdict envelope. The
returned envelopes are the seat reports' content source: the caller persists
`{SDD_DIR}/review/qc1.md` … `qc3.md` from them (a seat may also write its own file best-effort when
its sandbox permits).

**`meta`**

```json
{
  "name": "mstar-qc-tri",
  "description": "Plan QC tri-review: three independent read-only QC seats over one review range, each returning a verdict envelope.",
  "whenToUse": "dsh host, Execution mode: sdd — the changed-scope plan QC tri instead of three subagent dispatches.",
  "phases": [
    { "title": "qc-tri", "detail": "Three concurrent read-only QC seats over the same review range." }
  ]
}
```

**`args`**

```json
{
  "planId": "<plan-id>",
  "planPath": "<absolute path to the main plan file>",
  "range": "<base>..<head>",
  "reviewCwd": "<absolute review worktree path>",
  "branch": "feature/<plan-id>",
  "sddDir": "<absolute path to the SDD dir>"
}
```

**`script`**

```js
const a = args ?? {}
const missing = ['planId', 'planPath', 'range', 'reviewCwd', 'branch', 'sddDir']
  .filter((key) => typeof a[key] !== 'string' || a[key].length === 0)
if (missing.length > 0) throw new Error('mstar-qc-tri missing args: ' + missing.join(', '))

const sddDir = a.sddDir.replace(/\/$/, '')

const VERDICT = {
  type: 'object',
  description: 'One QC seat verdict envelope.',
  required: ['seat', 'verdict', 'summary', 'findings'],
  properties: {
    seat: {
      type: 'string',
      enum: ['qc-specialist', 'qc-specialist-2', 'qc-specialist-3'],
      description: 'The seat that produced this envelope.',
    },
    verdict: {
      type: 'string',
      enum: ['Approve', 'Request Changes', 'Needs Discussion', 'Unconfirmed'],
    },
    summary: {
      type: 'string',
      description: 'Two or three sentences; state the critical/warning counts.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'title', 'verification', 'expectedVsObserved'],
        properties: {
          severity: { type: 'string', enum: ['Critical', 'Warning', 'Suggestion', 'Unconfirmed'] },
          title: { type: 'string', description: 'Short imperative title.' },
          location: { type: 'string', description: 'path/file.ts:123 evidence anchor.' },
          verification: { type: 'string', description: 'The cross-check used (diff/read/grep anchor or repro).' },
          expectedVsObserved: { type: 'string' },
          fix: { type: 'string', description: 'One line.' },
        },
      },
    },
  },
}

const opts = { phase: 'qc-tri', schema: VERDICT }

phase('qc-tri')

const seats = await parallel([
  () => agent(`## Assignment

Execute as: qc-specialist
Delegation: forbidden
Task category: audit

plan_id: ${a.planId}
Review range: ${a.range}
Review cwd: ${a.reviewCwd}
Working branch: ${a.branch}
Report path: ${sddDir}/review/qc1.md
Reviewer focus: architecture coherence and maintainability risk (reviewer_index 1)

You are the first of three INDEPENDENT read-only QC seats over the same review range. Do not consult or wait for the other seats.

Load in order: skill mstar-roles then references/qc-specialist-shared.md (identity first), then references/qc-specialist/report-template.md and references/qc-specialist/reviewer-checklist.md; the plan at ${a.planPath}.

Review only changed hunks and directly affected interfaces in the review range above against that plan. Reuse unchanged task-review evidence; for re-review inspect only assigned findings and fix delta. Every finding needs a verification cross-check and an expected-vs-observed line; prefer omission to fabrication. Do not run build or test suites (they are not your evidence channel). Never edit the worktree, never post, never merge, never touch project registers.

Return ONLY the JSON object matching the provided schema (seat, verdict, summary, findings). If your sandbox permits, also write the full report to the report path above — never depend on being able to write.`, { ...opts, label: 'qc1-architecture' }),
  () => agent(`## Assignment

Execute as: qc-specialist-2
Delegation: forbidden
Task category: audit

plan_id: ${a.planId}
Review range: ${a.range}
Review cwd: ${a.reviewCwd}
Working branch: ${a.branch}
Report path: ${sddDir}/review/qc2.md
Reviewer focus: security and correctness risk (reviewer_index 2)

You are the second of three INDEPENDENT read-only QC seats over the same review range. Do not consult or wait for the other seats.

Load in order: skill mstar-roles then references/qc-specialist-shared.md (identity first), then references/qc-specialist/report-template.md, references/qc-specialist/reviewer-checklist.md and references/qc-specialist/deep-review-lenses.md; the plan at ${a.planPath}.

Review only changed hunks and directly affected interfaces in the review range above against that plan. Reuse unchanged task-review evidence; for re-review inspect only assigned findings and fix delta, with the security and correctness lenses. Every finding needs a verification cross-check and an expected-vs-observed line; prefer omission to fabrication. Do not run build or test suites. Never edit the worktree, never post, never merge, never touch project registers.

Return ONLY the JSON object matching the provided schema (seat, verdict, summary, findings). If your sandbox permits, also write the full report to the report path above — never depend on being able to write.`, { ...opts, label: 'qc2-security-correctness' }),
  () => agent(`## Assignment

Execute as: qc-specialist-3
Delegation: forbidden
Task category: audit

plan_id: ${a.planId}
Review range: ${a.range}
Review cwd: ${a.reviewCwd}
Working branch: ${a.branch}
Report path: ${sddDir}/review/qc3.md
Reviewer focus: performance and reliability risk (reviewer_index 3)

You are the third of three INDEPENDENT read-only QC seats over the same review range. Do not consult or wait for the other seats.

Load in order: skill mstar-roles then references/qc-specialist-shared.md (identity first), then references/qc-specialist/report-template.md, references/qc-specialist/reviewer-checklist.md and references/qc-specialist/deep-review-lenses.md; the plan at ${a.planPath}.

Review only changed hunks and directly affected interfaces in the review range above against that plan. Reuse unchanged task-review evidence; for re-review inspect only assigned findings and fix delta, with the performance and reliability lenses. Every finding needs a verification cross-check and an expected-vs-observed line; prefer omission to fabrication. Do not run build or test suites. Never edit the worktree, never post, never merge, never touch project registers.

Return ONLY the JSON object matching the provided schema (seat, verdict, summary, findings). If your sandbox permits, also write the full report to the report path above — never depend on being able to write.`, { ...opts, label: 'qc3-perf-reliability' }),
])

// A null entry is a seat whose child failed: its verdict is missing and the caller
// must re-dispatch that seat (or report Blocked) — never synthesize a verdict for it.
return seats
```

## 2. `mstar-audit-fanout` — large-repo category fan-out

One read-only audit seat per category (the nine `mstar-audit` categories), each returning findings in
the audit finding format. Scope comes from `args.categories` (default: all nine); the reconciling,
vetting and plan-writing stay with the audit executor (main agent).

**`meta`**

```json
{
  "name": "mstar-audit-fanout",
  "description": "Large-repo codebase audit: one read-only audit seat per category, each returning findings in the audit finding format.",
  "whenToUse": "dsh host, /codebase-audit on a repo large enough to need per-category parallel read-only fan-out (N >= 3).",
  "phases": [
    { "title": "bug" },
    { "title": "security" },
    { "title": "perf" },
    { "title": "tests" },
    { "title": "tech-debt" },
    { "title": "migration" },
    { "title": "dx" },
    { "title": "docs" },
    { "title": "direction" }
  ]
}
```

**`args`**

```json
{
  "repo": "<absolute path to the repo under audit>",
  "auditRef": "<absolute path to the mstar-audit skill references dir>",
  "recon": "<recon facts: languages, frameworks, key directories, what to skip, decided tradeoffs>",
  "categories": ["bug", "security", "perf"]
}
```

`categories` is optional — omit it for all nine. Keep the batch at one seat per category (concurrency
caps apply above the fan-out width).

**`script`**

```js
const a = args ?? {}
const missing = ['repo', 'auditRef', 'recon']
  .filter((key) => typeof a[key] !== 'string' || a[key].length === 0)
if (missing.length > 0) throw new Error('mstar-audit-fanout missing args: ' + missing.join(', '))

const ALL = ['bug', 'security', 'perf', 'tests', 'tech-debt', 'migration', 'dx', 'docs', 'direction']
const categories = Array.isArray(a.categories) && a.categories.length > 0 ? a.categories : ALL

const FINDING = {
  type: 'object',
  description: 'One audit category seat payload.',
  required: ['category', 'findings'],
  properties: {
    category: { type: 'string', enum: ALL },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence', 'impact', 'effort', 'risk', 'confidence', 'fix'],
        properties: {
          title: { type: 'string', description: 'Short imperative title.' },
          evidence: { type: 'string', description: 'path/file.ts:123 plus one sentence (2-5 strongest locations).' },
          impact: { type: 'string', description: 'What goes wrong / what is being paid.' },
          effort: { type: 'string', enum: ['XS', 'S', 'M', 'L', 'XL'] },
          risk: { type: 'string', enum: ['LOW', 'MED', 'HIGH'], description: 'What the fix could break, plus one line why.' },
          confidence: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
          fix: { type: 'string', description: 'One to three sentences — a sketch, not the plan.' },
        },
      },
    },
    notes: { type: 'string', description: 'Truncated coverage declaration and leads that are not findings.' },
  },
}

const seatPrompt = (category) => `## Assignment

Execute as: code-reviewer
Delegation: forbidden
Task category: audit

Audit category: ${category}
Repo under audit: ${a.repo}
Reference root: ${a.auditRef}

Read-only audit seat (one category of a parallel fan-out; the audit executor reconciles, vets and writes plans — you do not).

Recon facts already established: ${a.recon}

Load in order: ${a.auditRef}/audit-playbook.md section for your category plus the section "Finding format" (read it first — findings must match that shape exactly); for the security category also read ${a.auditRef}/security-review.md. Open every location you cite yourself, in ${a.repo}.

Report only what you can evidence: exact file:line anchors, a concrete impact, an honest effort on the XS-XL scale, the risk of the fix, and a HIGH/MED/LOW confidence. LOW-confidence items are allowed but are leads, not plan candidates. Do not edit any file, do not run project-wide suites, never reproduce secret values.

Return ONLY the JSON object matching the provided schema (category, findings, notes). Put the truncated-coverage declaration and any non-finding leads in notes.`

const seats = await parallel(categories.map((category) => () =>
  agent(seatPrompt(category), { label: category, phase: category, schema: FINDING })))

// A null entry is a category whose seat failed — the caller reports the uncollected
// category as such; it is never reported as "no findings".
return seats
```

## 3. `mstar-pr-seats` — `/amazing-pr-review deep` seats

Domain seats (2–3) plus an optional independent cross-domain security seat, all read-only, all
returning findings with a merge class and **no verdict** — synthesis (dedupe, tiered vet, tally,
verdict, posting) stays with the main agent, exactly as the `pr` variant requires. Do not use this
script for the `default` tier (two seats → `subagent`) or `quick` (one seat).

**`meta`**

```json
{
  "name": "mstar-pr-seats",
  "description": "Deep PR review: read-only domain review seats (2-3) plus an optional independent cross-domain security seat, each returning findings with a merge class and no verdict.",
  "whenToUse": "dsh host, /amazing-pr-review deep (3-4 seats) after the review worktree and diff basis are resolved.",
  "phases": [
    { "title": "pr-seats", "detail": "Domain review seats plus the cross-domain security seat." }
  ]
}
```

**`args`**

```json
{
  "worktree": "<absolute review worktree path>",
  "target": "<owner>/<repo>#<n> or branch:<slug> or diff:<short-sha>",
  "diffBase": "<base>..<head>",
  "diffFile": "<absolute path to the pinned diff snapshot, when worktree-setup produced one>",
  "reportsDir": "<absolute directory for the stage-2 evidence files>",
  "auditRef": "<absolute path to the mstar-audit skill references dir>",
  "domains": ["code", "tests"],
  "security": true
}
```

`domains` holds 2–3 domain labels (business domain / change surface / tech stack); with
`security: true` (the default) the seat count is 3 or 4.

**`script`**

```js
const a = args ?? {}
const missing = ['worktree', 'target', 'diffBase', 'reportsDir', 'auditRef']
  .filter((key) => typeof a[key] !== 'string' || a[key].length === 0)
if (missing.length > 0) throw new Error('mstar-pr-seats missing args: ' + missing.join(', '))

const domains = Array.isArray(a.domains) ? a.domains : []
if (domains.length < 2 || domains.length > 3) {
  throw new Error('mstar-pr-seats: args.domains must hold 2-3 domain labels (deep tier) — got ' + domains.length)
}
const withSecurity = a.security !== false
const diffHint = typeof a.diffFile === 'string' && a.diffFile.length > 0
  ? 'the pinned diff snapshot at ' + a.diffFile + ', plus ' + a.diffBase + ' in ' + a.worktree
  : a.diffBase + ' in ' + a.worktree

const SEAT = {
  type: 'object',
  description: 'One read-only PR review seat payload (findings only — the seat produces no verdict).',
  required: ['domain', 'findings'],
  properties: {
    domain: { type: 'string', description: 'The seat domain label.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence', 'impact', 'effort', 'risk', 'confidence', 'mergeClass', 'fix'],
        properties: {
          title: { type: 'string', description: 'Short imperative title.' },
          evidence: { type: 'string', description: 'path/file.ts:123 — code you opened yourself.' },
          impact: { type: 'string' },
          effort: { type: 'string', enum: ['XS', 'S', 'M', 'L', 'XL'] },
          risk: { type: 'string', enum: ['LOW', 'MED', 'HIGH'] },
          confidence: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
          mergeClass: { type: 'string', enum: ['must-fix', 'should-fix', 'nit'] },
          fix: { type: 'string', description: 'One line.' },
        },
      },
    },
    leads: { type: 'array', items: { type: 'string' }, description: 'MEDIUM/unverified observations — leads, not findings.' },
    notes: { type: 'string', description: 'Truncated-coverage declaration and cross-domain notes.' },
  },
}

const seatPrompt = (domain, extra) => `## Assignment

Execute as: code-reviewer
Delegation: forbidden
Task category: audit

Review target: ${a.target}
Review worktree: ${a.worktree}
Domain: ${domain}
Diff basis: ${a.diffBase}
Stage: Stage 2 domain review — read-only, you never post and never produce the verdict.

Read-only audit seat in the three-stage PR review pipeline; the main agent synthesizes one verdict and posts.

Load in order: skill mstar-audit then SKILL.md and references/pr-review-seat-evidence.md; ${a.auditRef}/pr-review.md sections "Review pipeline", "Merge class" and "Verdict synthesis"; ${a.auditRef}/finding-format.md for the finding fields. Then read ${diffHint}. Open the cited code yourself — a relayed claim from another seat is not evidence.

Conclude ONLY on your own domain (${domain}).${extra} Return findings with merge class must-fix | should-fix | nit, an XS-XL effort, a risk level, a confidence and a one-line fix sketch. Cross-domain boundary issues go to notes, not findings. Do not edit the worktree, do not run project-wide suites, never reproduce secret values.

Return ONLY the JSON object matching the provided schema (domain, findings, leads, notes). No verdict.`

phase('pr-seats')

const thunks = domains.map((domain, index) => () => agent(
  seatPrompt(domain, ''),
  { label: 'domain-' + (index + 1), phase: 'pr-seats', schema: SEAT },
))

if (withSecurity) {
  thunks.push(() => agent(
    seatPrompt('security (cross-domain)', ' Run the security lens from ' + a.auditRef + '/security-review.md across the whole diff, independent of the domain seats: trace data flow to its origin, never invent an attacker, never record secret values.'),
    { label: 'security-cross-domain', phase: 'pr-seats', schema: SEAT },
  ))
}

const seats = await parallel(thunks)

// A null entry is an uncollected domain (seat crashed or returned nothing) — the caller
// declares it as uncollected under the report notes and never reads it as "no findings".
return seats
```
