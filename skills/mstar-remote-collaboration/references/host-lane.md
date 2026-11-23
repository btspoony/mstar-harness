# Remote host lane reference

Open when executing one lane step, discovering a verb's input document, or recovering a refusal. `remote` below means `mstar store collaboration remote`; every call carries `--harness "$HARNESS"` with the addressed checkout's absolute harness directory, and every step's envelope is read before the next action.

## Lane commands

| Step | Command | What the envelope proves |
|---|---|---|
| Status | `mstar store collaboration remote status --harness "$HARNESS" [--project "$PROJECT"]` | `selector` (`commit`/`generation`/`phase`), this checkout's `binding` state, and per project `revision`, `completeness`, `freshness`, `scope`, `outcome`; reads nothing from the provider and creates nothing |
| Bind | `mstar store collaboration remote bind --harness "$HARNESS" --input "$BIND"` | One positive access check per selected project was accepted; an unbound cache was created or advanced |
| Observe | `mstar store collaboration remote observe --harness "$HARNESS" --input "$OBSERVATION"` | One project's evidence was replaced atomically; `completeness: partial` stays partial, a negative check records invalidation |
| Adopt | `mstar store collaboration remote adopt-issue --harness "$HARNESS" --project "$PROJECT" --issue "$PROVIDER_ISSUE_UUID" --operation "$OPERATION_UUID" --input "$ADOPTION"` | One reviewed intent is frozen under `--operation`; `state: enqueued` is the durable fact, not adoption |
| Pending | `mstar store collaboration remote outbox-pending --harness "$HARNESS" --project "$PROJECT"` | Summaries of current-binding enqueued intents; never a send permit |
| Show | `mstar store collaboration remote outbox-show --harness "$HARNESS" --operation "$OPERATION_UUID"` | The intent's binding, state, attempt id, request hash and — while access is current — the frozen request; never a permit |
| Dispatch | `mstar store collaboration remote outbox-dispatch --harness "$HARNESS" --operation "$OPERATION_UUID" [--input "$FORK"]` | One permit with `attemptId`, `binding`, `frozenRequest`, `requestHash` and the observed base; the intent is already persisted `unconfirmed` |
| Receipt | `mstar store collaboration remote outbox-receipt --harness "$HARNESS" --input "$RECEIPT"` | What the dispatched attempt observed; exit 0 means recorded, so read `state` |
| Reconcile | `mstar store collaboration remote outbox-reconcile --harness "$HARNESS" --input "$RECONCILIATION"` | Read-only lookup evidence for one uncertain attempt under its original binding; issues no permit |
| Resolve | `mstar store collaboration remote outbox-resolve --harness "$HARNESS" --operation "$OPERATION_UUID" --input "$RESOLUTION"` | A reviewed replacement event frozen under a new operation id, with every fork head as a parent |
| Abandon | `mstar store collaboration remote outbox-abandon --harness "$HARNESS" --operation "$OPERATION_UUID" --reason "$REASON"` | An explicit abandonment of an enqueued intent, or of one holding pre-send `not-sent` proof |

A dispatch replay returns `kind: state` instead of `kind: permit`; never treat that state as a second authorization.

## Input documents

The built CLI owns every shape. Ask for it per verb and take `data.descriptor.payloadSchemas.inputDocument`; `--input` carries that JSON as a file path or `-`, and a schema refusal is a usage error, not lane evidence.

| Host document | Schema command |
|---|---|
| Reviewed bind batch | `mstar schema --command store.collaboration.remote.bind` |
| Observation submission (access check plus snapshot) | `mstar schema --command store.collaboration.remote.observe` |
| Strict adoption (`new` or `retain`) | `mstar schema --command store.collaboration.remote.adopt-issue` |
| Fork observation for a reviewed resolution's dispatch | `mstar schema --command store.collaboration.remote.outbox-dispatch` |
| Dispatched attempt receipt | `mstar schema --command store.collaboration.remote.outbox-receipt` |
| Original-binding lookup evidence | `mstar schema --command store.collaboration.remote.outbox-reconcile` |
| Reviewed replacement event | `mstar schema --command store.collaboration.remote.outbox-resolve` |

## Provider capability mapping

A bind's access check sets all five booleans for every selected project; each is proven by the host with its own provider tools, never assumed. The capability the step needs decides which call the host makes:

| Capability | What the host must be able to do | Step that needs it |
|---|---|---|
| `fullRead` | Read the bound project completely, following pagination, including its issue history | Observe (the snapshot must cover the whole project) |
| `exactLookup` | Retrieve one issue by its immutable provider id | Adopt, and the post-dispatch lookup |
| `appendOnly` | Append a new journal or issue entry without rewriting existing content | Dispatch of an adopt/write intent |
| `fieldFidelity` | Carry native fields and MStar extension data through unchanged | Observe and receipt |
| `privateAudience` | Keep the bound project's audience private to its members | Bind |

