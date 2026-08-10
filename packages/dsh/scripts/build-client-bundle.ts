/**
 * Client bundle build (spec §6.2 + mechanism-guide §5.1 mirror): emits the
 * closure-factory CJS artifact the dsh web loader consumes —
 * `window.__ModuleLoader__.load({ id: '@mstar-harness/dsh', factory:
 * (require) => { … return module.exports; } })`. Externals resolve through the
 * loader module table (the platform seed entries + the documented
 * `@deepseek-ai/dsh-client-runtime/client` exemption); everything else inlines.
 *
 * Two build plugins enforce the bundle contract:
 * - CSS Modules (`*.module.css`) are compiled to a hashed class map plus an
 *   inline `<style data-plugin>` injection that runs when the factory
 *   materializes (the loader removes plugin-owned tags on unload). Hashed
 *   class selectors are escaped in the css TEXT only (CSSOM
 *   serialize-an-identifier): digit-leading hashes (`20fd0e45_root`) become
 *   `.\32 0fd0e45_root` so the browser never drops the rule — classMap / DOM
 *   class names stay unescaped (plan 20260810-panel-css-selector-fix).
 * - A purity gate rejects any non-external, non-inline-safe `@deepseek-ai/*`
 *   VALUE import (type-only imports are erased before resolution and never
 *   reach the gate) — cross-plugin collaboration goes through cordis
 *   services, never shared module instances.
 *
 * Build tool: `bun build` (zero new toolchain; the tsdown fallback in spec
 * §6.2 is not needed). `dist/client.js` is a build artifact (gitignored like
 * the rest of `dist/`).
 */

import { build } from 'bun'
import { basename, dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const ID = '@mstar-harness/dsh'
const ENTRY = 'src/client/index.ts'
const OUT_DIR = 'dist'
const OUT_FILE = 'client.js'

/** Loader module table (mechanism-guide §1.3): platform seed entries plus the documented runtime/client exemption. */
export const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Wire/type layers with no shared runtime identity that may inline (snapshot tsdown.client.ts mirror). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Deterministic CSS-module class hash: FNV-1a 32-bit over the local name →
 * `8hex_local` (mirrors the recipe's `[hash]_[local]` pattern; the hash only
 * needs to be stable within the bundle — the class map and the rewritten css
 * text come from the same transform).
 */
export function hashClass(local: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < local.length; i++) {
    h ^= local.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16).padStart(8, '0')}_${local}`
}

/**
 * Vendored WHATWG `CSS.escape` (CSSOM "serialize-an-identifier"): an
 * output-identical reimplementation of the Mathias Bynens css.escape v1.5.1
 * algorithm (MIT) — upstream: https://github.com/mathiasbynens/css.escape
 * Copyright (c) 2013 Mathias Bynens <https://mathiasbynens.be/>
 * node/bun expose no global `CSS.escape` (verified: `CSS is not defined` /
 * `undefined`), so the build script carries its own copy of the browser
 * serializer.
 *
 * Applied to the css TEXT only — `20fd0e45_root` → `\32 0fd0e45_root` (the
 * digit-leading case this plan fixes), while letter-leading names
 * (`c87acfc7_sidebar`) pass through unchanged. classMap / DOM class names are
 * never escaped: a selector's escape is a css-text concern; the class
 * attribute value the DOM API (`getElementsByClassName`) reads stays intact.
 */
export function cssEscapeIdentifier(value: string): string {
  const string = String(value)
  const length = string.length
  const firstCodeUnit = string.charCodeAt(0)

  // A lone `-` (U+002D) must be escaped — it is not a valid identifier alone.
  if (length === 1 && firstCodeUnit === 0x002d) {
    return `\\${string}`
  }

  let index = -1
  let result = ''
  while (++index < length) {
    const codeUnit = string.charCodeAt(index)
    // NULL (U+0000) → replacement character (CSSOM contract; cannot round-trip).
    if (codeUnit === 0x0000) {
      result += '\uFFFD'
      continue
    }

    if (
      // Control chars [\1-\1F] (U+0001–U+001F) / DEL (U+007F), a LEADING digit
      // [0-9], or a second-char digit right after a leading `-`: escape as a
      // code point (`\` + lowercase hex + space). The digit-leading case is
      // exactly the bug this plan fixes (`.20fd0e45_root` → `.\32 0fd0e45_root`).
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
    ) {
      result += `\\${codeUnit.toString(16)} `
      continue
    }

    if (
      // Everything CSSOM lets pass verbatim: ≥ U+0080, `-`, `_`, digits,
      // letters — a letter-leading hash class stays byte-identical.
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      result += string.charAt(index)
      continue
    }

    // Anything else (e.g. `!`, `@`, `#`) → escape a character (`\` + char).
    result += `\\${string.charAt(index)}`
  }
  return result
}

