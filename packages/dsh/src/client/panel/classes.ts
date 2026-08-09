/**
 * CSS-module class seam: the dsh client bundle (Task 4, `bun build`) rewrites
 * `*.module.css` imports into hashed class maps, while the dev-time `bun test`
 * transpiler leaves the import as the raw file-path string. `cls()` resolves a
 * logical class name through whichever shape arrived, falling back to the
 * plain name so dev-time renders (and their assertions) stay stable.
 *
 * simplify: direct `css.<name>` access once the dev-time test environment
 * processes CSS modules (upgrade path: bundle the spec through `bun build`
 * like the real client bundle).
 */

import css from './panel.module.css'

/** Resolve one logical class name to its emitted CSS-module class (plain name in dev-time tests). */
export function cls(name: string): string {
  const value = (css as Readonly<Record<string, string>>)[name]
  return typeof value === 'string' && value.length > 0 ? value : name
}
