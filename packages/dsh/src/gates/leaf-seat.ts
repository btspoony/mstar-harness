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
 * - `native-commands.ts` — the native `mstar_execution_clear` tool refuses a
 *   leaf seat fail-closed, before any store read.
 */
export function isLeafSeatHeader(header: unknown): boolean {
  if (typeof header !== 'object' || header === null) return false
  const view = header as { origin?: unknown; delegationDepth?: unknown }
  return view.origin === 'subagent' || (typeof view.delegationDepth === 'number' && view.delegationDepth > 0)
}
