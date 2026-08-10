/**
 * Task 1 — CSS-modules selector escaping + build-time regression assertions
 * (plan 20260810-panel-css-selector-fix, AC-1): `hashClass` (FNV-1a → 8-hex)
 * starts with a digit 10/16 of the time, so an unescaped `.20fd0e45_root`
 * selector is illegal CSS and the browser silently drops the whole rule —
 * the panel "no styles" root cause. The build script now escapes the css TEXT
 * with a vendored WHATWG `CSS.escape` (cssEscapeIdentifier) while classMap /
 * DOM class names stay unescaped, and carries two regression assertion layers
 * (transform + artifact).
 *
 * These tests pin the deterministic hash / escape samples and prove the
 * guards catch injected unescaped digit-leading selectors (negative control).
 * Importing the script must stay side-effect free — the build only runs under
 * `import.meta.main` (direct `bun run build-client`), never on import.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertCssModuleTransform,
  assertNoUnescapedDigitHashSelector,
  cssEscapeIdentifier,
  hashClass,
  transformCssModule,
  UNESCAPED_DIGIT_HASH_SELECTOR,
} from '../scripts/build-client-bundle.ts'

/** Package root of `@mstar-harness/dsh`. */
const PKG_DIR = join(import.meta.dir, '..')

describe('hashClass — deterministic FNV-1a 8-hex samples', () => {
  it('matches the root-cause samples (digit- and letter-leading)', () => {
    expect(hashClass('root')).toBe('20fd0e45_root') // digit-leading (the bug case)
    expect(hashClass('canvas')).toBe('83172271_canvas')
    expect(hashClass('legend')).toBe('0214fc64_legend')
    expect(hashClass('emptyRoot')).toBe('f83e09fa_emptyRoot') // letter-leading (no escape needed)
    expect(hashClass('sidebar')).toBe('c87acfc7_sidebar')
    expect(hashClass('header')).toBe('e488d460_header')
  })

  it('is deterministic across calls', () => {
    expect(hashClass('root')).toBe(hashClass('root'))
    expect(hashClass('sidebar')).toBe(hashClass('sidebar'))
  })
})

describe('cssEscapeIdentifier — vendored WHATWG CSS.escape (CSSOM serialize-an-identifier)', () => {
  it('escapes a digit-leading hash class to the canonical code-point form', () => {
    expect(cssEscapeIdentifier('20fd0e45_root')).toBe('\\32 0fd0e45_root')
  })

  it('is the identity for letter-leading hash classes', () => {
    expect(cssEscapeIdentifier('c87acfc7_sidebar')).toBe('c87acfc7_sidebar')
    expect(cssEscapeIdentifier('f83e09fa_emptyRoot')).toBe('f83e09fa_emptyRoot')
  })

  it('covers the CSSOM edge cases', () => {
    expect(cssEscapeIdentifier('2')).toBe('\\32 ') // lone leading digit
    expect(cssEscapeIdentifier('-')).toBe('\\-') // a lone dash must be escaped
    expect(cssEscapeIdentifier('-1')).toBe('-\\31 ') // digit right after a leading dash
    expect(cssEscapeIdentifier('\t')).toBe('\\9 ') // control char
    expect(cssEscapeIdentifier('\u0000x')).toBe('\uFFFdx') // NULL → replacement char
  })

  it('escapes punctuation / whitespace inside identifiers (character escapes)', () => {
    expect(cssEscapeIdentifier('a!b')).toBe('a\\!b') // `!` is not CSSOM-passable
    expect(cssEscapeIdentifier('a b')).toBe('a\\ b') // space (U+0020) escapes as `\ ` + char
  })
})

describe('transformCssModule — the exact css-modules transform the build runs', () => {
  it('escapes digit-leading hashed selectors end to end while classMap stays unescaped', () => {
    const { classMap, css } = transformCssModule(
      '.root { display: grid; } .sidebar, .root { color: var(--x); }',
    )
    expect(classMap['root']).toBe('20fd0e45_root') // DOM class name: unescaped
    expect(classMap['sidebar']).toBe('c87acfc7_sidebar')
    expect(css).toContain('.\\32 0fd0e45_root') // css TEXT: escaped
    expect(css).not.toContain('.20fd0e45_root')
    expect(UNESCAPED_DIGIT_HASH_SELECTOR.test(css)).toBe(false)
  })

  it('panel root hash is digit-leading and appears in its canonical escaped form', () => {
    const { classMap, css } = transformCssModule(
      readFileSync(join(PKG_DIR, 'src/client/panel/panel.module.css'), 'utf8'),
    )
    expect(classMap['root']).toBe('20fd0e45_root')
    expect(css).toContain('.\\32 0fd0e45_root')
  })

  it('transform-layer assertions pass on the shipped module.css files (plan Scope item 2)', () => {
    for (const file of [
      join(PKG_DIR, 'src/client/panel/panel.module.css'),
      join(PKG_DIR, 'src/client/panel/zones/zones.module.css'),
    ]) {
      const { classMap, css } = transformCssModule(readFileSync(file, 'utf8'))
      expect(Object.keys(classMap).length).toBeGreaterThan(0)
      expect(() => assertCssModuleTransform(classMap, css, file)).not.toThrow()
      expect(UNESCAPED_DIGIT_HASH_SELECTOR.test(css)).toBe(false)
    }
  })
})

