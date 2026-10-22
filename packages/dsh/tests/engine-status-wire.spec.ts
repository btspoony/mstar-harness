/**
 * Wire-address parity spec for the panel's channels: the host registers ONE
 * endpoint descriptor per method and the browser half calls the same address.
 * Both halves previously declared their own literals (`MSTAR_*_NAMESPACE` on the
 * host, `'mstar/engineStatus'` in the client) and each spec pinned only its own
 * copy — so renaming either side kept both suites green while the panel
 * silently degraded to `transport-error`.
 *
 * Covered: the literals live in exactly one module, each descriptor's endpoint
 * path is composed from them, and the client calls exactly that path on exactly
 * that channel (asserted through the real `connection.rpc.call` arguments, not
 * against a re-declared constant).
 *
 * The READ channel is `mstar/panelSnapshot` (its own spec:
 * `panel-snapshot-endpoint.spec.ts`); what remains in the `mstar` gateway
 * contribution is the picker's durable WRITE, pinned below.
 */
import { describe, expect, it } from 'bun:test'
import { ENGINE_STATUS_CHANNEL, PANEL_SNAPSHOT_ENDPOINT, SELECT_WORKFLOW_ENDPOINT } from '../src/engine-status-wire.ts'
import { mstarEngineStatusContribution } from '../src/engine-status-endpoint.ts'
import { MstarWorkflowPickerClient } from '../src/client/panel/workflow-picker-client.ts'
import { stubGateway } from './gateway-stub.ts'

/** Every endpoint path the package's one host contribution declares. */
function contributedEndpoints(): string[] {
  return mstarEngineStatusContribution().invocations.map((invocation) => `${invocation.namespace}/${invocation.method}`)
}

describe('panel wire addresses — one declaration, both halves', () => {
  it('the host contribution serves the picker write and the store-backed read', () => {
    expect(contributedEndpoints()).toEqual([SELECT_WORKFLOW_ENDPOINT, PANEL_SNAPSHOT_ENDPOINT])
  })

  it('the picker calls the shared selectWorkflow literal on the host /api channel', async () => {
    const gateway = stubGateway()
    const client = new MstarWorkflowPickerClient(gateway.connection)
    await client.selectWorkflow('s-wire', '/proj', 'wf-a')
    expect(gateway.calls).toHaveLength(1)
    // Compared against the shared literals, i.e. against what the descriptors
    // above use — not against a client-side copy of the same string.
    expect(gateway.calls[0]!.channel).toBe(ENGINE_STATUS_CHANNEL)
    expect(gateway.calls[0]!.endpoint).toBe(SELECT_WORKFLOW_ENDPOINT)
    expect(gateway.calls[0]!.payload).toEqual({ args: { sessionId: 's-wire', cwd: '/proj', workflowId: 'wf-a' } })
    client.dispose()
  })
})
