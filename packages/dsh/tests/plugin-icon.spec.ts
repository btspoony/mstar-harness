/**
 * dsh plugin artwork: `@mstar-harness/dsh` must ship the package-root `icon`
 * the dsh Plugins page reads for the package card and its component rows.
 *
 * Root cause: `readPluginMeta` (`@deepseek-ai/dsh-app-boot`, `lib/index.js`)
 * reads the manifest only for a package-root specifier (`packageName ===
 * specifier`), resolves that manifest through the exported `./package.json`,
 * resolves its `icon` relative to the manifest directory, requires the target
 * to stay inside that directory, accepts SVG/PNG/JPEG/WebP up to 256 KiB, and
 * hands the page a base64 data URL rendered as an `<img>`. Without it the page
 * falls back to the generic plugin artwork the screenshot bug showed.
 *
 * This test freezes the shipped shape the reader depends on: the relative
 * manifest field, the exported manifest, the tarball `files` entry, and a
 * self-contained 36px SVG (the plugin artwork box; the card frame supplies the
 * 48px tile). It does not repeat the locale dictionaries — that is
 * `plugin-meta.spec.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Package root of `@mstar-harness/dsh` (same resolution as manifest-contract.spec.ts). */
const PKG_DIR = join(import.meta.dir, '..')

const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  icon?: unknown
  exports?: Record<string, unknown>
  files?: string[]
}

/** The reader's size cap for one icon (raw bytes, before base64). */
const ICON_MAX_BYTES = 256 * 1024

describe('plugin artwork (package-root icon)', () => {
  it('declares a relative icon path and ships it in the published tarball', () => {
    expect(typeof pkg.icon).toBe('string')
    expect(pkg.icon).toBe('./icon.svg')
    // The published tarball drops a file the manifest does not declare.
    expect(pkg.files).toContain('icon.svg')
  })

  it('exports package.json — the manifest the icon field is read from', () => {
    // readPluginMeta resolves `<specifier>/package.json` through the exports
    // map; without this subpath the manifest icon is never read.
    expect(pkg.exports?.['./package.json']).toBe('./package.json')
  })

  it('ships a regular SVG file inside the package under the reader size cap', () => {
    const iconPath = join(PKG_DIR, pkg.icon as string)
    // The reader rejects an icon outside the manifest directory.
    expect(relative(PKG_DIR, iconPath)).not.toMatch(/^\.\./)
    const stat = statSync(iconPath)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeLessThanOrEqual(ICON_MAX_BYTES)
    expect(iconPath.endsWith('.svg')).toBe(true)
  })

  it('is self-contained 36px artwork the page renders as an isolated image', () => {
    const source = readFileSync(join(PKG_DIR, pkg.icon as string), 'utf8')
    // 36x36 is the artwork box dsh renders inside the 48px card tile.
    expect(source).toMatch(/^<svg\b[^>]*viewBox="0 0 36 36"/)
    // The reader converts bytes to a data URL and the page renders an <img>;
    // external references and script would not resolve from there.
    expect(source).not.toMatch(/<script\b|<foreignObject\b|<image\b|\bhref=/)
  })
})
