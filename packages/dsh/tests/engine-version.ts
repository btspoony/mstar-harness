/**
 * The tracked engine manifest version (`packages/engine/package.json`
 * `.version`, resolved relative to the dsh package under the monorepo) —
 * the same source the runtime's `readHarnessVersion()` reads (engine
 * `core.ts` reads `<moduleDir>/../package.json`; both the src layout and the
 * bundled `dist/` layout land on the engine package manifest). Engine-version
 * assertions use this shared value instead of a hardcoded pin so future
 * engine releases do not re-break the dsh suite.
 */
import { readFileSync } from 'node:fs'

export const ENGINE_VERSION = (JSON.parse(readFileSync(new URL('../../engine/package.json', import.meta.url), 'utf8')) as { version: string }).version
