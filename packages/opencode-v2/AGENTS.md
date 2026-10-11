# Morning Star - Global Entry

## Morning Star Harness Core

Any code agent working in this repository must read the `mstar-harness-core` skill before starting any non-trivial task, including relevant files in its `references/` directory.

`mstar-harness-core` is the single source of truth for lifecycle gates, routing, host entry behavior, skill loading order, and execution invariants across all `mstar-*` skills.

All other execution behavior remains defined by `mstar-harness-core`.
