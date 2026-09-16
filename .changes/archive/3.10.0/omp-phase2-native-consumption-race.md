---
category: Changed
packages: omp
---

- **Phase-2 native-delivery silence**: the reminder pass now consumes exactly the terminal job ids the decision sampled, instead of re-reading the async-job snapshot after the decision. A job that settles while the settings read is awaited can no longer be marked consumed without ever taking part in native-delivery suppression, which previously allowed a redundant reminder for an already-delivered completion.
- Added a `phase2Seams.readSettings` test seam and regressions covering settlement inside the settings-await window (no double reminder, no silent swallow) and the unchanged bounded reminder for a non-delivered change.
