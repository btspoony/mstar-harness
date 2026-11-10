/**
 * `isCiEnvironment()` is the single predicate the environment-dependent gates
 * read, so its matrix is pinned here: a regression to "CI only" would demote the
 * ten real-composition cases to skips on a runner child that unsets `CI`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { isCiEnvironment } from './harness.ts'

/** The variables the predicate reads; every case starts from neither set. */
const KEYS = ['CI', 'GITHUB_ACTIONS'] as const

const CASES: ReadonlyArray<{ name: string; env: Record<string, string>; ci: boolean }> = [
  { name: 'neither variable set', env: {}, ci: false },
  { name: 'both variables empty', env: { CI: '', GITHUB_ACTIONS: '' }, ci: false },
  { name: 'CI set alone', env: { CI: '1' }, ci: true },
  { name: 'CI set to the literal "false" (set, not unset)', env: { CI: 'false' }, ci: true },
  { name: 'GITHUB_ACTIONS set alone', env: { GITHUB_ACTIONS: 'true' }, ci: true },
  { name: 'GITHUB_ACTIONS set to the literal "false"', env: { GITHUB_ACTIONS: 'false' }, ci: true },
  { name: 'both set', env: { CI: '1', GITHUB_ACTIONS: '1' }, ci: true },
]

/** The process environment as this spec found it — restored after every case. */
const original = new Map<string, string | undefined>(KEYS.map((key) => [key, process.env[key]]))

function restore(): void {
  for (const key of KEYS) {
    const value = original.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

afterEach(restore)

describe('isCiEnvironment — explicit environment matrix', () => {
  for (const { name, env, ci } of CASES) {
    test(name, () => {
      restore()
      for (const key of KEYS) delete process.env[key]
      for (const [key, value] of Object.entries(env)) process.env[key] = value
      expect(isCiEnvironment()).toBe(ci)
      // The restore contract of this suite: no case may leak into the next one.
      restore()
      expect(process.env.CI).toBe(original.get('CI'))
      expect(process.env.GITHUB_ACTIONS).toBe(original.get('GITHUB_ACTIONS'))
    })
  }
})
