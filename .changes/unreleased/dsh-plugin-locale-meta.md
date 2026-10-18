---
packages: dsh
---

- `@mstar-harness/dsh` now ships `locale/en.json` + `locale/zh.json`, so the dsh **Plugins page** shows the plugin's localized title and description instead of the raw package name and the long npm description.
- Declared the `./locale/*.json` subpath export and added `locale` to the published `files` list (the same shape as `dsh-advisor` and `dsh-llm-fallbacks`).

<!-- CN -->
- `@mstar-harness/dsh` 现随包发布 `locale/en.json` + `locale/zh.json`，dsh **插件页**显示插件本地化的标题与描述，不再是原始包名与冗长的 npm 描述。
- 新增 `./locale/*.json` 子路径导出，并将 `locale` 加入发布的 `files` 列表（与 `dsh-advisor`、`dsh-llm-fallbacks` 同形）。
