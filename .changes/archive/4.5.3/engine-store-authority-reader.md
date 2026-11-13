---
category: Changed
packages: engine
---

- Added **`readStoreAuthority(db)`**: one `store_meta` select returning the raw authority columns plus `missing`, so the seventeen domain sites that re-derived that shape now share one reader — including the restore inventory and the diagnostic export, which keep their own stricter `staged|active` validation on top of it. The reader never throws — each caller keeps its own refusal type, code and message.
