---
category: Fixed
packages: root
---

- **A sampled refusal can no longer decline a reservation whose intent the winner froze.** Before the frame records a
  deterministic decline, it re-reads the composite's remote outbox rows under the freeze's own write lane
  (`remoteIds` on every remote composite: residual-add entries, residual-close and execution-register). A durable
  intent found there — or a lane that cannot be read, which proves nothing either way — keeps the reservation prepared,
  and the same-id replay settles from the winner's confirmed intent; a bounded regression freezes, dispatches and
  confirms the winner inside the loser's replay-admission gap and proves the refuse-then-resume journey end to end.
- **An established no-op answer is replay-first and observation-proven, like an insert.** At the decision boundary —
  inside the remote-cache write lane, the lock every freeze takes — the answer re-checks the outbox row under the
  operation id and the sampled observation revision: a different-payload capture that froze the same id in the overlap
  refuses as a collision instead of reporting a false established success, and a superseded sample refuses
  `collaboration.observation-stale`. A bounded no-op/operation-id overlap regression observes the refusal and the
  intact winner row.
- **One structural owner for the strict remote documents.** The published observe/receipt/reconcile/adoption/resolve/
  dispatch/bind descriptors move into the engine (`remote-documents`), built from the same vocabularies the runtime
  parsers enforce; the command package only re-exports them, so discovery can never drift from the document the
  runtime accepts. The engine's subject parsers (fields and every history row) now collect their defects in collector
  mode, so one receipt refusal names two bad subject fields and a malformed history row together — through the
  published descriptor and the runtime alike — before any outbox access; `remote.unsafe-fidelity` stays its own
  refusal class and is never flattened into the structural aggregate.
