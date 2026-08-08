/**
 * Engine audit module — audit Status-block validation, secret redaction, and
 * audit-<date>/ plan scaffolding.
 *
 * Spec sources (all embedded as constants — no runtime skill-file reads):
 * - mstar-audit SKILL.md Hard Rules (read-only; never reproduce secret
 *   values — reference file:line + credential type only), Phase 4 output
 *   layout (`{PLAN_DIR}/audit-<YYYY-MM-DD>/` README index + numbered plan
 *   files; reconcile prior dirs, keep numbering monotonic), Status block
 *   fields, and index format.
 * - mstar-audit/references/finding-format.md: category codes, evidence
 *   requirements.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GateResult, ValidationResult } from "./core.js";

function violation(severity: ValidationResult["severity"], code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

// ---------------------------------------------------------------------------
// Status block validation — mstar-audit SKILL § Plan files
// ---------------------------------------------------------------------------

/** Priority values (mstar-audit SKILL § Plan files Status block). */
export const AUDIT_PRIORITIES = ["P1", "P2", "P3"] as const;
export type AuditPriority = (typeof AUDIT_PRIORITIES)[number];

/** Effort values (Morning Star agent-oriented effort scale). */
export const AUDIT_EFFORTS = ["XS", "S", "M", "L", "XL"] as const;
export type AuditEffort = (typeof AUDIT_EFFORTS)[number];

/** Risk values. */
export const AUDIT_RISKS = ["LOW", "MED", "HIGH"] as const;
export type AuditRisk = (typeof AUDIT_RISKS)[number];

/** Category codes (finding-format.md § Category codes + SKILL Status block). */
export const AUDIT_CATEGORIES = [
  "bug",
  "security",
  "perf",
  "tests",
  "tech-debt",
  "migration",
  "dx",
  "docs",
  "direction",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** Required Status block fields for an audit plan file. */
const AUDIT_STATUS_FIELDS = ["Priority", "Effort", "Risk", "Depends on", "Category", "Planned at"] as const;

/** One `## Status` block with its parsed `- **Field**: value` entries. */
type StatusBlock = { fields: Map<string, string> };

/** Parse every `## Status` block in a plan document. A block ends at the
 * next `#` heading of any level. Shared with `scaffoldAuditPlan` for
 * rebuilding the index from existing plan files. */
function parseStatusBlocks(planText: string): StatusBlock[] {
  const blocks: StatusBlock[] = [];
  let current: Map<string, string> | null = null;
  for (const line of planText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "## Status") {
      current = new Map<string, string>();
      blocks.push({ fields: current });
      continue;
    }
    if (current === null) continue;
    if (trimmed.startsWith("#")) {
      current = null;
      continue;
    }
    const match = /^-\s*\*\*([^*]+)\*\*:\s*(.*)$/.exec(trimmed);
    if (match !== null) current.set(match[1].trim(), match[2].trim());
  }
  return blocks;
}

/**
 * Validate the audit Status block(s) of a plan file against the field
 * contract (mstar-audit SKILL § Plan files):
 * - `Priority`: P1 | P2 | P3
 * - `Effort`: XS | S | M | L | XL
 * - `Risk`: LOW | MED | HIGH
 * - `Depends on`: `none` or `plans/NNN-*.md`
 * - `Category`: bug | security | perf | tests | tech-debt | migration |
 *   dx | docs | direction
 * - `Planned at`: `commit <short SHA>, <YYYY-MM-DD>`
 *
 * Every `## Status` block in the document is checked; a document without
 * any block gets `audit.status.missing-block`. Violation codes:
 * `audit.status.missing-block`, `audit.status.missing-field`,
 * `audit.status.invalid-priority|effort|risk|depends-on|category|planned-at`.
 */
