const a = args ?? {}
const missing = ['repo', 'auditRef', 'recon']
  .filter((key) => typeof a[key] !== 'string' || a[key].length === 0)
if (missing.length > 0) throw new Error('mstar-audit-fanout missing args: ' + missing.join(', '))

const ALL = ['bug', 'security', 'perf', 'tests', 'tech-debt', 'migration', 'dx', 'docs', 'direction']
const categories = Array.isArray(a.categories) && a.categories.length > 0 ? a.categories : ALL

// Child seats resolve through the host subagent pool, capped at maxActiveSubagents
// (default 8; an over-cap activation is hard-rejected as a fatal AGENT_START that kills
// the whole run). The workflow tool's own concurrency — min(16, cores - 2) — is an
// independent cap and exceeds 8 on hosts with > 10 logical CPUs, so a single
// parallel() over all nine categories would exceed the pool there. Launching
// CHUNK seats per sequential batch keeps in-flight children <= 8 on any host.
const CHUNK = Math.min(8, categories.length)
const chunks = Array.from(
  { length: Math.ceil(categories.length / CHUNK) },
  (_, index) => categories.slice(index * CHUNK, (index + 1) * CHUNK))

const FINDING = {
  type: 'object',
  description: 'One audit category seat payload.',
  required: ['category', 'findings'],
  properties: {
    category: { type: 'string', enum: ALL },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence', 'impact', 'effort', 'risk', 'confidence', 'fix'],
        properties: {
          title: { type: 'string', description: 'Short imperative title.' },
          evidence: { type: 'string', description: 'path/file.ts:123 plus one sentence (2-5 strongest locations).' },
          impact: { type: 'string', description: 'What goes wrong / what is being paid.' },
          effort: { type: 'string', enum: ['XS', 'S', 'M', 'L', 'XL'] },
          risk: { type: 'string', enum: ['LOW', 'MED', 'HIGH'], description: 'What the fix could break, plus one line why.' },
          confidence: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
          fix: { type: 'string', description: 'One to three sentences — a sketch, not the review report.' },
        },
      },
    },
    notes: { type: 'string', description: 'Truncated coverage declaration and leads that are not findings.' },
  },
}

const seatPrompt = (category) => `## Assignment

Execute as: code-reviewer
Delegation: forbidden
Task category: audit
**Budget (review / QC seats)**: /1 round — one pass over the assigned categories
**Return shape (review / QC seats)**: the seat findings in the audit format; stop when the assigned categories or the budget bound are reached

Audit category: ${category}
Repo under audit: ${a.repo}
Reference root: ${a.auditRef}

Read-only audit seat (one category of a parallel fan-out; the audit executor reconciles, vets and writes the review report — you do not).

Recon facts already established: ${a.recon}

Load in order: ${a.auditRef}/audit-playbook.md section for your category plus the section "Finding format" (read it first — findings must match that shape exactly); for the security category also read ${a.auditRef}/security-review.md. Open every location you cite yourself, in ${a.repo}.

Report only what you can evidence: exact file:line anchors, a concrete impact, an honest effort on the XS-XL scale, the risk of the fix, and a HIGH/MED/LOW confidence. LOW-confidence items are allowed but are leads, not report findings. Do not edit any file, do not run project-wide suites, never reproduce secret values.

Return ONLY the JSON object matching the provided schema (category, findings, notes). Put the truncated-coverage declaration and any non-finding leads in notes.`

const seats = []
for (const chunk of chunks) {
  const chunkSeats = await parallel(chunk.map((category) => () =>
    agent(seatPrompt(category), { label: category, phase: category, schema: FINDING })))
  seats.push(...chunkSeats)
}

// A null entry is a category whose seat failed — the caller reports the uncollected
// category as such; it is never reported as "no findings".
return seats
