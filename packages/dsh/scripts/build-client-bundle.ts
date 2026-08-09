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
 *   materializes (the loader removes plugin-owned tags on unload).
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
function hashClass(local: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < local.length; i++) {
    h ^= local.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16).padStart(8, '0')}_${local}`
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
 * Compile one `*.module.css` file into a JS module: the css text (comments
 * stripped, class tokens hashed) plus a `<style data-plugin>` injection that
 * runs at factory materialization, and the hashed class map as the default
 * export. Mirrors the snapshot tsdown CSS plugin (virtual-id wrapper skipped —
 * bun's plugin `onLoad` fully replaces the module, no native css pipeline
 * involvement).
 *
 * simplify: the css text is emitted as-is (comment-stripped, not minified);
 * the snapshot recipe runs lightningcss. If bundle size ever matters, switch
 * the devDep path (tsdown + the clientBundle recipe) or add a minifier here.
 */
function cssModuleContents(fileId: string): { contents: string; loader: 'js' } {
  const source = readFileSync(fileId, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const classMap: Record<string, string> = {}
  const css = source.replace(/\.[A-Za-z_][A-Za-z0-9_-]*/g, (match) => {
    const local = match.slice(1)
    const hashed = hashClass(local)
    classMap[local] = hashed
    return `.${hashed}`
  })
  const tagId = `${ID}/${basename(fileId)}`
  const contents = [
    styleInjectionContents(css, tagId),
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
  return { contents, loader: 'js' }
}

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
  // like the snapshot recipe (artifacts default to production).
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
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

// Declarations for `exports["./client"].types` (spec §6.2): the tsc-emitted
// client declarations live at dist/client/index.d.ts; ship a flat re-export so
// the locked export path stays stable regardless of the internal layout.
const clientDts = join(OUT_DIR, 'client.d.ts')
writeFileSync(clientDts, `export * from './client/index.js'\n`)

console.log(`build-client: ${ENTRY} -> ${result.outputs[0]!.path} (closure-factory CJS, ${result.outputs[0]!.kind})`)