/**
 * The exact regression this plan fixes (plan Scope item 2): `.` + digit + 7
 * hex + `_` + letter — the shape `hashClass` emits when the FNV hash starts
 * with a digit (10/16 ≈ 62.5% of the time), UNESCAPED in css / bundle text.
 *
 * Anchored on the DIGIT, not on 8 hex: a letter-leading hash class
 * (`.f83e09fa_emptyRoot`) is legal and must not be flagged, and declaration
 * values (`.5s`, `opacity: 0.5`) cannot match the `_` + letter tail.
 *
 * Shape contract — coupled to `hashClass`'s `padStart(8)` output
 * (`8hex_local`): the `[0-9a-f]{7}` tail assumes an 8-hex hash. If
 * `hashClass` ever changes shape (hash width, separator, prefix), this guard
 * silently stops matching its own target; the artifact layer (this regex and
 * the pinned spec samples) must be updated in the same change.
 */
export const UNESCAPED_DIGIT_HASH_SELECTOR = /\.[0-9][0-9a-f]{7}_[A-Za-z_]/

/** Throw unless `text` is free of unescaped digit-leading hash class selectors. */
export function assertNoUnescapedDigitHashSelector(text: string, what: string): void {
  const hit = text.match(UNESCAPED_DIGIT_HASH_SELECTOR)
  if (hit) {
    throw new Error(
      `client bundle contract: ${what} contains an unescaped digit-leading hash class selector `
      + `${JSON.stringify(hit[0])} at index ${text.indexOf(hit[0])} — the browser would silently drop `
      + `the whole rule; class selectors in css text must go through cssEscapeIdentifier `
      + `(e.g. \`.\\32 0fd0e45_root\`)`,
    )
  }
}

/**
 * Transform-layer regression assertion (plan Scope item 2): after compiling
 * one `*.module.css`, (i) every classMap value appears in the css text in its
 * canonical escaped form (`'.' + cssEscapeIdentifier(hashed)` — a byte-level
 * proof the class map and the css text stayed in sync), and (ii) no unescaped
 * digit-leading hash class selector survives.
 */
export function assertCssModuleTransform(
  classMap: Record<string, string>,
  css: string,
  fileId: string,
): void {
  for (const [local, hashed] of Object.entries(classMap)) {
    const canonical = `.${cssEscapeIdentifier(hashed)}`
    if (!css.includes(canonical)) {
      throw new Error(
        `client bundle contract (${fileId}): classMap[${JSON.stringify(local)}] = ${JSON.stringify(hashed)} `
        + `is missing from the css text in its canonical escaped form ${JSON.stringify(canonical)}`,
      )
    }
  }
  assertNoUnescapedDigitHashSelector(css, `css-module transform output (${fileId})`)
}

/**
 * Inline `<style data-plugin>` injection source for a css text blob: the tag
 * is created once per factory materialization (the loader removes plugin-owned
 * tags on unload). Shared by the CSS-modules loader and the plain-`.css`
 * loader (react-flow's base stylesheet, spec §3.2 — the bundle must inline it:
 * a second emitted asset would never be served by the closure loader).
 */
