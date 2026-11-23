---
name: mstar-remote-collaboration
description: "Use when a `remote` (provider-authoritative) checkout must verify or bind its provider scope, observe provider issues, dispatch one queued provider effect, record what the provider answered, or adopt a provider issue — every provider call made by the host's own Linear MCP tools. Not for local or mirror-mode checkouts, mirror issue sync, or a provider client inside mstar."
---

# Remote Collaboration (host lane)

## Load Order

Read `mstar-harness-core` first (lifecycle/authorization authority), then this skill when the addressed checkout's collaboration mode is `remote` and a provider-authoritative step is due. Confirm the mode before the first step (`mstar path resolve` reports it), because a `local` or `mirror` checkout resolves no checked remote selector — even `remote status` refuses `collaboration.stale-binding` — and mirror-mode synchronisation belongs to `mstar-issue-mirror`. The precondition is a host that exposes Linear MCP tools — discover them from the live tool list at run time. Open `references/host-lane.md` before executing a step, discovering a verb's input document, or recovering a refusal.

## Workflow

`remote` below means `mstar store collaboration remote`. Pass `--harness "$HARNESS"` with the absolute harness directory of the addressed checkout on every call, and read each envelope before taking the next action.

1. **Status and bind.** `remote status` reports the checked selector, this checkout's binding, and each bound project's revision, completeness, freshness and access verdict. With the host's approved Linear tools, verify every selected project's exact workspace/team/project and all five capabilities (`fullRead`, `appendOnly`, `exactLookup`, `fieldFidelity`, `privateAudience`), then submit the reviewed batch with `remote bind --input`. Done when bind is accepted and `remote status` reports the binding.
2. **Observe.** Traverse the bound scope completely through the provider's pagination, keeping the traversal start (`asOf`), native fields and MStar extension data distinct. Submit one project's access check and snapshot with `remote observe --input`, addressing the revision `remote status --project` reported; a gap is submitted as `coverage: partial`, never presented as complete. Done when the observation is admitted complete and fresh. Observation never adopts an issue.
3. **Adopt, explicitly.** Address the exact observed **unmarked** provider issue UUID — never a display id, title or caller-supplied project — with `remote adopt-issue --project --issue --operation --input`. `new` builds the finding from the verified native title and bound project; `retain` carries the reviewed complete subject with its existing `IssueRef`. Done when the state reads `enqueued`: one durable intent, not an adopted issue and not provider success.
4. **Dispatch one intent.** `remote outbox-pending --project` lists summaries and never a permit. `remote outbox-dispatch --operation` returns the send permit for the addressed intent, durably marking it `unconfirmed` before any provider call; a replay answers state only. Sends are serialized per binding in FIFO order, so an older enqueued intent or any unsettled attempt refuses a later one. Through the authorized provider tool, perform exactly the permit's frozen request on its binding — and send nothing when no permit came back. Done when one permit is spent on exactly one provider call.
5. **Record, reconcile, re-observe.** `remote outbox-receipt --input` records the attempt's actual outcome: exit 0 means the evidence was stored, and only `confirmed` proves the effect. Re-observe the invalidated project, then read the adopted finding with `mstar issue show --id`. After a lost response, read `remote outbox-show --operation`, look the exact attempt up on its original binding, and submit that evidence with `remote outbox-reconcile --input`; a proven fork goes through `remote outbox-resolve`, and `remote outbox-abandon` is only for an enqueued intent or a recorded pre-send `not-sent`. Done when the intent's durable state is `confirmed` and the finding is readable by its `IssueRef`.

## Decision Rules

