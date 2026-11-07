# dsh workflow scripts — call contract for the four read-only fan-out scripts

Templates for the dsh **`workflow`** tool (`@deepseek-ai/dsh-tool-workflow`, mounted by the shipped agent presets; the `ptc` preset disables it). The script bodies ship as real files under `packages/dsh/workflows/`; this file is their call contract — when to use each one, what to pass, what it guarantees, and how it fails. House rules and the operator path live in skill **`mstar-host`** → `references/dsh.md` § Read-only fan-out via the `workflow` tool.

## How to call

One `workflow` tool call carries three parameters:

- `script` — the shipped file's body, passed **verbatim**: read the file at the dsh package root — `@mstar-harness/dsh/workflows/<name>.js` in an installed host, `packages/dsh/workflows/<name>.js` in this repo's checkout — and hand its text over unchanged. It is plain JavaScript (native TypeScript is not accepted), it declares no `export const meta` statement, and it ends with `return <JSON value>`. `scripts/dsh-workflow-files-hash.test.ts` checks the delivery surface instead — every shipped body parses, `package.json` ships the `workflows` directory, and each `meta` identity here plus the `**File**` anchors below name exactly the scripts on disk.
- `meta` — plain JSON identity: `name` (short kebab-case, the allowlist key of the host's `workflowGate`), `description`, optional `whenToUse`, optional `phases[] = { title, detail? }`. `phase()` calls and `agent({ phase })` strings match `phases[].title` by exact string. Each section below carries its `meta` as one JSON line.
- `args` — plain JSON object, exposed to the script verbatim as the `args` global.

Script hooks: `agent(prompt, opts?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(message)`, `args`. `agent()` opts are exactly `label`, `phase`, `schema`, `provider`, `model` — anything else (including the deferred agent-type selector and `effort` / `isolation`) is rejected loudly and kills the script. With `schema` the child resolves to the validated object; on child failure `agent()` resolves `null`, and `parallel()` maps a throwing thunk to `null` the same way. No filesystem, network, timers or Node APIs; concurrency and total-agent caps apply; the parent turn blocks until the whole run settles.

Supported `schema` subset (object-rooted): `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `oneOf`, plus the ignored annotations `description` / `title` / `default` / `examples`. Anything else (`pattern`, `format`, numeric bounds) is fatal.

**Read-only guarantee.** Every seat is a delegated child with approval pinned to `never`: a seat can depend on no file write, so each script returns its whole payload in the result and the caller persists anything durable. Each prompt opens with the Assignment header below — header first, because the engine reads only the header region and resolves the role persona from `Execute as` (the dsh gate compiled into the package's `dist/`; its source is `src/gates/role-persona.ts` at the package root):

```markdown
## Assignment

Execute as: <role-id>
Delegation: forbidden
Task category: audit
**Budget (review / QC seats)**: /1 round — one pass over the assigned scope
**Return shape (review / QC seats)**: the result envelope; stop when the assigned scope is covered
```

## Seat count — which carrier runs N seats

**N ≥ 3** is the `workflow` tool's designed width; **1–2 seats are carried by `subagent`**, and read-only fan-out never takes a teammate at any N. Where the Team layer disables `subagent`, the script follows the work, not the seat count: a 2-seat PR review runs § 3 with the tier's two domain lenses, and a 2-category audit runs § 2 with two `categories` (§ 3 requires `target` + `diffBase`, so it never carries an audit). Separately, a one-seat SDD task review must not consume a roster slot, so one-seat § 4 run is a **supported** route on a Team profile, not an improvisation. Any other 1–2 read-only delegation routes the same way: SDD task review → § 4, 2-seat PR review → § 3, 2-category audit → § 2. Writable fan-out never uses `workflow` — it has no per-child pre-start veto seam.

| Operator path | Script | Seats |
|---|---|---|
| Plan QC tri (`Execution mode: sdd`, conversation-only review) | § 1 `mstar-qc-tri` | 3 (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`) |
| `/codebase-audit` large-repo category fan-out | § 2 `mstar-audit-fanout` | 9 (one per audit category); 2 on a Team-only profile |
| `/amazing-pr-review deep` | § 3 `mstar-pr-seats` | 3–4 (2–3 domain + optional cross-domain security) |
| `/amazing-pr-review` default tier on a Team-only profile | § 3 `mstar-pr-seats` | 2 domain lenses the tier selected |
| SDD task review that must not take a Team roster seat | § 4 `mstar-review-single` | 1 |

