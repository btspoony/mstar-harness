import { describe, expect, it } from 'bun:test'
import { WorkflowAskCache, WORKFLOW_LEASE_UNCOVERED_CODE, WORKFLOW_NAME_UNKNOWN_CODE, normalizeWorkflowName, workflowNameUnknown, workflowPolicy } from '../src/gates/workflow-policy.ts'
import type { Config } from '../src/gates/_shared.ts'
import type { WorkflowGateInput } from '../src/gates/dispatch.ts'

const input = (overrides: Partial<WorkflowGateInput> = {}): WorkflowGateInput => ({
  tool: 'workflow',
  metaName: 'deploy',
  exec: {} as WorkflowGateInput['exec'],
  ...overrides,
})

const config = (overrides: Partial<Config> = {}): Config => ({ workflowNames: ['deploy'], ...overrides })

describe('workflow policy', () => {
  it('normalizes ASCII controls and allowlist entries without mutating config', () => {
    expect(normalizeWorkflowName('de\u0000p\nlo\u007fy')).toBe('deploy')
    const names = ['de\u0000ploy\n']
    expect(workflowNameUnknown(config({ workflowNames: names }), 'deploy')).toBe(false)
    expect(names).toEqual(['de\u0000ploy\n'])
    expect(workflowNameUnknown(config(), 'deployment')).toBe(true)
    expect(workflowNameUnknown(config({ workflowNames: [] }), 'deploy')).toBe(true)
    expect(workflowNameUnknown({}, 'deploy')).toBe(true)
  })

  it('allows allowlisted names in every enforcement mode', () => {
    for (const workflowGate of ['off', 'warn', 'hard', 'ask'] as const) {
      expect(workflowPolicy(config({ workflowGate }), new WorkflowAskCache(), input())).toEqual({ decision: 'allow' })
    }
  })

  it('warns or denies unknown names according to mode', () => {
    const unknown = input({ metaName: 'missing' })
    expect(workflowPolicy(config({ workflowGate: 'warn' }), new WorkflowAskCache(), unknown)).toMatchObject({ decision: 'warn', code: WORKFLOW_NAME_UNKNOWN_CODE })
    expect(workflowPolicy(config({ workflowGate: 'hard' }), new WorkflowAskCache(), unknown)).toMatchObject({ decision: 'deny', code: WORKFLOW_NAME_UNKNOWN_CODE })
    expect(workflowPolicy(config({ workflowGate: 'off' }), new WorkflowAskCache(), unknown)).toEqual({ decision: 'allow' })
  })

  it('asks on a cache miss and applies recorded allow and deny decisions on hits', () => {
    const cache = new WorkflowAskCache()
    const askConfig = config({ workflowGate: 'ask' })
    expect(workflowPolicy(askConfig, cache, input({ metaName: 'missing' }))).toMatchObject({ decision: 'ask', code: WORKFLOW_NAME_UNKNOWN_CODE })
    expect(cache.wasAsked('missing')).toBe(true)
    expect(workflowPolicy(askConfig, cache, input({ metaName: 'missing' }))).toMatchObject({ decision: 'ask' })
    cache.record('missing', 'allow')
    expect(workflowPolicy(askConfig, cache, input({ metaName: 'missing' }))).toEqual({ decision: 'allow' })
    cache.record('missing', 'deny')
    expect(workflowPolicy(askConfig, cache, input({ metaName: 'missing' }))).toMatchObject({ decision: 'deny', code: WORKFLOW_NAME_UNKNOWN_CODE })
  })

  it('normalizes cache writes and ask marks; cache persists for the cache instance lifetime', () => {
    const cache = new WorkflowAskCache()
    cache.record('mis\u0000sing\n', 'allow')
    expect(cache.get('missing')).toBe('allow')
    expect(cache.get('mis\u0000sing\n')).toBeUndefined()
    cache.markAsked('mis\u0000sing\n')
    expect(cache.wasAsked('missing')).toBe(true)
    expect(cache.wasAsked('mis\u0000sing\n')).toBe(true)
    expect(new WorkflowAskCache().get('missing')).toBeUndefined()
  })

  it('makes uncovered-plan policy preempt allowlists and name asks', () => {
    const cache = new WorkflowAskCache()
    expect(workflowPolicy(config({ workflowGate: 'hard' }), cache, input({ uncoveredPlanId: 'P-1' }))).toMatchObject({ decision: 'deny', code: WORKFLOW_LEASE_UNCOVERED_CODE })
    expect(workflowPolicy(config({ workflowGate: 'ask' }), cache, input({ uncoveredPlanId: 'P-1' }))).toMatchObject({ decision: 'warn', code: WORKFLOW_LEASE_UNCOVERED_CODE })
    expect(cache.wasAsked('deploy')).toBe(false)
    expect(workflowPolicy(config({ workflowGate: 'hard' }), cache, input({ tool: 'ralph', metaName: undefined, uncoveredPlanId: 'P-1' }))).toMatchObject({ decision: 'deny', code: WORKFLOW_LEASE_UNCOVERED_CODE })
  })

  it('does not apply name policy to ralph, while off mode always allows', () => {
    expect(workflowPolicy(config({ workflowGate: 'hard' }), new WorkflowAskCache(), input({ tool: 'ralph', metaName: undefined }))).toEqual({ decision: 'allow' })
    expect(workflowPolicy(config({ workflowGate: 'off' }), new WorkflowAskCache(), input({ uncoveredPlanId: 'P-1' }))).toEqual({ decision: 'allow' })
  })
})
