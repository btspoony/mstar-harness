---
category: Changed
packages: engine
---

- **Plan provenance is origin-scoped:** only plan-scoped writers can create scoped membership; actor-only links remain unscoped, and historical provenance remains plan-scoped.
- Origin-dependent issue reads refuse outdated stores with the supported `mstar store safe-upgrade` recovery.
- Removed the obsolete `triageIssueExecution`, `closeIssueExecution`, and `linkIssueExecution` exports from the engine API.
