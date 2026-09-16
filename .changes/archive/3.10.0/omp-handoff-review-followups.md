---
category: Changed
packages: omp
---

- A reused coordinator session can arm `@slow` for a later workflow after the previous model-handoff binding is terminal; the post-await concurrent-arm check no longer treats every historic record as an active binding.
- The Phase-1 fire path re-reads the session ledger after every await and refuses to invoke `setModel` when an observation handler already terminalized the pending record.
- Phase-2 native-delivery suppression samples settled job ids at `agent_end` before marking them consumed, so a tool-using coordinator turn does not emit a duplicate `triggerTurn` follow-up after the host already delivered the completion.