## 1. `mstar-qc-tri` — plan QC tri-review

**File** `@mstar-harness/dsh/workflows/mstar-qc-tri.js` (this repo: `packages/dsh/workflows/mstar-qc-tri.js`) · **Use** the changed-scope plan QC tri on a dsh host instead of three `subagent` dispatches; legal only when the Assignment declares **conversation-only review** (`QC report path: N/A`) — the caller persists `{SDD_DIR}/review/qc1.md` … `qc3.md` from the returned envelopes. A plan-backed QC seat that must write its own report routes through a writable channel (`dsh.md` § QC default). Three seats are within the child pool (`maxActiveSubagents`, default 8) by construction — no chunking.

**`meta`**
```json
{ "name": "mstar-qc-tri", "description": "Plan QC tri-review: three independent read-only QC seats over one review range, each returning a verdict envelope.", "whenToUse": "dsh host, Execution mode: sdd — the changed-scope plan QC tri instead of three subagent dispatches.", "phases": [{ "title": "qc-tri", "detail": "Three concurrent read-only QC seats over the same review range." }] }
```

`args` — all six are required strings; the guard throws naming every missing key, and `sddDir` loses a trailing slash before the report paths are built:
```json
{ "planId": "<plan-id>", "planPath": "<absolute main plan path>", "range": "<base>..<head>", "reviewCwd": "<absolute review worktree>", "branch": "feature/<plan-id>", "sddDir": "<absolute SDD dir>" }
```

**Each seat** loads `mstar-roles`, then `references/qc-specialist-shared.md` (identity first), the report template and checklist, and its own lens file; reviews only changed hunks and directly affected interfaces against the plan; reuses unchanged task-review evidence; and must not edit the worktree, post, merge, touch project registers, or run build/test suites. It returns the verdict envelope `{ seat, verdict, summary, findings }` and, only if its sandbox allows, also writes its report path.

**Failure surface** a seat whose child failed resolves to `null`: its verdict is missing and the caller must re-dispatch that seat or report `Blocked` — never synthesize a verdict for it.

## 2. `mstar-audit-fanout` — large-repo category fan-out

**File** `@mstar-harness/dsh/workflows/mstar-audit-fanout.js` (this repo: `packages/dsh/workflows/mstar-audit-fanout.js`) · **Use** `/codebase-audit` on a repo large enough to need per-category read-only fan-out; a Team-only profile runs it at two `categories`. Reconciling, vetting and the review report stay with the audit executor (main agent).

**`meta`**
```json
{ "name": "mstar-audit-fanout", "description": "Large-repo codebase audit: one read-only audit seat per category, each returning findings in the audit finding format.", "whenToUse": "dsh host, /codebase-audit on a repo large enough to need per-category parallel read-only fan-out (N >= 3).", "phases": [{ "title": "bug" }, { "title": "security" }, { "title": "perf" }, { "title": "tests" }, { "title": "tech-debt" }, { "title": "migration" }, { "title": "dx" }, { "title": "docs" }, { "title": "direction" }] }
```

`args` — `repo`, `auditRef` and `recon` are required strings; `categories` is optional and omitted means all nine:
```json
{ "repo": "<absolute path under audit>", "auditRef": "<absolute mstar-audit references dir>", "recon": "<established recon facts>", "categories": ["bug", "security"] }
```

**Seat count** one seat per category. The seats resolve through the host subagent pool, capped at `maxActiveSubagents` (default 8; an over-cap activation is a hard-rejected fatal `AGENT_START` that kills the whole run). The workflow tool's own concurrency — `min(16, cores - 2)` — is an independent cap that exceeds 8 on hosts with more than 10 logical CPUs, so a single `parallel()` over all nine would exceed the pool there; the script launches `Math.min(8, categories.length)` seats per sequential batch, keeping in-flight children ≤ 8 on any host. `scripts/dsh-workflow-script-bounds.test.ts` executes the shipped body against recording doubles and pins that depth behaviour independent of the host core count.

**Each seat** reads its category section plus the playbook's finding-format section (security also `security-review.md`), opens every location it cites, and reports file:line evidence, impact, XS–XL effort, fix risk and confidence — never editing, never running project-wide suites, never reproducing secret values. LOW-confidence items are leads, not findings.

**Failure surface** a `null` entry is a category whose seat failed: the caller reports that category as uncollected, never as "no findings".

## 3. `mstar-pr-seats` — `/amazing-pr-review deep` seats