function styleInjectionContents(cssText: string, tagId: string): string {
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

/**
 * The CSS-modules transform (pure and exported so tests exercise the exact
 * pipeline the build runs): strip block comments, hash every class token to
 * `8hex_local`, and rewrite the css TEXT with `cssEscapeIdentifier` applied
 * to every hashed selector (Option A — classMap / DOM class names stay
 * unescaped). The global replace naturally covers comma-separated selector
 * lists and `@media`-scoped rules.
 */
export function transformCssModule(source: string): { classMap: Record<string, string>; css: string } {
  const classMap: Record<string, string> = {}
  const css = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\.[A-Za-z_][A-Za-z0-9_-]*/g, (match) => {
      const local = match.slice(1)
      const hashed = hashClass(local)
      classMap[local] = hashed
      // Option A (plan Scope item 1): escape the css TEXT unconditionally —
      // cssEscapeIdentifier is the identity for letter-leading names
      // (`c87acfc7_sidebar`) and canonical-escapes digit-leading hashes
      // (`20fd0e45_root` → `\32 0fd0e45_root`). The classMap value stays
      // unescaped.
      return `.${cssEscapeIdentifier(hashed)}`
    })
  return { classMap, css }
}

/**
 * Compile one `*.module.css` file into a JS module: the css text (comments
 * stripped, class tokens hashed AND escaped in the text) plus a
 * `<style data-plugin>` injection that runs at factory materialization, and
 * the hashed class map as the default export. Mirrors the snapshot tsdown CSS
 * plugin (virtual-id wrapper skipped — bun's plugin `onLoad` fully replaces
 * the module, no native css pipeline involvement).
 *
 * simplify: the css text is emitted as-is (comment-stripped, not minified);
 * the snapshot recipe runs lightningcss. If bundle size ever matters, switch
 * the devDep path (tsdown + the clientBundle recipe) or add a minifier here.
 */
