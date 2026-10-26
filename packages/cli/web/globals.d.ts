/**
 * Values the dashboard receives from outside its own source.
 *
 * Two are build-time constants (`scripts/build-web.ts` reads them from this package's
 * manifest); one is injected at runtime by the dashboard server (`server.ts`), because
 * the harness root is decided when the server starts, not when the bundle is built.
 *
 * The harness root rides `document.documentElement.dataset.harnessDir` (the server's
 * `<html data-harness-dir>`), not a `window` global: this server sends
 * `script-src 'self'`, so an inline assignment would be blocked silently.
 */
declare global {
  /** `@mstar-harness/cli`, from `package.json`. */
  const __MSTAR_PACKAGE__: string;
  /** The same manifest's `version`. */
  const __MSTAR_VERSION__: string;
}

export {};
