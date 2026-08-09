/**
 * Field-level degradation guards for the runtime `mstar-engine-status` source
 * (spec §2.4): the client does not exhaustively validate the union — it
 * narrows by `kind`, then degrades per field. Unknown/missing values render
 * as `unknown`, never as guessed values.
 */

/** String field: non-empty string, else null (missing → `unknown`). */
export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Boolean field: real boolean, else null. */
export function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** Count field: finite number, else null. */
export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
