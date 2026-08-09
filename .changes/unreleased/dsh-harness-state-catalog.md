---
packages: root
---

- **dsh plugin**: the pre-step catalog is now ONE unified `mstar-engine-status` message — watermark (version, harness dir, enforcement) + iteration phase-gate section (when a steering compass resolves) + workspace-state digest section (plan registry, open residuals, branch/policy anchors, active leases, knowledge summary, compass direction — when the workspace has a `status.json`) — all from one cached `status.json`/compass/knowledge read.
- **dsh plugin**: the catalog row is TTL-refreshed per workspace (Config `catalogTtlMs`, default 60000 ms — mid-session plan/compass/residual changes land within one interval while the hot path stays a timestamp compare + cache hit) and digest-gated (injected once per turn, re-injected only when it changed — a long turn shows the catalog once, not per step).
