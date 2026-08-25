/**
 * Engine audit module — audit Status-block validation, secret redaction, and
 * audit-<date>/ plan scaffolding.
 *
 * Spec sources (all embedded as constants — no runtime skill-file reads):
 * - mstar-audit SKILL.md Hard Rules (read-only; never reproduce secret
 *   values — reference file:line + credential type only).
 * - mstar-audit SKILL.md § Plan output (all variants): plan-file output
 *   layout (`{PLAN_DIR}/audit-<YYYY-MM-DD>/` README index + numbered plan
 *   files) and Status block fields. The full-audit variant adds the
 *   reconcile rule (keep numbering monotonic across re-runs) and the audit
 *   index format → mstar-audit references/codebase-audit.md (Phase 4 /
 *   Output format).
 * - mstar-audit/references/finding-format.md: category codes, evidence
 *   requirements.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { GateResult, ValidationResult } from "./core.js";
import { writeJson } from "./core.js";
import { withStatusWriteLock } from "./lease.js";
import { assertSafePathComponent } from "./path.js";
import { registerWorkflowEntryLocked, validateWorkflowEntry, type PlanRow, type WorkflowEntry } from "./status.js";
import { WORKFLOW_SNAPSHOT_FILE, type WorkflowSnapshot } from "./workflow.js";

function violation(severity: ValidationResult["severity"], code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

// ---------------------------------------------------------------------------
// Status block validation — mstar-audit SKILL.md § Plan output (all variants) Status block
// ---------------------------------------------------------------------------

/** Priority values (mstar-audit SKILL.md § Plan output (all variants) Status block). */
export const AUDIT_PRIORITIES = ["P1", "P2", "P3"] as const;
export type AuditPriority = (typeof AUDIT_PRIORITIES)[number];

/** Effort values (Morning Star agent-oriented effort scale). */
export const AUDIT_EFFORTS = ["XS", "S", "M", "L", "XL"] as const;
export type AuditEffort = (typeof AUDIT_EFFORTS)[number];

/** Risk values. */
export const AUDIT_RISKS = ["LOW", "MED", "HIGH"] as const;
export type AuditRisk = (typeof AUDIT_RISKS)[number];

