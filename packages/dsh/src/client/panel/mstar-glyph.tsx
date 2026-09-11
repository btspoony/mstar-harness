/**
 * The panel's own inline glyph (plan sidebar §L1.3): the icon the guide
 * capsule draws before its title, and the chip title seat draws before the
 * captured tab title. Deliberately NOT imported from
 * `@deepseek-ai/dsh-client-ui-primitives` — dynamic client plugins may not
 * import runtime values from other client plugins (types only), and the
 * client bundle's purity gate rejects `@deepseek-ai/*` value imports — so the
 * glyph is our own `<svg>` on `currentColor`, `IconProps`-shaped like the
 * shipped `CompassGlyph`/`CubeGlyph`.
 */

import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The brand star on `currentColor` — the plugin's mark at guide and chip
 * sizes (14–16px). `size` defaults to 16 (the guide-capsule size — the
 * definition registers this component with no props); the chip title seat
 * passes 14 explicitly. The geometry is the brand mark from the repo's
 * `assets/` logos (`logo.svg` / `logo-dark.svg`): the star path reused
 * verbatim (viewBox 512), the assets' colored rounded tile dropped — no
 * tile, no hardcoded colors — `fill='currentColor'` so the host's chip/guide
 * styling themes the mark.
 */
export function MstarGlyph({ size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox='0 0 512 512'
      aria-hidden='true'
    >
      {/* Brand star path from assets/logo.svg (verbatim), colored via currentColor. */}
      <path fill='currentColor' d='M256 72l36 140 140 36-140 36-36 156-36-156-140-36 140-36 36-140z' />
    </svg>
  )
}
