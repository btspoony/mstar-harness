import { describe, expect, it } from 'bun:test'
import * as plugin from '../src/index.ts'

describe('@mstar-harness/dsh function-plugin contract', () => {
  it('exposes named exports name/inject/Config/apply with no default export', () => {
    expect(plugin.name).toBe('dsh')
    expect(Array.isArray(plugin.inject)).toBe(true)
    expect(plugin.Config).toBeDefined()
    expect(typeof plugin.apply).toBe('function')
    expect('default' in plugin).toBe(false)
  })

  it('apply accepts a registrant context and the validated config without registering', () => {
    // Scaffold contract: the empty apply must not throw on any registrant context.
    expect(() => plugin.apply({} as never, {})).not.toThrow()
  })
})