describe('assertion guards — negative control: injected unescaped digit-leading selector must fail', () => {
  const INJECTED = '.20fd0e45_root { display: grid; }'

  it('guard is pinned to every digit-leading hashClass sample (never misses its own target)', () => {
    // Shape-contract pin (qc1 F-003): the guard assumes `hashClass`'s
    // `8hex_local` output. If `hashClass` ever changes shape (hash width,
    // separator, prefix), these pins fail loudly instead of the guard silently
    // missing its own output. The samples are digit-leading by construction
    // (hashClass describe block above).
    for (const local of ['root', 'canvas', 'legend']) {
      const hashed = hashClass(local)
      expect(hashed[0]).toMatch(/[0-9]/)
      expect(UNESCAPED_DIGIT_HASH_SELECTOR.test(`.${hashed}`)).toBe(true)
    }
  })

  it('transform-layer guard throws on injected unescaped `.20fd0e45_root`', () => {
    // Raw injected selector: rejected by the guard as a whole (the
    // canonical-form check fires first — either way the injection is blocked).
    expect(() =>
      assertCssModuleTransform({ root: '20fd0e45_root' }, INJECTED, 'test-sample.module.css'),
    ).toThrow()
    // Targeted negative control: with the canonical escaped form ALSO present,
    // the unescaped-digit regex check is the one that must fire.
    const injectedAlongsideEscaped =
      '.\\32 0fd0e45_root { display: grid; } .20fd0e45_root { color: red; }'
    expect(() =>
      assertCssModuleTransform(
        { root: '20fd0e45_root' },
        injectedAlongsideEscaped,
        'test-sample.module.css',
      ),
    ).toThrow(/unescaped digit-leading/)
  })

  it('transform-layer guard accepts the canonical escaped form and rejects a classMap/css mismatch', () => {
    const escaped = '.\\32 0fd0e45_root { display: grid; }'
    expect(() =>
      assertCssModuleTransform({ root: '20fd0e45_root' }, escaped, 'test-sample.module.css'),
    ).not.toThrow()
    expect(() =>
      assertCssModuleTransform(
        { root: '20fd0e45_root', sidebar: 'c87acfc7_sidebar' },
        escaped,
        'test-sample.module.css',
      ),
    ).toThrow(/classMap/)
  })

  it('declaration value `.5s` never hooks the digit-anchored guard (whole pipeline)', () => {
    // `.5s` (no leading zero) is a legal transition duration; the regex needs
    // `.` + digit + 7 hex + `_` + letter, so it cannot match — the
    // transform-layer assertion accepts the css untouched.
    expect(() =>
      assertCssModuleTransform(
        { root: '20fd0e45_root' },
        '.\\32 0fd0e45_root { transition: opacity .5s ease; }',
        'test-sample.module.css',
      ),
    ).not.toThrow()
  })

  it('artifact-layer guard rejects a bundleText sample containing injected unescaped `.20fd0e45_root`', () => {
    // Minimal bundleText reproduction (plan constraint: no full build in Task 1).
    const bundleText = [
      'const css = ".20fd0e45_root { display: grid; }";',
      'var module = { exports: {} };',
    ].join('\n')
    expect(() => assertNoUnescapedDigitHashSelector(bundleText, 'emitted bundle')).toThrow(
      /unescaped digit-leading/,
    )
  })

  it('artifact-layer guard passes escaped / letter-leading / declaration-value samples (no false positives)', () => {
    expect(() =>
      assertNoUnescapedDigitHashSelector('.\\32 0fd0e45_root { display: grid; }', 'emitted bundle'),
    ).not.toThrow()
    expect(() =>
      assertNoUnescapedDigitHashSelector('.f83e09fa_emptyRoot { display: flex; }', 'emitted bundle'),
    ).not.toThrow()
    // Declaration values (`.5s`, `opacity: 0.5`) and letter-leading hash
    // classes must never be flagged by the digit-anchored pattern.
    expect(() =>
      assertNoUnescapedDigitHashSelector(
        '.c87acfc7_sidebar { transition: color 150ms ease; opacity: 0.5; }',
        'emitted bundle',
      ),
    ).not.toThrow()
  })
})
