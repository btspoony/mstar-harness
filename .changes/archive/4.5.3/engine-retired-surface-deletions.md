---
category: Removed
packages: engine
---

- Removed three retired engine surfaces with their barrel exports and the tests that only pinned them: **`assertIndexRows`** (always returned a `compound.index.retired` violation), **`claimIntegrationMergeLease`** (no importer) and `renderReviewMarkdown`'s unused options argument with `ReviewRenderOptions` / `ReviewRenderSurface`. The committed ZCode hook bundles intentionally stay at their base revision until `bun run release:prepare` rebuilds them.
