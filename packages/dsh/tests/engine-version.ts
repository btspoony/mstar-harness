/**
 * The tracked engine manifest version (`packages/engine/package.json`
 * `.version`, resolved relative to the source test layout
 * `packages/dsh/tests/` under the monorepo). This helper is only correct
 * from source — it anchors `../../engine/package.json` relative to
 * `import.meta.url` and is used where tests run from source (`bun test`);
 * the runtime's `readHarnessVersion()` is the one that handles src and
 * bundled `dist/` layouts via its own module dir. Engine-version assertions
 * use this shared value instead of a hardcoded pin so future engine
 * releases do not re-break the dsh suite.
 */
import { readFileSync } from 'node:fs'

export const ENGINE_VERSION = (JSON.parse(readFileSync(new URL('../../engine/package.json', import.meta.url), 'utf8')) as { version: string }).version
