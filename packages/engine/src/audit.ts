/**
 * Engine audit module — secret redaction, credential / CI-leak scanning,
 * supply-chain checks and the codebase-audit review report renderer.
 *
 * Spec sources (all embedded as constants — no runtime skill-file reads):
 * - mstar-audit SKILL.md Hard Rules (read-only; never reproduce secret
 *   values — reference file:line + credential type only).
 * - mstar-audit SKILL.md § Output format + references/codebase-audit.md
 *   § Output format: the review report is
 *   `{REVIEW_DIR}/<date>-codebase-<level>-<round>/README.md` — one report
 *   index (Findings / Direction / Needs verification / Hardening & checked
 *   notes / Findings considered and rejected / Red-team dispositions), no
 *   per-finding plan files.
 * - mstar-audit/references/finding-format.md: category codes, evidence
 *   requirements.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { GateResult, ValidationResult } from "./core.js";
import { resolveReviewRunDir, type ReviewRunLevel, type ReviewRunRequest } from "./path.js";

function violation(severity: ValidationResult["severity"], code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

// ---------------------------------------------------------------------------
// Finding enums — mstar-audit/references/finding-format.md
// ---------------------------------------------------------------------------

/** Priority values (references/finding-format.md § Finding template). */
export const AUDIT_PRIORITIES = ["P1", "P2", "P3"] as const;
export type AuditPriority = (typeof AUDIT_PRIORITIES)[number];

/** Effort values (Morning Star agent-oriented effort scale). */
export const AUDIT_EFFORTS = ["XS", "S", "M", "L", "XL"] as const;
export type AuditEffort = (typeof AUDIT_EFFORTS)[number];

/** Risk values. */
export const AUDIT_RISKS = ["LOW", "MED", "HIGH"] as const;
export type AuditRisk = (typeof AUDIT_RISKS)[number];

/** Confidence values (finding-format.md § Template — Confidence: HIGH
 * (certain, read the code) / MED (strong signal, verify) / LOW (smell,
 * investigate)). Enum SSOT for finding-doc lint + AuditFinding. */
export const AUDIT_CONFIDENCES = ["HIGH", "MED", "LOW"] as const;
export type AuditConfidence = (typeof AUDIT_CONFIDENCES)[number];

/** Category codes (finding-format.md § Category codes). */
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
 * credential type only, never the value). Exported as the D-2 SSOT: both
 * `redactSecrets` and `scanSecrets` share this one table, so reviewers can
 * reconcile against exactly what the engine scans. Extending it only ever
 * ADDS detections for consumers of either reader — existing-pattern
 * behavior of the dsh audit seam (`validateAuditDoc`) stays byte-identical.
 */
