/**
 * Scoped JUnit gate for the ten real-composition cases.
 *
 * Those cases are `test.if(isCiEnvironment())`: locally they report as skips by
 * design, in CI they must EXECUTE. A plain green `bun test` cannot tell the two
 * apart — a reverted CI predicate, or a spec silently dropped from the run, both
 * leave the job green. This check reads the JUnit report the same step emitted
 * and requires, for the two gated spec files only: the file is present, at least
 * one case executed, and no case was skipped. Skips in other files (optional
 * installs and the like) stay permitted.
 *
 * Usage: `bun run --cwd packages/dsh check:composition-report [report.xml]`
 * (the default report path is this package's `.junit-dsh.xml`).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The gated spec files, relative to this package root. */
export const GATED_SPECS = ['tests/e2e-session.spec.ts', 'tests/skills-mount.spec.ts'] as const

/** The JUnit report the `test-dsh` CI step writes (`--reporter-outfile`). */
export const REPORT_FILE = '.junit-dsh.xml'

export interface GatedFileReport {
  file: string
  executed: number
  skipped: number
}

export type CompositionReportCheck =
  | { ok: true; files: GatedFileReport[] }
  | { ok: false; reason: string }

const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
const TESTSUITE = /<testsuite\b([^>]*?)\/?>/g
const FILE_ATTR = /file="([^"]*)"/

function fileOf(attrs: string): string | undefined {
  return FILE_ATTR.exec(attrs)?.[1]
}

/** Report paths follow the invocation's cwd, so a spec matches by full relative path. */
function names(reported: string, spec: string): boolean {
  return reported === spec || reported.endsWith(`/${spec}`)
}

export function checkCompositionReport(xml: string): CompositionReportCheck {
  const cases: Array<{ file: string; skipped: boolean }> = []
  for (const match of xml.matchAll(TESTCASE)) {
    const file = fileOf(match[1] ?? '')
    if (file === undefined) continue
    cases.push({ file, skipped: (match[2] ?? '').includes('<skipped') })
  }
  const suites = [...xml.matchAll(TESTSUITE)]
    .map((match) => fileOf(match[1] ?? ''))
    .filter((file): file is string => file !== undefined)

  const files: GatedFileReport[] = []
  for (const spec of GATED_SPECS) {
    const own = cases.filter((entry) => names(entry.file, spec))
    const skipped = own.filter((entry) => entry.skipped).length
    const executed = own.length - skipped
    if (own.length === 0 && !suites.some((file) => names(file, spec))) {
      return {
        ok: false,
        reason: `${spec} is absent from the report — run it in the same bun test invocation as the rest of the suite, not in a second step`,
      }
    }
    if (skipped > 0) {
      return {
        ok: false,
        reason: `${spec} reported ${skipped} skipped case(s) — these gated cases must execute, so a CI run has to set CI or GITHUB_ACTIONS (nonempty) for isCiEnvironment()`,
      }
    }
    if (executed === 0) {
      return {
        ok: false,
        reason: `${spec} reported no executed case — an empty suite does not discharge the zero-skip invariant`,
      }
    }
    files.push({ file: spec, executed, skipped })
  }
  return { ok: true, files }
}

if (import.meta.main) {
  const reportPath = process.argv[2] ?? join(import.meta.dir, '..', REPORT_FILE)
  let xml: string
  try {
    xml = readFileSync(reportPath, 'utf8')
  } catch {
    console.error(`composition report: cannot read ${reportPath} — the dsh test step must emit JUnit (bun test --reporter=junit --reporter-outfile=${REPORT_FILE})`)
    process.exit(1)
  }
  const check = checkCompositionReport(xml)
  if (!check.ok) {
    console.error(`composition report: ${check.reason}`)
    process.exit(1)
  }
  console.log(`composition report ok: ${check.files.map((entry) => `${entry.file} executed=${entry.executed} skipped=${entry.skipped}`).join(', ')}`)
}
