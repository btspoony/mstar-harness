# CLI self-describing payload parity report

- **Status:** DONE_WITH_CONCERNS
- **Implementation commit:** `ed11cc67` (`fix(cli): align payload schema with engine rules`)
- **Scope:** PR #287 findings 1–3; worktree `fix/cli-self-describing-payloads`. No `hooks/` or `scripts/packaging-manifests/` files were touched.

## Registry-to-engine parity comparison

I compared every `ISSUE_PAYLOAD_SCHEMAS` entry in `packages/engine/src/issue.ts` with the runtime boundary that consumes it: `assertCaptureRequest` / `occurrenceColumns`, `triageIssue`, `assertClosureAuthority`, `linkIssueOn`, `validatePlanProgress`, and `readHandoffEvidence` (plus the CLI conversions and plan-coordination calls that feed those boundaries). The comparisons below distinguish field presence from domain/value rules; engine checks that depend on store state, filesystem paths, or authorization remain engine checks.

| Payload type | Registry required fields / optional fields | Engine enforcement and comparison result |
| --- | --- | --- |
| `CaptureInput` | Required: `projectId`, `title`, `kind`, `severity`, `impact`, `acceptance`, `sourceIdentity`, `rootCauseKey`, `acceptanceKey`, `occurrenceKey`, `sourceKind`, `location`, `observedBehavior`, `evidence`, `discoveredAt`. Optional: nullable `owner`. | `assertCaptureRequest` and `occurrenceColumns` require the capture and occurrence identity/details; engine also checks enums and semantic keys. **Runtime-only laxness found and fixed:** `evidence ?? []` accepted a missing required `evidence` property, and blank `discoveredAt` was silently converted to `null`. Runtime now rejects absent/non-string evidence and blank timestamps. An explicitly present empty array remains valid: required means the property must exist with the declared array type, not that it must contain at least one evidence item. |
| `OccurrenceInput` | Required: `sourceIdentity`, `rootCauseKey`, `acceptanceKey`, `occurrenceKey`, `sourceKind`, `location`, `observedBehavior`, `evidence`, `discoveredAt`. | `appendOccurrence` uses `occurrenceColumns` for the same required identity/details. The same `evidence` and `discoveredAt` runtime laxness was shared with `CaptureInput` and is fixed at that common boundary. |
| `IssueTriage` | Required: `reason`. Optional: `kind`, `severity`, `impact`, `acceptance`, `owner` (nullable). | `triageIssue` requires the reason; supplied kind/severity values are constrained; supplied impact/acceptance must be nonblank; owner may be cleared with `null`. The schema now states and CLI validation enforces nonblank impact/acceptance when supplied. No required-field omission found. |
| `ClosureEvidence` | Required: `reason`. Conditional: `references` for resolved/`close`; `alignmentRef` for resolved/`close` and waived/`waive`; `scope` for waived/`waive`; `canonicalIssueId` for duplicate and supersede. | `assertClosureAuthority` confirms those disposition-specific requirements; resolved references must contain at least one entry. The previous registry incorrectly marked `references` globally required, over-requiring it for waived/duplicate/superseded closure. It is now optional in the unconditional schema with explicit `requiredWhen` metadata and `minItems: 1`; both `issue` and plan closure routes pass the disposition context into aggregated CLI validation. Additional multi-plan/reference-target validity remains the engine's domain check. |
| `IssueLink` | No unconditional required fields: the two legal forms are `relation` + `issueId`, or `kind` + `target`. | Engine route consumes exactly one of those paired forms, with relation/provenance vocabulary and target checks. CLI pair completeness previously ran only when no other validation failure existed. It now independently checks both pairs even when another field is invalid, so `relation:"related", kind:"ticket"` reports invalid `kind` and missing `issueId` in the same refusal. |
| `PlanProgress` | Required: `status`, `summary`, `evidence_paths`. Optional: `track_branches`. | `validatePlanProgress` requires those fields and checks allowed status, nonblank summary, and nonblank path/branch entries. Registry requiredness matched; item nonblank metadata now lets CLI reject those malformed entries before reaching the engine. Plan-specific path/state checks remain engine-side. |
| `HandoffEvidence` | Required: `source_sha`, `review_head`, `review_base`, `qc` (`decision`, `reports`, `consolidated`), and `qa` (`gate`, `decision`, `report`). | `readHandoffEvidence` requires all listed fields, exact nested keys, valid full Git object IDs, QC/QA values, at least one QC report, and usable report paths. **Required-field divergence found and fixed:** registry omitted required `review_head`; it now advertises it. `qc.reports` is explicitly nonempty in the schema as well. A route regression compares the required schema shape and submits that complete evidence through the plan handoff route. |

### Required field versus runtime-only acceptance audit

The subtle opposite-direction drift was that engine type contracts and the schema marked occurrence evidence and observation time required, while the shared runtime conversion tolerated an absent evidence list and translated a blank timestamp to `null`. I searched the package `captureIssue` / `appendOccurrence` callsites, all `discoveredAt` and issue-evidence payload examples, engine/CLI/dsh tests, execution residual-add construction, and related docs. All in-repository capture/occurrence builders supply evidence and a nonblank timestamp; no caller, test, or doc depended on omitted evidence or a blank timestamp succeeding. Existing `evidence: []` examples are intentional and continue to pass because the required field is present and is a valid (empty) `string[]`. The only intentional absence remains the persisted nullable discovery timestamp for older/imported records, not an authored `CaptureInput`/`OccurrenceInput` value.

## Shared source and drift prevention

