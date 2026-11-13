---
category: Changed
packages: engine
---

- Added **`readStoreAuthority(db)`**: one `store_meta` select returning the raw authority columns plus `missing`, so the fourteen domain sites that re-derived that shape now share one reader. The reader never throws — each caller keeps its own refusal type, code and message.
