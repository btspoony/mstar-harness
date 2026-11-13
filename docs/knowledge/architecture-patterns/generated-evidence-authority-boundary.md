---
module: engine+commands+omp (attestation provisioning, store transactions)
date: 2026-10-30
problem_type: architecture_pattern
category: architecture-patterns
last_updated: 2026-11-13
severity: medium
applies_when:
  - replacing a hand-authored authorization or evidence document with tool-generated evidence
  - adding a new consumer of an activation/recovery attestation
  - reviewing a prepared/barrier document for whether its facts are provable
tags:
  - attestation
  - transaction
  - authority-boundary
  - generated-evidence
  - refusal
related_components:
  - packages/engine
  - packages/commands
  - packages/omp
---

# Generated evidence must be produced by the transaction that acts

Lessons from replacing a hand-authored authorization document (`--attestation`) with tool-generated
evidence across five store verbs (recover, upgrade, activate, reopen, adopt-terminal). Each rule
came from a real review finding, not a hypothetical.

## The generator must only restate what the same transaction did

When a barrier document moves from "operator writes it" to "the tool writes it", the only honest
content is the action the same transaction is performing: the rows it revokes, the epoch it bumps,
the clock it stamps. A generated document may never assert a fact the tool did not cause — "all
installed hosts are reloaded" or "this process died" cannot be demonstrated by the writer, so it
must be narrowed to "this recorded row no longer authorizes after this transaction" and the
narrowing stated in the code comment and the receipt text. Inventing a plausible value to satisfy
the validator turns the barrier into decoration.

## Enforcement belongs at the receiver, not the transport

The self-settlement rule ("a caller may not name itself as the prior holder") existed only in the
CLI command layer. Every host adapter that calls the engine directly — a host tool, an MCP bridge —
bypassed it, and the generated document then attested a stop the caller had caused to itself. The
fix is one check at the engine receiver covering both supplied and generated branches, with the
transport check kept as early UX. Rule: if two callers reach the same authority, the no-bypass
check lives at the authority.

## A validator is the acceptance authority; a builder never validates

Split the work: the builder assembles shape and process facts; the existing validator decides
acceptance at each receiving site, inside that site's transaction. This keeps one acceptance rule
(no second, drifting copy) and makes "the generated document must pass the existing validator"
true by construction rather than by review.

## Provisioning is a transaction step, not a request preprocessor

For a verb that already has a guarded transaction, build and validate the document inside it, so a
mid-way failure rolls the mutation back with the evidence. For a migration path that cannot decide
before rolling back (retired-claim settlement), raise an internal "needs document" signal, let the
first pass roll back, provision from the collected facts, and retry exactly once — never loop, and
convert a second signal into a named refusal instead of a bare error.

## Refuse with cause and recovery; do not fabricate the unavailable fact

Process facts can genuinely be unavailable: Bun is never an admissible consumer runtime, an
entrypoint can be absent, a node floor can be unresolvable. Each case refuses with a named cause and
a route the caller can actually take (run through the installed Node CLI, supply the explicit
override). A fabricated value is never the recovery.

## Generated artifacts are proved by behavior, not by a recorded digest

This repository keeps no committed digest inventory of generated bundles: a recorded digest can only
describe the environment that ran the build, and comparing it back re-reports environment drift as
source drift. Generated artifacts are held honest by a rebuild in CI (the blocking bundle build) and by
the suites that execute the built artifact, not by a checked-in hash — and not by diffing the rebuild
against the committed copy, which reports the bundler version rather than the source.
Never add a snapshot re-take step, a digest comparison, or a version pin as a test assertion — the
repository's test rules forbid that class outright.

## A pass/fail gate that only runs in CI hides environment inheritance

Synthetic-marker tests that read the ambient environment pass in CI and fail in a real deployment
shell that exports the same marker. Clear the identity channels in the fixture (or make the fixture
own its environment) so a red always means a regression.
