---
packages: dsh
---

- **The engine-status catalog derives its panel projection once per cache build.** The pre-step gate called `panelDigestOf` on every step, re-serializing the whole catalog payload even when the payload came from an unchanged cache entry. The projection now lives on the cache entry (`CatalogCacheEntry.projection`), is computed where the entry is built, and is returned alongside the payload by `readCatalogPayload`, so the gate reads it instead of recomputing it. `panelDigestOf` stays exported and unchanged — it is still the definition of the projection. Change detection is untouched: the model row still compares rendered text, the panel still compares the full projection.

<!-- CN -->
- **engine-status catalog 的 panel 投影改为每次缓存构建只算一次。** pre-step gate 原本在每个 step 都调用 `panelDigestOf`，即使 payload 直接来自未变的缓存条目也要把整个 catalog payload 重新序列化一遍。投影现在存在缓存条目上（`CatalogCacheEntry.projection`），在构建条目处计算，并由 `readCatalogPayload` 与 payload 一并返回，gate 直接读取而不再重算。`panelDigestOf` 仍然导出且行为不变——它依旧是投影的定义。变更检测语义未动：模型行照旧比较渲染文本，panel 照旧比较完整投影。
