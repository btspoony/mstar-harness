import { describe, expect, it } from 'bun:test'
import type { Context, Events } from '@deepseek-ai/cordis'
import * as entry from '../src/index.ts'

/** Host-facing Loader and Cordis contracts consumed by plugin integrations. */
type _CordisCtxAugment = Context['dshHostAdapter']
type _CordisEventDispatchGate = Events['mstar/dispatch-gate']
type _CordisEventStatusGate = Events['mstar/status-gate']
type _CordisEventSkillLint = Events['mstar/skill-lint']
type _CordisEventSeamLint = Events['mstar/seam-lint']

describe('src/index.ts Loader contract', () => {
  it('exposes the plugin entry points consumed by the host', () => {
    expect(entry.name).toBe('dsh')
    expect(Array.isArray(entry.inject)).toBe(true)
    expect(typeof entry.apply).toBe('function')
  })
})
