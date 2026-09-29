---
category: Changed
packages: root
---

- **Development calibration** recognizes a genuinely fresh frozen qualification root as a first run and loads prior-run manifests and request hashes from the newest per-run directory, preserving freeze identity checks.
- **Freeze validation** now rejects annotated corpus variants that lack a gold row instead of silently excluding their labels from coverage checks.

<!-- CN -->
- **开发校准**将真正全新的冻结资格根目录识别为首次运行，并从最新的单次运行目录加载先前的清单和请求哈希，同时保留冻结身份校验。
- **冻结校验**现在会拒绝存在标注但缺少 gold 行的语料变体，不再静默排除其标签覆盖检查。