- **This skill performs no provider call itself.** mstar holds no credential and opens no socket; every provider read and write is the host's, made under the host's own authorization. The lane's own evidence is the document the CLI accepted and the state it recorded.
- **Tool names are discovered, never assumed.** Provider tool names and argument shapes come from the live host tool list at run time; this lane names the CLI verb and the capability it needs, never a provider tool signature.
- **Discover the documents.** Read `mstar schema --command <verb-id>` and take its `data.descriptor.payloadSchemas.inputDocument`; `--input` carries a file path or `-`. Field lists are never restated here, so the published schema stays the one authority.
- **Read state before the next action.** `enqueued`, `unconfirmed`, `confirmed`, `conflict` and `abandoned` are durable intent states, and only `confirmed` is effect success. A dispatched intent is not retried, and a second send is never the recovery for a lost response — `outbox-reconcile`, or a reviewed `outbox-resolve`, is.
- **An access check is short-lived** (60 s from `checkedAt`): verify access immediately before `bind` or `observe`, and re-verify rather than resubmitting an old check.
- **A provider-native state is not an MStar disposition.** A Linear `Done` neither closes nor changes a local finding, and only the MStar verbs change it.
- **A missing leg stops the lane.** When an authorized provider tool or one of the five capabilities is absent, name the missing leg and stop; no REST call, local fallback or fabricated document stands in for it.

### Refusal map

| Refusal | Meaning | Recover with |
|---|---|---|
| `remote.selector-unavailable` | The selector ref or commit cannot be verified at the origin | Restore Git access to the canonical origin, then `remote status` |
| `remote.unavailable` | No usable admitted observation for the required scope | Reviewed `remote bind` if the binding is missing, then a complete `remote observe` |
| `collaboration.observation-incomplete` | The snapshot does not cover the scope completely | Finish the traversal and `remote observe` again |
| `collaboration.observation-stale` | Access evidence or traversal time is outside its freshness window | Recheck access, traverse afresh, `remote observe` again |
| `remote.scope-mismatch` | A verified scope disagrees with the binding, or adoption targets a marked issue or an already-bound reference | Correct the scope, or use the exact unmarked UUID with an unbound reference; never title-match |
| `remote.denied` / `remote.revoked` | A negative host check reported denied or revoked access | Restore authorized access, re-verify the scope, `remote observe` |
| `remote.effect-pending` | A business write froze an intent whose effect is not confirmed | Dispatch it and settle the receipt before replaying the write |
| `remote.intent-not-found` | Unknown operation id | `remote outbox-pending`; operation ids are never invented |
| `remote.operation-conflict` | The id already holds another request, kind or generation | `remote outbox-show`, then the route it names |
| `remote.dispatch-refused` | The intent is not dispatchable in its recorded state — older pending or unsettled intents serialize sends | `remote outbox-show`; settle the intent named ahead with `outbox-reconcile` or a reviewed `outbox-resolve` |
| `remote.input-invalid` | The submitted document failed its schema | Correct the named field and resubmit to the verb that reads that document |
| `remote.unsafe-fidelity` | The provider cannot preserve required meaning | Refuse remote mode for that project; never drop fields |
| `collaboration.stale-binding` | This checkout resolves another collaboration mode, or its selector moved and the binding is draining | Confirm the mode; for a remote checkout, `remote status` then a reviewed `remote bind` on the current selector |
| usage (exit 2) | A required flag or document is missing | Supply what the envelope names |

## Evidence

A correct cycle leaves all of: a binding `remote status` reports with checks covering every selected project; one complete, fresh observation per project that a fresh traversal re-materialises; one `enqueued` intent per adopted issue and no second attempt; exactly one send permit across dispatch and a replay; a durable `confirmed` receipt before any effect is claimed; and an adopted finding readable by its new `IssueRef` that maps to the same provider UUID. A native provider `Done` leaves that finding's disposition unchanged. Provider transport itself is never this lane's evidence — it is the host's call, and no receipt in mstar proves a provider CAS.

## References

- `references/host-lane.md` — open when executing a lane step, discovering which schema command publishes one verb's input document, or mapping a refusal to its recovering verb.
- `mstar-issue-mirror/references/linear-mcp.md` — open when the host lists no Linear MCP tools, or that server, its auth and the DSH `linear-mcp` row must be configured.
