---
packages: engine
---

- **Sync ledger substrate.** Store migration 15 adds `project_bindings`, `issue_sync_state` and `sync_cursor`, and `issue-sync.ts` adds the item state machine (`unbound → pending → applied | failed | skipped`) with revision-guarded transitions and operation replay. Each public verb commits its ledger row and its `store_operations` receipt in **one transaction**, so an interrupted sync retries instead of hitting a one-way door. Skips record their reason in a dedicated column (never as the ledger's last error), retries keep the recorded remote identity, and rewriting the cursor already recorded is a no-op. New refusal `sync.local-issue-missing` names a `localId` that is not an issue in the store.
