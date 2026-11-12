---
category: Fixed
packages: opencode-v2
---

- **A failed engine load now keeps its cause, and the dispatch refusal names a recovery that works.** The four `engine-seams.ts` seams logged nothing before caching `null`, so a rejected `@mstar-harness/engine` import surfaced only as an opaque refusal; each seam now logs the rejection cause. The dispatch gate's null-engine refusal told the operator to upgrade the plugin, which cannot clear a failed promise cached for the session — it now names a host reload or restart, matching the write gate.
- **A missing or empty `AGENTS.md` bootstrap warns at setup instead of silently vanishing.** `registerHooks` skips injection when the bundled content is absent, which left a packaged-but-broken install indistinguishable from a working one; setup now logs the missing asset and the reinstall that restores it. A packaging assertion pins `AGENTS.md` in the package file set.

<!-- CN -->
- **引擎加载失败现在保留原因，派发拒绝给出真正可行的恢复动作。** `engine-seams.ts` 的四个接缝此前在缓存 `null` 前不记录任何信息，`@mstar-harness/engine` 导入失败只剩一条不透明拒绝；现在每个接缝都记录失败原因。派发门禁的空引擎拒绝原本让操作者升级插件，但升级无法清掉本会话已缓存的失败 promise——改为点名重新加载或重启宿主，与写入门禁一致。
- **`AGENTS.md` 引导内容缺失或为空时在 setup 告警，不再静默消失。** 内容缺失时 `registerHooks` 跳过注入，打包后损坏的安装与正常安装因此无法区分；setup 现在记录缺失资产与可恢复它的重装动作，并新增打包断言钉住 `AGENTS.md` 在包文件集内。