/** Category codes (finding-format.md § Category codes + mstar-audit SKILL.md § Plan output (all variants) Status block). */
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
 * contract (mstar-audit SKILL.md § Plan output (all variants) Status block):
 * - `Priority`: P1 | P2 | P3
 * - `Effort`: XS | S | M | L | XL
 * - `Risk`: LOW | MED | HIGH
 * - `Depends on`: `none` or `plans/NNN-*.md` (the `*` is a literal
 *   wildcard form — the documented scaffolded scheme; concrete
 *   `plans/NNN-<slug>.md` paths are accepted too)
 * - `Category`: bug | security | perf | tests | tech-debt | migration |
 *   dx | docs | direction
 * - `Planned at`: `commit <short SHA>, <YYYY-MM-DD>` — `commit unknown`
 *   is accepted as the documented fallback (`scaffoldAuditPlan` default
 *   when the CLI runs outside a git repo)
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
        "no `## Status` block found \u2014 audit plan files carry the Status block fields (mstar-audit SKILL.md \u00a7 Plan output)",
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
            `Status block${label} missing required field "${field}" (mstar-audit SKILL.md \u00a7 Plan output)`,
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
            `Status block${label} "${field}" = "${value}" \u2014 expected ${expected} (mstar-audit SKILL.md \u00a7 Plan output)`,
            `fix \`- **${field}**:\` to one of: ${expected}`,
          ),
        );
      }
    };
    check("Priority", /^P[123]$/, "audit.status.invalid-priority", "P1 | P2 | P3");
    check("Effort", /^(?:XS|S|M|L|XL)$/, "audit.status.invalid-effort", "XS | S | M | L | XL");
    check("Risk", /^(?:LOW|MED|HIGH)$/, "audit.status.invalid-risk", "LOW | MED | HIGH");
    check("Category", /^(?:bug|security|perf|tests|tech-debt|migration|dx|docs|direction)$/, "audit.status.invalid-category", "bug | security | perf | tests | tech-debt | migration | dx | docs | direction");
    check("Depends on", /^(?:none|plans\/\d{3}-[\w.*-]+\.md)$/i, "audit.status.invalid-depends-on", "none or plans/NNN-*.md");
    check("Planned at", /^commit \`?(?:[0-9a-f]{7,40}|unknown)\`?, \d{4}-\d{2}-\d{2}$/, "audit.status.invalid-planned-at", "commit <short SHA>, <YYYY-MM-DD> (or `commit unknown` outside a git repo)");
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
  // Segments are capped ({10,1024}) so a dot-less run of eyJ-prefixed text
  // cannot backtrack quadratically — per-start work is bounded, keeping the
  // whole scan linear. 1024 chars covers ES/RS-family signatures (RS256
  // ~342 chars); only oversized exotic JWTs fall outside.
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,1024}\b/g },
  { type: "api-secret-key", re: /\bsk-[A-Za-z0-9-]{20,}\b/g },
];

/**
 * Key-value assignment patterns — the key name is preserved and only the
 * value is replaced. Value minimum lengths (8 quoted / 16 unquoted) keep the
 * scan conservative (`token: x` and `password: 1234` are not flagged).
 * Keys may carry optional quotes (JSON/YAML `"password": "..."`), which are
 * preserved in the replacement: group 1 = optional open quote, group 3 =
 * optional close quote, group 4 = separator, group 5 = value (dropped).
 */
const VALUE_PATTERNS: readonly { typeOf: (key: string) => string; re: RegExp }[] = [
  {
    typeOf: (key) =>
      key
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[_-]+/g, "-"),
    re: /(["']?)\b(password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|secret|token)\b(["']?)(\s*[:=]\s*)("[^"\n]{8,}"|'[^'\n]{8,}'|[A-Za-z0-9_./+\-=]{16,})/gi,
  },
];

/**
 * Line-number lookup via precomputed line-start offsets: O(n) to build once,
 * O(log n) per query — `redactSecrets` calls it once per match, so the total
 * stays linear instead of O(matches × text length).
 */
function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Scan text for credential patterns and replace every occurrence with a
 * `[REDACTED <type>@<line> in <file>]` marker (file omitted when `filePath`
 * is not provided), per mstar-audit Hard Rule 4. Newlines are preserved so
 * line numbers stay stable. Returns the redacted text plus a deduplicated,
 * line-sorted findings summary (`{ line, type }`).
 */
export function redactSecrets(text: string, filePath?: string): RedactResult {
  // simplify: single linear scan — line starts are precomputed once (O(n))
  // and per-match lookups are O(log n); the JWT whole-match pattern bounds
  // its segments ({10,1024}) so per-position backtracking is constant.
  const starts = buildLineStarts(text);
  const marker = (type: string, index: number) =>
    `[REDACTED ${type}@${lineAt(starts, index)}${filePath === undefined ? "" : ` in ${filePath}`}]`;
  const replacements: { index: number; length: number; text: string }[] = [];
  const findings: SecretFinding[] = [];

  for (const pattern of WHOLE_MATCH_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index === undefined) continue;
      replacements.push({ index: match.index, length: match[0].length, text: marker(pattern.type, match.index) });
      findings.push({ line: lineAt(starts, match.index), type: pattern.type });
    }
  }
  for (const pattern of VALUE_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index === undefined) continue;
      const type = pattern.typeOf(match[2]);
      // match[1]/match[3] = optional key quotes, match[4] = separator —
      // all preserved; the value (match[5]) is dropped and replaced by the
      // marker.
      const replacement = `${match[1]}${match[2]}${match[3]}${match[4]}${marker(type, match.index)}`;
      replacements.push({ index: match.index, length: match[0].length, text: replacement });
      findings.push({ line: lineAt(starts, match.index), type });
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
// Plan scaffolding — mstar-audit SKILL.md § Plan output (audit-<date>/ layout)
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
  needsVerification?: readonly { lead: string; how: string; evidence?: string }[];
  hardeningChecked?: readonly { kind: "Hardening" | "Checked and clean"; text: string }[];
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
const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}\u2026` : value);

/** Render one numbered plan file from a finding (self-contained; no
 * placeholder tokens, per plan-quality-bar). The `## Evidence` section is
 * rendered only when the finding carries evidence — an empty evidence list
 * must not leave a dangling heading behind. */
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
  ];
  if (finding.evidence.length > 0) {
    sections.push("", "## Evidence", ...finding.evidence.map((e) => `- ${e}`));
  }
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

/** Security-disposition carry-over: re-runs rebuild README.md from scratch,
 * so "Needs verification" / "Hardening & checked notes" entries rendered by
 * a previous run (or added by hand) are lifted from the existing index
 * unless the caller supplies fresh ones. Entry lines start with `- `. */
