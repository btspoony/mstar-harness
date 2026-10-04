/**
 * The one supply-naming sentence every identity-missing refusal states: how a
 * caller puts a session identity on the call, per transport. Refusal texts
 * interpolate it verbatim so the recovery is nameable without reading source.
 */
export const IDENTITY_SUPPLIES =
  "CLI: pass --session-id or set MSTAR_HOST_SESSION_ID; MCP: the host must pass sessionId per call";

/**
 * Where a caller reads each execution token kind a CLI `--expect` may need, in
 * the JSON paths the `status validate` ACTIVE emitter actually prints
 * (envelope `token`, flattened `workflows[].token`, `authority.workflows[]`
 * planTokens). Help lines and refusal recovery pointers interpolate these
 * verbatim, so the kind → read-path fact cannot drift between the two.
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
  "the active session reference returned by the `plan bind --execution` receipt: wire format exec-session-v1:<base64url JSON carrying storeId, epoch, workflowId, role, sessionId, planId>";
