---
category: Fixed
packages: engine
---

- **`@mstar-harness/engine` declares the `zod` dependency it imports.** `src/remote-documents.ts` imports `zod`, but the package manifest did not list it, so a clean `bun install` never placed it where the engine workspace resolves modules; every CI job that built the engine failed with `Could not resolve: "zod"`. Local checkouts masked it through a stale `packages/engine/node_modules/zod`.
