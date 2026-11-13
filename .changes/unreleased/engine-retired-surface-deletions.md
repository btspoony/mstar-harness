---
category: Removed
packages: engine
---

- Removed three retired engine surfaces with their barrel exports and the tests that only pinned them: **`assertIndexRows`** (always returned a `compound.index.retired` violation), **`claimIntegrationMergeLease`** (no importer; the generated hook bundles no longer inline it) and `renderReviewMarkdown`'s unused options argument with `ReviewRenderOptions` / `ReviewRenderSurface`.
