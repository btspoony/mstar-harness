---
packages: root
---

- **dsh plugin**: new `mstar-harness-state` catalog row at `agent/pre-step` — per-workspace digest of plan registry, open residual counts, branch/policy anchors, active execution leases, knowledge-index summary and the steering compass direction one-liner (all from one cached `status.json`/compass/knowledge read).
- **dsh plugin**: the pre-step catalog cache (engine-status / iteration-gate / harness-state rows) is now TTL-refreshed per workspace — Config `catalogTtlMs` (default 60000 ms) bounds mid-session plan/compass/residual staleness while the hot path stays a timestamp compare + cache hit between refreshes.
