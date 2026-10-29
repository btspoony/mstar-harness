import type { ExecutionIdentity } from "@mstar-harness/engine";

/**
 * The one supply-naming sentence every identity-missing refusal states: how a
 * caller puts a session identity on the call, per transport. Refusal texts
 * interpolate it verbatim so the recovery is nameable without reading source.
 *
 * The MCP clause names the real routes on purpose: a shared MCP server is a
 * child process with no host-proven caller identity, so a caller-declared
 * `sessionId` is refused unless the launcher opted in
 * (`mstar mcp --trust-caller-session-id`, off by default). Only three
 * operations have a host-proven native tool today; everything else runs
 * through the CLI, and plan prepare/progress/complete have no native tool yet.
 */
export const IDENTITY_SUPPLIES =
  "CLI: pass --session-id or set MSTAR_HOST_SESSION_ID (dsh shells also export DSH_SESSION_ID, which the CLI reads); MCP: pass sessionId on a connection launched with --trust-caller-session-id \u2014 the shipped dsh and omp launcher rows pass it, and there the value is a bearer identity that selects the caller's own coordinator binding; on a connection that did not opt in, use the dsh native tool that covers the operation (plan bind, audit report validation and execution clear) or run the CLI command";

/**
 * Where a caller reads each execution token kind a CLI `--expect` may need, in
 * the JSON paths the `status validate` ACTIVE emitter actually prints
 * (envelope `token`, flattened `workflows[].token`, `authority.workflows[]`
 * planTokens). Help lines interpolate these constants directly. The engine's
 * own wrong-kind refusal (`tokenKindReadPointer`, execution-store.ts) states
 * the same paths in parallel literals it cannot import from here. When a
 * read path changes, co-edit that refusal text in the same change set.
 */
export const TOKEN_SUPPLIES = {
  root: "the store's root execution token: read `mstar status validate` output field data.token",
  workflow: "the addressed workflow's execution token: read `mstar status validate` output data.workflows[].token for this workflow's id",
  plan: "the addressed plan's execution token: read `mstar status validate` output data.authority.workflows[].planTokens[<planId>]",
} as const;

/**
 * The one wire-format sentence for `--session-ref`: the transport the engine
 * parser accepts (prefix + base64url JSON) and the exact field set it
 * validates, matching the `plan bind --execution` receipt's session object.
 */
export const SESSION_REF_SUPPLIES =
  "the active session reference returned by the `plan bind --execution` receipt: wire format exec-session-v1:<base64url JSON carrying storeId, epoch, workflowId, role, sessionId>";

/**
 * Stamp the shell-transport leaf fact (#548) onto a coordinator REGISTRATION
 * tuple a family built (bind, recover, register, adopt, close, reopen and the
 * seat-addressing reads). Deliberately NOT every §3.1 tuple: a leaf-permitted
 * action — `workflow-note.append` (`execution-ledgers.ts`) — is left unstamped,
 * because stamping it would make the engine refuse a write the leaf may run.
 * The fact is fail-closed only: a stamped identity makes the engine's
 * `coordination.leaf-seat` refusal fire on coordinator registration and changes
 * nothing else, so a forged marker can only self-restrict a caller.
 */
export function withLeafSeat<T extends ExecutionIdentity>(identity: T, context: { readonly leafSeat?: true }): T {
  return context.leafSeat === true ? { ...identity, leafSeat: true } : identity;
}
