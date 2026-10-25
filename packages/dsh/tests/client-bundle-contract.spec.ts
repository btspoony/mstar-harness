/**
 * Task 7: the shipped client bundle's contract.
 *
 * The plain-`.css` loader landed early (Task 2 needed it to import
 * `@mstar-harness/ui` at all); this suite VERIFIES the artifact rather than
 * adding anything:
 *
 * - the purity gate passes (a build that reaches the assertions has passed it);
 * - no `@deepseek-ai/*` VALUE import survived outside the loader table;
 * - no remote reference (offline, single artifact);
 * - both shared global sheets (`tokens.css`, `base.css`) are inlined exactly
 *   once — one `<style data-plugin>` per sheet, never duplicated by a second
 *   import path;
 * - the size ceiling (500 KB, compass constraint 8) holds, and the measured
 *   size is reported.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { offTableDeepseekRequires } from '../scripts/build-client-bundle.ts'

/**
 * The artifact the plugin ships. This suite reads the BUILT bundle, so the run
 * order is: `bun run --cwd packages/dsh build` first, then this spec (the same
 * order the packed-artifact spec needs).
 */
const BUNDLE = join(import.meta.dir, '..', 'dist', 'client.js')
if (!existsSync(BUNDLE)) {
  throw new Error('dist/client.js is missing — run `bun run --cwd packages/dsh build-client` before this suite')
}
const text = readFileSync(BUNDLE, 'utf8')
const bytes = statSync(BUNDLE).size

describe('client bundle — the shipped artifact', () => {
  it('stays under the 500 KB ceiling', () => {
    expect(bytes).toBeLessThanOrEqual(500 * 1024)
    // eslint-disable-next-line no-console
    console.log(`client bundle: ${bytes} B`)
  })

  it('carries no @deepseek-ai/* value import beyond the loader table', () => {
    expect(offTableDeepseekRequires(text)).toEqual([])
  })

  it('references no remote asset or endpoint', () => {
    expect(/https?:\/\//.test(text)).toBe(false)
  })

  it('inlines both shared global sheets exactly once', () => {
    // One marker per sheet: a token role from `tokens.css`, a base-layer rule
    // from `base.css`. Twice would mean two import paths inlined one sheet.
    const occurrences = (marker: string): number => text.split(marker).length - 1
    // Declarations (not usages): a role declaration exists only in `tokens.css`,
    // and the reset rule only in `base.css`.
    expect(occurrences('--ms-font-sans: system-ui')).toBe(1)
    expect(occurrences('--ms-fs-11: 11px')).toBe(1)
    expect(occurrences('box-sizing: border-box')).toBe(1)
    // And the sheets arrive through the plugin-tag mechanism the module files use.
    expect(text).toContain('data-plugin-css')
  })
})
