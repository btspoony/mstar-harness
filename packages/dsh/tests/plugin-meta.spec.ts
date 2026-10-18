/**
 * Task 1 — dsh plugin locale metadata: `@mstar-harness/dsh` must ship the
 * `locale/` display dictionaries dsh reads.
 *
 * Root cause: `readPluginMeta` (`@deepseek-ai/dsh-app-boot`, `lib/index.js`)
 * resolves `<specifier>/locale/en.json` THROUGH the package `exports` map,
 * then scans every sibling `*.json` in that directory as one language
 * dictionary (`{ meta: { title, description } }`). Only when that resource is
 * absent does it fall back to the manifest `name` + `description`. The package
 * shipped neither the directory nor the export, so the dsh Plugins page
 * rendered "@mstar-harness/dsh" and the long English npm description.
 *
 * This test freezes the shipped shape the reader depends on: the subpath
 * export, the `files` entry (the published tarball drops an undeclared
 * directory), and both dictionaries with non-empty, actually translated copy.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Package root of `@mstar-harness/dsh` (same resolution as manifest-contract.spec.ts). */
const PKG_DIR = join(import.meta.dir, '..')
const LOCALE_DIR = join(PKG_DIR, 'locale')

const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  exports?: Record<string, unknown>
  files?: string[]
}

/** One language dictionary exactly as the dsh reader parses it. */
interface LocaleDictionary {
  meta?: { title?: string; description?: string }
}

/** Every shipped dictionary keyed by language id (filename minus `.json`). */
function dictionaries(): Record<string, LocaleDictionary> {
  return Object.fromEntries(
    readdirSync(LOCALE_DIR).map((name) => [
      name.slice(0, -'.json'.length),
      JSON.parse(readFileSync(join(LOCALE_DIR, name), 'utf8')) as LocaleDictionary,
    ]),
  )
}

describe('plugin locale metadata (Task 1)', () => {
  it('exports the locale subpath and ships the directory in the tarball', () => {
    expect(pkg.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(pkg.files).toContain('locale')
  })

  it('ships exactly the en and zh language dictionaries', () => {
    expect(readdirSync(LOCALE_DIR).sort()).toEqual(['en.json', 'zh.json'])
  })

  it('gives every dictionary a non-empty title and description', () => {
    for (const [language, dictionary] of Object.entries(dictionaries())) {
      expect(dictionary.meta?.title?.trim(), `${language} meta.title`).toBeTruthy()
      expect(dictionary.meta?.description?.trim(), `${language} meta.description`).toBeTruthy()
    }
  })

  it('carries a translated description rather than the English copy', () => {
    const { en, zh } = dictionaries()
    expect(zh?.meta?.description?.trim()).not.toBe(en?.meta?.description?.trim())
  })
})
