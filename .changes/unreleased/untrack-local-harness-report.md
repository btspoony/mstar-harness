---
category: Fixed
packages: root
---

- Untrack the local harness process reports that had been committed under `.mstar/`. `.mstar/` is gitignored, so tracked files there could only have arrived by force-add; process artifacts are local state and must not be tracked. A report that must persist belongs in `{KNOWLEDGE_DIR}` or another tracked location.

<!-- CN -->
- 取消跟踪此前被提交到 `.mstar/` 下的本地 harness 进程报告。`.mstar/` 默认被忽略，因此其中被跟踪的文件只能是强制添加进来的；进程产物属于本地状态，不应纳入版本跟踪。需要长期留存的内容应放入 `{KNOWLEDGE_DIR}` 或其他受跟踪位置。
