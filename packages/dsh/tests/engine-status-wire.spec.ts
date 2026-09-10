/**
 * Wire-address parity spec for the engine-status channel: the host registers
 * ONE endpoint descriptor and the browser half calls ONE address, and those two
 * must be the same address. Both halves previously declared their own literals
 * (`MSTAR_ENGINE_STATUS_NAMESPACE`/`_METHOD` on the host, `'mstar/engineStatus'`
 * in the client) and each spec pinned only its own copy — so renaming either
 * side kept both suites green while the panel silently degraded to
 * `transport-error`.
 *
 * Covered: the literals live in exactly one module, the descriptor's endpoint
 * path is composed from them, and the client calls exactly that path on exactly
 * that channel (asserted through the real `connection.rpc.call` arguments, not
 * against a re-declared constant).
 */
import { describe, expect, it } from 'bun:test'
import { ENGINE_STATUS_CHANNEL, ENGINE_STATUS_ENDPOINT } from '../src/engine-status-wire.ts'
import {
  MSTAR_ENGINE_STATUS_METHOD,
  MSTAR_ENGINE_STATUS_NAMESPACE,
  mstarEngineStatusContribution,
} from '../src/engine-status-endpoint.ts'
import { MstarEngineStatusClient } from '../src/client/panel/engine-status-client.ts'
import { stubGateway } from './gateway-stub.ts'

/** The `namespace/method` address a typert invocation descriptor is served at. */
function descriptorAddress(): string {
  const invocation = mstarEngineStatusContribution().invocations[0]
  if (invocation === undefined) throw new Error('the contribution declares no invocation')
  return `${invocation.namespace}/${invocation.method}`
}

describe('engine-status wire address — one declaration, both halves', () => {
  it('the host descriptor is served at the shared endpoint literal', () => {
    expect(descriptorAddress()).toBe(ENGINE_STATUS_ENDPOINT)
  })

  it('the client calls the shared endpoint literal on the host /api channel', async () => {
    const gateway = stubGateway()
    const client = new MstarEngineStatusClient(gateway.connection)
    client.ensure('s-wire', '/proj', 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(gateway.calls).toHaveLength(1)
    // Compared against the shared literals, i.e. against what the descriptor
    // above uses — not against a client-side copy of the same string.
    expect(gateway.calls[0]!.channel).toBe(ENGINE_STATUS_CHANNEL)
    expect(gateway.calls[0]!.endpoint).toBe(ENGINE_STATUS_ENDPOINT)
  })

  it('the address is composed of the namespace and method the host declares', () => {
    expect(ENGINE_STATUS_ENDPOINT).toBe(`${MSTAR_ENGINE_STATUS_NAMESPACE}/${MSTAR_ENGINE_STATUS_METHOD}`)
    expect(ENGINE_STATUS_CHANNEL).toBe('/api')
  })
})
