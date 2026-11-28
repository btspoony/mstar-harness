---
category: Fixed
packages: dsh
---

- **The milestone write channel recovers from a stale store revision.** A write refused with the engine's revision-conflict class now refreshes the roadmap read (an input-validation refusal still never does), so the retry carries the freshly observed revision instead of being refused forever. In-progress drafts moved out of the read's subtree into a host-owned store keyed per target ('create' / the milestone id): a refresh re-mounts the form over the typed values, and an accepted write clears exactly its target's entry.
