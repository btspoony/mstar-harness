/**
 * Scoped JUnit gate for the ten real-composition cases.
 *
 * Those cases are `test.if(isCiEnvironment())`: locally they report as skips by
 * design, in CI they must EXECUTE. A plain green `bun test` cannot tell the two
 * apart — a reverted CI predicate, or a spec silently dropped from the run, both
 * leave the job green. This check reads the JUnit report the same step emitted
 * and requires, for the two gated spec files only: the file is present, no
 * GATED case was skipped, and at least the pinned number of gated cases
 * executed. Gated cases are the ones whose title ends with the recorded skip
 * reason; the rest of a gated spec file is ordinary and cannot stand in for a
 * deleted gated case. Skips in other files (optional installs and the like)
 * stay permitted.
 *
 * Usage: `bun run --cwd packages/dsh check:composition-report [report.xml]`
 * (the default report path is this package's `.junit-dsh.xml`).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_SKILL_MOUNT_SKIP_REASON } from '../tests/skip-reasons.ts'

/**
 * The gated spec files (relative to this package root) and how many gated cases
 * each must execute. Adding or removing a `test.if(isCiEnvironment())` case means
 * editing this list in the same change — that is the only place the inventory
 * lives, so a dropped case cannot leave the gate green.
 */
export const GATED_SPECS = [
  { file: 'tests/e2e-session.spec.ts', expectedExecuted: 2 },
  { file: 'tests/skills-mount.spec.ts', expectedExecuted: 8 },
] as const

/**
 * How a gated case is recognized in a report: every gated case in both specs
 * carries the recorded skip reason in its title, and Bun copies the title into
 * the JUnit `name` attribute verbatim. The reason itself is owned by
 * `tests/skip-reasons.ts`, so a wording change there needs no second edit here.
 */
const GATED_CASE_MARKER = `(${LOCAL_SKILL_MOUNT_SKIP_REASON})`

/** The JUnit report the `test-dsh` CI step writes (`--reporter-outfile`). */
export const REPORT_FILE = '.junit-dsh.xml'

/** Gated-case counts for one gated spec file — ordinary cases in it are ignored. */
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
const NAME_ATTR = /name="([^"]*)"/

function fileOf(attrs: string): string | undefined {
  return FILE_ATTR.exec(attrs)?.[1]
}

/** Report paths follow the invocation's cwd, so a spec matches by full relative path. */
function names(reported: string, spec: string): boolean {
  return reported === spec || reported.endsWith(`/${spec}`)
}

export function checkCompositionReport(xml: string): CompositionReportCheck {
  const cases: Array<{ file: string; gated: boolean; skipped: boolean }> = []
  for (const match of xml.matchAll(TESTCASE)) {
    const attrs = match[1] ?? ''
    const file = fileOf(attrs)
    if (file === undefined) continue
    const name = NAME_ATTR.exec(attrs)?.[1] ?? ''
    cases.push({ file, gated: name.endsWith(GATED_CASE_MARKER), skipped: (match[2] ?? '').includes('<skipped') })
  }
  const suites = [...xml.matchAll(TESTSUITE)]
    .map((match) => fileOf(match[1] ?? ''))
    .filter((file): file is string => file !== undefined)

  const files: GatedFileReport[] = []
  for (const { file: spec, expectedExecuted } of GATED_SPECS) {
    const own = cases.filter((entry) => names(entry.file, spec))
    const gated = own.filter((entry) => entry.gated)
    const skipped = gated.filter((entry) => entry.skipped).length
    const executed = gated.length - skipped
    if (own.length === 0 && !suites.some((file) => names(file, spec))) {
      return {
        ok: false,
        reason: `${spec} is absent from the report — run it in the same bun test invocation as the rest of the suite, not in a second step`,
      }
    }
    if (skipped > 0) {
      return {
        ok: false,
        reason: `${spec} reported ${skipped} skipped gated case(s) — these gated cases must execute, so a CI run has to set CI or GITHUB_ACTIONS (nonempty) for isCiEnvironment()`,
      }
    }
    if (executed === 0) {
      return {
        ok: false,
        reason: `${spec} reported no executed gated case — no case titled with the recorded skip reason ran (deleted, renamed, or an empty suite); restore it, or update the inventory in scripts/check-composition-report.ts if that removal is deliberate`,
      }
    }
    if (executed < expectedExecuted) {
      return {
        ok: false,
        reason: `${spec} executed ${executed} gated case(s), expected at least ${expectedExecuted} — a gated case was deleted or dropped from the run; update the inventory in scripts/check-composition-report.ts if that removal is deliberate`,
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
