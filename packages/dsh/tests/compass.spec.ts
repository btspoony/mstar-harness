/**
 * Golden-vector guard for the in-app compass frontmatter parser
 * (`src/compass.ts`) — the CLI parser mirror (qc1 F-002).
 *
 * The dsh parser is maintained in sync with the CLI parser
 * (`packages/cli/src/compass.ts` — the single parser home). The shared
 * fixtures + `golden.json` under `tests/fixtures/compass/` are asserted by
 * BOTH sides: this spec pins the dsh mirror to the canonical format, and
 * `packages/cli/test/compass.test.ts` pins the CLI parser to the SAME
 * vectors — a format change on either side fails that side's suite, and a
 * change to the shared contract must update the fixtures + golden in both
 * packages together.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCompassFrontmatterText } from '../src/compass.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'compass')

/** Load the shared golden vector for one fixture. */
function goldenFor(fixture: string): Record<string, unknown> {
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8')) as Record<string, Record<string, unknown>>
  return golden[fixture]!
}

describe('parseCompassFrontmatterText — golden vectors (shared with packages/cli)', () => {
  it('delivery-compass fixture → expected fields (scalars, comment/blank lines, plans block list)', () => {
    const fixture = 'delivery-compass.md'
    const doc = parseCompassFrontmatterText(readFileSync(join(FIXTURES, fixture), 'utf8'), fixture)
    expect(doc).toEqual(goldenFor(fixture))
  })

  it('flow-plans fixture → expected fields (flow array, quoted item, empty scalar → null)', () => {
    const fixture = 'flow-plans.md'
    const doc = parseCompassFrontmatterText(readFileSync(join(FIXTURES, fixture), 'utf8'), fixture)
    expect(doc).toEqual(goldenFor(fixture))
  })

  it('empty-plans fixture → empty flow array stays an empty ARRAY (template default `plans: []`)', () => {
    const fixture = 'empty-plans.md'
    const doc = parseCompassFrontmatterText(readFileSync(join(FIXTURES, fixture), 'utf8'), fixture)
    expect(doc).toEqual(goldenFor(fixture))
  })
})

describe('parseCompassFrontmatterText — structural errors (source name in the message)', () => {
  const SOURCE = '/some/compass.md'

  it('no opening fence → throws', () => {
    expect(() => parseCompassFrontmatterText('iteration_id: v1\n', SOURCE)).toThrow(/no YAML frontmatter fence/)
  })

  it('unterminated fence → throws', () => {
    expect(() => parseCompassFrontmatterText('---\niteration_id: v1\n', SOURCE)).toThrow(/unterminated YAML frontmatter/)
  })

  it('unsupported line (dangling list item with no list key) → throws with the line', () => {
    expect(() => parseCompassFrontmatterText('---\niteration_id: v1\n- dangling\n---\n', SOURCE)).toThrow(
      /unsupported frontmatter line/,
    )
  })

  it('nested flow-style array → throws', () => {
    expect(() => parseCompassFrontmatterText('---\nplans: [[a]]\n---\n', SOURCE)).toThrow(/nested flow-style array/)
  })

  it('comma inside a quoted flow item → throws (cannot be split unambiguously)', () => {
    expect(() => parseCompassFrontmatterText('---\nplans: ["a, b"]\n---\n', SOURCE)).toThrow(
      /ambiguous flow-style array/,
    )
  })

  it('unterminated quote in a flow array → throws', () => {
    expect(() => parseCompassFrontmatterText('---\nplans: ["a]\n---\n', SOURCE)).toThrow(/unterminated " quote/)
  })

  it('CRLF line endings parse identically (Windows-authored compass files)', () => {
    const doc = parseCompassFrontmatterText('---\r\niteration_id: v1\r\nstatus: active\r\nplans: [a]\r\n---\r\n', SOURCE)
    expect(doc).toEqual({ iteration_id: 'v1', status: 'active', plans: ['a'] })
  })
})
