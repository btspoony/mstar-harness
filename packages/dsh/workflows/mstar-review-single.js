const a = args ?? {}
const missing = ['planId', 'taskId', 'reviewCwd', 'branch', 'briefPath', 'implementerReport',
  'diffFile', 'diffBase', 'diffHead', 'globalConstraints']
  .filter((key) => typeof a[key] !== 'string' || a[key].length === 0)
if (missing.length > 0) {
  throw new Error('mstar-review-single missing args: ' + missing.join(', ') +
    ' — Mode A needs the task brief, the implementer report, the diff artifact and the Global Constraints')
}

const REPORT = {
  type: 'object',
  description: 'One Mode A SDD task-review result: the canonical report sections plus its full markdown.',
  required: ['specCompliance', 'taskQuality', 'reportMarkdown'],
  properties: {
    specCompliance: {
      type: 'object',
      description: 'Spec compliance verdict for this task.',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['compliant', 'issues-found'], description: 'Compliant, or issues found (name them in issues).' },
        cannotVerify: {
          type: 'array',
          description: 'Items the diff cannot settle; the PM resolves them before completing the task.',
          items: { type: 'string' }
        }
      }
    },
    strengths: { type: 'array', description: 'What the implementation does well.', items: { type: 'string' } },
    issues: {
      type: 'array',
      description: 'Findings ordered Critical, Important, Minor. Empty when the task passes.',
      items: {
        type: 'object',
        required: ['severity', 'title', 'evidence', 'impact', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'], description: 'Mode A severity class.' },
          title: { type: 'string', description: 'Short imperative title.' },
          evidence: { type: 'string', description: 'path/file.ts:123 — evidence you opened yourself.' },
          impact: { type: 'string', description: 'Expected vs observed, and why it matters.' },
          fix: { type: 'string', description: 'The concrete correction.' }
        }
      }
    },
    truncatedCoverage: {
      type: 'string',
      description: 'ONLY when a budget bound stopped expansion: name the interfaces/files left unexamined. Omit entirely for a complete review.'
    },
    taskQuality: { type: 'string', enum: ['approved', 'needs-fixes'], description: 'The Mode A task-quality gate.' },
    reportMarkdown: {
      type: 'string',
      description: 'The COMPLETE canonical report in the Mode A layout: Scope (only when truncated), ### Spec Compliance, ### Strengths, ### Issues (#### Critical | Important | Minor), ### Assessment with **Task quality:**. The caller persists this to {SDD_DIR}/task-N-review.md.'
    }
  }
}

phase('task-review')

const seat = await agent(`## Assignment

Execute as: code-reviewer
Delegation: forbidden
Task category: review
**Budget (review / QC seats)**: /1 round — one pass over the task diff
**Return shape (review / QC seats)**: the canonical Mode A report (reportMarkdown) + taskQuality; stop when the task diff and its directly affected interfaces are covered

plan_id: ${a.planId}
Task: ${a.taskId}
Review cwd: ${a.reviewCwd}
Working branch: ${a.branch}
Task brief: ${a.briefPath}
Implementer report (input — never overwrite): ${a.implementerReport}
Diff: ${a.diffFile}
Base: ${a.diffBase}
Head: ${a.diffHead}

Global constraints (verbatim):
${a.globalConstraints}

You are the L2 SDD task reviewer for this ONE task — Mode A, the default. Do NOT run the codebase-audit workflow and do not produce audit-format findings.

Load in order: skill mstar-roles then references/code-reviewer.md (identity first, Mode A), then mstar-sdd references/task-reviewer-prompt.md.

Behavior: diff-first. Read the diff once — do not re-run git, do not mutate the checkout, do not run build or test suites. Spec compliance FIRST against the brief and the constraints above, then code quality. Treat the implementer report's claims as unverified until you check them against the diff. Focus: ${a.reviewerFocus || 'the task acceptance criteria and directly affected interfaces'}.

Verdict discipline: never pre-judge; a task that cannot be verified from the diff names the items you cannot check rather than guessing. If a budget bound stops expansion, record the truncation and keep the quality label earned for the scope you did review.

Return ONLY the JSON object matching the provided schema. reportMarkdown must be the COMPLETE canonical report so the caller can persist it; your own attempt to write a file is best-effort and never the contract.`, { phase: 'task-review', schema: REPORT, label: 'task-review-1' })

if (seat === null) {
  throw new Error('mstar-review-single: the review seat returned nothing — dispatch it again rather than recording an unreviewed task')
}

return { task: a.taskId, seat }
