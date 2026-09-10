/**
 * The ONE declaration of the engine-status wire address, shared by both halves
 * of the channel: the host half composes the `/api` typert endpoint descriptor
 * from these literals, and the browser half calls the same address through
 * `connection.rpc.call(...)`.
 *
 * WHY a separate module: the two halves live in two bundle graphs (the host
 * runs from `dist/index.js`, the panel from the closure-factory
 * `dist/client.js`), and a rename on either side used to leave both suites
 * green while the panel silently degraded to `transport-error` — each half's
 * spec pinned only its own copy of the literals. Importing one module makes the
 * rename impossible to land half-done, and `engine-status-wire.spec.ts` pins the
 * descriptor the host registers against the address the client calls.
 *
 * CLIENT-SAFE BY CONSTRUCTION: no imports, no `node:` builtins, no side effects
 * — only string literals and types. The client bundle's purity gate rejects
 * non-inline-safe `@deepseek-ai/*` value imports; this module has nothing to
 * inline but the two constants.
 *
 * @module @mstar-harness/dsh/engine-status-wire
 */

/** The gateway channel the endpoint is served on (the host's shared `/api`). */
export const ENGINE_STATUS_CHANNEL = '/api'
/** The endpoint path on that channel (namespace + method of the descriptor). */
export const ENGINE_STATUS_ENDPOINT = 'mstar/engineStatus'
/** Wire namespace of the invocation (the cordis service key mirrors it). */
export const MSTAR_ENGINE_STATUS_NAMESPACE = 'mstar'
/** Wire method of the invocation → `/api/mstar/engineStatus`. */
export const MSTAR_ENGINE_STATUS_METHOD = 'engineStatus'