function cssModuleContents(fileId: string): { contents: string; loader: 'js' } {
  const { classMap, css } = transformCssModule(readFileSync(fileId, 'utf8'))
  // Transform-layer regression assertion (plan Scope item 2): fails the build
  // the moment a classMap value stops matching the css text or an unescaped
  // digit-leading selector appears.
  assertCssModuleTransform(classMap, css, fileId)
  const tagId = `${ID}/${basename(fileId)}`
  const contents = [
    styleInjectionContents(css, tagId),
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
  return { contents, loader: 'js' }
}

// Run only when executed directly (`bun run build-client`): the pure
// transform / escape / assertion functions above are exported so unit tests
// can import this module side-effect free. Tests must never trigger a build.
// NOTE (qc3 S-1): this guard supports direct execution under bun only —
// `import.meta.main` is undefined in non-bun runtimes, so running this script
// directly there silently no-ops (no build, no error). If the build ever moves
// to tsdown or another runtime with direct execution, add a loud failure guard
// (throw) instead of relying on `import.meta.main`.
if (import.meta.main) {
  const result = await build({
    entrypoints: [ENTRY],
    outdir: OUT_DIR,
    target: 'browser',
    format: 'cjs',
    external: [...CLIENT_EXTERNALS],
    // Plain `.css` imports (e.g. `@xyflow/react/dist/style.css`) load as TEXT
    // modules: GraphCanvas imports the stylesheet string and injects it as a
    // `<style data-plugin>` tag at factory materialization (spec §3.2 — a second
    // emitted asset would never be served by the closure loader). `*.module.css`
    // is unaffected: the css-modules plugin below wins for those paths.
    loader: { '.css': 'text' },
    // zustand/immer-style deps read process.env.NODE_ENV; honor the build env
    // like the snapshot recipe (artifacts default to production). zustand v4
    // ALSO reads `import.meta.env.MODE` (its store `destroy` deprecation
    // branch) — the web loader executes plugin bundles as a CLASSIC <script>
    // (client-modules defaultLoadBundle, no `type="module"`), where a literal
    // `import.meta` is a SyntaxError that kills the whole bundle at parse time
    // (the panel never registers). Defining the full `import.meta.env` object
    // erases every reference; the emitted code keeps a plain-object read.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({
        MODE: process.env.NODE_ENV ?? 'production',
        DEV: (process.env.NODE_ENV ?? 'production') !== 'production',
        PROD: (process.env.NODE_ENV ?? 'production') === 'production',
      }),
    },
    // Closure-factory handoff (spec §6.2): `module`/`exports` are declared
    // inside the factory body because bun's cjs emission assigns module.exports
    // itself; the factory returns that surface to the loader.
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
    footer: 'return module.exports; } });',
    naming: { entry: OUT_FILE },
    plugins: [
      {
        name: 'dsh-client-bundle-purity',
        setup(build) {
          build.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
            if (CLIENT_EXTERNALS.includes(args.path)) return undefined // platform module: external wins
            if (INLINE_SAFE.test(args.path) || GENERATED_REMOTE.test(args.path)) return undefined // wire contribution: inline is the point
            throw new Error(
              `client bundle purity: "${args.path}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — `
              + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
            )
          })
        },
      },
      {
        name: 'dsh-css-modules-inline',
        setup(build) {
          build.onLoad({ filter: /\.module\.css$/ }, (args) => cssModuleContents(args.path))
        },
      },
    ],
  })

  if (!result.success) {
    const detail = result.logs.map((log) => (typeof log === 'string' ? log : log.message)).join('\n')
    throw new Error(`client bundle build failed:\n${detail}`)
  }
  if (result.outputs.length !== 1 || !result.outputs[0]!.path.endsWith(`/${OUT_FILE}`)) {
    throw new Error(`client bundle build: expected exactly one ${OUT_FILE} output, got ${result.outputs.map((o) => o.path).join(', ')}`)
  }

  // Inline bundle-contract assertions (spec §3.2 #2 verify-only + the
  // classic-script guard): the emitted text must carry the inlined graph lib,
  // must not value-import `@deepseek-ai/*` (purity gate), and must contain NO
  // `import.meta` / ESM statements — the web loader executes this file as a
  // classic <script>, where either is a parse-time SyntaxError.
  const bundleText = readFileSync(result.outputs[0]!.path, 'utf8')
  if (!/xyflow|reactflow/i.test(bundleText)) {
    throw new Error('client bundle contract: @xyflow/react is NOT inlined — check CLIENT_EXTERNALS / the loader module table')
  }
  if (/require\(\s*["']@deepseek-ai\//.test(bundleText)) {
    throw new Error('client bundle contract: a @deepseek-ai/* VALUE import survived the purity gate')
  }
  if (bundleText.includes('import.meta') || /(^|\n)\s*(import|export)\s/.test(bundleText)) {
    throw new Error('client bundle contract: emitted bundle contains import.meta / ESM statements — the classic-script loader would fail to parse it')
  }
  // Artifact-layer regression assertion (plan Scope item 2): the emitted
  // bundle must be free of unescaped digit-leading hash class selectors —
  // catches any future path that injects css text bypassing the transform
  // layer. Fails the build on regression.
  assertNoUnescapedDigitHashSelector(bundleText, 'emitted bundle')

  // Declarations for `exports["./client"].types` (spec §6.2): the tsc-emitted
  // client declarations live at dist/client/index.d.ts; ship a flat re-export so
  // the locked export path stays stable regardless of the internal layout.
  const clientDts = join(OUT_DIR, 'client.d.ts')
  writeFileSync(clientDts, `export * from './client/index.js'\n`)

  console.log(`build-client: ${ENTRY} -> ${result.outputs[0]!.path} (closure-factory CJS, ${result.outputs[0]!.kind})`)
}
