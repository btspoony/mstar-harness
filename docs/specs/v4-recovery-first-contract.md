# V4 recovery-first product contract

Status: product specification for the recovery-first wave (iteration `iter-20260928-v4-recovery-first`), written by the product seat during Phase 1 (2026-09-28). Implementation has not started; nothing here claims a fix landed or a bug closed. This file is the long-lived product authority for the wave; the live per-issue tracking state lives in the iteration package (`../iterations/iter-20260928-v4-recovery-first/specs/issue-ownership-matrix.md`).

Authority chain (highest first): the user's locked decisions recorded in `plans/20260927-v4-release-readiness.md`; the accepted recovery design `plans/20260927-v4-progress-without-false-blockers.md` (recovery classes R1–R12, scenario groups A01–A30, slices S1–S6, §4.1 component rules, §9 gate-disposition ledger); the accepted closure matrix `plans/20260927-v4-known-bug-clearance.md`; then this contract. This contract references those documents and adds product rules plus the source-current technical handoff below; it does not replace the accepted recovery design. Where they conflict with a later user decision, the user decision wins.

## Product outcomes

The wave is done when a real caller of the harness observes all of the following:

1. **Ordinary intent completes.** Registering, amending, correcting, completing and closing work reaches its effect through ordinary commands, with derivable omissions derived, recoverable bookkeeping applied by the engine, and at most one grouped question containing the genuinely unresolved decisions. No agent-operated repair, CAS or token ceremony anywhere in the transcript (recovery design §3.1, R1–R12; scenarios A01–A30 are the acceptance basis, by reference).
2. **The command surface is self-describing.** An agent can build a valid payload from the CLI alone for every payload-taking command, including the `issue` family verbs; a refusal names every non-derivable problem at once, is classified as validation (never `internal-error` for missing input), and derivation runs before rejection (#288, expanded 2026-09-28).
3. **Every declared lifecycle state has a supported writer.** Report-only completion, failed and stopped terminal states are reachable through each supported authority route and both transports; completion fulfilment is recorded before row Done (#270; R10/R11, A17/A21).
4. **Amendment derives intent from facts.** Any recognized declaration form (e.g. `Working branch policy`) or branch anchor satisfies branch intent; independent amendment components land separately with explicit applied/unresolved results, dependency-connected components stay atomic; unrelated drift never blocks the addressed correction (#278; recovery design §4.1).
5. **Manual registration enters Prepare through ordinary commands.** Phase is derived from lifecycle facts at registration/admission; the `not-prepare` dead end and the CAS escape hatch are gone (#293; A04).
6. **Evidence-honest closure.** Zero unresolved confirmed bugs across all severities at the acceptance snapshot over the full open inventory (not a label filter, not a seven-issue cap); every closed issue cites executed verification; source presence, merged PRs, downgrades, relabels, deferrals and partial #282 closure never count (accepted clearance matrix, by reference).
7. **A disabled preference is a choice, not an error.** With any optional integration preference off, its lifecycle anchors return success-shaped no-ops with the fact retained in details; no tool error, no re-enabling notice, no user ruling mid-iteration (#299 — the omp model-handoff anchors are the concrete instance; the rule is the product generalization of recovery design §6.2's "no-op is success").
8. **Provenance is answerable without leaking.** "Which seat, which model, when, which iteration" is answerable from process-local control-root records for every planning-document edit (model recorded as actual when observable, `unknown` otherwise); tracked artifacts carry synthetic examples only (#295 resolution, D10 below).
9. **Tests assert product behavior.** The keep/delete rule holds across every inventoried package: keep product-behavior assertions and fails-first regression defenses; delete incidental/source-shape/wiring/environment-constant assertions — deleted, never renamed or re-pinned (#282).
10. **Development acceptance stays isolated.** Unit/component/integration fixtures plus actual built CLI/MCP smoke gate development; no live-API, named-host, installed-artifact, browser or device evidence is demanded, and the QA/QC contracts forbid demanding it (#283).

## Scope and plan ownership

Slices S1–S6 and all nine open issues (2026-09-28: #248 #270 #278 #282 #283 #288 #293 #295 #299) distribute across exactly four plans; task splitting does not reduce scope:

| Plan | Slices | Primary issue ownership |
|---|---|---|
| 20260928-recovery-engine | S1–S3 | #278, #293, #270 engine half |
| 20260928-recovery-transports | S4–S5 | #288 (expanded), #299 runtime half, #270 transport half |
| 20260928-recovery-policy | S6 | #282 Slice A, #283, #295, #299 doc half |
| 20260928-recovery-clearance | — | #282 all package slices, #248, #270 acceptance, closure evidence for all nine |

Split halves of one issue (#270, #299, #282) close only together with their issue; cross-plan dependencies and the final integration obligation preserve the complete engine/CLI/MCP cutover — no plan is independently "done" against a partially migrated surface. The `packages/omp` model-handoff extension (#299 runtime half) is an explicitly assigned host seam inside recovery-transports, not part of the shared command registry; the architect's decomposition records its exact files and its write handoff against the `omp` test corpus.

## Durable product rules

- **No per-issue exceptions, no new gate layers.** Fixes close the class through generic recovery mechanisms; any optional machine check must itself be clearable, actionable and never a new deadlock, with its executable need justified (#283, #295 enforcement).
- **Refusal burden of proof.** A refusal must name the smallest unresolved fact/decision, the competing facts, the withheld effect and the remaining available work, after discovery and recovery were attempted (recovery design §1.3, by reference).
- **Outcomes are honest.** No-ops and already-satisfied intents return success; partial compound results report applied and unresolved components; status codes never instruct a host to stop all work (recovery design §6.2, by reference).
- **Provenance split (D10).** Process-local, gitignored control-root artifacts carry actual attribution (seat, model-or-`unknown`, ISO-8601 timestamp, iteration); tracked code and docs never disclose real plan/iteration IDs, local SHAs or acceptance labels and use synthetic examples — repository `AGENTS.md` policy is unchanged and never weakened; a child's model is never inferred, only observed or `unknown`.
- **Bilingual mirror.** README usage changes land in English and Chinese in the same change.
- **Real-environment work is separately authorized.** No live store upgrade/activation, installed-plugin refresh, credential/config writes, release preparation/publication or automatic merge is part of this wave; operational follow-ups (e.g. roadmap G−1) are tracked operationally and never gate product closure.

## Acceptance

The iteration compass `Acceptance Criteria` (AC1–AC9) is the acceptance list of record for this wave; R1–R12 and A01–A30 remain the behavioral acceptance basis and §9's census the completion definition, both by reference to the accepted recovery design. Issue-level closure evidence digests live in the iteration matrix. Development evidence boundaries follow outcome 10 and compass D6.

## Non-goals

Unchanged from the compass: no OpenCode V2 or Jev 3b delivery here; no live migration/activation or installed-consumer upgrades; no new recovery DSL/broker/scheduler/daemon/state store/batch language/force switch; no repository-wide audit beyond the selected GitHub clearance surface; no v4.0 release authorization.

## Sequencing

Engine contracts (S1) precede transport implementation; rule writing (policy) can start independently, final recovery prose follows the implemented contract; sweeps follow the written rule and transfer test files only after their implementing owner finishes; final acceptance follows all three upstream plans, with #248 verification allowed earlier. Cross-plan integration is serial and coordinator-owned.

## Technical handoff contract

The following is a **target contract**, not a claim that these interfaces already exist. Source-current baseline: `c31d59bdd0ca2321bfdc256e5f7f1349e986bf1f`, inspected 2026-09-28. Exact implementation owners and bounded tasks live in the four plans; the decisions here remain valid beyond their task numbering.

### One resolver path, two existing authorities

- Keep existing public operation names. Their public intent inputs allow omitted redundant selectors, revisions, session projections and copied metadata; their transaction-local resolved inputs stay strict. Every exported direct operation enters the same resolution path, not a new convenience wrapper beside an unchanged strict public path.
- Resolve from explicit selection plus trusted invocation association, then authoritative records and referenced declarations. Never select the sole/most-recent workflow without an association. Current authority selects DB versus supported pre-activation file behavior; flags do not select authority and a failed DB read never falls back to files.
- Reuse `InvocationContext` (`packages/commands/src/types.ts:43-51`) without importing commands into engine. A small engine-owned `IntentContext` carries the needed subset and an independently acquired identity. A role string or session reference is a selector, not authority; no leaf receives coordinator credentials.
- No persistent recovery graph, registry, journal or new store is introduced. DB composition uses the existing `withExecutionTransaction` handle; file composition uses existing locks and owned journals. A read computes a derived view without writes. The first relevant normal mutation persists its repair.

Proposed engine-owned types (S1 freezes exports and migrates callers; spelling changes require a coordinated contract update):

```ts
type IntentContext = Readonly<{
  cwd: string;
  controlRoot?: string;
  identity?: ExecutionIdentity;
  requestId?: string;
}>;
type RecoveryProblem = Readonly<{
  component: string;
  path: string;
  code: string;
  sourcesTried: readonly string[];
  currentFacts: readonly string[];
  needed: string;
  withheldEffect: string;
  availableWork: readonly string[];
}>;
type RecoveryDetails = Readonly<{
  outcome: "applied" | "already-satisfied" | "partial" | "unresolved";
  target: Readonly<{ workflowId?: string; planId?: string; entityId?: string }>;
  applied: readonly string[];
  unresolved: readonly RecoveryProblem[];
  resolvedFrom: readonly Readonly<{ path: string; source: string }>[];
  warnings: readonly Readonly<{ code: string; path?: string; message: string }>[];
  commitState: "none" | "committed" | "partial" | "unknown";
}>;
```

`RecoveryDetails` is a sidecar on existing domain results/errors, not a second transport envelope. Successful engine values expose `recovery`; refusal/error details expose the same `recovery` object and current result where known. `CommandEnvelope` remains the only CLI/MCP envelope (`packages/commands/src/types.ts:3-8`). Full success/no-op → `ok`/0/`isError:false`; unresolved or partially applied compound intent → `refused`/1 with complete applied/unresolved details; undecodable transport syntax → `usage`/2; storage/capability failure → `error`/1 with actual cause and known commit state. Missing domain input is validation, never an `internal-error`. Retain field paths, array indexes, all independently determinable problems and safe provenance; do not print secrets.

### Action-local dependencies and commit boundary

| Action | Reads / derives | Writes and atomic boundary | Facts it must not demand |
|---|---|---|---|
| Register/adopt selected work | Explicit execution selection, canonical artifact identity, current association, registration journal | Creation + catalog/membership through existing DB transaction or file journal; preserve first identity/time | A new user choice inferred merely from reading an artifact; live activation |
| Correct a plan pointer | Named row identity/current pointer and canonical target document; `expectedFile` if explicitly supplied is a semantic constraint | Only that pointer plus required bookkeeping; same-target no-op is success | Whole compass set equality, sibling Todo status, integration checkout or branch header |
| Append selected plan | Selection/approval association, canonical plan data, existing identity collisions; recognized branch declarations only when consumed | New row plus its dependent registration projections; preserve unknown metadata | Inert later-stage spec lists or unneeded code-write branch facts |
| Change integration path/policy | Only affected integration ownership, branch facts and the proposed policy fields | Connected path/ownership/policy changes commit together | Unrelated plan pointer completeness |
| Complete/close | Current accepted handoff and kind-specific evidence; recorded external-result witnesses | Fulfilment before row Done; local predecessor bookkeeping and effect compose on one DB handle, or resumable file steps; close owns unregister | Report-only PR/Git/integration facts; development evidence recording waiting for Done |
| Failed/stopped | Explicit terminal intent/reason or existing terminal decision; ownership and stop facts for claims | Preserve terminal kind/first ended_at; settle only owned inactive/released claims; replay completes residual cleanup | Successful-delivery evidence or inferred stop of a foreign live holder |

Partition only the existing compound amendment: components connected by shared semantic reads/writes or a prerequisite edge are indivisible; independently requested components may commit despite another component's conflict. One revision advance per committed connected DB action, no nested separately committing public calls. Each component's receipt identity derives from the outer request plus stable component identity; a retry must not relabel, repeat or roll back completed components. File journals report actual restart boundaries, never claim cross-file atomicity.

Reconcile against fresh relevant facts under the owning lock/transaction. A supplied comparison token constrains its semantic read set; unrelated byte/revision drift is not a conflict. Raw whole-document replacement still requires an observed comparison basis — it cannot silently become a field merge. Check current authority/epoch and relevant external witnesses before commit. Use at most two internal fresh-state retries after the initial attempt; continued contention returns a scoped retryable conflict, not a busy loop. Same-effect state intents can recognize current success without a receipt; issue occurrences are events and require stable request/occurrence identity to replay, never content-only deduplication.

### Payload and host boundaries

- One command registry is `packages/commands/src/definitions.ts:134-155`; actual MCP lives at `packages/cli/src/mcp/register.ts:40-88`, **not** a separate `packages/mcp` package. CLI decoding and MCP schemas retain omissions until engine resolution, using that registry.
- Extend the existing payload-schema exposure from `packages/engine/src/issue.ts:79-194` and `packages/commands/src/families/schema.ts:9-32`: each domain owns its schema; command metadata links it to its payload-taking verb. Do not author a second CLI-only field table. Schema/help describes caller-owned requirements and derivable fields separately.
- #288 includes `plan.issue-add` (array, per-entry indexed errors), `workflow.execution-policy`, `workflow.evidence`, `persist.write` (the current spelling of historical `persist <kind>`), and the historical `judgment submit` obligation. Current registry exposes only `judgment.review-advice` (`families/judgment.ts:19,88`): retain a named task to document `submit` as out-of-contract with that source-grounded reason and the supported `review-advice --file` + pilot alternative, and deliver schema/aggregate validation for its `ReviewDecisionPack`. Do not silently drop the historical row or resurrect a retired verb. No live provider call is needed to validate a payload.
- Issue-family coverage is `add`, `occurrence`, `triage`, `close`, `waive`, `duplicate`, `supersede`, `link`, with read/export surfaces retained in the census. CLI `--payload` parses exactly once; native MCP objects remain objects; file read/parse failure never chooses an invented replacement payload. `--operation-id`/`--actor` are currently hard-required and their accepted full-role vocabulary must be discoverable in help. Resolve them from genuine request/identity context when available; otherwise aggregate the unresolved identity requirements. An event without observable retry identity keeps the operation-id requirement; a model-asserted actor never grants closure authority.
- #299 is a host seam, not a registry command. On both `start` and `phase1-complete`, a readable disabled preference returns `ok:true`, `isError:false`, `details.code:"preference-off"` with unchanged model/ledger/binding and neutral notice. In particular, preference-off with no binding is not `not-pending`; check preference before absent-binding/readiness requirements that are irrelevant to the no-op. Preserve actual in-flight/identity/navigation safeguards, settings-read failures and enabled-preference readiness/terminal-binding behavior; re-read preference after awaited readiness before any model action.

### Review-only enforcement decisions

**#283: wording + review-side prohibition only; no machine check.** Natural-language mentions can be non-goals or examples; a keyword gate cannot establish whether a development AC demands a real environment and risks the prohibited deadlock. Prepare review names the offending AC and replaces it with layer-appropriate isolated evidence; separately authorized operational work keeps its own workflow. QA/QC cannot demand live API/provider receipts, named/authenticated host/account, installed artifact/plugin, browser/device or deployed-environment proof for development. Positive isolated unit/component/integration and local built CLI/MCP cases remain admissible.

**#295: no machine check; review-side only.** A checker cannot truthfully infer a child model or reconstruct an unobserved edit time, and requiring those inferred values would create a false authority/gate. Each edit appends actual attribution to its gitignored control-root record (or the compass record naming changed files). Missing observability records model `unknown`; a later correction records its actual correction time and states the earlier time is unknown, never backdates. Existing plan-QC and iteration-close review checks this local record and the tracked synthetic-only boundary; correction is local and actionable, not an engine/transport gate or a new state authority.


## Change policy

Changes to this contract require the PM plus the product seat in a tracked Phase-1/Phase-2 edit; scope reductions require an explicit user decision. The live issue matrix may be refreshed by the product seat or PM as the rolling inventory changes; acceptance-snapshot rules from the clearance matrix apply.
