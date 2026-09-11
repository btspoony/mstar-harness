/**
 * Steering-helper tests : the structural
 * lineage reads the goal and planMode bridges share via explicit no-barrel
 * imports (`gates/steering.ts`): the `parentSession` root walk
 * (`rootAgentOf`) — its root discrimination, its registry-gap abandonment,
 * and its `seen`-set cycle guard, which keeps the synchronous
 * `subagent/start` decision-point listeners from spinning on a malformed
 * lineage.
 */
import { describe, expect, it } from 'bun:test'
import { rootAgentOf } from '../src/gates/steering.ts'

describe('steering — root lineage (rootAgentOf)', () => {
  it('rootAgentOf: a 2+ hop parentSession CYCLE returns undefined (seen-set guard — upstream liveLineage precedent)', () => {
    // A→B→A: no root reachable — the walk must break on the REVISITED id
    // instead of spinning forever (the sync decision-point listeners hang
    // otherwise). The current 1-cycle guard (parent === current) cannot see
    // this — the guard needs a seen-set over session ids.
    const agentA = { id: 'cycle-a', session: { header: { parentSession: 'cycle-b' } } }
    const agentB = { id: 'cycle-b', session: { header: { parentSession: 'cycle-a' } } }
    const registry = { get: (id: string) => (id === 'cycle-a' ? agentA : id === 'cycle-b' ? agentB : undefined) }
    expect(rootAgentOf(agentA, registry)).toBeUndefined()
    expect(rootAgentOf(agentB, registry)).toBeUndefined()
  })
})