function extractSecurityDispositionSections(text: string): { needsVerification: string[]; hardeningChecked: string[] } {
  const grab = (heading: string): string[] => {
    // No `m` flag: `$` must match only at end of string — with `m`, `$`
    // also matches at every line ending, so the lazy group would stop
    // after the FIRST entry line and silently drop the rest.
    // Tolerances for hand-edited indexes: case-insensitive heading,
    // flexible spacing inside the ATX heading, blank line(s) before the
    // body, and CRLF line endings.
    const match = text.match(
      new RegExp(`(?:^|\\r?\\n)##[ \\t]+${heading}[ \\t]*\\r?\\n(?:[ \\t]*\\r?\\n)?([\\s\\S]*?)(?=\\r?\\n## |$)`, "i"),
    );
    if (!match) return [];
    return match[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.startsWith("- "));
  };
  return { needsVerification: grab("Needs verification"), hardeningChecked: grab("Hardening & checked notes") };
}
/** Render the audit-<date>/README.md index (mstar-audit references/codebase-audit.md § Output
 * format · Audit index). `rows` covers every plan file in the directory (existing + new).
 * `needsVerification` / `hardeningChecked` carry the security-disposition entry
 * lines documented by `references/security-review.md`; empty arrays omit the section.
 * Status values: TODO | IN PROGRESS | DONE | BLOCKED | REJECTED. */
