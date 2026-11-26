const a = args ?? {}
const missing = ['planId', 'planPath', 'range', 'reviewCwd', 'branch', 'sddDir']
  .filter((key) => typeof a[key] !== 'string' || a[key].length === 0)
if (missing.length > 0) throw new Error('mstar-qc-tri missing args: ' + missing.join(', '))

const sddDir = a.sddDir.replace(/\/$/, '')

const VERDICT = {
  type: 'object',
  description: 'One QC seat verdict envelope.',
  required: ['seat', 'verdict', 'summary', 'findings'],
  properties: {
    seat: {
      type: 'string',
      enum: ['qc-specialist', 'qc-specialist-2', 'qc-specialist-3'],
      description: 'The seat that produced this envelope.',
    },
    verdict: {
      type: 'string',
      enum: ['Approve', 'Request Changes', 'Needs Discussion', 'Unconfirmed'],
    },
    summary: {
      type: 'string',
      description: 'Two or three sentences; state the critical/warning counts.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'title', 'verification', 'expectedVsObserved'],
        properties: {
          severity: { type: 'string', enum: ['Critical', 'Warning', 'Suggestion', 'Unconfirmed'] },
          title: { type: 'string', description: 'Short imperative title.' },
          location: { type: 'string', description: 'path/file.ts:123 evidence anchor.' },
          verification: { type: 'string', description: 'The cross-check used (diff/read/grep anchor or repro).' },
          expectedVsObserved: { type: 'string' },
          fix: { type: 'string', description: 'One line.' },
        },
      },
    },
  },
}

const opts = { phase: 'qc-tri', schema: VERDICT }

phase('qc-tri')

// Seat prompts carry the Assignment FRONT MATTER; the body is narrative only
// (a body `**Label**:` line would declare nothing and shape the document as
// the retired format, `dispatch.assignment.legacy-format`).
const seatPrompt = (seat, index, reportPath, focus, ordinal, lensNote) => `---
execute_as: ${seat}
delegation: forbidden
task_category: audit
budget: /1 round — one full pass over the review range
return_shape: the verdict envelope (seat, verdict, summary, findings); stop when the range and its directly affected interfaces are covered
plan_id: ${a.planId}
review_range: ${a.range}
review_cwd: ${a.reviewCwd}
working_branch: ${a.branch}
qc_report_path: ${reportPath}
plan_path: ${a.planPath}
---

## Assignment

You are the ${ordinal} of three INDEPENDENT read-only QC seats over the same review range. Do not consult or wait for the other seats.

Reviewer focus: ${focus} (reviewer_index ${index}).

Load in order: skill mstar-roles then references/qc-specialist-shared.md (identity first), then references/qc-specialist/report-template.md and references/qc-specialist/reviewer-checklist.md${lensNote === '' ? '' : ', and references/qc-specialist/deep-review-lenses.md'}; the plan at ${a.planPath}.

Review only changed hunks and directly affected interfaces in the review range above against that plan. Reuse unchanged task-review evidence; for re-review inspect only assigned findings and fix delta${lensNote === '' ? '' : ', with the ' + lensNote + ' lenses'}. Every finding needs a verification cross-check and an expected-vs-observed line; prefer omission to fabrication. Do not run build or test suites (they are not your evidence channel). Never edit the worktree, never post, never merge, never touch project registers.

Return ONLY the JSON object matching the provided schema (seat, verdict, summary, findings). If your sandbox permits, also write the full report to ${reportPath} — never depend on being able to write.`

const seats = await parallel([
  () => agent(seatPrompt('qc-specialist', 1, `${sddDir}/review/qc1.md`, 'architecture coherence and maintainability risk', 'first', ''), { ...opts, label: 'qc1-architecture' }),
  () => agent(seatPrompt('qc-specialist-2', 2, `${sddDir}/review/qc2.md`, 'security and correctness risk', 'second', 'security and correctness'), { ...opts, label: 'qc2-security-correctness' }),
  () => agent(seatPrompt('qc-specialist-3', 3, `${sddDir}/review/qc3.md`, 'performance and reliability risk', 'third', 'performance and reliability'), { ...opts, label: 'qc3-perf-reliability' }),
])

// A null entry is a seat whose child failed: its verdict is missing and the caller
// must re-dispatch that seat (or report Blocked) — never synthesize a verdict for it.
return seats