**File** `@mstar-harness/dsh/workflows/mstar-pr-seats.js` (this repo: `packages/dsh/workflows/mstar-pr-seats.js`) · **Use** the `deep` tier (3–4 seats) once the review worktree and diff basis are resolved; on a Team-only profile it IS the `default`-tier carrier, run with the tier's two domain lenses. Do not use it for the `default` tier while `subagent` is available, nor for `quick`. Its 3–4 seats sit within the child pool by construction.

**`meta`**
```json
{ "name": "mstar-pr-seats", "description": "Deep PR review: read-only domain review seats (2-3) plus an optional independent cross-domain security seat, each returning findings with a merge class and no verdict.", "whenToUse": "dsh host, /amazing-pr-review deep (3-4 seats) after the review worktree and diff basis are resolved.", "phases": [{ "title": "pr-seats", "detail": "Domain review seats plus the cross-domain security seat." }] }
```

`args` — `worktree`, `target`, `diffBase`, `auditRef` and `budgetLine` are required strings; `domains` holds 2–3 labels (the guard throws otherwise) and `security` defaults to true, so the seat count is 3 or 4. `budgetLine` is required because these seats are fire-and-forget and cannot be nudged mid-run: take it from `mstar pr-review budget` plus the review's own clock (`mstar-audit` `references/pr-review.md` § Seat supervision):
```json
{ "worktree": "<absolute review worktree>", "target": "<owner>/<repo>#<n> | branch:<slug> | diff:<short-sha>", "diffBase": "<base>..<head>", "diffFile": "<pinned diff snapshot, optional>", "auditRef": "<absolute mstar-audit references dir>", "domains": ["code", "tests"], "security": true, "budgetLine": "<tier + shared soft cap + minutes left>" }
```

**Each seat** opens the cited code itself (a relayed claim from another seat is not evidence), concludes only on its own domain, and returns findings with merge class `must-fix | should-fix | may-fix | nit`, effort, risk, confidence and a one-line fix. Cross-domain boundary issues go to `notes`. No verdict: synthesis (dedupe, tiered vet, tally, posting) stays with the main agent.

**Failure surface** a `null` entry is an uncollected domain (crashed or empty): the caller declares it under the report notes and never reads it as "no findings".

## 4. `mstar-review-single` — one read-only task-review seat

**File** `@mstar-harness/dsh/workflows/mstar-review-single.js` (this repo: `packages/dsh/workflows/mstar-review-single.js`) · **Use** one fresh-context SDD task reviewer that must not consume a Team roster slot (a teammate is a durable seat and the roster is finite). The run costs one `workflow-run` node instead of a subagent card — the price of keeping the reviewer off the roster; one seat is far below the child pool, so no chunking applies.

**This is Mode A, the SDD task reviewer, and the only mode it has.** The argument guard requires the task fields, so a PR or audit review cannot be routed here; the header's `Task category` is therefore not `audit` (an `audit` category selects `code-reviewer` Mode B and would run the wrong workflow). Writable work never uses this route.

**`meta`**
```json
{ "name": "mstar-review-single", "description": "One read-only SDD task-review seat (code-reviewer Mode A, fresh context, no roster seat), returning the complete canonical task-review report.", "whenToUse": "dsh host: a mandatory SDD task review that must not consume a Team roster seat (the Team profile disables the direct subagent rows).", "phases": [{ "title": "task-review", "detail": "One fresh-context Mode A task reviewer." }] }
```

`args` — every key except `reviewerFocus` is a required string; the guard throws naming what is missing:
```json
{ "planId": "<plan id>", "taskId": "<task id>", "reviewCwd": "<absolute feature worktree>", "branch": "<working branch>", "briefPath": "<absolute task brief>", "implementerReport": "<absolute implementer report (input)>", "diffFile": "<absolute review-package diff>", "diffBase": "<base sha>", "diffHead": "<head sha>", "globalConstraints": "<plan Global Constraints, verbatim>", "reviewerFocus": "<optional focus>" }
```

**Each seat** is diff-first: read the diff once, never re-run git, never mutate the checkout, never run build/test suites; spec compliance against the brief and constraints comes first, then code quality, and the implementer report's claims stay unverified until checked. The payload is the **complete canonical report** (`reportMarkdown`) plus `taskQuality` (the gate the PM reads); the caller persists `reportMarkdown` to `{SDD_DIR}/task-<n>-review.md` — the child's own write is best-effort, never the contract.

**Failure surface** a `null` seat throws in-script ("dispatch it again rather than recording an unreviewed task"); `truncatedCoverage` blocks completing the uncovered scope.