export function validateAuditStatusBlocks(planText: string): GateResult {
  const violations: ValidationResult[] = [];
  const blocks = parseStatusBlocks(planText);
  if (blocks.length === 0) {
    violations.push(
      violation(
        "medium",
        "audit.status.missing-block",
        "no `## Status` block found — audit plan files carry the Status block fields (mstar-audit SKILL § Plan files)",
        "add a `## Status` block with Priority, Effort, Risk, Depends on, Category, Planned at",
      ),
    );
    return { ok: false, violations };
  }

  blocks.forEach((block, index) => {
    const label = blocks.length > 1 ? ` #${index + 1}` : "";
    for (const field of AUDIT_STATUS_FIELDS) {
      if (!block.fields.has(field)) {
        violations.push(
          violation(
            "medium",
            "audit.status.missing-field",
            `Status block${label} missing required field "${field}" (mstar-audit SKILL § Plan files)`,
            `add \`- **${field}**: <value>\` to the Status block`,
          ),
        );
      }
    }
    const check = (field: string, pattern: RegExp, code: string, expected: string) => {
      const value = block.fields.get(field);
      if (value === undefined) return;
      if (!pattern.test(value)) {
        violations.push(
          violation(
            "medium",
            code,
            `Status block${label} "${field}" = "${value}" — expected ${expected} (mstar-audit SKILL § Plan files)`,
            `fix \`- **${field}**:\` to one of: ${expected}`,
          ),
        );
      }
    };
    check("Priority", /^P[123]$/, "audit.status.invalid-priority", "P1 | P2 | P3");
    check("Effort", /^(?:XS|S|M|L|XL)$/, "audit.status.invalid-effort", "XS | S | M | L | XL");
    check("Risk", /^(?:LOW|MED|HIGH)$/, "audit.status.invalid-risk", "LOW | MED | HIGH");
    check("Category", /^(?:bug|security|perf|tests|tech-debt|migration|dx|docs|direction)$/, "audit.status.invalid-category", "bug | security | perf | tests | tech-debt | migration | dx | docs | direction");
    check("Depends on", /^(?:none|plans\/\d{3}-[\w.-]+\.md)$/i, "audit.status.invalid-depends-on", "none or plans/NNN-*.md");
    check("Planned at", /^commit `?[0-9a-f]{7,40}`?, \d{4}-\d{2}-\d{2}$/, "audit.status.invalid-planned-at", "commit <short SHA>, <YYYY-MM-DD>");
  });

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Secret redaction — mstar-audit Hard Rule 4
// ---------------------------------------------------------------------------

/** A redacted credential occurrence: 1-based line + credential type. */
export type SecretFinding = { line: number; type: string };

/** Result of `redactSecrets`: redacted text + the findings summary. */
export type RedactResult = { text: string; findings: SecretFinding[] };

/**
 * Whole-match credential patterns — the match is fully replaced. Patterns
 * are deliberately conservative (prefixed signatures + minimum lengths) to
 * avoid false positives (mstar-audit Hard Rule 4: reference file:line and
 * credential type only, never the value).
 */
const WHOLE_MATCH_PATTERNS: readonly { type: string; re: RegExp }[] = [
  { type: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { type: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: "api-secret-key", re: /\bsk-[A-Za-z0-9-]{20,}\b/g },
];

/**
 * Key-value assignment patterns — the key name is preserved and only the
 * value is replaced. Value minimum lengths (8 quoted / 16 unquoted) keep the
 * scan conservative (`token: x` and `password: 1234` are not flagged).
 */
const VALUE_PATTERNS: readonly { typeOf: (key: string) => string; re: RegExp }[] = [
  {
    typeOf: (key) =>
      key
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[_-]+/g, "-"),
    re: /\b(password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|secret|token)\b(\s*[:=]\s*)("[^"\n]{8,}"|'[^'\n]{8,}'|[A-Za-z0-9_./+\-=]{16,})/gi,
  },
];

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Scan text for credential patterns and replace every occurrence with a
 * `[REDACTED <type>@<line> in <file>]` marker (file omitted when `filePath`
 * is not provided), per mstar-audit Hard Rule 4. Newlines are preserved so
 * line numbers stay stable. Returns the redacted text plus a deduplicated,
 * line-sorted findings summary (`{ line, type }`).
 */
export function redactSecrets(text: string, filePath?: string): RedactResult {
  const marker = (type: string, index: number) =>
    `[REDACTED ${type}@${lineAt(text, index)}${filePath === undefined ? "" : ` in ${filePath}`}]`;
  const replacements: { index: number; length: number; text: string }[] = [];
  const findings: SecretFinding[] = [];

  for (const pattern of WHOLE_MATCH_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index === undefined) continue;
      replacements.push({ index: match.index, length: match[0].length, text: marker(pattern.type, match.index) });
      findings.push({ line: lineAt(text, match.index), type: pattern.type });
    }
  }
  for (const pattern of VALUE_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index === undefined) continue;
      const type = pattern.typeOf(match[1]);
      const replacement = `${match[1]}${match[2]}${marker(type, match.index)}`;
      replacements.push({ index: match.index, length: match[0].length, text: replacement });
      findings.push({ line: lineAt(text, match.index), type });
    }
  }

  // Apply from the end so earlier indices stay valid.
  replacements.sort((a, b) => b.index - a.index);
  let out = text;
  for (const r of replacements) out = out.slice(0, r.index) + r.text + out.slice(r.index + r.length);

  const deduped = new Map<string, SecretFinding>();
  for (const f of findings) deduped.set(`${f.line}:${f.type}`, f);
  const sorted = [...deduped.values()].sort((a, b) => a.line - b.line || a.type.localeCompare(b.type));

  return { text: out, findings: sorted };
}