Traversal discipline for an observation: page until the provider reports no next page, begin `asOf` at the traversal start, keep each issue's native identity, title, status and update time separate from its `mstar` subject, and record an extension-less provider issue as `mstar: null` — visible in the snapshot, never counted as an MStar record.

## Intent states

| State | Meaning | Next verb |
|---|---|---|
| `enqueued` | One frozen intent is waiting for a permit | `outbox-dispatch` |
| `unconfirmed` | A permit was issued and persisted before the send; the effect is unknown | `outbox-receipt`, then `outbox-reconcile` if the answer is missing |
| `confirmed` | A receipt proved the provider effect | Re-observe, then read the finding |
| `conflict` | The provider held competing records; nothing was overwritten | `outbox-resolve` after a fresh complete traversal |
| `abandoned` | The intent was explicitly given up, with its reason retained | Nothing; a new intent needs a new operation id |

## Refusal recovery

| Refusal | Cause | Recover with |
|---|---|---|
| `remote.selector-unavailable` | The canonical origin or protected selector ref is unreadable | Restore Git access, then `remote status` |
| `remote.unavailable` | No usable admitted observation for the required scope | Reviewed `bind` when the binding is missing, then a complete `observe` |
| `collaboration.observation-incomplete` | The admitted snapshot does not cover the scope completely | Finish the traversal, `observe` again |
| `collaboration.observation-stale` | Access evidence or traversal time is outside its window | Recheck access, traverse afresh, `observe` again |
| `remote.scope-mismatch` | Verified scope disagrees with the binding, or the adoption target is marked or already referenced | Correct the scope, or use the exact unmarked UUID and an unbound reference |
| `remote.denied` / `remote.revoked` | A negative host check reported denied or revoked access | Restore access, re-verify the scope, `observe` |
| `remote.effect-pending` | A business write froze an intent without a confirmed effect | Dispatch, settle the receipt, replay the identical write only after confirmation |
| `remote.intent-not-found` | Unknown operation id | `outbox-pending`, then address the id it names |
| `remote.operation-conflict` | The id holds another request, kind or generation | `outbox-show`, then `outbox-resolve` for a conflicted fork |
| `remote.dispatch-refused` | The intent's recorded state allows no permit: not enqueued, an older intent still pending, an unsettled attempt ahead of it, or its own base no longer matches the observation | `outbox-show`; clear the intent it names by that intent's own state: an older `enqueued` predecessor → dispatch and settle it (`outbox-dispatch`, its one provider call, `outbox-receipt`), then retry this intent; `unconfirmed` → `outbox-reconcile` under its original binding; `conflict` → a reviewed `outbox-resolve`; this intent's own base is stale → re-observe the scope, abandon the still-`enqueued` intent with `outbox-abandon --reason`, then freeze a fresh intent under a new operation id against the new observation and dispatch that |
| `remote.input-invalid` | The document failed its schema | Correct the named field and resubmit to the verb that reads that document |
| `remote.unsafe-fidelity` | The provider cannot preserve required meaning | Refuse remote mode for that project; do not drop fields |
| `collaboration.stale-binding` | This checkout resolves another collaboration mode, the selector moved and the binding is draining, or the intent belongs to another generation | Confirm the mode; for a remote checkout `remote status` then a reviewed `bind`; a draining generation is recovered, never resent |
| `collaboration.not-initialized` / `collaboration.upgrade-required` | This checkout's collaboration lane is absent or older | `mstar store upgrade --operator <name> --harness "$HARNESS"`, then `bind` |

## Lost response, ambiguity and conflict

1. Read the attempt with `outbox-show --operation`; it names the attempt id, request hash and, while access is current, the frozen request to look up.
2. Look the attempt up on its **original binding** — the project and scope in the permit, not the current one — using the provider tools that satisfy `exactLookup`.
3. Submit that lookup as `outbox-reconcile --input`. Exact, unique evidence can confirm the attempt; missing evidence leaves `unconfirmed`, and ambiguous evidence (two plausible provider records) stays `unconfirmed` with no second send.
4. A `conflict` outcome proves competing records. Traverse the fork completely, then freeze a reviewed replacement with `outbox-resolve --input` under a new operation id, and dispatch it with the fresh complete fork observation through `outbox-dispatch --input`.
5. Abandonment is only for an intent that is still `enqueued`, or one holding the original host's own pre-send `not-sent` receipt. It is never the recovery for a lost response.

## Stop conditions

Stop the lane, and report the exact leg, when: no Linear MCP tool set is exposed; one of the five capabilities cannot be proven; a scope the host verifies is not the bound one; an adoption target is marked or its identity is ambiguous; a permit was not returned for a time-sensitive intent; or the provider answer cannot be represented without dropping fields. No REST call, local edit, retry of a dispatched intent, or invented operation id substitutes for any of these.
