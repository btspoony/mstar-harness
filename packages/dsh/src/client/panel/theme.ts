/**
 * The host's COLOUR SCHEME, resolved for the product (plan dsh-panel-unification
 * Task 5, compass constraint 4).
 *
 * The unified product keeps its own `--ms-*` values in both schemes; only the
 * scheme is inherited. Aliasing `--ms-*` onto the host's palette would make the
 * panel look like the host instead of the product — and the host has no alias at
 * all for the roles the design needs (the purple terminal-lifecycle accent, the
 * five status tones). So this module answers ONE question: is the host light or
 * dark? The product's `[data-ms-theme="dark"]` token block does the rest.
 *
 * `ctx.theme.getTheme()` publishes an immutable `ThemeSnapshot` whose
 * `active.colorScheme` is the resolved scheme (the host switches
 * `body[data-ds-dark-theme]` from that same field, never from the theme id).
 *
 * @module @mstar-harness/dsh/client/panel/theme
 */

/** The two schemes the shared token set declares. */
export type ColorScheme = 'light' | 'dark'

/**
 * The host theme face the seats consume: the resolved scheme plus a change
 * subscription (uSES-safe), so a theme switch re-renders the wrapper.
 */
export type HostThemeFace = {
  getSnapshot(): ColorScheme
  subscribe(listener: () => void): () => void
}

/** The structural face of the host's theme service (no host value import). */
export type HostThemeService = {
  getTheme(): { readonly active?: { readonly colorScheme?: unknown } }
}

/**
 * One host theme snapshot → the product scheme. An unreadable or unknown scheme
 * answers `light`: the product's light values are the safe default, and a wrong
 * dark guess would be a contrast failure.
 * @param snapshot - whatever `getTheme()` returned.
 * @returns the scheme to apply as `data-ms-theme`.
 */
export function resolveScheme(snapshot: { readonly active?: { readonly colorScheme?: unknown } } | null | undefined): ColorScheme {
  return snapshot?.active?.colorScheme === 'dark' ? 'dark' : 'light'
}

/**
 * Wrap the host theme service in the face the seats need.
 *
 * `onThemeChange` is the host's subscription entry (`ctx.on('theme/change', …)`);
 * it returns the disposer, so the plugin's fiber unload unsubscribes.
 * @param service - the host theme service (`ctx.theme`).
 * @param onThemeChange - the host's `theme/change` subscription.
 * @returns the face and its own disposer.
 */
export function createHostThemeFace(
  service: HostThemeService,
  onThemeChange: (listener: () => void) => () => void,
): { readonly face: HostThemeFace; readonly dispose: () => void } {
  const listeners = new Set<() => void>()
  const stop = onThemeChange(() => {
    for (const listener of listeners) listener()
  })
  return {
    face: {
      getSnapshot: () => resolveScheme(service.getTheme()),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    dispose: () => {
      stop()
      listeners.clear()
    },
  }
}
