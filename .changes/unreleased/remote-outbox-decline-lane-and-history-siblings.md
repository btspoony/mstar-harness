---
category: Fixed
packages: root
---

- **The settled-effect correction is now runnable as printed.** The changed-field refusal of a remote registration names
  the journal's own `--project` on its `mstar catalog update` route (a remote catalog write refuses without it), and the
  structured refusal carries that same ordered route as `recovery` plus the durable `confirmed_components`, so a replayed
  decline never reports an effect-free operation. A command-surface regression proves the flag is both required and
  accepted.
- **The empty outbox probe and the durable decline share one lane.** The composite decline checks for the same-id durable
  intent INSIDE the remote-cache write lane and commits the execution decline while holding it, while a composite freeze
  proves the reservation is still `prepared` in that same lane before inserting. A freeze that lands between the sampled
  refusal and the decline therefore retains the reservation, and a decline that wins refuses an already-admitted
  attempt's freeze instead of leaving a durable intent it can never finalize. Two bounded overlaps cover both orderings.
- **One malformed history entry no longer truncates a receipt refusal.** Every subject-history row is its own collection
  boundary in the runtime parser (and the project journal's rows too), so a null entry and a later entry with a bad field
  are named together with the subject's own field defects; the engine-owned descriptors already report per entry, and
  both paths are asserted on one receipt before any outbox access.
