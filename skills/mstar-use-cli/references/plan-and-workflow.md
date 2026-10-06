# Plan and workflow transport

This reference owns coordinator command address/parameter shapes, token discipline and recovery. Fields/lifecycle belong to `mstar-artifacts`; iteration procedure to `mstar-iteration`; checkout safety to `mstar-branch-worktree`.

## Normal route

One primary coordinator operates every row in its explicitly selected workflow. Choose the intended ordinary action, supply only genuinely missing facts and inspect its applied/partial/replay receipt. Do not insert a bind/claim/repair ladder before normal progress. Leaves receive task scope/path/evidence instructions, never coordinator state authority.

ACTIVE writes derive the caller's current own coordinator reference, scope token and a fresh operation id where unambiguous. Explicit values remain checked constraints. Ambiguous workflow selection needs a supported explicit selector, never the latest/sole stored session. New registration uses the root creation token; workflow and row actions use their respective tokens.

## Transports

`mstar status validate` reports execution authority. ACTIVE operations use DB transactions, independent caller identity, CAS and receipts. File operations are available only before activation under the workflow coordinator envelope and row revision, using the domain writer's same-host lock/atomic replacement. File forms on an ACTIVE root refuse instead of falling back. Store upgrade remains the supported operator transition from legacy authority; never edit live store/config/credentials to change routes.

| Transport | Address and concurrency context |
|---|---|
| ACTIVE | Own coordinator reference and acquired identity; token/operation defaults may be derived. Explicit `--session-ref`, `--expect`, `--operation`, `--harness`, `--session-id` constrain that context. |
| File | `--session <absolute-json>` plus applicable row `--expect <revision>`; no per-row envelope. Coordinator bootstrap uses an explicitly acquired `--session-id`, never a generated identity. |

A reference is a lookup, not bearer authorization. Copying another reference never acquires its identity. Row scope comes from explicit `--plan` and the coordinator's selected workflow, not prepared Assignment bytes.

## Public parameter shapes

The same coordinator owns all retained plan verbs:

```text
mstar plan bind [--execution] --workflow <id> (--coordinator | --resume <path> | --resume-ref <ref>) [--expect <token>] [--operation <id>] [--harness <path>] [--session-id <id>]
mstar plan show --plan <id> [--session <path> | --session-ref <ref>] [--workflow <id>] [--harness <path>] [--session-id <id>]
mstar plan prepare --plan <id> [--worktree-path <absolute-path>] [--working-branch <branch>] [--qa-gate mandatory|pm-acceptance] [--findings-cleanup zero-residual|allow-residual]
mstar plan progress --plan <id> (--progress <json> | --file <json>)
mstar plan issue-add --plan <id> (--entries <json-array> | --file <json>)
mstar plan issue-close --plan <id> --issue <id> --disposition resolved|waived|duplicate|superseded (--evidence <json> | --file <json>) --expect-issue <revision>
mstar plan complete --plan <id> (--evidence <json> | --file <json>) [--integration-base-sha <full-sha> --integration-result-sha <full-sha>]
```

Mutation lines also accept their applicable transport context described above, including explicit workflow selection. Consult current source-built verb help for the complete transport option set. No retired verbs/flags or compatibility aliases are supported.

`show` needs no preliminary bind when the acquired caller already has a live coordinator binding. `prepare` is revisable configuration and source metadata, not admission sealing: QA defaults to mandatory, cleanup to allow-residual; an existing valid source/default configuration needs no ceremonial prepare record. Changes while InProgress/InReview do not reset status or seal plan/Assignment bytes. A missing or corrected source checkout/branch uses ordinary prepare, validated against actual Git. `progress` records start/review/block states; Done is complete-only.

## Direct completion

Supply one complete evidence document:

```json
{
  "source_sha": "<actual source SHA>",
  "review_base": "<actual review base SHA>",
  "review_head": "<actual reviewed head SHA>",
  "qc": {"decision": "Approve", "reports": ["<absolute report path>"], "consolidated": "<absolute summary path>"},
  "qa": {"gate": "mandatory", "decision": "pass", "report": "<absolute report path>"}
}
```

Use actual reports/source facts, not placeholders. The integration CLI pair must be supplied together, or the document may carry `integration: {base_sha,result_sha}`. Evidence paths are existing absolute files; hashes are informational provenance, not resealing requirements.

| Engine-selected route | Proof before direct complete | After row Done |
|---|---|---|
| Iteration/non-standalone | QC/QA and source/review ancestry plus already-performed serial two-parent merge in the clean recorded integration checkout on its target branch. Supply real base/result. The engine re-witnesses Git at commit. | Parent still owes compound/PR/verified merge/terminal close; no child PR. |
| Standalone development, exactly one row | QC/QA and clean registered source checkout/ref/commit; integration input refuses. | Own compound/PR/verified merge/terminal close; workflow stays running. |
| Standalone verification/report-only, exactly one row | Record explicit fulfilment matching registered completion_policy before Done, then supply QC/QA. Git fields are provenance only, not an invented source/integration requirement. Integration input refuses. | Evidence-backed terminal close; no invented compound-before-PR, PR or merge. |