function renderIndex(params: {
  date: string;
  repoName: string;
  repoShortSha: string;
  rows: { num: string; title: string; category: string; impact: string; effort: string; risk: string; confidence: string; evidence: string; priority: string; dependsOn: string }[];
  rejected: readonly { title: string; reason: string }[];
  needsVerification: readonly string[];
  hardeningChecked: readonly string[];
}): string {
  const { date, repoName, repoShortSha, rows, rejected, needsVerification, hardeningChecked } = params;
  const findingsRows = rows
    .map(
      (r) =>
        `| ${r.num} | ${escapeCell(r.title)} | ${r.category} | ${escapeCell(truncate(r.impact, 80))} | ${r.effort} | ${r.risk} | ${r.confidence} | ${escapeCell(truncate(r.evidence, 80))} |`,
    )
    .join("\n");
  const directionRows = rows
    .filter((r) => r.category === "direction")
    .map((r) => `- ${escapeCell(r.title)} \u2014 ${escapeCell(truncate(r.impact, 120))}`)
    .join("\n");
  const executionRows = rows
    .map((r) => `| ${r.num} | ${escapeCell(r.title)} | ${r.priority} | ${r.effort} | ${r.dependsOn} | TODO |`)
    .join("\n");
  const rejectedRows = rejected.map((r) => `- ${escapeCell(r.title)}: ${escapeCell(r.reason)}`).join("\n");

  const sections = [
    `# Audit Report \u2014 ${repoName} @ ${repoShortSha} (${date})`,
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
  if (needsVerification.length > 0) {
    sections.push("", "## Needs verification", "", ...needsVerification);
  }
  if (hardeningChecked.length > 0) {
    sections.push("", "## Hardening & checked notes", "", ...hardeningChecked);
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
  sections.push(
    "",
    "## Red-team dispositions",
    "",
    "- <finding>: <survived / refuted / hallucination-dropped / uncovered-kept>, <one-line reason>",
  );
  return `${sections.join("\n")}\n`;
}

/**
 * Scaffold an audit plan directory (`{PLAN_DIR}/audit-<date>/` layout,
 * mstar-audit SKILL.md § Plan output (all variants)): numbered `NNN-<slug>.md` plan files from
 * findings plus a README.md index. Numbering is monotonic — when the
 * directory already contains `NNN-*.md` files (same-date re-run), the new
 * batch continues after the highest existing number instead of restarting
 * at 001, and the rebuilt index includes the pre-existing plans. Rejected
 * findings render in the "considered and rejected" section. Security
 * dispositions (`needsVerification` / `hardeningChecked`) render in their
 * documented index sections. Policy: a SUPPLIED option is the authoritative
 * current set and replaces the section (resolved leads can be removed,
 * revised entries updated); an OMITTED option carries the previous section
 * over from the existing README so hand-added entries survive the rebuild.
 */
export function scaffoldAuditPlan(
  outDir: string,
  findings: readonly AuditFinding[],
  options: ScaffoldAuditPlanOptions = {},
): ScaffoldAuditPlanResult {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const plannedAt = options.plannedAt ?? { commit: options.repoShortSha ?? "unknown", date };
  mkdirSync(outDir, { recursive: true });
  const existingReadme = join(outDir, "README.md");
  const carried = existsSync(existingReadme)
    ? extractSecurityDispositionSections(readFileSync(existingReadme, "utf8"))
    : { needsVerification: [] as string[], hardeningChecked: [] as string[] };

  const existing = readdirSync(outDir).filter((f) => /^\d{3}-.*\.md$/.test(f));
  let next = existing.reduce((max, f) => Math.max(max, Number(f.slice(0, 3))), 0) + 1;

  const written: string[] = [];
  // Slug collision guard: two findings whose titles slugify identically
  // (e.g. "Fix N+1 query" / "Fix N+1 query!") get a `-2`/`-3` suffix instead
  // of silently overwriting the earlier plan file (qc3 F-001).
  const usedSlugs = new Set<string>();
  for (const finding of findings) {
    const num = String(next).padStart(3, "0");
    let slug = slugify(finding.title);
    if (usedSlugs.has(slug)) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    usedSlugs.add(slug);
    const file = `${num}-${slug}.md`;
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
      category: fields.get("Category") ?? "\u2014",
      impact: "see plan file",
      effort: fields.get("Effort") ?? "\u2014",
      risk: fields.get("Risk") ?? "\u2014",
      confidence: "\u2014",
      evidence: fields.get("Evidence") ?? "\u2014",
      priority: fields.get("Priority") ?? "\u2014",
      dependsOn: fields.get("Depends on") ?? "\u2014",
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

  // Disposition policy: an option that IS supplied is the caller's
  // authoritative current set — it REPLACES the section, so resolved leads
  // can be removed and revised entries can be updated on a rerun. An
  // OMITTED option carries the previous section over, protecting hand-added
  // or earlier-run entries from being wiped by the README rebuild.
  const needsVerificationLines =
    options.needsVerification !== undefined
      ? options.needsVerification.map(
          (nv) => `- ${escapeCell(nv.lead)}: ${escapeCell(nv.how)}${nv.evidence ? ` (${escapeCell(nv.evidence)})` : ""}`,
        )
      : carried.needsVerification;
  const hardeningCheckedLines =
    options.hardeningChecked !== undefined
      ? options.hardeningChecked.map((hc) => `- ${hc.kind}: ${escapeCell(hc.text)}`)
      : carried.hardeningChecked;

  writeFileSync(
    join(outDir, "README.md"),
    renderIndex({
      date,
      repoName: options.repoName ?? "repo",
      repoShortSha: options.repoShortSha ?? "unknown",
      rows,
      rejected: options.rejected ?? [],
      needsVerification: needsVerificationLines,
      hardeningChecked: hardeningCheckedLines,
    }),
  );

  return { outDir: resolve(outDir), date, files: written, nextNumber: next };
}

// ---------------------------------------------------------------------------
// Plan promotion — v2 workflow registration for selected audit plans
// (snapshot FIRST, then registerWorkflow; register refuses a missing snapshot)
// ---------------------------------------------------------------------------

/** Options for `promoteAuditPlans`. `harnessDir` is required — the snapshot
 * and `status.json` live under the harness, never beside the audit dir. */
export type PromoteAuditPlansOptions = {
  /** Absolute harness dir that contains `status.json` + `workflows/`. Required. */
  harnessDir: string;
  /** Default: basename of `outDir` (e.g. `audit-2026-08-22`). */
  workflowId?: string;
};

/**
 * Promote selected audit plans into the v2 workflow lifecycle as a
 * `type: "plan"` workflow (mstar-audit SKILL.md § Plan output (all variants) — handoff): write the workflow
 * snapshot FIRST (with one Todo PlanRow per selected file), then register
 * the workflow entry — `validateStatusV2` validates the full status doc
 * including the per-snapshot existence check, so the snapshot must exist
 * before the registration. Plan rows are built from the README index
 * `## Execution order & status` columns (Plan/Title), falling back to the
 * private `readPlanFileSummary` only when the index lacks the row.
 *
 * Run-once semantics: a workflow id whose snapshot already exists refuses
 * the promote (re-promote would drop its registered plan rows); remove
 * that workflow first.
 *
 * The re-promote guard, the snapshot write, and the root upsert run in ONE
 * atomic section under the root `withStatusWriteLock(statusPath)` — the
 * same root lock `registerWorkflow` uses — so the guard is check-then-act
 * safe: two concurrent same-id promotes cannot both pass it (one writes
 * and registers; the other re-checks under the lock and refuses). The
 * snapshot is written directly with `writeJson` under the root lock (never
 * a nested `writeWorkflowSnapshot` — its own snapshot-dir lock would be a
 * second serialization point; the root lock must be THE serialization
 * point). The root upsert replicates `registerWorkflow` semantics inline
 * via the shared `registerWorkflowEntryLocked` helper (calling
 * `registerWorkflow` itself would re-enter the non-reentrant root lock).
 *
 * On any failure inside the lock, the partial snapshot + now-empty
 * workflow dir are rolled back so a retry converges after the root
 * conflict is resolved.
 */
export async function promoteAuditPlans(
  outDir: string,
  selected: readonly string[],
  options: PromoteAuditPlansOptions,
): Promise<{ workflowId: string; snapshotPath: string }> {
  if (selected.length === 0) {
    throw new Error("promoteAuditPlans: at least one plan id must be selected (--plans 001,002,\u2026)");
  }
  if (typeof options.harnessDir !== "string" || options.harnessDir.trim() === "") {
    throw new Error("promoteAuditPlans: options.harnessDir is required (must contain status.json + workflows/)");
  }

  const workflowId = options.workflowId ?? basename(resolve(outDir));
  assertSafePathComponent(workflowId, "workflow id");

  // W-001 (QC wave 1): refuse re-promote instead of silently whole-rewriting
  // the snapshot and dropping previously promoted Todo rows. The workflow
  // dir is the existence probe — a second promote would otherwise overwrite
  // (snapshot) / upsert (status.json) with a fresh set, losing the prior
  // subset. Recovery: remove the workflow first (`mstar sdd`/manual
  // `unregisterWorkflow` + snapshot removal). Greptile (fix-1): this guard
  // is check-then-act — it must run INSIDE the root write lock, atomically
  // with the snapshot write + root upsert below.
  const harnessDir = resolve(options.harnessDir);
  const statusPath = join(harnessDir, "status.json");
  const workflowDir = join(harnessDir, "workflows", workflowId);
  const snapshotPath = join(workflowDir, WORKFLOW_SNAPSHOT_FILE);

  const planFiles = resolveSelectedPlanFiles(outDir, selected);
  const indexRows = readExecutionOrderIndex(outDir);
  const plans: PlanRow[] = planFiles.map((planFile) => {
    const stem = planFile.replace(/\.md$/, "");
    const num = stem.slice(0, 3);
    const indexRow = indexRows.get(num);
    const title = indexRow?.title ?? readPlanFileSummary(join(outDir, planFile)).title;
    return {
      id: stem,
      title,
      file: planFileRel(outDir, planFile),
      status: "Todo",
    };
  });

  const now = new Date();
  const snapshot: WorkflowSnapshot = {
    schema_version: 1,
    id: workflowId,
    type: "plan",
    status: "running",
    started_at: now.toISOString(),
    updated_at: now.toISOString().slice(0, 10),
    plans,
  };
  const entry: WorkflowEntry = {
    id: workflowId,
    type: "plan",
    started_at: snapshot.started_at,
    dir: `workflows/${workflowId}`,
  };
  const entryGate = validateWorkflowEntry(entry);
  if (!entryGate.ok) {
    throw new Error(
      `refusing to register invalid workflow entry: ${entryGate.violations.map((v) => v.message).join("; ")}`,
    );
  }

  // Greptile (fix-1): the re-promote guard, the snapshot write, and the root
  // upsert are ONE atomic section under the root status.json write lock —
  // the same serialization point `registerWorkflow` uses. The guard is the
  // lock's first statement, so two concurrent same-id promotes cannot both
  // pass it (check-then-act closed). The snapshot is written directly with
  // writeJson (atomic temp+rename) instead of `writeWorkflowSnapshot`, whose
  // own snapshot-dir lock would split the serialization point; nesting that
  // second lock is technically safe (different lockdir) but would let the
  // re-promote guard and the snapshot write serialize separately.
  await withStatusWriteLock(statusPath, () => {
    if (existsSync(snapshotPath)) {
      throw new Error(
        `refusing to promote audit plans: workflow ${JSON.stringify(workflowId)} already exists ` +
          `(snapshot at ${snapshotPath}) \u2014 re-promote would drop its registered plan rows; ` +
          `remove that workflow before promoting again`,
      );
    }
    mkdirSync(workflowDir, { recursive: true });
    try {
      writeJson(snapshotPath, snapshot);
      registerWorkflowEntryLocked(statusPath, entry);
    } catch (error) {
      rmSync(snapshotPath, { force: true });
      try {
        // Remove the workflow dir only when empty — a concurrent writer's
        // snapshot/rows are never destroyed; rmdirSync throws ENOTEMPTY if
        // content appeared between the readdir and the removal, and the
        // re-promote guard would refuse the retry anyway, keeping this
        // promote's partial state out of the way.
        if (readdirSync(workflowDir).length === 0) {
          rmdirSync(workflowDir);
        }
      } catch {
        // Dir non-empty or already gone — leave it; never force-remove.
      }
      throw error;
    }
    return { workflowId, snapshotPath };
  });

  return { workflowId, snapshotPath };
}

/**
 * Resolve every selected id (`001`, `001-slug`, or `001-slug.md`) to its
 * plan file in `outDir`. A selected id with no matching `NNN-*.md` file is
 * a usage error — do not silently promote a subset.
 */
function resolveSelectedPlanFiles(outDir: string, selected: readonly string[]): string[] {
  // S-03 (QC wave 1): readdirSync order is filesystem-dependent — sort so a
  // duplicate numeric prefix (e.g. manual `001-foo.md` + `001-bar.md`) is
  // resolved deterministically: the FIRST (lowest) filename wins for a bare
  // numeric prefix (`001`), instead of by directory order. Exact-stem
  // lookups (`001-foo`) still resolve to their own file via byStem.
  const files = readdirSync(outDir)
    .filter((f) => /^\d{3}-.*\.md$/.test(f))
    .sort();
  const byNum = new Map<string, string>();
  const byStem = new Map<string, string>();
  for (const file of files) {
    const stem = file.replace(/\.md$/, "");
    // Keep the first (lowest) file per numeric prefix — a later `set` would
    // overwrite it and resolve `001` to the highest duplicate instead.
    if (!byNum.has(stem.slice(0, 3))) {
      byNum.set(stem.slice(0, 3), file);
    }
    byStem.set(stem, file);
  }
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const id of selected) {
    const file = byNum.get(id) ?? byStem.get(id) ?? byStem.get(id.replace(/\.md$/, ""));
    if (file === undefined) {
      throw new Error(
        `promoteAuditPlans: selected plan ${JSON.stringify(id)} does not match any NNN-*.md file in ${resolve(outDir)}`,
      );
    }
    if (!seen.has(file)) {
      seen.add(file);
      resolved.push(file);
    }
  }
  return resolved;
}

/** Parse the README index `## Execution order & status` table into
 *  `num -> { title }` rows (Plan column = `001`, Title column adjacent). */
function readExecutionOrderIndex(outDir: string): Map<string, { title: string }> {
  const readmePath = join(outDir, "README.md");
  let text: string;
  try {
    text = readFileSync(readmePath, "utf8");
  } catch {
    return new Map();
  }
  const rows = new Map<string, { title: string }>();
  const lines = text.split("\n");
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Execution order & status/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#/.test(line)) {
      break;
    }
    if (!inSection) continue;
    // Split on unescaped `|` (the index escapes literal pipes in titles as
    // `\|`, matching escapeCell in renderIndex).
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    if (cells.length >= 3 && /^\d{3}$/.test(cells[1])) {
      rows.set(cells[1], { title: cells[2].replace(/\\\|/g, "|") });
    }
  }
  return rows;
}

/**
 * The plan row `file` value: `{PLAN_DIR}`-relative when `outDir` sits under
 * a `plans/` directory (e.g. `audit-2026-08-22/001-slug.md`), otherwise the
 * basename. `outDir` may be reached through a `plans/` segment anywhere in
 * the path (e.g. `.mstar/plans/audit-...`).
 */
function planFileRel(outDir: string, planFile: string): string {
  const resolved = resolve(outDir);
  const parts = resolved.split(sep);
  const plansIdx = parts.lastIndexOf("plans");
  if (plansIdx >= 0) {
    return `${parts.slice(plansIdx + 1).join(sep)}${sep}${planFile}`;
  }
  return planFile;
}
