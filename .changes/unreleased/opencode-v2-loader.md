---
category: Fixed
packages: opencode-v2
---

- **A failed engine load now keeps its cause, and both gates name the recovery that actually fits the failure.** Every `engine-seams.ts` gate seam used to log nothing before caching the failure, so a rejected `@mstar-harness/engine` import and a missing engine export both surfaced as one opaque refusal. Each seam now logs its cause, and the dispatch and write gates distinguish the two cases: a rejected import is cached for the host process lifetime, so the refusal names a host reload or restart; a loaded engine that lacks the expected exports is a version mismatch a reload would reproduce identically, so the refusal says the installed plugin and engine do not match and names the reinstall that ships a matching engine.
- **A missing or empty `AGENTS.md` bootstrap warns at setup instead of silently vanishing.** `registerHooks` skips injection when the bundled content is absent, which left a packaged-but-broken install indistinguishable from a working one; setup now logs the missing asset and the reinstall that restores it. A packaging assertion pins `AGENTS.md` in the package file set.

<!-- CN -->
- **引擎加载失败现在保留原因，两个门禁都给出真正可行的恢复动作。** `engine-seams.ts` 的每个门禁接缝此前在缓存失败前不记录任何信息，`@mstar-harness/engine` 导入失败与引擎缺少导出因此都收敛成同一条不透明拒绝；现在每个接缝都记录失败原因，派发与写入两个门禁区分这两种情况：导入失败只在宿主进程生命周期内缓存，因此拒绝点名重新加载或重启宿主；引擎已加载但缺少预期导出属于版本不匹配，重新加载会原样复现，因此拒绝直接说明插件与引擎不匹配，并点名可装回匹配引擎的重装动作。
- **`AGENTS.md` 引导内容缺失或为空时在 setup 告警，不再静默消失。** 内容缺失时 `registerHooks` 跳过注入，打包后损坏的安装与正常安装因此无法区分；setup 现在记录缺失资产与可恢复它的重装动作，并新增打包断言钉住 `AGENTS.md` 在包文件集内。