// ---------------------------------------------------------------------------
// Plan scaffolding — mstar-audit SKILL § Phase 4 (audit-<date>/ layout)
// ---------------------------------------------------------------------------

/** One audit finding, shaped after finding-format.md. */
export type AuditFinding = {
  title: string;
  category: AuditCategory;
  impact: string;
  effort: AuditEffort;
  risk: AuditRisk;
  confidence: "HIGH" | "MED" | "LOW";
  evidence: readonly string[];
  priority: AuditPriority;
  fixSketch?: string;
  verification?: string;
  dependsOn?: string;
};

/** Options for `scaffoldAuditPlan`. `plannedAt` defaults to the
 * `repoShortSha` + `date`; `date` defaults to today (YYYY-MM-DD). */
export type ScaffoldAuditPlanOptions = {
  date?: string;
  repoName?: string;
  repoShortSha?: string;
  plannedAt?: { commit: string; date: string };
  rejected?: readonly { title: string; reason: string }[];
};

/** Result of `scaffoldAuditPlan`. `nextNumber` is the next free plan number
 * (monotonic continuation vs. any pre-existing `NNN-*.md` files). */
export type ScaffoldAuditPlanResult = {
  outDir: string;
  date: string;
  files: string[];
  nextNumber: number;
};

/** Lowercase-hyphen slug from a finding title (`Fix N+1 query` →
 * `fix-n-1-query`). */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const escapeCell = (value: string) => value.replace(/\|/g, "\\|");
const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value);

/** Render one numbered plan file from a finding (self-contained; no
 * placeholder tokens, per plan-quality-bar). */
function renderPlanFile(finding: AuditFinding, plannedAt: { commit: string; date: string }): string {
  const sections = [
    `# ${finding.title}`,
    "",
    "## Status",
    `- **Priority**: ${finding.priority}`,
    `- **Effort**: ${finding.effort}`,
    `- **Risk**: ${finding.risk}`,
    `- **Depends on**: ${finding.dependsOn ?? "none"}`,
    `- **Category**: ${finding.category}`,
    `- **Planned at**: commit \`${plannedAt.commit}\`, ${plannedAt.date}`,
    "",
    "## Impact",
    finding.impact,
    "",
    "## Evidence",
    ...finding.evidence.map((e) => `- ${e}`),
  ];
  if (finding.fixSketch !== undefined) {
    sections.push("", "## Fix sketch", finding.fixSketch);
  }
  if (finding.verification !== undefined) {
    sections.push("", "## Verification", finding.verification);
  }
  return `${sections.join("\n")}\n`;
}

