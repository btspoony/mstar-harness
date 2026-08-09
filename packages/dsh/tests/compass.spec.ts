/**
 * Golden-vector guard for the shared compass frontmatter parser — the
 * ENGINE's `parseCompassFrontmatter` (upstream 2.0.3 moved the parser into
 * the engine; the CLI re-imports from there and the dsh plugin does the
 * same — no local mirror).
 *
 * The shared fixtures + `golden.json` under `tests/fixtures/compass/` are
 * asserted by BOTH sides: this spec pins the dsh in-app parser to the
 * engine's canonical format, and `packages/cli/test/compass.test.ts` pins
 * the CLI parser to the SAME vectors — a format change on either side fails
 * that side's suite, and a change to the shared contract must update the
 * fixtures + golden in both packages together.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCompassFrontmatter } from '@mstar-harness/engine'

const FIXTURES = join(import.meta.dir, 'fixtures', 'compass')

/** Load the shared golden vector for one fixture. */
function goldenFor(fixture: string): Record<string, unknown> {
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8')) as Record<string, Record<string, unknown>>
  return golden[fixture]!
}

describe('parseCompassFrontmatter — golden vectors (engine parity, shared with packages/cli)', () => {
  it('delivery-compass fixture → expected fields (scalars, comment/blank lines, plans block list)', () => {
    const fixture = 'delivery-compass.md'
    const doc = parseCompassFrontmatter(join(FIXTURES, fixture))
    expect(doc).toEqual(goldenFor(fixture))
  })

  it('flow-plans fixture → expected fields (flow array, quoted item, empty scalar → null)', () => {
    const fixture = 'flow-plans.md'
    const doc = parseCompassFrontmatter(join(FIXTURES, fixture))
    expect(doc).toEqual(goldenFor(fixture))
  })

  it('empty-plans fixture → empty flow array stays an empty ARRAY (template default `plans: []`)', () => {
    const fixture = 'empty-plans.md'
    const doc = parseCompassFrontmatter(join(FIXTURES, fixture))
    expect(doc).toEqual(goldenFor(fixture))
  })
})

describe('parseCompassFrontmatter — structural errors (file path in the message)', () => {
  it('no opening fence → throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mstar-compass-'))
    const file = join(dir, 'broken.md')
    writeFileSync(file, 'iteration_id: v1\n')
    try {
      expect(() => parseCompassFrontmatter(file)).toThrow(/no YAML frontmatter fence/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unterminated fence → throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mstar-compass-'))
    const file = join(dir, 'broken.md')
    writeFileSync(file, '---\niteration_id: v1\n')
    try {
      expect(() => parseCompassFrontmatter(file)).toThrow(/unterminated YAML frontmatter/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unsupported line (dangling list item with no list key) → throws with the line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mstar-compass-'))
    const file = join(dir, 'broken.md')
    writeFileSync(file, '---\niteration_id: v1\n- dangling\n---\n')
    try {
      expect(() => parseCompassFrontmatter(file)).toThrow(/unsupported frontmatter line/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('nested flow-style array → throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mstar-compass-'))
    const file = join(dir, 'broken.md')
    writeFileSync(file, '---\nplans: [[a]]\n---\n')
    try {
      expect(() => parseCompassFrontmatter(file)).toThrow(/nested flow-style array/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('comma inside a quoted flow item → throws (cannot be split unambiguously)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mstar-compass-'))
    const file = join(dir, 'broken.md')
    writeFileSync(file, '---\nplans: ["a, b"]\n---\n')
    try {
      expect(() => parseCompassFrontmatter(file)).toThrow(/ambiguous flow-style array/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unterminated quote in a flow array → throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mstar-compass-'))
    const file = join(dir, 'broken.md')
    writeFileSync(file, '---\nplans: ["a]\n---\n')
    try {
      expect(() => parseCompassFrontmatter(file)).toThrow(/unterminated " quote/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CRLF line endings parse identically (Windows-authored compass files)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mstar-compass-'))
    const file = join(dir, 'crlf.md')
    writeFileSync(file, '---\r\niteration_id: v1\r\nstatus: active\r\nplans: [a]\r\n---\r\n')
    try {
      expect(parseCompassFrontmatter(file)).toEqual({ iteration_id: 'v1', status: 'active', plans: ['a'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
