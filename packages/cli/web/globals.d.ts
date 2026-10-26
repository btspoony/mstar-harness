/**
 * Constants the dashboard bundle receives at build time (`scripts/build-web.ts` reads
 * them from this package's manifest). Declared here so the source can name them without
 * a runtime import — the values only exist once the bundle is built.
 */
declare const __MSTAR_PACKAGE__: string;
declare const __MSTAR_VERSION__: string;
