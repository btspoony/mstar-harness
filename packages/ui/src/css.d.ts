/**
 * The stylesheet modules this package imports, declared once.
 *
 * Bun bundles both forms natively — a `*.module.css` import yields the class-name
 * map, a plain `*.css` import is a side effect — but TypeScript has no notion of
 * either, so `emitDeclarationOnly` fails on all nineteen imports without this
 * file. Declaring them here is what makes `dist/index.d.ts` producible at all;
 * the alternative would be a cast at every import site, nineteen times.
 *
 * The class-name map is typed loosely on purpose: a generated literal union of
 * every class name would have to be rebuilt on each CSS edit, and a typo in a
 * class name is caught by the visual pass, not by the compiler.
 */
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module "*.css";
