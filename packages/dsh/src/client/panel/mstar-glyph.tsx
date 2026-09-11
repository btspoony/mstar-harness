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
 * A four-point morning star on `currentColor` — the plugin's mark at guide
 * and chip sizes (14–16px). `size` defaults to 16 (the guide-capsule size —
 * the definition registers this component with no props); the chip title
 * seat passes 14 explicitly. Pure geometry: no fills, no hardcoded colors,
 * every stroke rides `currentColor` so the host's chip/guide styling applies.
 */
export function MstarGlyph({ size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      {/* Four-point star: long vertical/horizontal rays + short diagonals. */}
      <path d='M12 3v18M3 12h18' />
      <path d='M12 3l2.2 4.6L12 12l-2.2 4.4L12 21M12 3L7.4 9.8 3 12m9-9l4.6 6.8L21 12m-9 9l-4.6-6.8L3 12m18 0l-4.6 2.2L12 21' />
      <circle cx='12' cy='12' r='1.6' />
    </svg>
  )
}