export const WHOLE_MATCH_PATTERNS: readonly { type: string; re: RegExp }[] = [
  // the whole PEM/OpenSSH block (header through END marker) is
 // one credential — redacting only the header left the base64 body raw.
 // [\s\S] (not `.`) spans newlines; single alternation keeps it linear.
  { type: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { type: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
 // Fine-grained PATs: github_pat_<22 alnum>_<59 alnum>. A flat floor on the
 // combined tail stays conservative without encoding GitHub's split lengths.
  { type: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
 // Stripe secret keys: sk_live_<24+ alnum>. Test-mode keys (sk_test_) are
 // deliberately NOT flagged — they hold no production authority.
  { type: "stripe-live-key", re: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
  { type: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
 // Segments are capped ({10,1024}) so a dot-less run of eyJ-prefixed text
 // cannot backtrack quadratically — per-start work is bounded, keeping the
 // whole scan linear. 1024 chars covers ES/RS-family signatures (RS256
 // ~342 chars); only oversized exotic JWTs fall outside.
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,1024}\b/g },
  { type: "api-secret-key", re: /\bsk-[A-Za-z0-9-]{20,}\b/g },
];

/**
 * Key-value assignment patterns — for redaction the key name is preserved
 * and only the value is replaced. Value minimum lengths (8 quoted / 16
 * unquoted) keep the scan conservative (`token: x` and `password: 1234`
 * are not flagged). Keys may carry optional quotes (JSON/YAML
 * `"password": "..."`), which are preserved in the replacement: group 1 =
 * optional open quote, group 3 = optional close quote, group 4 = separator,
 * group 5 = value (dropped). Exported as part of the D-2 SSOT — shared by
 * `redactSecrets` and `scanSecrets`.
 */
export const VALUE_PATTERNS: readonly { typeOf: (key: string) => string; re: RegExp }[] = [
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
 * Never-commit filename patterns (security-review.md §6): a file whose name
 * matches should not be committed regardless of content — `.env*`, `*.pem`,
 * `*.key`, `id_rsa`-family, plus named credential stores. All patterns are
 * matched against the path BASENAME, never the full path.
 */
export const NEVER_COMMIT_FILENAMES: readonly { type: string; re: RegExp }[] = [
 // `.env*` glob semantics: basename STARTS with ".env" — covers `.env`,
 // `.env.production`, `.envrc`; does NOT flag `foo.env` / `config.env`.
  { type: "env-file", re: /^\.env/i },
  { type: "private-key-file", re: /\.(?:pem|key)$/i },
  { type: "ssh-private-key-file", re: /^id_(?:rsa|ed25519|ecdsa|dsa)$/ },
  { type: "credentials-json", re: /^credentials\.json$/i },
  { type: "service-account-json", re: /^service-account\.json$/i },
  { type: "git-credentials", re: /^\.?git-credentials$/i },
];

/**
 * CI/IaC credential-leak shapes (security-review.md §6). Each entry is one
 * deterministic line shape; match groups feed the finding message. All
 * shapes are additive on top of the pattern tables above and never capture
 * secret VALUES into findings (Hard Rule 4) — only file:line + type.
 */
export const CI_IAC_LEAK_SHAPES: readonly { kind: string; description: string; re: RegExp }[] = [
 // GitHub Actions plaintext `env:` assignment of a secret-looking var:
 // `env: API_TOKEN="literal"` — literals carry no `${{ }}` interpolation.
  {
    kind: "actions-plaintext-env",
    description: 'GitHub Actions env assignment with plaintext literal',
    re: /^\s*(?:-\s+)?env:\s*[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9_/+=-]{8,}["']?\s*$/,
  },
 // `echo ${{ secrets.X }}` / `printf` exposure: piping a context secret to
 // stdout can land in build logs (masking is best-effort).
  {
    kind: "actions-secret-echo",
    description: 'echo of a GitHub Actions secrets context value',
    re: /\becho\b[^#\n]*\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/,
  },
 // Dockerfile ENV/ARG whose NAME looks like a credential: values bake into
 // image layers even when the build arg intent was injection at build time.
  {
    kind: "dockerfile-credential-env",
    description: 'Dockerfile ENV/ARG with credential-looking name',
    re: /^\s*(?:ENV|ARG)\s+[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\b/i,
  },
 // Terraform hardcoded password: `password = "literal"` in any block.
  {
    kind: "terraform-hardcoded-password",
    description: 'Terraform hardcoded password attribute',
    re: /^\s*password\s*=\s*"[^$\{][^"]*"\s*$/,
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

/** Start offset of the line containing `index` (binary search over the
 * same precomputed offsets `lineAt` uses). */
function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
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

 // One span per regex match over the ORIGINAL text: {start, end} plus the
 // precomputed replacement. Every table feeds the same list so overlaps are
 // merged before any replacement is applied — applying ORIGINAL lengths
 // against already-modified text corrupted output . `priority`
 // breaks exact ties (same start AND end): the CI/IaC span wins over the
 // value span over the whole-match span — a bare `password = "…"` line
 // keeps the Terraform shape, matching what scanSecrets reports for it.
  type RedactSpan = { start: number; end: number; priority: number; text: string; type: string };
  const spans: RedactSpan[] = [];

  for (const pattern of WHOLE_MATCH_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index === undefined) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        priority: 0,
        text: marker(pattern.type, match.index),
        type: pattern.type,
      });
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
      spans.push({ start: match.index, end: match.index + match[0].length, priority: 1, text: replacement, type });
    }
  }
  // the CI/IaC shapes are part of the scan contract, so the
 // redactor consumes them too — a finding shape that can be detected must
 // never survive redaction with its value intact. These shapes are
 // LINE-scoped (matched against one line at a time by `scanSecrets`), so
 // here each match is replaced up to its line end; leading indentation is
 // preserved. Additive on top of the two tables above, so every whole-
 // match/value match still lands exactly as before (the dsh audit seam
 // keeps its pre-existing behavior for those outcomes).
  for (const shape of CI_IAC_LEAK_SHAPES) {
 // 'm' flag : the ^/$ anchors are line-scoped — a shape must
 // fire on ANY line of a multi-line evidence text, not only at the
 // string edges.
    const lineScoped = new RegExp(shape.re.source, shape.re.ignoreCase ? "gim" : "gm");
    for (const match of text.matchAll(lineScoped)) {
      if (match.index === undefined) continue;
 // Each regex above anchors at a line start — replace through
 // end-of-line. Clamping at the line end also keeps a `\s*$`-swallowed
 // trailing newline out of the replacement, so line structure stays
 // intact.
      const lineEnd = text.indexOf("\n", match.index);
      const end = lineEnd === -1 ? text.length : lineEnd;
      spans.push({
        start: match.index,
        end,
        priority: 2,
        text: `${" ".repeat(match.index - lineStartOf(text, match.index))}${marker(shape.kind, match.index)}`,
        type: shape.kind,
      });
    }
  }

 // Merge overlapping spans: sort by start asc, end desc (longer first),
 // priority desc (the exact-tie order above). Each overlap group keeps its
 // LONGEST span — nested whole-match/value matches inside a PEM block or
 // an env line are absorbed by the outer span. Deterministic: a tie in
 // start resolves to the longer span; an exact tie to the higher priority.
 // Dropped spans produce no finding — their marker never appears in the
 // output.
  spans.sort((a, b) => a.start - b.start || b.end - a.end || b.priority - a.priority);
  const merged: RedactSpan[] = [];
  let groupMaxEnd = -1;
  let best: RedactSpan | null = null;
  for (const span of spans) {
    if (span.start < groupMaxEnd) {
      if (groupMaxEnd < span.end) groupMaxEnd = span.end;
      if (span.end - span.start > best!.end - best!.start) best = span;
    } else {
      if (best !== null) merged.push(best);
      groupMaxEnd = span.end;
      best = span;
    }
  }
  if (best !== null) merged.push(best);

 // Apply from the end so earlier indices stay valid in the original text.
  let out = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const r = merged[i];
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }

  const findings: SecretFinding[] = merged.map((r) => ({ line: lineAt(starts, r.start), type: r.type }));
  const deduped = new Map<string, SecretFinding>();
  for (const f of findings) deduped.set(`${f.line}:${f.type}`, f);
  const sorted = [...deduped.values()].sort((a, b) => a.line - b.line || a.type.localeCompare(b.type));

  return { text: out, findings: sorted };
}

// ---------------------------------------------------------------------------
// Secret scanning — mstar-audit security-review.md §6 (deterministic static
// checks lifted out of reviewer hands; findings stay LLM triage)
// ---------------------------------------------------------------------------

/** One `scanSecrets` finding: file + 1-based line + credential type ONLY —
 * never the secret value (mstar-audit Hard Rule 4). */
export type ScannedSecret = { file: string; line: number; type: string };

/**
 * Safe-placeholder exclusions (security-review.md §6 "do NOT flag").
 * `${ENV_VAR}` indirection and `process.env.X` / `os.environ.get(...)`
 * reads are the intended safe forms of environment indirection, and
 * `<your_api_key>`-style literals are documentation placeholders.
 *
 * The exclusion applies to the MATCHED VALUE REGION only, never to the
 * whole line : `process.env.X ?? "sk_live_…"` shares a line
 * with a real key, so a line-wide skip would hide committed credentials.
 */
const SAFE_PLACEHOLDER_SHAPES: readonly RegExp[] = [
  /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, // ${ENV_VAR} shell/compose indirection
  /process\.env\.[A-Za-z_][A-Za-z0-9_]*/g, // process.env.FOO (Node)
  /os\.environ(?:\.get)?\(?\s*["']/g, // os.environ / os.environ.get(...) (Python)
];

/** Placeholder literals explicitly listed as safe in security-review.md §6. */
const SAFE_PLACEHOLDER_VALUES = ["your-api-key-here", "<your_api_key>", "<your-api-key>"] as const;

/**
 * Mask every safe-placeholder occurrence in `line` with spaces before
 * pattern evaluation: only the placeholder span itself is exempted, so a
 * literal credential elsewhere on the line still fires (the
 * former whole-line skip hid committed keys sitting next to a
 * `process.env.X` reference). Each masked span grows by one wrapping
 * quote layer when present, so leftover empty quotes cannot be mistaken
 * for a non-whitespace credential value.
 */
function maskSafePlaceholders(line: string): string {
  let masked = line;
  for (const shape of [...SAFE_PLACEHOLDER_VALUES, ...SAFE_PLACEHOLDER_SHAPES]) {
    if (typeof shape === "string") {
      let at = masked.toLowerCase().indexOf(shape);
      while (at !== -1) {
        let from = at;
        let to = at + shape.length;
        if (masked[from - 1] === '"' || masked[from - 1] === "'") from--;
        if (masked[to] === '"' || masked[to] === "'") to++;
        masked = masked.slice(0, from) + " ".repeat(to - from) + masked.slice(to);
        at = masked.toLowerCase().indexOf(shape);
      }
    } else {
 // matchAll clones the regex, so the tables' lastIndex state is never
 // mutated here — same guarantee `redactSecrets` relies on.
      for (const match of masked.matchAll(shape)) {
        if (match.index === undefined) continue;
        let from = match.index;
        let to = match.index + match[0].length;
        if (masked[from - 1] === '"' || masked[from - 1] === "'") from--;
        if (masked[to] === '"' || masked[to] === "'") to++;
        masked = masked.slice(0, from) + " ".repeat(to - from) + masked.slice(to);
      }
    }
  }
  return masked;
}

/**
 * Read-only per-line secret scan over the given files. Report-only by
 * design — it never redacts, never writes, and its findings carry
 * `file:line` + credential type only (Hard Rule 4). Patterns come from the
 * D-2 SSOT tables above (`WHOLE_MATCH_PATTERNS`, `VALUE_PATTERNS`) plus the
 * never-commit filename list (`NEVER_COMMIT_FILENAMES`) and CI/IaC leak
 * shapes (`CI_IAC_LEAK_SHAPES`). Safe-placeholder spans are masked before
 * pattern evaluation (only the span — a key beside it still fires). Files
 * that cannot be read are counted in `unreadableFiles` instead of being
 * silently skipped: a security gate must never report clean over input it
 * could not inspect. */

/** Result of {@link scanSecrets}: findings plus how many selected files
 * could not be read (fail-closed signal for CLI gates). */
export type ScanSecretsResult = { findings: ScannedSecret[]; unreadableFiles: number };

/** Credential-looking KEY in an Actions env map: contains TOKEN / SECRET /
 * PASSWORD / KEY (same shapes as the same-line shortcut). */
const ACTIONS_ENV_KEY = /[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*/;

/**
 * Two-pass scan of the canonical GitHub Actions block mapping:
 * find an `env:` opener line, then flag credential-looking `KEY: literal`
 * children at DEEPER indent until dedent. A `${{ }}` (or `${...}`)
 * indirection value is the safe form and is never flagged.
 */
function scanActionsEnvMap(lines: readonly string[]): number[] {
  const out: number[] = [];
  let inMap = false;
  let mapIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    if (!rawLine.trim()) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = maskSafePlaceholders(rawLine);
    if (inMap) {
      if (indent <= mapIndent) {
        inMap = false; // dedent closes the env map
      } else if (line.trim() !== "") {
 // Only the placeholder span is masked — a literal key sharing the
         // line with a `${ENV_VAR}` reference still fires.
        const child = /^\s*(?:["']?)([A-Za-z0-9_-]+)(?:["']?)\s*:\s*(.+?)\s*$/.exec(line);
        const value = child?.[2] ?? "";
        if (
          child !== null &&
          ACTIONS_ENV_KEY.test(child[1]) &&
          !/^\$\{\{[^}]*\}\}$/.test(value) && // ${{ secrets.X }} — safe form
          !/^\$\{[^}]*\}$/.test(value) // ${ENV_VAR} — safe form
        ) {
          out.push(i + 1);
        }
      }
      if (inMap) continue;
    }
 // Opener: bare `env:` mapping (no inline value on the same line);
 // a trailing YAML comment does not stop `env:` opening a map.
    if (/^\s*(?:-\s+)?env:\s*(?:#.*)?$/.test(line)) {
      inMap = true;
      mapIndent = indent;
    }
  }
  return out;
}

export function scanSecrets(files: readonly string[]): ScanSecretsResult {
  const findings: ScannedSecret[] = [];
  let unreadableFiles = 0;
 // D-2 SSOT: the private-key row spans the whole PEM block, so it needs a
 // full-file pass (the per-line loop below can never see it). The regex
 // comes from the exported table — the same row redactSecrets uses — so
 // table edits propagate instead of drifting from a second copy.
  const privateKeyRow = WHOLE_MATCH_PATTERNS.find((pattern) => pattern.type === "private-key");
  if (privateKeyRow === undefined) {
    throw new Error("scanSecrets: WHOLE_MATCH_PATTERNS is missing its private-key row (full-text PEM pass)");
  }
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
 // Fail closed: the file was selected (tracked) but could not be
 // inspected — surface the gap instead of implying a clean read.
      unreadableFiles++;
      continue;
    }
    const base = basename(file);
 // Never-commit filenames fire regardless of content.
    for (const entry of NEVER_COMMIT_FILENAMES) {
      if (entry.re.test(base)) findings.push({ file, line: 1, type: entry.type });
    }
    const starts = buildLineStarts(text);
 // Full-text pass for the private-key row: a PEM block spans multiple
 // lines, so the per-line loop below can never see it. Reported once at
 // the header line. Pattern and type both come from the SSOT row above.
    for (const match of text.matchAll(privateKeyRow.re)) {
      if (match.index === undefined) continue;
      findings.push({ file, line: lineAt(starts, match.index), type: privateKeyRow.type });
    }
    const lines = text.split("\n");
 // Canonical YAML block mapping — `env:` opener + indented children —
 // is invisible to single-line shapes; scan it before the line loop.
    for (const lineNo of scanActionsEnvMap(lines)) {
      findings.push({ file, line: lineNo, type: "actions-plaintext-env" });
    }
    for (let i = 0; i < lines.length; i++) {
  // the safe-placeholder vocab masks only ITS OWN span —
 // the rest of the line stays live for pattern evaluation, so a real
 // key beside a `process.env.X` reference is still reported.
      const line = maskSafePlaceholders(lines[i] ?? "");
 // str.match never leaks lastIndex between calls; the VALUE_PATTERNS
 // exec below resets it explicitly because /g exec advances it.
      for (const pattern of WHOLE_MATCH_PATTERNS) {
        if (line.match(pattern.re) !== null) findings.push({ file, line: i + 1, type: pattern.type });
      }
      for (const pattern of VALUE_PATTERNS) {
        const match = pattern.re.exec(line);
        pattern.re.lastIndex = 0;
 // Skip env-indirection VALUES (safe form): the whole value is
 // `${...}` indirection rather than an inline literal.
        if (match !== null && !/^\$\{[^}]*\}$/.test(match[5])) {
          findings.push({ file, line: i + 1, type: pattern.typeOf(match[2]) });
        }
      }
      for (const shape of CI_IAC_LEAK_SHAPES) {
        if (shape.re.test(line)) findings.push({ file, line: i + 1, type: shape.kind });
      }
    }
  }
  return { findings, unreadableFiles };
}

// ---------------------------------------------------------------------------
// Supply-chain gate — pr-review programmatic checks (lockfiles + workflow
// action pins); reachable/runtime-relevant triage stays with the reviewer
// ---------------------------------------------------------------------------

/** Kinds of supply-chain findings (B-11): lockfile presence/duplication at
 * install boundaries and GitHub Actions pin/exposure shapes. */
export type SupplyChainFindingKind =
  | "lockfile-missing"
  | "lockfile-duplicate"
  | "action-unpinned"
  | "pull_request_target-head";

export type SupplyChainFinding = { kind: SupplyChainFindingKind; file: string; line?: number };

/** Result of {@link supplyChainChecks}: gate verdict + machine findings. */
export type SupplyChainResult = GateResult & { findings: SupplyChainFinding[] };

/** Lockfile basenames treated as install-boundary evidence. */
const LOCKFILE_NAMES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
] as const;

function rootLockfiles(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = new Set<string>(LOCKFILE_NAMES);
  const present = entries.filter((entry) => entry.isFile() && names.has(entry.name)).map((entry) => join(root, entry.name));
  if (present.length === 0) return [];
  // inside a git repository the AUTHORITATIVE install input is
 // the tracked file set — a worktree-but-ignored lockfile is still a
 // reproducibility gap. Outside a repo (no git / bare directory), fall
 // back to filesystem presence.
  try {
    const tracked = new Set(
      execFileSync("git", ["ls-files", "-z", "--", "."], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\0")
        .filter((f) => f !== ""),
    );
    return present.filter((p) => tracked.has(basename(p)));
  } catch {
    return present;
  }
}

/**
 * Deterministic supply-chain checks over `repoRoot` (read-only):
 * - `lockfile-missing`: no recognized lockfile at the repo root
 * (package-lock.json / pnpm-lock.yaml / yarn.lock / bun.lock[b] /
 * Cargo.lock / poetry.lock / uv.lock / Gemfile.lock / composer.lock).
 * - `lockfile-duplicate`: two or more distinct lockfiles at the root —
 * ambiguous install boundaries.
 * - `action-unpinned`: `.github/workflows/*.yml` steps using mutable refs
 * (`@main`, `@master`, `@latest` or any non-SHA ref).
 * - `pull_request_target-head`: a workflow triggers on `pull_request_target`
 * AND checks out the PR head — untrusted code with secrets access.
 *
 * Tri-age judgment (reachable / runtime-relevant) is deliberately left to
 * the reviewer (C-class). Violation codes mirror finding kinds with the
 * `audit.supply.` prefix; `ok` is false iff any finding exists.
 */
export function supplyChainChecks(repoRoot: string): SupplyChainResult {
  const findings: SupplyChainFinding[] = [];
  const violations: ValidationResult[] = [];

 // Lockfile existence / duplication at the repo root.
  const lockfiles = rootLockfiles(repoRoot);
  if (lockfiles.length === 0) {
    findings.push({ kind: "lockfile-missing", file: repoRoot });
    violations.push(
      violation("medium", "audit.supply.lockfile-missing", `no recognized lockfile at ${repoRoot}`, "commit a lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock, \u2026)"),
    );
  } else if (lockfiles.length > 1) {
    findings.push({ kind: "lockfile-duplicate", file: lockfiles.map((f) => f.replace(`${repoRoot}/`, "")).join(", ") });
    violations.push(
      violation("medium", "audit.supply.lockfile-duplicate", `multiple lockfiles at ${repoRoot}: ${lockfiles.join(", ")}`, "keep exactly one lockfile per package manager"),
    );
  }

 // Workflow scans: unpinned actions + pull_request_target PR-head checkout.
  const workflowsDir = join(repoRoot, ".github", "workflows");
  let wfEntries: Dirent[] = [];
  try {
    wfEntries = readdirSync(workflowsDir, { withFileTypes: true });
  } catch {
    wfEntries = []; // no workflows dir → no workflow findings
  }
  for (const entry of wfEntries) {
    if (!entry.isFile() || !/\.(?:ya?ml)$/.test(entry.name)) continue;
    const wfPath = join(workflowsDir, entry.name);
    const relPath = `.github/workflows/${entry.name}`;
    let text: string;
    try {
      text = readFileSync(wfPath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
 // A pull_request_target trigger grants the invoked workflow access to
 // repo secrets; combined with an EXPLICIT PR-head checkout
 // (`ref: github.event.pull_request.head.sha|ref`) it runs untrusted
 // code with those secrets. Plain checkout under pull_request_target
 // defaults to the base ref — that safe shape is NOT flagged.
    const hasPrt =
 // Trigger forms of the `on:` key: block (trigger on its own indented
 // line under `on:`, with or without a `- ` marker), inline scalar
 // (`on: pull_request_target`) and inline flow sequence
 // (`on: [push, pull_request_target]`). Inline forms stay anchored to
 // the line start so comments or differently-named keys do not fire.
      /(?:^|\n)\s*(?:(?:-\s+)?pull_request_target\b|on:\s*(?:\[[^\]]*\s*)?pull_request_target\b)/.test(text);
  // pair each checkout step with its OWN `with:` map (scanned
 // until the map dedents) instead of a fixed ±6-line window — a verbose
 // `with:` block places the head ref far below the `uses:` line. A step
 // is a PR-head checkout iff its paired map contains a head.sha/head.ref
 // expression.
    const prtHeadSteps = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!/uses:\s*actions\/checkout\b/.test(line)) continue;
 // Step boundary: a verbose `with:` map is a SIBLING of the `uses:` key
 // (same indent), so the step ends only when a line dedents to or above
 // the STEP-ITEM indent (the `- ` list marker), not at `with:` itself.
      let stepIndent = line.length - line.trimStart().length;
      for (let k = i - 1; k >= 0; k--) {
        const up = lines[k] ?? "";
        const ind = up.length - up.trimStart().length;
        if (up.trimStart().startsWith("- ") && ind < stepIndent) {
          stepIndent = ind;
          break;
        }
      }
      for (let j = i + 1; j < lines.length; j++) {
        const l2 = lines[j] ?? "";
        if (l2.trim() && l2.length - l2.trimStart().length <= stepIndent) break; // step ended
        if (/github\.event\.pull_request\.head\.(?:sha|ref)\b/.test(l2)) {
          prtHeadSteps.add(i);
          break;
        }
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
 // Mutable-ref action usage: @main/@master/@latest and any non-version,
 // non-full-SHA ref are flagged (pin-to-SHA is the fix). A trailing
 // YAML comment after the ref does not hide the unpinned ref.
      const uses = /^\s*(?:-\s+)?uses:\s*(\S+)@(\S+)\s*(?:#.*)?$/.exec(line);
      if (uses !== null) {
        const ref = uses[2].replace(/^["']|["']$/g, "");
        const shaLike = /^[0-9a-f]{40}$/.test(ref);
        const versionLike = /^v\d+(?:\.\d+)*$/.test(ref);
        if (!shaLike && !versionLike) {
          findings.push({ kind: "action-unpinned", file: relPath, line: i + 1 });
          violations.push(
            violation(
              "high",
              "audit.supply.action-unpinned",
              `${relPath}:${i + 1} uses \`${uses[1]}@${ref}\` \u2014 mutable ref`,
              "pin the action to a full commit SHA",
            ),
          );
        }
      }
 // pull_request_target + explicit PR-head checkout, structurally paired.
      if (hasPrt && prtHeadSteps.has(i)) {
        findings.push({ kind: "pull_request_target-head", file: relPath, line: i + 1 });
        violations.push(
          violation(
            "high",
            "audit.supply.pull_request_target-head",
            `${relPath}:${i + 1} checks out the PR head under pull_request_target`,
            "check out the base ref or use a pull_request trigger for untrusted code",
          ),
        );
      }
    }
  }

  return { ok: violations.length === 0, violations, findings };
}

// ---------------------------------------------------------------------------
// Report scaffolding — mstar-audit SKILL.md § Output format
// ({REVIEW_DIR}/<date>-codebase-<level>-<round>/README.md)
// ---------------------------------------------------------------------------

/** One audit finding, shaped after finding-format.md. */
export type AuditFinding = {
  title: string;
  category: AuditCategory;
  impact: string;
  effort: AuditEffort;
  risk: AuditRisk;
  confidence: AuditConfidence;
  /** Free-text string (legacy form, rendered byte-for-byte) or a structured
   * location. Authored JSON should prefer the structured form. */
  evidence: readonly (string | AuditEvidence)[];
  priority: AuditPriority;
  fixSketch?: string;
  verification?: string;
  /** Source-derived root-cause identity (audit-finding-contract.md §4).
   * Optional; never invented by the engine. */
  fingerprint?: string;
  /** Entry-point → propagation → sink path (§5). Supplements evidence. */
  trace?: readonly AuditTraceStep[];
  /** Author-supplied severity assessment (§6). Never inferred from
   * priority/risk/confidence. */
  severity?: AuditSeverity;
};

/** One structured evidence location. `file` is a safe repository-relative
 * POSIX path; `line` is omitted when unknown (never invented). */
export type AuditEvidence = { file: string; line?: number; description: string };

/** Trace-step kind (§5): where data enters, how it travels, where it lands. */
export type AuditTraceKind = "entrypoint" | "propagation" | "sink";

/** One trace step. `line` is a positive safe integer; `scope` names the
 * enclosing route/function/module. */
export type AuditTraceStep = { kind: AuditTraceKind; file: string; line: number; scope: string; description: string };

/** Severity rank ordinal labels (§6). Harness diagnostic `Severity` is a
 * DIFFERENT enum (`nit`, no `informational`) — never conflate them. */
export type AuditSeverityRank = "informational" | "low" | "medium" | "high" | "critical";

export type AuditSeverity = { likelihood: AuditSeverityRank; impact: AuditSeverityRank; overall: AuditSeverityRank };

/**
 * Options for `scaffoldAuditReport`. `date` defaults to the local calendar
 * date, `level` to `standard`; `round` is allocated when omitted. `dir` is
 * the exact-run-dir override (the CLI's `--dir`).
 */
export type ScaffoldAuditReportOptions = {
  /** `{REVIEW_DIR}` root the run dir is composed under. */
  reviewsDir: string;
  /** Exact run dir: when present it IS the output dir and nothing is derived
   * from its name (`level` / `round` / `reviewsDir` then only seed the
   * returned metadata). */
  dir?: string;
  /** Audit effort level (default `standard`). */
  level?: ReviewRunLevel;
  /** Run round; omit to allocate the next free round for `date` + `level`. */
  round?: number;
  date?: string;
  repoName?: string;
  repoShortSha?: string;
  rejected?: readonly { title: string; reason: string }[];
  needsVerification?: readonly { lead: string; how: string; evidence?: string }[];
  hardeningChecked?: readonly { kind: "Hardening" | "Checked and clean"; text: string }[];
};

/** Result of `scaffoldAuditReport`: the run dir and its report index. */
export type ScaffoldAuditReportResult = {
  outDir: string;
  file: string;
  date: string;
  level: ReviewRunLevel;
  round: number;
};

const escapeCell = (value: string) => value.replace(/\|/g, "\\|");
const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}\u2026` : value);
/** Line-break collapse for index rows (table-safe single-line text). */
const collapseEvidenceWs = (value: string): string => value.replace(/\s*[\r\n]\s*/g, " ");
/** Render one evidence item: strings byte-for-byte; structured locations as
 * `file:line — description`, or `file — description` when the line is
 * omitted (never invented). */
const evidenceText = (item: string | AuditEvidence): string =>
  typeof item === "string" ? item : `${item.file}${item.line !== undefined ? `:${item.line}` : ""} \u2014 ${item.description}`;

// ---------------------------------------------------------------------------
// Finding gates — audit-finding-contract.md §§3–6 (deterministic only)
// ---------------------------------------------------------------------------

/** Fingerprint grammar (§4): source-derived identity token. The trailing
 * `(?![\s\S])` is JS's true end-of-input assertion (\z): a bare `$` would
 * also match before a final CR/LS/PS, letting a value like "valid-id\r"
 * slip through into finding metadata. */
const AUDIT_FINGERPRINT_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*(?![\s\S])/;
/** Rank ordinal for the §6 ceiling (`overall ≤ impact`). No numeric product. */
const AUDIT_SEVERITY_ORDER: Record<AuditSeverityRank, number> = { informational: 0, low: 1, medium: 2, high: 3, critical: 4 };
/** Default_Ignorable_Code_Point (JS has no \p{DI} property): the exact
 * Unicode property set — soft hyphen, CGJ, Arabic letter mark, hangul
 * fillers, Khmer vowel modifiers, Mongolian FVS, ZW characters, bidi
 * controls, joiners/deprecated/interlinear format chars, Hangul filler,
 * variation selectors, BOM, halfwidth form, halfwidth junk, CJK compat
 * ideograph filler, linear-B format, and the full tags/variation-selector
 * supplementary planes (U+E0000–U+E0FFF covers U+E0100–U+E01EF). */
const DEFAULT_IGNORABLE_RE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/u;
/** A lone UTF-16 surrogate is invalid anywhere (§3 deterministic predicates). */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Runtime shape guard (§3): JavaScript callers bypass type-checking, so
 * every carrier is shape-checked before any field is dereferenced — a
 * malformed carrier yields a stable `audit.finding.*.shape` violation, not
 * a native TypeError. Arrays are not plain objects. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Visible content: ≥1 code point outside White_Space and
 * Default_Ignorable_Code_Point; lone surrogates invalid. Multilingual text
 * is never stripped. */
function isVisibleText(value: string): boolean {
  if (LONE_SURROGATE_RE.test(value)) return false;
  for (const ch of value) {
    if (!/\p{White_Space}/u.test(ch) && !DEFAULT_IGNORABLE_RE.test(ch)) return true;
  }
  return false;
}

/** Safe repository-relative POSIX path (§3): reject empty paths, absolute /
 * drive / UNC paths, backslashes, control characters, empty / `.` / `..`
 * segments, and segments ending in a dot or space. Never normalizes unsafe
 * input into acceptance; never checks filesystem existence. */
function safeAuditPath(value: string): boolean {
  if (typeof value !== "string") return false; // runtime shape (JS callers)
  if (value === "") return false;
  if (value.includes("\\")) return false;
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) return false;
  // A lone surrogate is invalid UTF-8 on write: it would silently become
  // U+FFFD, so the persisted location must never differ from the supplied
  // one. Falls under the same `audit.finding.path.unsafe` code family.
  if (LONE_SURROGATE_RE.test(value)) return false;
  if (value.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (segment.endsWith(".") || segment.endsWith(" ")) return false;
  }
  return true;
}

/**
 * Deterministic finding gates (audit-finding-contract.md §§2–6): fingerprint
 * grammar / exact uniqueness / ordinal ordering of the supplied subsequence,
 * `severity.overall ≤ severity.impact`, nonempty trace topology, positive
 * safe-integer trace lines, safe typed paths, visible well-formed text, and
 * opaque-field credential rejection (a fingerprint or typed location that
 * `redactSecrets` would alter is REJECTED, never redacted into a different
 * identity). Contextual judgement (reportability, semantic exclusion,
 * coverage) stays in skill prose (§2).
 *
 * Violation codes are stable `audit.finding.<family>.<rule>`; messages carry
 * `findings[index].field` paths only — never raw submitted values. Pure:
 * the input is never mutated and nothing is sorted or repaired.
 */
export function validateAuditFindingGates(findings: readonly AuditFinding[]): GateResult {
  const violations: ValidationResult[] = [];
  const seen = new Map<string, number>();
  let previousFingerprint: string | undefined;

 // Runtime shape (JS callers): findings itself must be an array.
  if (!Array.isArray(findings)) {
    violations.push(violation("high", "audit.finding.shape", "findings \u2014 audit.finding.shape"));
    return { ok: false, violations };
  }

  findings.forEach((finding, index) => {
    const at = (field: string): string => `findings[${index}].${field}`;
    const push = (code: string, field: string): void => {
      violations.push(violation("high", code, `${at(field)} \u2014 ${code}`));
    };

 // Runtime shape: a non-object finding cannot be dereferenced safely (JS
 // callers bypass type-checking) — one stable violation, no field paths.
    if (!isPlainObject(finding)) {
      violations.push(violation("high", "audit.finding.shape", `findings[${index}] \u2014 audit.finding.shape`));
      return;
    }

 // §4 fingerprint: grammar, credential rejection, exact uniqueness,
 // strict ASCII ordering of the supplied subsequence (absent ones skipped;
 // out-of-order input is rejected, never sorted — positions control the
 // report row order).
    // Omission (absent key) is the only benign case: a supplied `null` or
    // any wrong type must enter this block and fail the grammar/shape check
    // as a usage error (`!= null` would silently treat `null` as omitted).
    if (finding.fingerprint !== undefined) {
      const fingerprint = finding.fingerprint;
      if (typeof fingerprint !== "string" || !AUDIT_FINGERPRINT_RE.test(fingerprint)) push("audit.finding.fingerprint.grammar", "fingerprint");
      else if (redactSecrets(fingerprint).text !== fingerprint) push("audit.finding.fingerprint.secret", "fingerprint");
      else {
        const firstAt = seen.get(fingerprint);
        if (firstAt !== undefined) push("audit.finding.fingerprint.duplicate", "fingerprint");
        else seen.set(fingerprint, index);
        if (previousFingerprint !== undefined && fingerprint < previousFingerprint) {
          push("audit.finding.fingerprint.order", "fingerprint");
        }
        previousFingerprint = fingerprint;
      }
    }

 // §6 severity ceiling: only `overall ≤ impact` is computed; invalid ranks
 // are errors (no inference from priority/risk/confidence).
    if (finding.severity !== undefined) {
      if (!isPlainObject(finding.severity)) {
        push("audit.finding.severity.shape", "severity");
      } else {
      const { likelihood, impact, overall } = finding.severity;
      const rankOf = (r: unknown): number | undefined => AUDIT_SEVERITY_ORDER[r as AuditSeverityRank];
      for (const [field, value] of [
        ["likelihood", likelihood],
        ["impact", impact],
        ["overall", overall],
      ] as const) {
        if (rankOf(value) === undefined) push("audit.finding.severity.rank", `severity.${field}`);
      }
      const impactRank = rankOf(impact);
      const overallRank = rankOf(overall);
      if (impactRank !== undefined && overallRank !== undefined && overallRank > impactRank) {
        push("audit.finding.severity.overall-exceeds-impact", "severity.overall");
      }
      }
    }

    const textViolation = (field: string, value: unknown): void => {
      if (value === undefined) return;
      if (typeof value !== "string") push("audit.finding.text.type", field);
      else if (LONE_SURROGATE_RE.test(value)) push("audit.finding.text.surrogate", field);
      else if (!isVisibleText(value)) push("audit.finding.text.invisible", field);
    };

 // §5 trace: nonempty array; length 1 allows entrypoint|sink; length >1
 // requires first entrypoint, last sink, propagation between.
    if (finding.trace !== undefined) {
      if (!Array.isArray(finding.trace)) push("audit.finding.trace.shape", "trace");
      else if (finding.trace.length === 0) push("audit.finding.trace.empty", "trace");
      else {
        const kinds = finding.trace.map((s) => (isPlainObject(s) ? s.kind : undefined));
        const topologyOk =
          finding.trace.length === 1
            ? kinds[0] === "entrypoint" || kinds[0] === "sink"
            : kinds[0] === "entrypoint" && kinds[kinds.length - 1] === "sink" && kinds.slice(1, -1).every((k) => k === "propagation");
        if (!topologyOk) push("audit.finding.trace.topology", "trace");
        finding.trace.forEach((step, stepIndex) => {
          const stepAt = `trace[${stepIndex}]`;
          if (!isPlainObject(step)) {
            push("audit.finding.trace.shape", stepAt);
            return;
          }
          if (typeof step.line !== "number" || !Number.isSafeInteger(step.line) || step.line <= 0) {
            push("audit.finding.trace.line", `${stepAt}.line`);
          }
          const stepFile = step.file;
          if (typeof stepFile !== "string" || !safeAuditPath(stepFile)) push("audit.finding.path.unsafe", `${stepAt}.file`);
          else if (redactSecrets(stepFile).text !== stepFile) push("audit.finding.path.secret", `${stepAt}.file`);
          if (step.scope === undefined) push("audit.finding.trace.shape", `${stepAt}.scope`);
          else textViolation(`${stepAt}.scope`, step.scope);
          if (step.description === undefined) push("audit.finding.trace.shape", `${stepAt}.description`);
          else textViolation(`${stepAt}.description`, step.description);
        });
      }
    }

 // §3 typed evidence objects
    if (!Array.isArray(finding.evidence)) push("audit.finding.evidence.shape", "evidence");
    else
    finding.evidence.forEach((item, itemIndex) => {
      if (typeof item === "string") {
        textViolation(`evidence[${itemIndex}]`, item);
        return;
      }
      if (!isPlainObject(item)) {
        push("audit.finding.evidence.shape", `evidence[${itemIndex}]`);
        return;
      }
      const itemFile = item.file;
      if (typeof itemFile !== "string" || !safeAuditPath(itemFile)) push("audit.finding.path.unsafe", `evidence[${itemIndex}].file`);
      else if (redactSecrets(itemFile).text !== itemFile) push("audit.finding.path.secret", `evidence[${itemIndex}].file`);
      if (item.line !== undefined && (typeof item.line !== "number" || !Number.isSafeInteger(item.line) || item.line <= 0)) {
        push("audit.finding.evidence.line", `evidence[${itemIndex}].line`);
      }
      textViolation(`evidence[${itemIndex}].description`, item.description);
    });

 // §3 visible-text predicate on finding text fields (title, impact, supplied
 // fixSketch / verification).
    textViolation("title", finding.title);
    textViolation("impact", finding.impact);
    textViolation("fixSketch", finding.fixSketch);
    textViolation("verification", finding.verification);
    // trace step text fields are validated in the §5 loop above — no
    // duplicate pass (one bad field must yield one violation).
  });

  return { ok: violations.length === 0, violations };
}

/**
 * One redaction wrapper for every free-text scaffold channel: finding
 * fields (via {@link redactFinding}) AND the non-finding report channels
 * (rejected findings, `needsVerification`, `hardeningChecked` —
 *).
 * All user-supplied strings pass through this before any rendering, so no
 * channel can reach an artifact with raw credential material.
 */
function redactText(text: string): string {
  return redactSecrets(text).text;
}

/**
 * Redact credential patterns from a finding's free-text fields (title /
 * impact / evidence / fixSketch / verification) before rendering, making
 * the codebase-audit.md Engine-check promise literal: the review report
 * README never carries raw credential values (mstar-audit Hard
 * Rule 4). Enum fields (category/effort/risk/priority/confidence) are
 * machine-checked enums and pass through untouched.
 */
function redactFinding(finding: AuditFinding): AuditFinding {
  return {
    ...finding,
    title: redactText(finding.title),
    impact: redactText(finding.impact),
 // String evidence redacts normally; structured locations redact the
 // description only — file/line are opaque identity/location fields the
 // gate already verified unaltered by redaction (§8).
    evidence: finding.evidence.map((item) =>
      typeof item === "string" ? redactText(item) : { ...item, description: redactText(item.description) },
    ),
    ...(finding.trace !== undefined
      ? { trace: finding.trace.map((step) => ({ ...step, scope: redactText(step.scope), description: redactText(step.description) })) }
      : {}),
    ...(finding.fixSketch !== undefined ? { fixSketch: redactText(finding.fixSketch) } : {}),
    ...(finding.verification !== undefined ? { verification: redactText(finding.verification) } : {}),
  };
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
/** Render one finding's detail block — assessment fields, Impact, the full
 * Evidence list, the Trace table, Fix sketch and Verification. Prose and
 * multi-line text stay verbatim (only the heading is collapsed to one line).
 * Carries no plan concepts (no Status block, no depends-on, no planned-at):
 * the run's README is its only artifact and must hold each finding in full. */
function renderFindingDetail(num: string, finding: AuditFinding): string {
  const sections = [
    `### ${num}. ${collapseEvidenceWs(finding.title)}`,
    "",
    `- **Priority**: ${finding.priority}`,
    `- **Effort**: ${finding.effort}`,
    `- **Risk**: ${finding.risk}`,
    `- **Confidence**: ${finding.confidence}`,
    ...(finding.fingerprint !== undefined ? [`- **Fingerprint**: ${finding.fingerprint}`] : []),
    ...(finding.severity !== undefined
      ? [`- **Likelihood**: ${finding.severity.likelihood}`, `- **Severity impact**: ${finding.severity.impact}`, `- **Severity**: ${finding.severity.overall}`]
      : []),
    "",
    "**Impact**",
    "",
    finding.impact,
  ];
  if (finding.evidence.length > 0) {
    sections.push("", "**Evidence**", "", ...finding.evidence.map((item) => `- ${evidenceText(item)}`));
  }
  if (finding.trace !== undefined) {
    sections.push(
      "",
      "**Trace**",
      "",
      "| Kind | Location | Scope / Description |",
      "|------|----------|---------------------|",
      ...finding.trace.map(
        (step) =>
          `| ${escapeCell(step.kind)} | ${escapeCell(`${step.file}:${step.line}`)} | ${escapeCell(`${step.scope} \u2014 ${step.description}`).replace(/\r\n|\r|\n/g, "\\n")} |`,
      ),
    );
  }
  if (finding.fixSketch !== undefined) sections.push("", "**Fix sketch**", "", finding.fixSketch);
  if (finding.verification !== undefined) sections.push("", "**Verification**", "", finding.verification);
  return sections.join("\n");
}

/** Render the run's report index (`README.md`) — mstar-audit
 * references/codebase-audit.md § Output format · Audit index. `rows` is the
 * batch of findings this run reports, numbered in order; `details` carries one
 * rendered detail block per row (the `## Finding detail` section).
 * `needsVerification` / `hardeningChecked` carry the security-disposition entry
 * lines documented by `references/security-review.md`; empty arrays omit the section. */
function renderIndex(params: {
  date: string;
  repoName: string;
  repoShortSha: string;
  rows: {
    num: string;
    title: string;
    category: string;
    impact: string;
    effort: string;
    risk: string;
    confidence: string;
    evidence: string;
    fingerprint?: string;
    likelihood?: string;
    severityImpact?: string;
    severity?: string;
  }[];
  details: readonly string[];
  rejected: readonly { title: string; reason: string }[];
  needsVerification: readonly string[];
  hardeningChecked: readonly string[];
}): string {
  const { date, repoName, repoShortSha, rows, details, rejected, needsVerification, hardeningChecked } = params;
 // §8: the Fingerprint column appears if any displayed row carries one; the
 // severity columns are appended after (retained prose) Impact when any row
 // has severity. Unrated rows show `—`; legacy-only batches keep the old
 // header bytes exactly.
  const showFingerprint = rows.some((r) => r.fingerprint !== undefined);
  const showSeverity = rows.some((r) => r.likelihood !== undefined || r.severityImpact !== undefined || r.severity !== undefined);
  const cell = (value: string | undefined): string => escapeCell(value ?? "\u2014");
  const findingsRows = rows
    .map(
      (r) =>
        `| ${r.num} | ${escapeCell(r.title)} | ${r.category} | ${escapeCell(truncate(r.impact, 80))} | ${r.effort} | ${r.risk} | ${r.confidence} | ${escapeCell(truncate(r.evidence, 80))}` +
        (showFingerprint ? ` | ${cell(r.fingerprint)}` : "") +
        (showSeverity ? ` | ${cell(r.likelihood)} | ${cell(r.severityImpact)} | ${cell(r.severity)}` : "") +
        " |",
    )
    .join("\n");
  const directionRows = rows
    .filter((r) => r.category === "direction")
    .map((r) => `- ${escapeCell(r.title)} \u2014 ${escapeCell(truncate(r.impact, 120))}`)
    .join("\n");
  const rejectedRows = rejected.map((r) => `- ${escapeCell(r.title)}: ${escapeCell(r.reason)}`).join("\n");

  const sections = [
    `# Audit Report \u2014 ${repoName} @ ${repoShortSha} (${date})`,
    "",
    "## Findings",
    "",
    "| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence" +
      (showFingerprint ? " | Fingerprint" : "") +
      (showSeverity ? " | Likelihood | Severity impact | Severity" : "") +
      " |",
    "|---|---------|----------|--------|--------|------|------------|----------" +
      (showFingerprint ? "|------------" : "") +
      (showSeverity ? "|------------|-----------------|----------" : "") +
      "|",
    findingsRows,
  ];
  if (details.length > 0) {
    // The table above is the overview; the detail blocks carry each finding
    // in full (evidence list, trace, fix sketch, verification).
    sections.push("", "## Finding detail", "", details.join("\n\n"));
  }
  if (directionRows !== "") {
    sections.push("", "## Direction", "", directionRows);
  }
  if (needsVerification.length > 0) {
    sections.push("", "## Needs verification", "", ...needsVerification);
  }
  if (hardeningChecked.length > 0) {
    sections.push("", "## Hardening & checked notes", "", ...hardeningChecked);
  }
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

/** Local calendar date `YYYY-MM-DD` — the run dir / report date, never UTC. */
function localToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Write the run's review report
 * (`{REVIEW_DIR}/<date>-codebase-<level>-<round>/README.md`, mstar-audit
 * SKILL.md § Output format · references/codebase-audit.md § Output format):
 * ONE report index rendered from the supplied findings — no per-finding
 * plan files, no Status blocks. The run dir is the SSOT (§ 2); an omitted
 * `round` allocates the next free round for `date` + `level` unless
 * `options.dir` names the directory outright. Rejected findings render in
 * the "considered and rejected" section. Security dispositions
 * (`needsVerification` / `hardeningChecked`) render in their documented
 * sections. Policy: a SUPPLIED option is the authoritative current set and
 * replaces the section (resolved leads can be removed, revised entries
 * updated); an OMITTED option carries the previous section over from the
 * existing README so hand-added entries survive the rebuild.
 */
export function scaffoldAuditReport(
  findings: readonly AuditFinding[],
  options: ScaffoldAuditReportOptions,
): ScaffoldAuditReportResult {
  const date = options.date ?? localToday();
  const level = options.level ?? "standard";
 // Contract §3 integration: the deterministic gates run BEFORE the first
 // mkdirSync/write — a rejected batch causes zero new files and leaves any
 // existing README untouched. Direct engine callers get the same gate.
  const gate = validateAuditFindingGates(findings);
  if (!gate.ok) {
    const first = gate.violations[0];
    throw new TypeError(`invalid audit findings \u2014 ${first.code}: ${first.message}`);
  }
  const spec: ReviewRunRequest = { kind: "codebase", level, round: options.round };
  const outDir =
    options.dir !== undefined
      ? resolve(options.dir)
      : resolveReviewRunDir({ reviewsDir: options.reviewsDir, date, spec });
 // An explicit dir names its own round; an allocated one is echoed as the
 // run-dir name's trailing segment (§ 2 SSOT).
  const round = options.round ?? (options.dir !== undefined ? 1 : Number(basename(outDir).split("-").pop()));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "README.md");
  const carried = existsSync(file)
    ? extractSecurityDispositionSections(readFileSync(file, "utf8"))
    : { needsVerification: [] as string[], hardeningChecked: [] as string[] };

 // Redact ONCE up front — every rendered row shares these redacted copies
 // instead of calling redactFinding again per column.
  const redacted = findings.map(redactFinding);
  const details = redacted.map((finding, index) => renderFindingDetail(String(index + 1).padStart(3, "0"), finding));
  const rows = redacted.map((finding, index) => ({
    num: String(index + 1).padStart(3, "0"),
    title: finding.title,
    category: finding.category,
    impact: finding.impact,
    effort: finding.effort,
    risk: finding.risk,
    confidence: finding.confidence,
    evidence: finding.evidence.length > 0 ? collapseEvidenceWs(evidenceText(finding.evidence[0])) : "",
    fingerprint: finding.fingerprint,
    likelihood: finding.severity?.likelihood,
    severityImpact: finding.severity?.impact,
    severity: finding.severity?.overall,
  }));

 // Disposition policy: an option that IS supplied is the caller's
 // authoritative current set — it REPLACES the section, so resolved leads
 // can be removed and revised entries can be updated on a rerun. An
 // OMITTED option carries the previous section over, protecting hand-added
 // or earlier-run entries from being wiped by the README rebuild.
 // Every supplied entry passes the shared redaction wrapper first: carried-over lines were
 // already redacted when written.
  const needsVerificationLines =
    options.needsVerification !== undefined
      ? options.needsVerification.map(
          (nv) =>
            `- ${escapeCell(redactText(nv.lead))}: ${escapeCell(redactText(nv.how))}${
              nv.evidence ? ` (${escapeCell(redactText(nv.evidence))})` : ""
            }`,
        )
      : carried.needsVerification;
  const hardeningCheckedLines =
    options.hardeningChecked !== undefined
      ? options.hardeningChecked.map((hc) => `- ${hc.kind}: ${escapeCell(redactText(hc.text))}`)
      : carried.hardeningChecked;

  writeFileSync(
    file,
    renderIndex({
      date,
      repoName: options.repoName ?? "repo",
      repoShortSha: options.repoShortSha ?? "unknown",
      rows,
      details,
      rejected: (options.rejected ?? []).map((r) => ({ title: redactText(r.title), reason: redactText(r.reason) })),
      needsVerification: needsVerificationLines,
      hardeningChecked: hardeningCheckedLines,
    }),
  );

  return { outDir, file, date, level, round };
}
