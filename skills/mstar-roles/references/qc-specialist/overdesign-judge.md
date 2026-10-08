# Overdesign Judge Lens

## Trigger and scope

Role-owned reference of **mstar-roles** → `references/qc-specialist/overdesign-judge.md`, discovered through `references/qc-specialist/deep-review-lenses.md`; never preset-gated.

**REQUIRED:** qc-specialist seat 1 (architecture coherence / maintainability) reads this lens at plan QC tri-review and the inline single-seat equivalent whenever the reviewed diff touches `packages/engine/src` (including engine/store/workflow) or `packages/commands/src`. This path trigger does not depend on the registry's ≥2 deep-review signals. Seats 2/3 read it on demand when a mechanical-lint candidate from the refusal-quality or help-reachability `--json` report intersects their security/correctness or performance/reliability focus. Required loading does not expand the assigned diff or targeted re-review scope.

The reviewing Assignment must explicitly state the module's **operating-model premise**, for example `local, stopped, disposable workspace update`. Do not infer it from filenames, a historical issue, or the presence of locks. Without that input, return exactly:

```text
cannot-judge: no operating-model premise supplied
```

This is an out-of-scope lens result, not a refusal of the operation, a Critical finding, or a new approval gate. Existing mechanical findings remain valid independently; the result makes no claim that the unjudged semantic scope is clean.

Use diff/read/grep and already supplied L1 evidence only. Do not run lints, tests, builds, installs, or new audits from the QC seat. This lens judges semantics that AST cannot decide; it does not replace mechanical enforcement or authorize changes to implementation or issue-store state.

## Frozen anchors

Preserve these source rules rather than inventing stricter ones:

