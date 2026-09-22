import { describe, expect, it } from 'bun:test'
import { runExecutionCommand } from '../src/gates/execution-session.ts'

describe('mstar-execution native launcher', () => {
  it('runs argv without a shell and returns output/exit status', async () => {
    const result = await runExecutionCommand([process.execPath, '-e', 'process.stdout.write(process.env.MSTAR_EXECUTION_IDENTITY ?? "missing")'], {
      ...process.env,
      MSTAR_EXECUTION_IDENTITY: '{"sessionId":"native"}',
    }, new AbortController().signal)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('{"sessionId":"native"}')
  })

  it('rejects empty argv before launching a child', async () => {
    await expect(runExecutionCommand([], process.env, new AbortController().signal)).rejects.toThrow('execution argv must be non-empty')
  })
})
