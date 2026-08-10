/**
 * Unit tests for the sidebar / Done-column plan ordering rule (spec
 * panel-zones §3): the hard-coded digitized sort keys — `doneAt` matching
 * /^\d{4}-\d{2}-\d{2}$/ digitized DESC, `id` first-8-digits fallback DESC,
 * `id` lexicographic DESC tie-break. The canvas Done column (plan
 * 20260810-panel-canvas-zones) reuses the same rule — this module is the
 * single implementation.
 */

import { describe, expect, it } from 'bun:test'
import { comparePlans, sortPlans, PLAN_CAP, FINDINGS_CAP } from '../src/client/panel/plan-sort'

type PlanLike = { id: string; doneAt: string | null }

const ids = (plans: PlanLike[]): string[] => plans.map((p) => p.id)

describe('plan-sort (spec panel-zones §3)', () => {
  it('doneAt matching /^\d{4}-\d{2}-\d{2}$/ digitized DESC — newer done first', () => {
    const plans: PlanLike[] = [
      { id: 'plan-a', doneAt: '2026-08-01' },
      { id: 'plan-b', doneAt: '2026-08-10' },
      { id: 'plan-c', doneAt: '2026-07-20' },
    ]
    expect(ids(sortPlans(plans))).toEqual(['plan-b', 'plan-a', 'plan-c'])
  })

  it("doneAt missing (null / '' / garbage) → empty key sorts LAST, id tie-breaks still apply", () => {
    const plans: PlanLike[] = [
      { id: '20260808-pkg', doneAt: '2026-08-08' }, // valid doneAt wins
      { id: 'plan-x', doneAt: 'garbage-date' },     // garbage → empty key
      { id: 'plan-y', doneAt: null },               // missing → empty key
      { id: 'plan-z', doneAt: '' },                 // empty → empty key
    ]
    // Among the empty-key plans: no id-date (no /^\d{8}/) → id lex DESC.
    expect(ids(sortPlans(plans))).toEqual(['20260808-pkg', 'plan-z', 'plan-y', 'plan-x'])
  })

  it('doneAt digitized beats the id-date fallback (fallback only applies among equal doneAt keys)', () => {
    const plans: PlanLike[] = [
      { id: '20260815-no-doneat', doneAt: null },  // id-date 20260815 but no doneAt
      { id: 'plan-old', doneAt: '2026-08-08' },    // doneKey 20260808
    ]
    // Level 1 (doneAt) is authoritative: a plan WITH doneAt always leads.
    expect(ids(sortPlans(plans))).toEqual(['plan-old', '20260815-no-doneat'])
  })

  it('id first-8-digits fallback (/^\d{8}/) DESC when doneAt keys are equal', () => {
    const plans: PlanLike[] = [
      { id: '20260810-some-plan', doneAt: null },
      { id: '20260808-other-plan', doneAt: null },
      { id: 'plan-legacy', doneAt: null }, // no id-date → last
    ]
    expect(ids(sortPlans(plans))).toEqual(['20260810-some-plan', '20260808-other-plan', 'plan-legacy'])
  })

  it('tie-break: identical doneAt + id-date → id lexicographic DESC (deterministic)', () => {
    const plans: PlanLike[] = [
      { id: '20260808-plan-b', doneAt: '2026-08-08' },
      { id: '20260808-plan-a', doneAt: '2026-08-08' },
    ]
    expect(ids(sortPlans(plans))).toEqual(['20260808-plan-b', '20260808-plan-a'])
  })

  it('equal ids compare as 0 (stable); missing doneAt loses to present doneAt', () => {
    const bare: PlanLike = { id: 'same-id', doneAt: null }
    expect(comparePlans(bare, { ...bare })).toBe(0)
    expect(comparePlans(bare, { id: 'same-id', doneAt: '2026-08-08' })).toBeGreaterThan(0)
    expect(comparePlans({ id: 'same-id', doneAt: '2026-08-08' }, bare)).toBeLessThan(0)
  })

  it('does not mutate the input array', () => {
    const plans: PlanLike[] = [
      { id: 'plan-a', doneAt: '2026-08-01' },
      { id: 'plan-b', doneAt: '2026-08-10' },
    ]
    const snapshot = [...plans]
    sortPlans(plans)
    expect(plans).toEqual(snapshot)
  })

  it('caps match spec §5: plans ≤5, residual findings ≤10', () => {
    expect(PLAN_CAP).toBe(5)
    expect(FINDINGS_CAP).toBe(10)
  })
})