- [#340, two-path rule](https://github.com/btspoony/mstar-harness/issues/340#issuecomment-5934855290):
  > **Known violation code → a designed resolution** (normalize / re-pin / repair) — never a refusal.
  > **Unknown / unresolvable → archive the exact bytes, record the exclusion, complete the operation** — never a dead end.
  > Every refusal names its actual cause and an operator-executable recovery; generic catch-alls and "rerun" advices are defects.
  > A validation gate may not refuse a state its own documented contract calls importable.
- [#341, four checkable classes](https://github.com/btspoony/mstar-harness/issues/341#issuecomment-5953850747):
  > content hash / canonical-serialized equality may RECORD, never GATE or ASSERT — replay exemption only.
  > every `refuse`/`conflict`/`throw` carries (a) a named cause code, (b) a recovery referencing a command/flag that **exists**, (c) a repro test.
  > a parameter may be `required` only with recorded justification; everything else is optional with a safe default or context derivation. Omission errors must name the missing parameter and how to supply it.
  > a verb, flag, or recovery path absent from `--help` or refusal text is treated as absent. Lint fails any recovery string or feature that is not reachable from the help surface.
- [#340, ordering invariant](https://github.com/btspoony/mstar-harness/issues/340#issuecomment-5934855290):
  > **NEW (this session): any index-by-index comparison of an enumerated filesystem-derived set must be preceded by a canonical sort (or use keyed maps), with a regression that reorders enumeration and proves the identity/hash is unchanged.**
- [#365, fault tolerance and discoverability](https://github.com/btspoony/mstar-harness/issues/365):
  > All document and content mutations in this system are performed by agents.
  > **Edits are revisable.** Any mutation can be corrected through ordinary public operations — no one-way doors, no states that require hidden or manual repair.
  > A capability that exists but is not discoverable does not exist.

The #341 prepare-seal owner correction takes precedence over repairing that prohibited gate: deletion of the byte-hash refusal, not a reseal escape. Historical counts and examples below are source evidence, not current-tree findings or numeric thresholds. Do not revive protocols deleted by the [#340 program closure](https://github.com/btspoony/mstar-harness/issues/340#issuecomment-5982147502).

## Judgment procedure

1. Read the declared premise and supplied review range. For each changed gate, trace its actual refusal path, the state it protects, its documented contract, and the producer of the rejected input. A lint candidate is a starting point, not proof of semantic misclassification; a clean lint report does not establish semantic conformance.
2. Answer the four criteria below using concrete anchors. Preserve distinctions between foreign/operator input, authority/security boundaries, and the system's own persisted output. Do not globally replace legitimate integrity refusals with archive-and-complete.
3. Separate proven mechanical violations and catch-all masking from semantic findings. Emit structured findings with both disposition paths considered; report no finding without expected/observed evidence. Return `findings: []` when the judged scope is clean.
4. Place findings in the ordinary QC report with `Source Type: deep-lens: Overdesign Judge Lens`. The owning PM captures advisory findings as issues through the existing issue-capture route; the QC seat does not mutate the store.

## L2 criteria

### OD-J-MODEL — Gate necessity versus the declared operating model

Frozen anchor: [#340 epic lesson](https://github.com/btspoony/mstar-harness/issues/340#issuecomment-5934855290):

> The cleanup should start by classifying every gate against the owner's actual operating model (local files, everything stopped, process data disposable), not by fixing gates one at a time.

Does the gate protect a condition that can occur under the Assignment's premise? Identify the assumed concurrent writer, live service, irreplaceable data, or other hazard and compare it with the declared environment. For a stopped local disposable update, a concurrent-mutation barrier needs an actual in-model justification, not a production analogy. A different declared premise may justify a different judgment.

Evidence must pair the exact premise with the gate's protected hazard and refusal path. Suggest a designed resolution that removes an unnecessary gate or performs the supported correction; alternatively, identify unresolvable material that can be losslessly archived, durably excluded, and completed. Do not infer authorization to discard foreign or protected state.

### OD-J-CONTRACT — Gate versus contract semantic agreement

Frozen anchor: [#340 rule and instance 1](https://github.com/btspoony/mstar-harness/issues/340):

> A validation gate may not refuse a state its own documented contract calls importable.

The binding example describes `input_hash` as:

> *its identity, not an execution pin*

Compare the comment/spec's allowed state with the branch that refuses it. Does the code demand equality, ownership, freshness, or registration that the contract does not require? Show the accepted-state statement and the rejecting predicate together; a suspicious name alone is insufficient.

Suggest deletion of a contradictory predicate or a designed resolution consistent with the declared contract, not rewriting the comment merely to bless the refusal. For genuinely unknown/unresolvable material, describe lossless archive/exclusion/completion instead. If the contradiction also proves a mechanical hash-gate violation, report that mechanical defect as Critical rather than downgrading it to semantic advice.

### OD-J-SELF-OUTPUT — Classification of self-written persisted output

Frozen anchor: [#340 throw-site lesson](https://github.com/btspoony/mstar-harness/issues/340#issuecomment-5933407399):

> **flag refusals that re-validate the system's own persisted output** (self-written manifests, bindings, envelopes, journals) — those need resolutions or archive-exclusions, not refusals.

Trace who wrote the record and which operation is consuming it. Does discovery/import classify the system's own manifests, bindings, envelopes, or journals as foreign operator input and stop the whole operation on a defect? Cite producer and consumer anchors plus the actual classification. A record being stored locally alone does not prove that it is self-written or disposable.

The source's ~65 misses among ~550 sites identify this failure class; they are not a mandate to delete every throw. The later epic lesson separately revisits ~440 of ~485 gates against the operating model. Do not conflate those two historical classifications.

Suggest a designed normalization/repair for a known violation; for unknown/unresolvable self-written material, archive the exact bytes, record the exclusion durably, and complete. Do not apply this classification to foreign ownership, path escape, or required authority checks without evidence and the appropriate contract.

### OD-J-PROTOCOL — Protocol sized for a nonexistent problem

Frozen anchor: [#340 epic lesson](https://github.com/btspoony/mstar-harness/issues/340#issuecomment-5934855290):

> The failure was not 16 independent bugs. It was **one architectural premise** — "protect a live production migration" — applied to a **local, stopped, disposable workspace update**, generating ~485 fail-closed gates of which ~440 were correct-for-production and wrong-for-here.

Inspect the changed protocol as a whole: do attestations, coverage closure, canonical hash chains, evidence barriers, or staged graphs solve a demonstrated problem within the declared premise, or maintain extra artifacts solely to cross-confirm each other? Distinguish this architectural mismatch from OD-J-MODEL's individual gate; do not duplicate the same finding under both IDs.

Evidence must connect the added protocol/dependencies to its assumed hazard and the declared premise. Suggest the smallest complete designed operation rather than adding another declaration or repair protocol. Consider archive-and-complete for unresolvable process data only where lossless exclusion fits the contract. Neither protocol size nor gate count alone proves overdesign.

## Severity and structured output

**Red line: mechanical-rule violations and catch-all masking are blocking Critical; semantic findings are advisory, captured as issues. The judge must not become a new over-gate.**

- Proven violations of the frozen mechanical rules (hash gates/assertions outside the replay exception, dead-end refusal requirements, unjustified required parameters, undiscoverable capabilities, or unordered index-based set comparison) are **Critical**. Cite the named rule and the supplied lint finding or concrete source evidence; do not invent lint coverage or treat `allowlisted` as proof of a new violation.
- A generic catch-all that masks identifiable causes is **Critical** even if AST sees a cause-code string and an existing recovery command. Syntactic presence does not make a recovery executable in the failing state.
- OD-J-MODEL / OD-J-CONTRACT / OD-J-SELF-OUTPUT / OD-J-PROTOCOL findings without a separately proven mechanical or masking violation are **Suggestion (advisory)**. Capture them as issues through PM; do not promote them to Warning/Critical or require their resolution before approval. This lens alone must not turn semantic disagreement into a blocking verdict. Other independently established QC defects keep their existing severity and verdict rules.

Every finding has these four fields; `severity` uses the QC report's Critical / Suggestion labels, not a new issue-store enum:

```text
rule-id: stable frozen-rule identifier (OD-J-* above; OD-M-HASH,
         OD-M-REFUSAL, OD-M-REQUIRED, OD-M-HELP, OD-M-ORDER,
         or OD-CATCH-ALL for proven non-semantic defects)
severity: Critical (blocking) | Suggestion (advisory)
evidence: declared operating-model premise; frozen-rule source URL;
          diff/read/grep file:line anchors and relevant excerpts;
          expected versus observed, including producer/consumer or
          cause/recovery reachability where applicable
disposition suggestion:
  designed resolution: specific deletion/normalization/repair or public
                       recovery consistent with the frozen rule
  archive-and-complete: exact bytes to preserve, durable exclusion to
                        record, and operation to complete; if inapplicable,
                        state why and select designed resolution
```

These IDs identify judgment findings; they do not replace the mechanical lints' classification vocabulary. Both paths are suggestions, not authority to mutate or archive state. Archive-and-complete must not fabricate success for an unresolved security, ownership, or authority violation. For prohibited gates, choose deletion, not a newly invented bypass.

## Worked judgments (historical, not current defects)

### 1. Prepare-seal C-class hash gate — L1 catches; judgment confirms deletion

- **rule-id:** OD-M-HASH
- **severity:** Critical (blocking)
- **evidence:** [#341 owner correction, comment 2](https://github.com/btspoony/mstar-harness/issues/341#issuecomment-5953290104) identifies `plan prepare` pinning Assignment/plan SHA-256, then recomputing them on every plan-row change and refusing with `coordination.assignment-stale`. Expected: hashes record reviewed bytes, never gate routine edits. Observed historically: document-byte drift refused the operation. This is the C-class external-document-versus-own-pin pattern; L1 hash-gate enforcement catches it, and L2 must not reinterpret it as mere missing recovery.
- **disposition suggestion:** Designed resolution: delete the `assignment_sha256` / `plan_sha256` refusal predicates (`assertPreparedFresh` and bind-adoption plan comparison); preserve record-only `assignment_path`, `prepared_by`, `prepared_at`, and apply necessary QA/cleanup/scope constraints by field values. Archive-and-complete: inapplicable to a prohibited comparison, not unresolvable material. Do not add a reseal route to repair the gate. This disposition is tightly bound to the owner correction, not the earlier #340 reseal suggestion.

### 2. Production-cutover protocol on a stopped local workspace — pure L2

- **rule-id:** OD-J-PROTOCOL
- **severity:** Suggestion (advisory; issue capture)
- **evidence:** Assignment premise for this example: `local, stopped, disposable workspace update`. [#340 epic lesson](https://github.com/btspoony/mstar-harness/issues/340#issuecomment-5934855290) describes attestations, coverage closure, canonical digests, evidence barriers, and staged graphs protecting concurrent mutation despite everything being stopped; ~440 of ~485 gates were correct-for-production and wrong-for-here. Expected: protocol protects actual in-model hazards. Observed historically: live-production assumptions drove a local static update. AST can locate the gates but cannot decide whether that operating model makes the protocol necessary.
- **disposition suggestion:** Designed resolution: remove the unnecessary cutover machinery in favor of the source's minimal operation: **stop → copy the dir aside (or discard it) → move the data → point at the new store → done.** Archive-and-complete: preserve exact unresolvable process-data bytes, durably record exclusions, and complete the static import when the contract permits it. Do not demand another attestation to resolve this advisory finding. A live/non-disposable Assignment would require a different judgment, not reuse of this conclusion.

### 3. Generic `store.upgrade-blocked` catch-all — blocking despite syntactic fields

- **rule-id:** OD-CATCH-ALL
- **severity:** Critical (blocking)
- **evidence:** [#340 instance 4](https://github.com/btspoony/mstar-harness/issues/340) records: “One generic `store.upgrade-blocked` refusal masked every specific cause, with a "rerun" recovery that refused identically.” Expected: actual cause plus operator-executable recovery. Observed historically: identifiable causes collapsed into one message and an identical-failure retry. Even if a mechanical candidate has a literal code and recovery string, the judge confirms masking by tracing the specific cause into the catch-all and the retry back to the same rejection.
- **disposition suggestion:** Designed resolution: preserve the structured specific cause and provide its supported, discoverable resolution instead of generic rerun advice. Archive-and-complete: for truly unknown/unresolvable import material, preserve exact bytes, record its exclusion, and complete; not for all errors indiscriminately. Do not swallow errors, relabel the catch-all, or claim the operation succeeded without its required work.
