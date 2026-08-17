---
packages: root
---

- **Fail-loud fragment validation**: `scripts/prepare-release.ts` now validates each changelog fragment's `packages:` tokens against the release-surface enum (`root | cli | opencode | engine | dsh`). A typo'd or unknown token (e.g. `clii`, `scripts`) previously matched no changelog target and silently dropped the fragment's bullets from every changelog; release prep now prints one error line per bad token to stderr and exits 1 before any changelog mutation or fragment archival. `validateFragmentPackages` is exported for tests.

<!-- CN -->
- **fragment 校验 fail-loud**：`scripts/prepare-release.ts` 现对每个 changelog fragment 的 `packages:` token 按发布面枚举（`root | cli | opencode | engine | dsh`）校验。此前拼错的 token（如 `clii`、`scripts`）不匹配任何 changelog 目标，导致该 fragment 的要点被静默丢弃；现发版准备会在任何 changelog 改动或 fragment 归档前，逐行打印错误并以 exit 1 中止。`validateFragmentPackages` 已导出供测试使用。
