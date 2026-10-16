---
category: Harness
packages: root
---

- **The release preflight suite no longer pins the release version.** `scripts/release-preflight.test.ts` asserted that the real workspace manifests carry the literal `"4.0.0"`, so `release:prepare` bumping every manifest to the next version turned CI red on the release branch (`lint-scripts-hooks` → `Test scripts`) while `main` stayed green — a release-blocking failure no ordinary PR could surface. The expected version is now read from the root manifest, the release's own version source, so the assertion still catches a publishable package left behind at bump time.
- **`AGENTS.md` now states the rule this regressed against:** tests derive volatile repository facts (the release version, a package/role/skill inventory or count, a checkout path) from their owning source, and may pin a literal only as a synthetic fixture input nothing compares against reality.

<!-- CN -->
- **release 预检套件不再钉死发布版本。** `scripts/release-preflight.test.ts` 断言真实 workspace manifest 携带字面量 `"4.0.0"`，于是 `release:prepare` 把所有 manifest bump 到下一个版本后，release 分支上 CI 必红（`lint-scripts-hooks` → `Test scripts`），而 `main` 保持全绿——这是一个普通 PR 无法暴露的、会阻塞发布的失败。期望版本改为从根 manifest（发布版本自身的来源）读取，断言仍能捕获 bump 时有 publishable 包被遗漏。
- **`AGENTS.md` 现在写明这条被违反的规则：** 测试须从权威来源派生易变仓库事实（发布版本、包/角色/skill 清单或数量、检出路径），字面量只能作为不与现实比较的合成 fixture 输入。