Example report-only fulfilment: `mstar workflow evidence --workflow <id> --file <absolute-json>` with `{"completion":{"policy":"<registered policy>","evidence":"<real fulfilment reference>"}}`. QA pass alone is never fulfilment.

Complete may atomically entail InProgress → InReview → Done with sufficient reviewed evidence. It retains source ownership metadata and completion evidence, releases only applicable workflow merge exclusion and preserves completed_at on exact replay. Per-plan execution leases are removed. Completion never runs Git merge: the coordinator explicitly performs it once in the recorded integration checkout, then submits actual SHAs. If merge output/state response is lost, retry complete against the real result, never merge again. Resolve or explicitly abort a real conflict in Git; never force state to Done.

## Coordinator identity and recovery

```text
mstar session run --workflow <id> --role coordinator <argv...> [--harness <path>]
mstar session recover --workflow <id> (--prior-session <id> | --unowned) --reason <text> --attestation <absolute-json> --expect <workflow-token> --operation <id> [--harness <path>] [--session-id <id>]
```

The launcher mints one child-local coordinator identity, overwrites the identity channel and propagates exit/signal. It does not bind a workflow. Coordinator bootstrap remains workflow-wide and limited to one owner. Read-only resume reports current own context; it never restarts execution or replaces a stopped owner. Recovery replaces the explicitly stopped workflow coordinator, never a row identity. The stop attestation must name the real prior owner; `--unowned` explicitly means no recorded coordinator. No age/idle/TTL takeover. Any authorizationRef names a real external user/operator authorization event, not an agent-invented task reference.

Public recovery output exposes workflow/public session ids and receipt/replay/token/version facts, never envelope paths/body. Independent caller identity is revalidated within the transaction. A copied session id/reference or repeated launcher is not acquisition of the old identity.

## Issue writes

Unscoped `mstar issue` remains actor-only: write verbs require `--actor`, `--operation-id` and payload/file; triage/terminal disposition/link require issue CAS `--expect`. Plan issue-add/issue-close compose issue mutations under the workflow coordinator and selected row, preserving closure authority and issue CAS. The legacy residual register is migration history, never a live dual-write target.

## Tokens, receipts and failure

| Value | Meaning/source |
|---|---|
| Root token | `status validate`, new workflow registration only |
| Workflow token | Authoritative workflow read, coordinator bind/workflow transitions/evidence/recovery/close |
| Plan token | `plan show`, selected row mutations |
| Session reference | Stored coordinator lookup `{storeId,epoch,workflowId,role,sessionId}`; no row identity |
| Operation id | Exact-request replay key; changed semantics under the same id refuse |
| Issue revision | Issue read/capture receipt, passed as `--expect-issue` |

After a mutation use its new token or derive current own context; an explicitly supplied stale token refuses. Machine output is one JSON object; human summaries go to stderr. Success names operation/scope/fresh token/store/epoch/id/replay and action-local outcome. Failure names stable code plus safe current/expected scope facts, never credential/identity-channel payloads. Consult the refusal instead of inventing a top-down repair sequence. Transactional row refusal changes no row/receipt/counter; where a composed action documents partial application, retain applied components and retry only the remaining action.

Refusals cover absent/ambiguous scope, missing/mismatched independent identity, duplicate coordinator, invalid status/configuration, stopped workflow, foreign real merge exclusion, open critical/findings-cleanup failure and unavailable/mismatched Git facts. No force option or silent scope broadening exists.

## Registration and outer delivery

Standalone `workflow register` is create-only and declares project, plan pointer, delivery kind, anchors and report-only completion policy. `--plan-file` accepts harness-relative `plans/<id>.md` or canonical absolute path, not repository-relative `.mstar/plans/<id>.md`. ACTIVE creation uses root token + operation under independently acquired identity, no pre-existing session reference. Delivery evidence/close use workflow context and token. Source facts are corrected through ordinary prepare, never a legacy repair verb.

Iteration registration uses `mstar iteration register`, not standalone registration: compass ref, explicit base/integration/target anchors and Todo rows; canonical absolute plan pointers and producer-derived metadata. Registration cannot silently overwrite an existing lifecycle; recover partial registration through the supported catalog/registration receipt route.

## Exit codes

- `0`: success, idempotent no-op, exact replay or read-only resume.
- `1`: engine refusal; commit-state is action-local and visible in its receipt.
- `2`: usage, unsupported option/verb, mixed/missing address forms, malformed token/file/path or incomplete integration pair. Unsupported scoped command arguments refuse before any workflow action; they never start the whole iteration.
