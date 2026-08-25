---
packages: engine
---

<!-- CN block intentionally omitted — engine changelog is EN-only; root bullets reused per .changes/README.md -->
- **Audit index security dispositions in `scaffoldAuditPlan`**: the README index renderer now emits the documented **Needs verification** and **Hardening & checked notes** sections (new `needsVerification` / `hardeningChecked` options). On re-runs without those options, previously rendered entries are carried over from the existing README, so hand-added or earlier-run security leads, hardening notes, and checked-and-clean records survive the index rebuild instead of being silently dropped.
