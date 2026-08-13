# Changelog

All notable changes to the `@mstar-harness/dsh` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

## [2.2.0] - 2026-08-13

### Changed

- **dsh public release prep**: removed the `prepare` script from `@mstar-harness/dsh` (fresh-checkout `bun install` no longer fails on the gitignored engine `dist/`; the monorepo builds packages explicitly, matching cli/opencode), wired dsh into the release pipeline (`release-surfaces.ts` version surface + changelog, `release.yml` build/publish), and made the READMEs public — the private dsh-provider block and the private-mirror repo-URL install (`dsh-external/mstar-workflow`) are gone, replaced by the registry form `dsh plugin --profile web add @mstar-harness/dsh` (plus local-checkout dev install). Dropped a stray committed `.pnpm-store/` (gitignored now).

- Version alignment with harness **2.2.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.2.0**.

