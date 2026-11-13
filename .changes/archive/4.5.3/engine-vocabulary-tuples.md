---
category: Changed
packages: engine
---

- **Issue kind and severity are declared tuples** (`ISSUE_KINDS`, `ISSUE_SEVERITIES`) beside the disposition tuple; every validation map and browser filter derives from them through `vocabularyMap`, so adding a member is one edit and no consumer can silently skip it.
- Exported **`REVIEW_RUN_LEVELS`** and derived `ReviewRunLevel` from it.
