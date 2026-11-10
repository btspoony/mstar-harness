/**
 * The outcomes the CI report gate must distinguish, on synthetic JUnit reports
 * (Bun's `--reporter=junit` shape): valid, skipped, missing, empty, a deleted
 * gated case, and an over-executed (parametrized) gated case. The reports are
 * fixtures — nothing here is compared against a real runner.
 *
 * The expected per-file counts come from the gate's own inventory; the skip that
 * must NOT fail it is in `tests/install-e2e.spec.ts`, because the invariant is
 * scoped to the two gated spec files.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATED_SPECS, checkCompositionReport } from './check-composition-report.ts'

const [
  { file: SESSION_SPEC, expectedExecuted: SESSION_CASES },
  { file: SKILLS_SPEC, expectedExecuted: SKILLS_CASES },
] = GATED_SPECS
const SCRIPT = join(import.meta.dir, 'check-composition-report.ts')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-composition-report-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function testcase(file: string, name: string, skipped = false): string {
  if (!skipped) return `<testcase name="${name}" classname="suite" file="${file}" line="1" />`
  return `<testcase name="${name}" classname="suite" file="${file}" line="1"><skipped /></testcase>`
}

/** `count` executed cases for a file, as a report would list them. */
function executed(file: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => testcase(file, `case ${index + 1}`))
}

/** One file-level suite, optionally with a nested describe suite, as Bun emits them. */
function suite(file: string, cases: string[], nested = true): string {
  const body = cases.join('\n')
  const inner = nested && cases.length > 0 ? `<testsuite name="suite" file="${file}" line="1">\n${body}\n</testsuite>` : body
  return `<testsuite name="${file}" file="${file}" tests="${cases.length}">\n${inner}\n</testsuite>`
}

function report(...suites: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">\n${suites.join('\n')}\n</testsuites>`
}

/** Write a synthetic report and run the real script against it. */
function runScript(xml: string): { exitCode: number; stdout: string; stderr: string } {
  const path = join(scratch, `report-${Math.random().toString(36).slice(2)}.xml`)
  writeFileSync(path, xml)
  const proc = Bun.spawnSync(['bun', SCRIPT, path], { cwd: join(import.meta.dir, '..') })
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

describe('composition report gate — synthetic reports', () => {
  test('valid: both gated files executed, an unrelated file may skip', () => {
    const check = checkCompositionReport(report(
      suite(SESSION_SPEC, executed(SESSION_SPEC, SESSION_CASES)),
      suite(SKILLS_SPEC, executed(SKILLS_SPEC, SKILLS_CASES)),
      suite('tests/install-e2e.spec.ts', [testcase('tests/install-e2e.spec.ts', 'no dsh bin on PATH', true)], false),
    ))
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.files.map((entry) => entry.file)).toEqual([SESSION_SPEC, SKILLS_SPEC])
    expect(check.files.every((entry) => entry.skipped === 0)).toBe(true)
  })

  test('deleted: fewer executed cases than the inventory pins names that file and both counts', () => {
    const check = checkCompositionReport(report(
      suite(SESSION_SPEC, executed(SESSION_SPEC, SESSION_CASES - 1)),
      suite(SKILLS_SPEC, executed(SKILLS_SPEC, SKILLS_CASES)),
    ))
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toContain(SESSION_SPEC)
    expect(check.reason).toContain(`executed ${SESSION_CASES - 1}`)
    expect(check.reason).toContain(`expected at least ${SESSION_CASES}`)
  })

  test('over-executed: a parametrized gated case may exceed the pinned count', () => {
    const check = checkCompositionReport(report(
      suite(SESSION_SPEC, executed(SESSION_SPEC, SESSION_CASES + 1)),
      suite(SKILLS_SPEC, executed(SKILLS_SPEC, SKILLS_CASES + 1)),
    ))
    expect(check.ok).toBe(true)
  })

  test('skipped: a gated case reported as a skip names that file', () => {
    const check = checkCompositionReport(report(
      suite(SESSION_SPEC, executed(SESSION_SPEC, SESSION_CASES)),
      suite(SKILLS_SPEC, [...executed(SKILLS_SPEC, SKILLS_CASES - 1), testcase(SKILLS_SPEC, 'loads the body', true)]),
    ))
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toContain(SKILLS_SPEC)
    expect(check.reason).toContain('skipped')
  })

  test('missing: an absent gated suite names that file', () => {
    const check = checkCompositionReport(report(
      suite(SESSION_SPEC, executed(SESSION_SPEC, SESSION_CASES)),
      suite('tests/invariant.spec.ts', [testcase('tests/invariant.spec.ts', 'exports')], false),
    ))
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toContain(SKILLS_SPEC)
    expect(check.reason).toContain('absent')
  })

  test('empty: a present gated suite with no executed case names that file', () => {
    const check = checkCompositionReport(report(
      suite(SESSION_SPEC, executed(SESSION_SPEC, SESSION_CASES)),
      suite(SKILLS_SPEC, []),
    ))
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toContain(SKILLS_SPEC)
    expect(check.reason).toContain('no executed case')
  })
})

describe('composition report gate — script exit status', () => {
  const valid = report(
    suite(SESSION_SPEC, executed(SESSION_SPEC, SESSION_CASES)),
    suite(SKILLS_SPEC, executed(SKILLS_SPEC, SKILLS_CASES)),
  )
  const skipped = report(
    suite(SESSION_SPEC, executed(SESSION_SPEC, SESSION_CASES)),
    suite(SKILLS_SPEC, [...executed(SKILLS_SPEC, SKILLS_CASES - 1), testcase(SKILLS_SPEC, 'mounts the mirror', true)]),
  )
  const deleted = report(
    suite(SESSION_SPEC, executed(SESSION_SPEC, SESSION_CASES - 1)),
    suite(SKILLS_SPEC, executed(SKILLS_SPEC, SKILLS_CASES)),
  )

  test('exits 0 and reports the executed population when the gate holds', () => {
    const run = runScript(valid)
    expect(run.stderr).toBe('')
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain(`${SKILLS_SPEC} executed=${SKILLS_CASES} skipped=0`)
  })

  test('exits 1 and names the offending file when a gated case skipped', () => {
    const run = runScript(skipped)
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain(SKILLS_SPEC)
  })

  test('exits 1 and names the file with expected-vs-actual counts when a gated case was deleted', () => {
    const run = runScript(deleted)
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain(SESSION_SPEC)
    expect(run.stderr).toContain(`executed ${SESSION_CASES - 1}`)
    expect(run.stderr).toContain(`expected at least ${SESSION_CASES}`)
  })
})
