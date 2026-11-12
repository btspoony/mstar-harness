---
category: Fixed
packages: opencode-v2
---

- **The V2 package's live version citations follow the manifest pin.** `assets.ts` and `hooks/bootstrap.ts` still named `2.1.3` while the manifest pinned `2.2.5`, so a reader checking a projection claim landed on the wrong tag; each live claim now names the pin and its installed declaration, with the bootstrap declaration anchor re-read at the pinned package. Historical receipts keep the version they recorded.
- **The OpenCode V2 host-presence note states the generation the installer ships.** The knowledge document named `@opencode/plugin` `2.0.26`; it now matches the manifest pin.
