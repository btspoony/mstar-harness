/**
 * Dev-time CSS-module typing (snapshot `css-modules.d.ts` mirror): `bun test`
 * leaves `*.module.css` imports as the raw file-path string (class attributes
 * are dropped in dev-time renders — assertions pin `data-mstar-*`
 * attributes), while the client bundle build (`scripts/build-client-bundle.ts`)
 * compiles them to hashed class maps. This ambient declaration keeps the tsc
 * declaration gate self-contained — the class map shape is what both shapes
 * share.
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
