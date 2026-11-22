---
category: Fixed
packages: root
---

- **A same-ID overlap can no longer release the winning reservation.** A `remote.operation-conflict` that READ a durable
  outbox row proves the failure happened AFTER a freeze, so the losing identical attempt reports a partial and retains
  the shared reservation instead of declining it; the winner's frozen intent settles by the same-id replay, which a
  bounded same-ID overlap regression observes end to end (one frozen intent, one resumable reservation).
- **Remote capture decides against the observation it freezes.** The write's sampled observation revision is re-proved
  inside the freeze transaction, so a scope that moves after the last sample refuses
  `collaboration.observation-stale` instead of freezing decisions about a superseded base; the occurrence-key dedupe is
  project-wide (another subject's key answers the established receipt, a conflict, or an identity refusal — never a
  second append), and the established no-op answer sits inside the replay boundary. A confirmed append receipt names
  the eventId of the occurrence actually in the confirmed event.
- **Closures enforce their gates on the freeze revision.** An ordinary closure and a plan-scoped residual-close re-prove
  the sampled base inside the freeze transaction and keep the reservation when the scope moved; a terminal refusal's
  inspect command is valid for the addressed alias (a provider UUID names its `--project`), and reopening a terminal
  issue is stated as a deliberate change with its required inputs, never a default next step.
- **One structural contract drives the observe documents and the engine's recursive refusals.** The published
  `portableSubject` accepts the `fields` member the engine requires, so a marked observation the runtime accepts is no
  longer refused by discovery; the engine's identity, event and observed-records parsers collect unknown keys and every
  nested defect into ONE refusal before any outbox access, while authority, freshness and exact-event checks stay the
  engine's own.
- **Cache-recovery and roadmap evidence no longer assume a three-migration layout or an empty template.** The
  destination ledger assertion reads the whole migration registry, and the undated roadmap round-trip authors a
  Direction and proves its semantic survival, the absent `created_at`, and the re-export's own success status.
