const a = args ?? {}
const missing = ['worktree', 'target', 'diffBase', 'auditRef', 'budgetLine']
  .filter((key) => typeof a[key] !== 'string' || a[key].length === 0)
if (missing.length > 0) {
  throw new Error('mstar-pr-seats missing args: ' + missing.join(', ') +
    ' — budgetLine is the seat budget head (tier + shared soft wall-clock cap + minutes left of it): take it from `mstar pr-review budget` and the review clock (mstar-audit references/pr-review.md § Seat supervision)')
}

const domains = Array.isArray(a.domains) ? a.domains : []
if (domains.length < 2 || domains.length > 3) {
  throw new Error('mstar-pr-seats: args.domains must hold 2-3 domain labels (deep tier) — got ' + domains.length)
}
const withSecurity = a.security !== false
const diffHint = typeof a.diffFile === 'string' && a.diffFile.length > 0
  ? 'the pinned diff snapshot at ' + a.diffFile + ', plus ' + a.diffBase + ' in ' + a.worktree
  : a.diffBase + ' in ' + a.worktree
const budgetLine = '\nBudget: ' + a.budgetLine

const SEAT = {
  type: 'object',
  description: 'One read-only PR review seat payload (findings only — the seat produces no verdict).',
  required: ['domain', 'findings'],
  properties: {
    domain: { type: 'string', description: 'The seat domain label.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence', 'impact', 'effort', 'risk', 'confidence', 'mergeClass', 'fix'],
        properties: {
          title: { type: 'string', description: 'Short imperative title.' },
          evidence: { type: 'string', description: 'path/file.ts:123 — code you opened yourself.' },
          impact: { type: 'string' },
          effort: { type: 'string', enum: ['XS', 'S', 'M', 'L', 'XL'] },
          risk: { type: 'string', enum: ['LOW', 'MED', 'HIGH'] },
          confidence: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
          mergeClass: { type: 'string', enum: ['must-fix', 'should-fix', 'may-fix', 'nit'] },
          fix: { type: 'string', description: 'One line.' },
        },
      },
    },
    leads: { type: 'array', items: { type: 'string' }, description: 'MEDIUM observations — leads, not findings.' },
    notes: { type: 'string', description: 'Truncated-coverage declaration and cross-domain notes.' },
  },
}

const seatPrompt = (domain, extra) => `## Assignment

Execute as: code-reviewer
Delegation: forbidden
Task category: audit
**Budget (review / QC seats)**: /1 round — one pass over the diff
**Return shape (review / QC seats)**: the seat findings in the audit format; stop when the diff or the budget bound is reached

Review target: ${a.target}
Review worktree: ${a.worktree}
Domain: ${domain}
Diff basis: ${a.diffBase}${budgetLine}
Stage: Stage 2 domain review — read-only, you never post and never produce the verdict.

Read-only audit seat in the three-stage PR review pipeline; the main agent synthesizes one verdict and posts.

Load in order: skill mstar-audit then SKILL.md and references/pr-review-seat-evidence.md; ${a.auditRef}/pr-review.md sections "Review pipeline", "Merge class" and "Verdict synthesis"; ${a.auditRef}/finding-format.md for the finding fields. Then read ${diffHint}. Open the cited code yourself — a relayed claim from another seat is not evidence.

Conclude ONLY on your own domain (${domain}).${extra} Return findings with merge class must-fix | should-fix | may-fix | nit, an XS-XL effort, a risk level, a confidence and a one-line fix sketch. Cross-domain boundary issues go to notes, not findings. Do not edit the worktree, do not run project-wide suites, never reproduce secret values.

Return ONLY the JSON object matching the provided schema (domain, findings, leads, notes). No verdict.`

phase('pr-seats')

const thunks = domains.map((domain, index) => () => agent(
  seatPrompt(domain, ''),
  { label: 'domain-' + (index + 1), phase: 'pr-seats', schema: SEAT },
))

if (withSecurity) {
  thunks.push(() => agent(
    seatPrompt('security (cross-domain)', ' Run the security lens from ' + a.auditRef + '/security-review.md across the whole diff, independent of the domain seats: trace data flow to its origin, never invent an attacker, never record secret values.'),
    { label: 'security-cross-domain', phase: 'pr-seats', schema: SEAT },
  ))
}

const seats = await parallel(thunks)

// A null entry is an uncollected domain (seat crashed or returned nothing) — the caller
// declares it as uncollected under the report notes and never reads it as "no findings".
return seats
