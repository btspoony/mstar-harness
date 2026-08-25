---
packages: engine, cli
---

<!-- CN block intentionally omitted — engine/cli changelogs are EN-only; root bullets reused per .changes/README.md -->
- **Audit index security dispositions in `scaffoldAuditPlan`** (engine): the README index renderer now emits the documented **Needs verification** and **Hardening & checked notes** sections (new `needsVerification` / `hardeningChecked` options). On re-runs without those options, previously rendered entries are carried over from the existing README, so hand-added or earlier-run security leads, hardening notes, and checked-and-clean records survive the index rebuild instead of being silently dropped.
- **`mstar audit scaffold` accepts security dispositions** (cli): the findings file now also accepts an object form `{findings: [...], needsVerification?: [{lead, how, evidence?}], hardeningChecked?: [{kind, text}]}` (bare array still supported) and passes the dispositions through to the engine renderer, so CLI-scaffolded audit indexes include the security sections exactly as documented in `mstar-audit/references/security-review.md`.
