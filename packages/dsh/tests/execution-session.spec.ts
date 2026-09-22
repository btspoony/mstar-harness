import { describe, expect, it } from 'bun:test'
import { serializeExecutionValue } from '@mstar-harness/engine'
import { parseExecutionRequest, runExecutionCommand } from '../src/gates/execution-session.ts'
describe('mstar-execution native launcher', () => {
  it('runs argv without a shell and returns output/exit status', async () => {
    const result = await runExecutionCommand([process.execPath, '-e', 'process.stdout.write(process.env.MSTAR_EXECUTION_IDENTITY ?? "missing")'], {
      ...process.env,
      MSTAR_EXECUTION_IDENTITY: serializeExecutionValue({
        source: 'host', sessionId: 'native', workflowId: 'wf', role: 'coordinator', planId: null,
      }),
    }, new AbortController().signal)
    expect(result.stdout).toBe(serializeExecutionValue({
      source: 'host', sessionId: 'native', workflowId: 'wf', role: 'coordinator', planId: null,
    }))
  })

  it('rejects empty argv before launching a child', async () => {
    await expect(runExecutionCommand([], process.env, new AbortController().signal)).rejects.toThrow('execution argv must be non-empty')
  })

  it('requires a closed human JSON union and rejects model-shaped extras', () => {
    expect(parseExecutionRequest('{"operation":"clear"}')).toEqual({ operation: 'clear' })
    expect(() => parseExecutionRequest('{"operation":"clear","sessionId":"model-input"}')).toThrow('clear does not accept extra fields')
  })
})
