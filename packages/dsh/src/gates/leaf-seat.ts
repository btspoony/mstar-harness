/**
 * The shared leaf-seat predicate of the dsh identity chain — the ONE shape
 * every dsh-side enforcement reads (ADR
 * `docs/adr/dsh-native-identity-channels.md`): a known leaf seat
 * (`header.origin === 'subagent'`, or a numeric `delegationDepth > 0`) can
 * never own an execution binding or hold a coordinator session.
 *
 * Consumers:
 * - `scoped-mcp-mount.ts` — a known leaf never gets an identity-bearing child
 *   process (there is no binding it could ever attribute);
 * - `native-commands.ts` — the coordinator-seat-capable native tools
 *   (`mstar_plan_bind`, `mstar_plan_complete`, `mstar_execution_clear`) refuse
 *   a leaf seat fail-closed, before any admission or engine round-trip.
 */
export function isLeafSeatHeader(header: unknown): boolean {
  if (typeof header !== 'object' || header === null) return false
  const view = header as { origin?: unknown; delegationDepth?: unknown }
  return view.origin === 'subagent' || (typeof view.delegationDepth === 'number' && view.delegationDepth > 0)
}