/** Title + Status fields of an existing plan file, for index rebuilding. */
function readPlanFileSummary(filePath: string): { title: string; fields: Map<string, string> } {
  const text = readFileSync(filePath, "utf8");
  const title = (text.match(/^# (.+)$/m) ?? [])[1] ?? filePath;
  const blocks = parseStatusBlocks(text);
  return { title: title.trim(), fields: blocks.length > 0 ? blocks[0].fields : new Map() };
}

/** Render the audit-<date>/README.md index (mstar-audit SKILL § Output
 * format). `rows` covers every plan file in the directory (existing + new).
 * Status values: TODO | IN PROGRESS | DONE | BLOCKED | REJECTED. */
function renderIndex(params: {
  date: string;
  repoName: string;
  repoShortSha: string;
  rows: { num: string; title: string; category: string; impact: string; effort: string; risk: string; confidence: string; evidence: string; priority: string; dependsOn: string }[];
  rejected: readonly { title: string; reason: string }[];
}): string {
  const { date, repoName, repoShortSha, rows, rejected } = params;
  const findingsRows = rows
    .map(
      (r) =>
        `| ${r.num} | ${escapeCell(r.title)} | ${r.category} | ${escapeCell(truncate(r.impact, 80))} | ${r.effort} | ${r.risk} | ${r.confidence} | ${escapeCell(truncate(r.evidence, 80))} |`,
    )
    .join("\n");
  const directionRows = rows
    .filter((r) => r.category === "direction")
    .map((r) => `- ${escapeCell(r.title)} — ${escapeCell(truncate(r.impact, 120))}`)
    .join("\n");
  const executionRows = rows
    .map((r) => `| ${r.num} | ${escapeCell(r.title)} | ${r.priority} | ${r.effort} | ${r.dependsOn} | TODO |`)
    .join("\n");
  const rejectedRows = rejected.map((r) => `- ${escapeCell(r.title)}: ${escapeCell(r.reason)}`).join("\n");

  const sections = [
    `# Audit Report — ${repoName} @ ${repoShortSha} (${date})`,
    "",
    "## Findings",
    "",
    "| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence |",
    "|---|---------|----------|--------|--------|------|------------|----------|",
    findingsRows,
  ];
  if (directionRows !== "") {
    sections.push("", "## Direction", "", directionRows);
  }
  sections.push(
    "",
    "## Execution order & status",
    "",
    "| Plan | Title | Priority | Effort | Depends on | Status |",
    "|------|-------|----------|--------|------------|--------|",
    executionRows,
  );
  if (rejectedRows !== "") {
    sections.push("", "## Findings considered and rejected", "", rejectedRows);
  }
  return `${sections.join("\n")}\n`;
}

/**
 * Scaffold an audit plan directory (`{PLAN_DIR}/audit-<date>/` layout,
 * mstar-audit SKILL § Phase 4): numbered `NNN-<slug>.md` plan files from
 * findings plus a README.md index. Numbering is monotonic — when the
 * directory already contains `NNN-*.md` files (same-date re-run), the new
 * batch continues after the highest existing number instead of restarting
 * at 001, and the rebuilt index includes the pre-existing plans. Rejected
 * findings render in the "considered and rejected" section.
 */
export function scaffoldAuditPlan(
  outDir: string,
  findings: readonly AuditFinding[],
  options: ScaffoldAuditPlanOptions = {},
): ScaffoldAuditPlanResult {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const plannedAt = options.plannedAt ?? { commit: options.repoShortSha ?? "unknown", date };
  mkdirSync(outDir, { recursive: true });

  const existing = readdirSync(outDir).filter((f) => /^\d{3}-.*\.md$/.test(f));
  let next = existing.reduce((max, f) => Math.max(max, Number(f.slice(0, 3))), 0) + 1;

  const written: string[] = [];
  for (const finding of findings) {
    const num = String(next).padStart(3, "0");
    const file = `${num}-${slugify(finding.title)}.md`;
    writeFileSync(join(outDir, file), renderPlanFile(finding, plannedAt));
    written.push(file);
    next++;
  }

  const all = [...existing, ...written].sort();
  const rows = all.map((file) => {
    const summary = readPlanFileSummary(join(outDir, file));
    const fields = summary.fields;
    return {
      num: file.slice(0, 3),
      title: summary.title,
      category: fields.get("Category") ?? "—",
      impact: "see plan file",
      effort: fields.get("Effort") ?? "—",
      risk: fields.get("Risk") ?? "—",
      confidence: "—",
      evidence: fields.get("Evidence") ?? "—",
      priority: fields.get("Priority") ?? "—",
      dependsOn: fields.get("Depends on") ?? "—",
    };
  });

  // New findings carry full detail; existing rows keep their parsed fields.
  const byNum = new Map(rows.map((r) => [r.num, r]));
  written.forEach((file, i) => {
    const finding = findings[i];
    if (finding === undefined) return;
    const row = byNum.get(file.slice(0, 3));
    if (row !== undefined) {
      row.category = finding.category;
      row.impact = finding.impact;
      row.effort = finding.effort;
      row.risk = finding.risk;
      row.confidence = finding.confidence;
      row.evidence = finding.evidence[0] ?? "";
      row.priority = finding.priority;
      row.dependsOn = finding.dependsOn ?? "none";
    }
  });

  writeFileSync(
    join(outDir, "README.md"),
    renderIndex({
      date,
      repoName: options.repoName ?? "repo",
      repoShortSha: options.repoShortSha ?? "unknown",
      rows,
      rejected: options.rejected ?? [],
    }),
  );

  return { outDir: resolve(outDir), date, files: written, nextNumber: next };
}
