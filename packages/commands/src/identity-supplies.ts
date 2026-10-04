/**
 * The one supply-naming sentence every identity-missing refusal states: how a
 * caller puts a session identity on the call, per transport. Refusal texts
 * interpolate it verbatim so the recovery is nameable without reading source.
 */
export const IDENTITY_SUPPLIES =
  "CLI: pass --session-id or set MSTAR_HOST_SESSION_ID; MCP: the host must pass sessionId per call";
