/**
 * The one supply-naming sentence every identity-missing refusal states: how a
 * caller puts a session identity on the call, per transport. Refusal texts
 * interpolate it verbatim so the recovery is nameable without reading source.
 *
 * Both transports take the same value: the calling session's own id. On dsh the
 * host exports it as `DSH_SESSION_ID`, which the CLI reads directly; an MCP
 * call passes it as the per-call `sessionId` field. The identity only
 * ATTRIBUTES the write to that session; the coordinator binding plus the
 * scope's `--expect` execution token authorize it.
 */
export const IDENTITY_SUPPLIES =
  "CLI: pass --session-id or set MSTAR_HOST_SESSION_ID (dsh shells already export DSH_SESSION_ID); MCP: pass sessionId \u2014 the calling session's id. The identity only attributes the write; the coordinator binding plus the --expect token authorize it";

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
