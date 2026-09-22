import { describe, expect, it } from 'bun:test'
import {
  executionIdentityForSession,
  nativeSessionCwdOf,
  nativeSessionIdOf,
} from '../src/gates/execution-session.ts'

describe('DSh native execution identity', () => {
  it('uses only the SDK session header and keeps scope explicit', () => {
    const agent = {
      id: 'child-agent-id',
      session: { header: { id: 'native-session-id', cwd: '/workspace' } },
    }
    expect(nativeSessionIdOf(agent)).toBe('native-session-id')
    expect(nativeSessionCwdOf(agent)).toBe('/workspace')
    expect(executionIdentityForSession('native-session-id', {
      workflowId: 'wf-1', role: 'plan-pm', planId: 'plan-1',
    })).toEqual({
      source: 'host', sessionId: 'native-session-id', workflowId: 'wf-1', role: 'plan-pm', planId: 'plan-1',
    })
  })

  it('refuses missing native identity instead of accepting an agent or model id', () => {
    expect(nativeSessionIdOf({ id: 'spoofed-agent', arguments: { sessionId: 'fake' } })).toBeUndefined()
    expect(() => executionIdentityForSession('', {
      workflowId: 'wf-1', role: 'coordinator', planId: null,
    })).toThrow('native execution session identity is required')
  })
})