The registry remains the engine-owned source for schema output and the CLI's structural required/type/value validation; the CLI validator consumes that registry rather than keeping a second field list. I did not replace all engine route checks with a generated validator: the engine additionally applies disposition-, path-, authorization-, and store-state-specific rules that do not reduce to field-shape metadata. A full single-validator conversion would cross those domain boundaries and was not a safe narrow fix. The guardrails added here are: schema-driven CLI checks (including `requiredWhen`, array cardinality, and item constraints), engine runtime checks for the two required-field leniencies, a successful schema-derived handoff route regression, disposition-specific closure tests, and an invalid-link-plus-missing-pair regression. The per-type comparison above records the route/check that must be reviewed if a registry contract changes.

## Finding 2: paired and conditional short-circuit checks

- `IssueLink` relation/issueId and kind/target completeness now runs independently of enum/type failures. The original `related` + `ticket` case reports both invalid provenance kind and missing `issueId`; a partially supplied provenance arm also reports missing `target` even if another arm or field is invalid.
- `ClosureEvidence` was the other disposition-conditional payload rule. The `close`, `waive`, `duplicate`, and `supersede` routes now validate their respective required evidence in one CLI refusal rather than relying on a later engine refusal. Plan `issue-close` uses the same mapped disposition context.
- `IssueTriage` optional impact/acceptance fields were checked for the same issue: if present but blank, the CLI now reports them as invalid instead of allowing the engine to refuse later.
- `PlanProgress` and nested handoff objects have requiredness/array rules, not paired alternatives; no analogous conditional pair short-circuit was found there.

## Finding 3: schema command error path

The standalone `schema` action was the only payload subcommand in `packages/cli/src/issue.ts` outside the normal `runVerb` error boundary. It now catches its usage error locally, includes the available type names, and returns exit 2. The issue verbs in the same file already use `runVerb`; no second equivalent escape was found in that file.

## Regressions and pre-fix output

Before the fixes, the three new CLI regressions were run together against the assigned tip:

```text
bun test packages/cli/test/issue.test.ts -t 'schema output|unknown schema|link validation'
0 pass
3 fail
```

1. The schema assertion expected required `review_head`; the pre-fix output only advertised `source_sha`, `review_base`, `qc`, and `qa` (no `review_head`). Calling the engine handoff evidence reader with those advertised top-level fields produced:
   ```text
   evidence.review_head must be a full Git object id (40 or 64 lowercase hex), not an abbreviation
   ```
2. For `{"relation":"related","kind":"ticket"}`, the pre-fix CLI failure was:
   ```text
   IssueLink payload invalid: invalid provenance kind "ticket"
   ```
   The test failed because the output did not contain `issueId`.
3. For `schema HandofffEvidence`, the pre-fix assertion was `Expected: 2 / Received: 1`; the CLI printed:
   ```text
   Setup failed: unknown payload type "HandofffEvidence"; available: CaptureInput, OccurrenceInput, IssueTriage, ClosureEvidence, IssueLink, PlanProgress, HandoffEvidence
   ```

Post-fix regression test outputs:

```text
bun test packages/engine/src/issue.test.ts
42 pass / 0 fail / 192 expect() calls

bun test packages/cli/test/issue.test.ts
20 pass / 0 fail / 189 expect() calls

bun test packages/cli/test/plan-coordination.test.ts
62 pass / 0 fail / 1288 expect() calls
```

The `schema HandofffEvidence` child-process regression passes with exit 2, a usage refusal, the available-type list, and no `Setup failed`. The handoff test submits the schema-required evidence through the plan engine route. The final engine runtime-only occurrence hardening was applied after the CLI/plan test runs; those suites' payload fixtures supply nonblank timestamps and present evidence fields. Main will repeat all three against the committed final tree.

## Commands run

- `bun test packages/engine/src/issue.test.ts` — final engine-only runtime hardening: **42 pass, 0 fail, 192 expectations**.
- `bun test packages/cli/test/issue.test.ts` — **20 pass, 0 fail, 189 expectations**.
- `bun test packages/cli/test/plan-coordination.test.ts` — **62 pass, 0 fail, 1288 expectations** (before the final engine-only occurrence hardening; no plan CLI source changed afterward).
- `bunx tsc -p packages/engine/tsconfig.json --noEmit` — exited successfully before the final runtime hardening; the final engine build also completed its `bunx tsc` step cleanly.
- `bun run --cwd packages/cli typecheck:src` — exited successfully before the final engine-only runtime hardening.
- `bun run --cwd packages/engine build` — completed: bundled 51 engine modules and 21 audit modules, then `bunx tsc` succeeded.
- `bun run --cwd packages/cli build` — completed after the final engine build: web assets generated, CLI bundled 82 modules into `dist/mstar-harness.js` (2.61 MB), and non-ASCII literals were escaped.

A local `node_modules/@mstar-harness/judgment` workspace symlink was missing in this worktree; the first CLI build could not resolve the package. I restored the normal workspace link and built the judgment workspace package; subsequent CLI builds and typecheck succeeded. This is an environment/workspace-link observation, not a source change.

## What I did not verify

- No whole-suite run, provider call, credentialed flow, Docker flow, external deployment, or CI/Greptile result.
- Main owns the post-commit rerun of all three targeted tests, both typechecks, and the complete build chain before regenerating hooks/packaging manifests and pushing.
- I did not modify or regenerate `hooks/` or `scripts/packaging-manifests/`.

## Residuals

- **Open:** `I-000198` — **P0** — GitHub issue [#284](https://github.com/btspoony/mstar-harness/issues/284). This remains the tracked umbrella incident until the parent verifies/pushes the broader PR change. The three scoped review findings are fixed here; no new residual was opened.
