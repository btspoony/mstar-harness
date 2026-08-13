---
packages: root, dsh
---
- **dsh public release prep**: removed the `prepare` script from `@mstar-harness/dsh` (fresh-checkout `bun install` no longer fails on the gitignored engine `dist/`; the monorepo builds packages explicitly, matching cli/opencode), wired dsh into the release pipeline (`release-surfaces.ts` version surface + changelog, `release.yml` build/publish), and made the READMEs public — the private dsh-provider block and the private-mirror repo-URL install (`dsh-external/mstar-workflow`) are gone, replaced by the registry form `dsh plugin --profile web add @mstar-harness/dsh` (plus local-checkout dev install). Dropped a stray committed `.pnpm-store/` (gitignored now).

<!-- CN -->
- **dsh 公开发布准备**：移除 `@mstar-harness/dsh` 的 `prepare` 脚本（fresh checkout 下 `bun install` 不再因 gitignored 的 engine `dist/` 失败；monorepo 与 cli/opencode 一致显式构建各包），把 dsh 接入发布流程（`release-surfaces.ts` 版本表面 + changelog、`release.yml` 构建/发布），并全面公开 README——删除私有 dsh-provider 区块与私有镜像 repo-URL 安装（`dsh-external/mstar-workflow`），改为 registry 形式 `dsh plugin --profile web add @mstar-harness/dsh`（外加 local-checkout 开发安装）。清除误提交的 `.pnpm-store/`（现已 gitignore）。
