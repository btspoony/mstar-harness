/**
 * Engine lint module — deterministic lint checks ported from skill prose.
 *
 * Roadmap §8.2 `lint` row + §4.5 Lint layer (`simplify:` / `temporary` marker presence; SDD TDD
 * triple in completion reports; plan-quality-bar checks; skill frontmatter
 * contract; STRATEGY.md required sections). Skill text stays the semantic
 * SSOT (roadmap D5) — this module implements the deterministic subset and
 * never forks semantics.
 *
 * Spec sources (each function cites the source section):
 * - simplify:/temporary markers: `mstar-coding-behavior` SKILL.md § Decision
 * Rules: a deliberate shortcut with a known
 * ceiling is marked with a `simplify:` comment naming the ceiling and the
 * upgrade path; a workaround is labeled `simplify:` / `temporary`, explains
 * why, and records the removal path in the plan/status artifact before the
 * task is claimed complete.
 * - SDD verification evidence: `mstar-sdd/references/file-handoffs.md`
 * § Verification evidence — completion and fix reports retain the affected
 * test file(s), command and actual output, or applicable scoped-check evidence.
 * - Plan quality bar: `mstar-artifacts/references/plan-quality-bar.md`
 * § Quality checklist + `templates/plan.main.md` self-review
 * ("Placeholder scan: no TBD").
 * - Skill frontmatter contract: `mstar-skill-authoring` SKILL.md § Frontmatter
 * Contract — `name` stable lowercase-hyphen; `description` is the trigger
 * contract (not a workflow summary), third person.
 * - STRATEGY.md structure: `mstar-knowledge/references/strategy-document.md`
 * § Shape — six required sections.
 * - Ephemeral citations: knowledge `conventions/skill-content-porting-discipline.md`
 * §3 ("No ephemeral citations in durable skill text") + session evaluation
 * 2026-08-16 discrimination contract — concrete task-artifact references
 * and SDD deeplinks are ephemeral; placeholder forms are not.
 *
 * Enforcement depth: roadmap §8.5 C4 — v1 lints are non-blocking
 * `ValidationResult`s; callers surface them as warnings.
 *
 * Severity mapping: structural gaps (missing name/description/sections,
 * placeholder tokens, TDD-triple gaps, un-tracked temporary markers) are
 * `medium`; style heuristics (pronouns, workflow-summary shape) are `low`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { GateResult, Severity, ValidationResult } from "./core.js";

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

/** Comment-introducer prefixes before a marker word (line-level scan):
 * `//`, `/*`, `*` (block-comment continuation — must be preceded by
 * whitespace so regex quantifiers like `\s*temporary` are not read as
 * markers), `#` (shell/YAML/TOML), `;` (Lisp-ish), `--` (SQL). The comment
 * context guard keeps prose lines that merely contain "simplify:" /
 * "temporary" out of the marker set. */
const COMMENT_INTRODUCER = "(?:\\/\\/|\\/\\*|#|;|--|\\s\\*)";

/**
 * A `simplify:` marker found in a file, with its 1-based line number and the
 * trimmed comment line (lint reporting).
 */
export type SimplifyMarker = { line: number; text: string };

/**
 * Find `simplify:` marker comments (mstar-coding-behavior § Decision Rules:
 * a deliberate shortcut with a known ceiling —
 * global lock, O(n²) scan, naive heuristic — is marked with a `simplify:`
 * comment naming the ceiling and the upgrade path).
 *
 * Heuristic (documented, conservative): a marker is a line where a comment
 * introducer (`//`, `/*`, `*`, `#`, `;`, `--`) precedes `simplify:` —
 * case-insensitive, any column (leading or trailing comments). Pure prose
 * like "we simplify: the interface" carries no comment introducer and is
 * never reported. No judgment about whether the marker actually names a
 * ceiling/upgrade path — discovery only; callers may inspect `text`.
 */
export function findSimplifyMarkers(fileText: string): SimplifyMarker[] {
  const markers: SimplifyMarker[] = [];
  const re = new RegExp(`${COMMENT_INTRODUCER}\\s*simplify\\s*:`, "i");
  const lines = fileText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) markers.push({ line: i + 1, text: lines[i].trim() });
  }
  return markers;
}

/**
 * A `temporary` marker found in a file. `removalPath` is the recorded
 * plan/status artifact reference (first pattern match, see
 * `findTemporaryMarkers`), or `null` when the marker names no removal path.
 */
export type TemporaryMarker = {
  line: number;
  text: string;
  removalPath: string | null;
};

/** Result of `findTemporaryMarkers`: the gate verdict plus the markers found
 * (so callers can both lint and report). */
export type TemporaryMarkerResult = GateResult & { markers: TemporaryMarker[] };

/**
 * Removal-path patterns (mstar-coding-behavior § Decision Rules: "record
 * the removal path in the plan/status artifact"). A marker satisfies the
 * convention when its line references one of these — first match wins:
 * 1. `status.json` (the plan-harness status artifact)
 * 2. `R#<n>` (residual entry)
 * 3. the word `residual` (residual tracker / notes)
 * 4. a `plans/<file>` path (e.g. `plans/20991231-example.md`)
 * 5. a dated plan id ("plan 20991231-example-plan")
 * 6. "tracked/recorded/logged/scheduled/listed/noted in <artifact>"
 * 7. an explicit "removal path: <artifact>" label
 */
const REMOVAL_PATH_PATTERNS: readonly RegExp[] = [
  /status\.json/i,
  /R#\d+/i,
  /\bresiduals?\b/i,
  /plans?\/[\w./-]+/i,
  /\bplans?\s+20\d{6}[-.\w]*/i,
  /\b(?:tracked|recorded|logged|scheduled|listed|noted)\s+in\s+[\w./-]+/i,
  /removal\s+path\s*[:=]\s*["'`]?[\w./-]+/i,
];

/**
 * Find `temporary` label comments and check each carries a recorded removal
 * path (plan/status artifact reference). Markers lacking a removal path are
 * violations: `lint.temporary.no-removal-path` (mstar-coding-behavior §
 * Decision Rules — unavoidable workarounds explain why, carry a `simplify:`
 * or `temporary` label, and record a removal path in the existing plan/status
 * artifact before completion; temporary markers cite that artifact).
 *
 * Heuristic (documented, conservative): a marker is a comment-context line
 * containing the word `temporary` (case-insensitive, word-boundary — so
 * "temporarily" is not a label). Removal-path detection uses the pattern set
 * above; a version mention alone ("remove in v2.0.0") is NOT a plan/status
 * artifact reference and is reported, per the strict convention wording.
 *
 * Accepted false-positive (documented trade-off): the `;` / `--` comment
 * introducers (Lisp/SQL comment syntax) can match code lines such as
 * `foo(); temporary = 1;` — the `;` introducer + `\s*temporary\b` looks
 * like a marker even though `temporary` is a variable name. Errs toward
 * flagging (a violation prompts a removal path, which the code line won't
 * carry); do not special-case it without a real FP report.
 */
export function findTemporaryMarkers(fileText: string): TemporaryMarkerResult {
  const markers: TemporaryMarker[] = [];
  const violations: ValidationResult[] = [];
  const re = new RegExp(`${COMMENT_INTRODUCER}\\s*temporary\\b`, "i");
  const lines = fileText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!re.test(line)) continue;
    const text = line.trim();
    let removalPath: string | null = null;
    for (const pattern of REMOVAL_PATH_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        removalPath = match[0];
        break;
      }
    }
    markers.push({ line: i + 1, text, removalPath });
    if (removalPath === null) {
      violations.push(
        violation(
          "medium",
          "lint.temporary.no-removal-path",
          `temporary marker at line ${i + 1} records no removal path (plan/status artifact reference) \u2014 record one before claiming the task complete (mstar-coding-behavior \u00a7 Decision Rules)`,
          'add a plan/status reference to the marker, e.g. "removal tracked in status.json" or "plan 20991231-example-plan removes this"',
        ),
      );
    }
  }
  return { ok: violations.length === 0, violations, markers };
}

/**
 * An ephemeral citation found in durable skill text: a concrete reference to
 * a per-task artifact or an SDD deeplink that survives nothing (knowledge
 * conventions/skill-content-porting-discipline.md §3 — "No ephemeral
 * citations in durable skill text": a calibration line citing an SDD task
 * report violates standalone + survives nothing; instances/examples cite
 * in-repo artifacts only).
 */
export type EphemeralCitation = {
 /** 1-based line number of the citation. */
  line: number;
 /** The matched citation token (artifact name or deeplink prefix). */
  match: string;
  /** `task-artifact`: `task-<digits>-(brief|report|fix-report|diff)`;
 * `sdd-deeplink`: `.mstar/sdd/` / `.agents/sdd/` + a concrete first
 * segment. */
  kind: "task-artifact" | "sdd-deeplink";
};

/** Concrete task-artifact reference — `task-<digits>-(brief|report|fix-report|
 * diff)`, 1+ digits being a real instance; the dot form `task-<digits>.diff`
 * (review-package diff naming) is included. Placeholder forms (`task-N-*`,
 * `task-<...>`, `{...}`) never match: `N` is a letter, and `<`/`{` are not
 * digits. Word boundaries at both ends keep `task-2-reporting` out. */
const TASK_ARTIFACT_RE = /\btask-\d+(?:-(?:brief|report|fix-report|diff)|\.diff)\b/g;

/** Concrete SDD deeplink — `.mstar/sdd/` / `.agents/sdd/` followed by a
 * first path segment that is not a placeholder. Segment chars exclude
 * whitespace, `/`, quote/backtick, the placeholder brackets `<` `>` `{`
 * `}` `[` `]`, and the glob wildcards `*` `?`, so `<plan-id>` / `{SDD_DIR}`
 * / `<...>` segments and allowlist globs (`.mstar/sdd/**`) never match. */
const SDD_DEEPLINK_RE = /\.(?:mstar|agents)\/sdd\/([^\s/<>{}\[\]"'\*\?]+)/g;

/**
 * Find ephemeral citations in skill text (knowledge
 * conventions/skill-content-porting-discipline.md §3 + session evaluation
 * 2026-08-16 discrimination contract).
 *
 * Discrimination (HARD — zero false positives on the skills corpus):
 * - `task-<digits>-(brief|report|fix-report|diff)` with 1+ digits is a
 * concrete instance → reported (`task-2-report`, `task-1.diff`).
 * Placeholders (`task-N-brief`, `task-N-report`, `<plan-id>`,
 * `{SDD_DIR}/task-N-report.md`) never match.
 * - `.mstar/sdd/<segment>` / `.agents/sdd/<segment>` with a concrete dated
 * first segment → reported; `<plan-id>` / `{SDD_DIR}` segments
 * are template forms → never match.
 *
 * Discovery only — a finder returning an array, same shape as
 * `findSimplifyMarkers`, NOT a GateResult; callers wrap findings into
 * `ViolationResult`s (codes `skill.ephemeral.task-artifact` /
 * `skill.ephemeral.sdd-deeplink`). Citations are reported line by line in
 * 1-based line order, source order within a line.
 */
export function findEphemeralCitations(skillText: string): EphemeralCitation[] {
  const citations: EphemeralCitation[] = [];
  const lines = skillText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const found: Array<{ index: number; match: string; kind: EphemeralCitation["kind"] }> = [];
    for (const m of lines[i].matchAll(TASK_ARTIFACT_RE)) {
      found.push({ index: m.index, match: m[0], kind: "task-artifact" });
    }
    for (const m of lines[i].matchAll(SDD_DEEPLINK_RE)) {
      found.push({ index: m.index, match: m[0], kind: "sdd-deeplink" });
    }
    found.sort((a, b) => a.index - b.index);
    for (const f of found) {
      citations.push({ line: i + 1, match: f.match, kind: f.kind });
    }
  }
  return citations;
}

/**
 * A provenance citation found in text: a dated plan/iteration id token, or a
 * local-harness deeplink whose specificity comes from a dated instance
 * segment. Both disclose local artifact provenance, which tracked code and
 * docs must not carry (repo AGENTS.md "Git and local artifacts": tracked
 * content must not disclose real plan/iteration ids or local deep paths;
 * synthetic example forms and generic layout lines are exempt).
 */
export type ProvenanceCitation = {
  /** 1-based line number of the citation. */
  line: number;
  /** The matched citation token (dated plan id or deeplink path). */
  match: string;
  /** `plan-id`: a dated-slug plan/iteration id token; `harness-path`: a
   * local-harness deeplink containing a dated token. */
  kind: "plan-id" | "harness-path";
};

/** Dated-slug token shape shared by both provenance kinds: `20\d{6}-` plus a
 * lowercase slug, word-bounded at both ends (`20991231-example-plan`; an
 * `iter-` / `plan ` / `planId` prefix is optional — the token itself is the
 * fingerprint). The trailing `(?!\\.\d)` lookahead rejects a `.digits`
 * version segment after the token (`20260908-v3.9.0` is a version, not a
 * plan id). Placeholder forms (`task-N-*`, `<plan-id>`, `{…}`) never match:
 * `N` is a letter and bracket characters are not digits (same placeholder
 * discrimination as TASK_ARTIFACT_RE). */
const DATED_SLUG_TOKEN_SOURCE = "\\b20\\d{6}-[a-z0-9][a-z0-9-]*\\b(?!\\.\\d)";
/** Standalone dated-slug token occurrences (plan-id candidates). Consumed
 * only via `matchAll` (which clones the regex), so the shared `lastIndex`
 * never leaks between calls — do not `.exec` this instance directly. */
const DATED_SLUG_TOKEN_RE = new RegExp(DATED_SLUG_TOKEN_SOURCE, "g");
/** Local-harness deeplink — `.mstar/` / `.agents/` + a path tail. Segment
 * charset mirrors SDD_DEEPLINK_RE (whitespace, placeholder brackets, quotes
 * and glob wildcards excluded) plus `/`, so `<plan-id>` / `{SDD_DIR}` tails
 * and allowlist globs (`.mstar/sdd/**`) never match past the root. */
const HARNESS_PATH_RE = /\.(?:mstar|agents)\/[^\s<>{}\[\]"'\*\?]+/g;
/** Sdd deeplink surface — first path segment `sdd` (same face as
 * SDD_DEEPLINK_RE). Attribution contract: these paths belong to the
 * ephemeral-citation check exclusively, so this finder never reports them. */
const SDD_DEEPLINK_PREFIX_RE = /^\.(?:mstar|agents)\/sdd(?:\/|$)/;
/** Trailing sentence punctuation swallowed by the harness-path tail charset
 * (`… /tasks.md.` in a sentence). Trimmed from the REPORTED `match` only —
 * span and line detection are unchanged; the plan-id token charset cannot
 * carry trailing punctuation (word-bounded), so the trim is a no-op there. */
const TRAILING_SENTENCE_PUNCT_RE = /[.,;:!?]+$/;

/** True when a dated-slug token is a synthetic example form
 * (`20991231-example-plan`, `20260717-example`): any `-`-separated segment
 * equal to `example` marks fixture/template text — never reported. */
function isExampleSlug(token: string): boolean {
  return token.split("-").includes("example");
}

/** First dated-slug token in `text` that is not a synthetic example form, or
 * `null` — the dated-instance requirement a harness path must satisfy to be
 * specific (generic layout segments alone never qualify). */
function qualifyingDatedToken(text: string): string | null {
  for (const m of text.matchAll(DATED_SLUG_TOKEN_RE)) {
    if (!isExampleSlug(m[0])) return m[0];
  }
  return null;
}

/**
 * Find provenance citations in text (repo AGENTS.md "Git and local
 * artifacts": tracked code and docs must not depend on local harness
 * artifacts or disclose their provenance with real plan/iteration ids or
 * local deep paths).
 *
 * Discrimination (HARD — zero false positives on the skills corpus):
 * - `plan-id`: a dated-slug token (`20991231-<slug>`; the dated token
 *   inside `iter-20990101-<slug>` counts). Synthetic example
 *   slugs (`20991231-example-plan`, `20260717-example`) are never reported;
 *   a token followed by a `.digits` version segment (`20260908-v3.9.0`) is
 *   a version, not a plan id; placeholder shapes (`task-N-*`, `<plan-id>`,
 *   `{…}`) never match the digit-anchored form.
 * - `harness-path`: a `.mstar/…` / `.agents/…` deeplink containing a
 *   qualifying dated token — the dated instance segment carries the
 *   specificity, so generic layout lines (`.mstar/plans/`,
 *   `.mstar/status.json`, `.mstar/knowledge/<category>/`) are never
 *   reported.
 * - Attribution (single decision, shared with `findEphemeralCitations`):
 *   sdd deeplinks (first segment `sdd`, the SDD_DEEPLINK_RE face) belong to
 *   the ephemeral check exclusively; a dated token inside any harness path
 *   is reported at most once — as `harness-path` for non-sdd paths, never
 *   by this finder for sdd paths. Undated concrete path segments are out of
 *   scope (shape ambiguity — prose/review territory, like merge SHAs).
 *
 * Discovery only — a finder returning an array, same shape as
 * `findEphemeralCitations`; callers wrap findings into `ViolationResult`s.
 * Citations are reported line by line in 1-based line order, source order
 * within a line.
 */
export function findProvenanceCitations(text: string): ProvenanceCitation[] {
  const citations: ProvenanceCitation[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const found: Array<{ index: number; match: string; kind: ProvenanceCitation["kind"] }> = [];
    const pathRanges: Array<[number, number]> = [];
    for (const m of lines[i].matchAll(HARNESS_PATH_RE)) {
      const start = m.index;
      pathRanges.push([start, start + m[0].length]);
      if (SDD_DEEPLINK_PREFIX_RE.test(m[0])) continue;
      if (qualifyingDatedToken(m[0]) !== null) {
        found.push({ index: start, match: m[0], kind: "harness-path" });
      }
    }
    const inPath = (index: number) => pathRanges.some(([from, to]) => index >= from && index < to);
    for (const m of lines[i].matchAll(DATED_SLUG_TOKEN_RE)) {
      if (inPath(m.index)) continue; // owned by the path-level decision
      if (isExampleSlug(m[0])) continue;
      found.push({ index: m.index, match: m[0], kind: "plan-id" });
    }
    found.sort((a, b) => a.index - b.index);
    for (const f of found) {
      citations.push({ line: i + 1, match: f.match.replace(TRAILING_SENTENCE_PUNCT_RE, ""), kind: f.kind });
    }
  }
  return citations;
}

function hasEvidenceDetail(value: string): boolean {
  const detail = value.trim().replace(/^`+|`+$/g, "").trim();
  return detail.length > 0 && !/^(?:n\/a|none|tbd|todo|tba|unknown|skipped|not[- ]run|\.\.\.|\u2026|<[^>]+>)$/i.test(detail);
}

/**
 * Validate the declared structure of a task report's verification evidence in
 * the active (last delimited) verification round:
 *
 * - A malformed `## Verification round:` label is invalid.
 * - At most one `Verification mode: scoped-check` declaration, carrying exactly
 *   one concrete `Changed files`, `Reason`, `Check command` and `Check result`
 *   field and `Tests: N/A`.
 * - Outside that declaration, a bare `Tests: N/A` (or `Covering test file(s):
 *   N/A`) claim is invalid.
 * - A report that declares no mode and makes no bare-N/A claim is accepted.
 *
 * This checks declared structure only: it does not establish that a command
 * ran, that the declared mode fits the actual diff, or that the evidence is
 * authentic. PM/QC own applicability and evidence truth
 * (mstar-sdd/references/file-handoffs.md § Verification evidence).
 */
export function assertSddTddTriple(reportText: string): GateResult {
  const violations: ValidationResult[] = [];
  // Fix evidence is append-only. Validate the last explicitly delimited round
  // in isolation; earlier fields cannot satisfy an incomplete active report.
  const activeRound = [...reportText.matchAll(/^## Verification round:[ \t]*(.*)$/gm)].at(-1);
  if (activeRound && !hasEvidenceDetail(activeRound[1])) {
    return {
      ok: false,
      violations: [violation("medium", "lint.sdd-evidence.invalid-round", "Verification round requires a concrete label.")],
    };
  }
  const activeText = activeRound ? reportText.slice(activeRound.index! + activeRound[0].length) : reportText;
  const lines = activeText.split(/\r?\n/);
  const fields = new Map<string, string[]>();
  for (const line of lines) {
    const match = line.match(/^\s*(Verification mode|Changed files|Tests|Reason|Check command|Check result):[ \t]*(.*)$/i);
    if (match) {
      const key = match[1].toLowerCase();
      fields.set(key, [...(fields.get(key) ?? []), match[2].trim()]);
    }
  }
  const modes = fields.get("verification mode");
  if (modes) {
    if (modes.length !== 1 || modes[0] !== "scoped-check") {
      return {
        ok: false,
        violations: [violation("medium", "lint.sdd-evidence.invalid-mode", "Use exactly one Verification mode: scoped-check declaration in the active round; unknown or duplicate modes are invalid.")],
      };
    }
    for (const key of ["changed files", "tests", "reason", "check command", "check result"]) {
      const values = fields.get(key) ?? [];
      const value = values[0] ?? "";
      const valid = values.length === 1 && (key === "tests"
        ? value === "N/A"
        : hasEvidenceDetail(value));
      if (!valid) {
        violations.push(violation("medium", `lint.sdd-evidence.${key.replaceAll(" ", "-")}`, `scoped-check requires one concrete ${key} field${key === "tests" ? " with value N/A" : ""}; missing, duplicate, or placeholder evidence is invalid.`));
      }
    }
    return { ok: violations.length === 0, violations };
  }
  if (lines.some((line) => /^\s*(?:Tests|(?:Covering )?test file(?:s|\(s\))?):\s*`?N\/A`?\s*$/i.test(line))) {
    return {
      ok: false,
      violations: [violation("medium", "lint.sdd-evidence.bare-tests-na", "Bare N/A is not test evidence; document/policy checks need an explicit, complete scoped-check declaration.")],
    };
  }
  return { ok: true, violations };
}

/**
 * One placeholder occurrence found by `planQualityBar`.
 */
export type PlanQualityFinding = {
 /** Normalized token: `TBD`, `TODO`, `TBA`, or `...`. */
  token: string;
 /** 1-based line number. */
  line: number;
 /** Trimmed source line. */
  text: string;
};

/** Result of `planQualityBar`: the gate verdict plus structured findings. */
export type PlanQualityResult = GateResult & { findings: PlanQualityFinding[] };

/** Placeholder word tokens (mstar-artifacts/templates/plan.main.md
 * self-review "Placeholder scan: no TBD" + plan-quality-bar.md): TBD, TODO,
 * TBA (singular/plural) — word-boundary, case-insensitive. `FIXME`/`XXX` are
 * deliberately NOT flagged (code-marker territory, not plan placeholders). */
const PLACEHOLDER_TOKEN_RE = /\b(TBDs?|TODOs?|TBAs?)\b/gi;
/** Prose ellipsis placeholder ("a.ts, b.ts, ..."). Intentional ellipsis can
 * use U+2026 `…`, which is exempt. */
const ELLIPSIS_RE = /\.\.\./;
/** Negation words that turn a token mention into an absence assertion
 * ("no TBD/placeholder/TODO" in a constraints section states the rule rather
 * than marking a placeholder). */
const NEGATION_RE = /\b(?:no|not|without|none)\b/i;

/** Strip inline code spans (backticks) so `...` / tokens inside code are
 * exempt — file lists like `src/{core,path,...}.ts` are legitimate. */
function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, " ");
}

/**
 * Plan quality bar — placeholder scan (mstar-artifacts
 * `references/plan-quality-bar.md` § Quality checklist + `templates/
 * plan.main.md` self-review "Placeholder scan: no TBD"). Every placeholder
 * token found becomes one `lint.plan-quality.placeholder` violation whose
 * message lists the token and location.
 *
 * Heuristic (documented, conservative):
 * - tokens: `TBD`, `TODO`, `TBA` (case-insensitive, word-boundary, plural
 * forms included) and the prose ellipsis `...`. One finding per line per
 * token (a line with two TBDs yields one finding).
 * - negation guard: a token preceded by a negation word (`no/not/without/
 * none`) in the same segment (split at `(`/`[`/`{`/`.`/`;`/`,`/line
 * start) is an absence assertion ("no TBD/placeholder/TODO" states the
 * rule), not a placeholder — not flagged.
 * - exemptions: fenced code blocks (```` ``` ```` / `~~~`) and inline code
 * spans are skipped — `...` in a file-list or example is not a placeholder;
 * a leading `---`-fenced frontmatter block is skipped too (a plan's
 * `status: Todo` value is not a placeholder — issue #499 item 5).
 * - out of scope (judgment stays prompt): "add tests" without code, and
 * `FIXME`/`XXX` code markers.
 */
export function planQualityBar(planText: string): PlanQualityResult {
  const findings: PlanQualityFinding[] = [];
  const violations: ValidationResult[] = [];
  const lines = planText.split(/\r?\n/);
  // Skip a leading frontmatter block (`---` on line 1, closed by the next
  // `---`): a plan's `status:` value is not a placeholder. An unclosed fence
  // is scanned as body, and line numbers stay the file's own.
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (close !== -1) start = close + 1;
  }
  let inFence = false;
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const stripped = stripInlineCode(lines[i]);
 // Negation guard: "no TBD/placeholder/TODO" asserts absence (a mention
 // of the rule), not a placeholder. A negation word earlier in the same
 // segment (split at `(`/`[`/`{`/`.`/`;`/`,`/line start) suppresses the
 // finding — the comma split keeps "no TBD yet, and TODO items remain"
     // flagging TODO.
    const segmentStartBefore = (index: number) =>
      Math.max(
        stripped.lastIndexOf("(", index - 1),
        stripped.lastIndexOf("[", index - 1),
        stripped.lastIndexOf("{", index - 1),
        stripped.lastIndexOf(".", index - 1),
        stripped.lastIndexOf(";", index - 1),
        stripped.lastIndexOf(",", index - 1),
      );
 // Every placeholder on the line is checked — a negated first token must
 // not hide a later unnegated one ("no TBD yet, and TODO remains").
    let token: string | null = null;
    for (const wordMatch of stripped.matchAll(PLACEHOLDER_TOKEN_RE)) {
      if (wordMatch.index === undefined) continue;
      const negated = NEGATION_RE.test(stripped.slice(segmentStartBefore(wordMatch.index) + 1, wordMatch.index));
      if (!negated) {
        token = wordMatch[0].replace(/s$/i, "").toUpperCase();
        break;
      }
    }
    if (token === null && ELLIPSIS_RE.test(stripped)) {
      token = "...";
    }
    if (token !== null) {
      const text = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
      findings.push({ token, line: i + 1, text });
      violations.push(
        violation(
          "medium",
          "lint.plan-quality.placeholder",
          `placeholder token "${token}" at line ${i + 1}: "${text}"`,
          "replace the placeholder with concrete content before locking the plan (mstar-artifacts/references/plan-quality-bar.md; templates/plan.main.md placeholder scan)",
        ),
      );
    }
  }
  return { ok: violations.length === 0, violations, findings };
}

/** Workflow-summary verb list (mstar-skill-authoring § Frontmatter Contract
 * bad example: "Explains how to write plans with steps, tests, commits, and
 * review gates."). Deliberately excludes ambiguous "Contains/Includes/Offers"
 * starts — those can be legitimate trigger phrasing. */
const WORKFLOW_VERB_START_RE =
  /^(?:explains?|describes?|covers?|provides?|walks?|guides?|shows?|lists?|details?|demonstrates?|outlines?|teaches?|summarizes?)\b/i;

/** First/second-person pronouns (third-person contract). Guards:
 * - `\bI\b(?!/)` — "I/O" is a technical term, not a pronoun;
 * - all-caps `US` (acronym) is skipped;
 * - quoted/code spans are stripped before matching (user utterances like
 * "what should I improve" are quoted speech, not author voice). */
const PRONOUN_RE = /\bI\b(?!\/)|\b(?:we|you|my|our|your|us)\b/gi;

/**
 * Description length ceiling for the workflow-summary heuristic. Grounded in
 * the current corpus (2026-08-08): the longest legit trigger contract is 114
 * words (`mstar-design-md`); the threshold is set above it at 120. A
 * paragraph at/over 120 words is treated as a workflow summary that buries
 * the trigger contract. Intentional ellipsis `…` exempt; counts words after
 * trimming.
 */
const DESCRIPTION_MAX_WORDS = 120;

/**
 * Lint a skill file's frontmatter against the mstar-skill-authoring §
 * Frontmatter Contract:
 * - `name` — stable, lowercase-hyphen (`example-skill`);
 * - `description` — the trigger contract, third person, not a workflow
 * summary.
 *
 * Accepts a full document (leading `---`-fenced block is parsed) or a bare
 * frontmatter body (`name:`/`description:` lines at the start). Violations:
 * - `lint.frontmatter.missing` — no frontmatter block found
 * - `lint.frontmatter.name.missing` — `name` absent
 * - `lint.frontmatter.name.format` — `name` not lowercase-hyphen
 * - `lint.frontmatter.description.missing` — `description` absent/empty
 * - `lint.frontmatter.description.person` — first/second-person pronoun in
 * the description (third-person heuristic, low severity)
 * - `lint.frontmatter.description.workflow` — description reads as a
 * workflow summary (verb-start or paragraph-length heuristic, low
 * severity)
 *
 * Heuristics (documented, conservative; corpus regression tests in
 * lint.test.ts cover the 20 real skill frontmatters):
 * - pronouns: `I`/`we`/`you`/`my`/`our`/`your`/`us`, word-boundary,
 * case-insensitive, after stripping quoted and backticked spans; `I/`
 * (I/O) and all-caps `US` exempt.
 * - workflow shape: description starts with a workflow verb ("Explains how
 * …", "Describes …") — the contract's own bad example — or exceeds 120
 * words (corpus max 114). Bold/quote prefixes are stripped before the
 * verb check. No content judgment (e.g. whether the trigger is narrow
 * enough) — that stays prompt.
 */
export function lintSkillFrontmatter(frontmatterText: string): GateResult {
  const violations: ValidationResult[] = [];
  const fm = parseFrontmatter(frontmatterText);
  if (fm === null) {
    violations.push(
      violation(
        "medium",
        "lint.frontmatter.missing",
        "no YAML frontmatter block found \u2014 a skill file must open with a `---` fenced frontmatter (mstar-skill-authoring \u00a7 Frontmatter Contract)",
        'add a frontmatter block with `name` and `description` at the top of the file',
      ),
    );
    return { ok: false, violations };
  }

  const name = fm.name ?? "";
  if (name === "") {
    violations.push(
      violation(
        "medium",
        "lint.frontmatter.name.missing",
        "frontmatter `name` is missing \u2014 required (mstar-skill-authoring \u00a7 Frontmatter Contract)",
        'add `name: <lowercase-hyphen-id>` to the frontmatter',
      ),
    );
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    violations.push(
      violation(
        "medium",
        "lint.frontmatter.name.format",
        `frontmatter \`name\` must be lowercase-hyphen ("${name}") \u2014 e.g. example-skill (mstar-skill-authoring \u00a7 Frontmatter Contract)`,
        'rename to a stable lowercase-hyphen id, e.g. `name: example-skill`',
      ),
    );
  }

  const description = fm.description ?? "";
  if (description === "") {
    violations.push(
      violation(
        "medium",
        "lint.frontmatter.description.missing",
        "frontmatter `description` is missing \u2014 the trigger contract is required (mstar-skill-authoring \u00a7 Frontmatter Contract)",
        "add a `description:` that states when the skill loads (symptoms, context, roles, exclusions)",
      ),
    );
  } else {
    const stripped = description
      .replace(/`[^`]*`/g, " ")
      .replace(/'[^']*'/g, " ")
      .replace(/"[^"]*"/g, " ");
    let pronoun: RegExpExecArray | null = null;
    for (const m of stripped.matchAll(PRONOUN_RE)) {
      if (m[0] === "US") continue;
      pronoun = m;
      break;
    }
    if (pronoun !== null) {
      violations.push(
        violation(
          "low",
          "lint.frontmatter.description.person",
          `description uses first/second-person pronoun "${pronoun[0]}" \u2014 keep the trigger contract third person (mstar-skill-authoring \u00a7 Frontmatter Contract)`,
          'rewrite without I/we/you/my/our/your/us, e.g. "Use when the user asks \u2026"',
        ),
      );
    }
    const start = description.trim().replace(/^[*_#>]+/, "").replace(/^["'`]+/, "").trim();
    if (WORKFLOW_VERB_START_RE.test(start)) {
      violations.push(
        violation(
          "low",
          "lint.frontmatter.description.workflow",
          'description reads as a workflow summary ("Explains/Describes/Covers \u2026") \u2014 the description is the trigger contract, not a summary of steps (mstar-skill-authoring \u00a7 Frontmatter Contract)',
          'describe when to load the skill (symptoms, context, roles, exclusions) instead of summarizing its steps',
        ),
      );
    } else {
      const words = description.trim().split(/\s+/).filter(Boolean).length;
      if (words > DESCRIPTION_MAX_WORDS) {
        violations.push(
          violation(
            "low",
            "lint.frontmatter.description.workflow",
            `description is ${words} words \u2014 paragraph-length summaries bury the trigger contract (threshold ${DESCRIPTION_MAX_WORDS}, above the longest corpus description at 114 words, mstar-design-md; mstar-skill-authoring \u00a7 Frontmatter Contract)`,
            "trim the description to a scannable trigger contract and move detail into the body",
          ),
        );
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Parse the leading `---`-fenced YAML-lite frontmatter block of a skill
 * document. Returns the key→value map, or `null` when the text does not
 * start with a frontmatter block AND no `name:`/`description:` keys appear
 * in the first lines (bare-body input is still parsed). Values support
 * single-line and indented-continuation YAML, with surrounding quotes
 * stripped. Keys are lowercased.
 */
function parseFrontmatter(text: string): Record<string, string> | null {
  const body = text.replace(/^\uFEFF/, "").replace(/^\s*/, "");
  const lines = body.split(/\r?\n/);
  const fields: Record<string, string> = {};
  let inBlock = body.startsWith("---");
  for (let i = inBlock ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock && line.trim() === "---") break;
    const keyMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (keyMatch) {
      fields[keyMatch[1].toLowerCase()] = keyMatch[2].trim().replace(/^["']|["']$/g, "");
    } else if (inBlock && fields.description !== undefined) {
 // indented continuation of the description value
      fields.description = `${fields.description} ${line.trim()}`.trim();
    } else if (!inBlock && i >= 10) {
      break;
    }
  }
  if (Object.keys(fields).length === 0) return null;
  return fields;
}

/** Required STRATEGY.md sections (mstar-knowledge/references/strategy-document.md § Shape). */
const REQUIRED_STRATEGY_SECTIONS = [
  "Vision",
  "What we build",
  "What we don't build",
  "Guiding Principles",
  "Technology Direction",
  "Decision Log",
] as const;

/**
 * Lint a STRATEGY.md document for the six required section headings
 * (mstar-knowledge/references/strategy-document.md § Shape: Vision, What we
 * build, What we don't build, Guiding Principles, Technology Direction,
 * Decision Log).
 * Optional sections (Current Focus, Risks & Mitigations, Competitive
 * Context) are not required.
 *
 * Heuristic (documented, conservative): a section is a Markdown heading
 * (`#`–`######`) whose text matches a required name exactly, case-
 * insensitively, after stripping emphasis/backticks (so `## VISION`,
 * `### What We Don't Build` all count). Partial matches ("Vision (short)")
 * and other heading levels do not count. Each missing section is one
 * `lint.strategy.missing-section` violation naming the heading.
 */
export function lintStrategySections(docText: string): GateResult {
  const violations: ValidationResult[] = [];
  const headings = new Set<string>();
  for (const line of docText.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    headings.add(match[1].replace(/[*_`]/g, "").trim().toLowerCase());
  }
  for (const required of REQUIRED_STRATEGY_SECTIONS) {
    if (!headings.has(required.toLowerCase())) {
      violations.push(
        violation(
          "medium",
          "lint.strategy.missing-section",
          `missing required section "${required}" (mstar-knowledge/references/strategy-document.md \u00a7 Shape)`,
          "add a `## <Section>` heading; required: Vision, What we build, What we don't build, Guiding Principles, Technology Direction, Decision Log",
        ),
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

/* ------------------------------------------------------------------ */
/* Document layers: {SPECS_DIR} and {ADR_DIR}                          */
/* ------------------------------------------------------------------ */

/** A fence toggle line: three or more backticks or tildes, plus its info
 * string (CommonMark: at most three leading spaces; four or more is an
 * indented code block, not a fence). Shared by both document-layer checks. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Toggle line numbers (1-based) of every fence open or close. An odd count
 * means one never closed, so the document tail is hidden from every heading
 * scan. Closes only on the same character, at least as long, and with nothing
 * but whitespace after it. */
function fenceLines(text: string): number[] {
  const lines: number[] = [];
  let open: { char: string; length: number } | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const match = FENCE_OPEN_RE.exec(raw);
    if (open === null) {
      if (match === null) return;
      open = { char: match[1]![0]!, length: match[1]!.length };
      lines.push(index + 1);
      return;
    }
    if (match !== null && match[2]!.trim() === "" && match[1]![0] === open.char && match[1]!.length >= open.length) {
      lines.push(index + 1);
      open = null;
    }
  });
  return lines;
}

/** The document's lines outside fenced code blocks: a `## ` line quoted in a
 * fence is example text, not a section. */
function unfencedLines(text: string): string[] {
  const fenced = new Set<number>();
  const toggles = fenceLines(text);
  for (let index = 0; index < toggles.length; index += 2) {
    const from = toggles[index]!;
    const to = toggles[index + 1] ?? Number.MAX_SAFE_INTEGER;
    for (let line = from + 1; line < to; line++) fenced.add(line);
  }
  return text.split(/\r?\n/).filter((_, index) => !fenced.has(index + 1));
}

/** `## <Name>` level-2 headings outside fences, bare names. */
function sectionNames(text: string): string[] {
  return unfencedLines(text)
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

/** `^## <Name>` against a required or banned name: the character after the
 * name is not a word character, so `## Scope: x` counts while `## Scopes`
 * does not. */
function hasSectionName(headings: readonly string[], name: string): boolean {
  return headings.some((heading) => heading.startsWith(name) && !/\w/.test(heading.charAt(name.length)));
}

/** Required `{SPECS_DIR}` sections (knowledge-and-designs.md: a spec is the
 * current state, so its shape is fixed and reviewable). */
export const SPECS_REQUIRED_SECTIONS = [
  "Scope",
  "Current state",
  "Invariants",
  "Where it lives",
  "Change obligations",
] as const;

/** ADR-only sections a spec must not carry: a spec states the current state,
 * never one decision, its alternatives, its plan or its acceptance list. */
const SPECS_BANNED_SECTIONS = [
  "Problem",
  "Proposal",
  "Decision",
  "Alternatives considered",
  "Acceptance criteria",
  "Consequences",
  "Risks",
] as const;

/** A spec filename carrying a version suffix (`-v2.md`) or a date prefix
 * (`2026-11-09-…` / `20261109-…`): both mean the layer is keeping history
 * instead of describing the current state. */
const SPEC_NAMES = [
  { re: /-v\d+\.md$/i, why: "version suffix -v<N>" },
  { re: /^\d{4}-\d{2}-\d{2}-/, why: "date prefix" },
  { re: /^\d{8}-/, why: "date prefix" },
] as const;

/** Directory names that make a spec tree a history store (latest-only). */
const SPECS_HISTORY_DIRS: Readonly<Record<string, true>> = {
  history: true,
  archive: true,
  archived: true,
  versions: true,
};

/** Local-harness disclosure a tracked spec must not carry: an absolute local
 * path, a process-state deep path, or a plan/iteration id field. A bare
 * `{HARNESS_DIR}` candidate name (`.mstar`, `.agents`, or a resolution-chain
 * candidate under it) is product convention, not local state. */
const SPECS_LOCAL_PATHS = [
  { re: /\.(?:mstar|agents)\/(?:plans|sdd|workflows|reviews|projects|archived|store\.db|status\.json)/, why: "local harness process-state path" },
  { re: /(?:^|[\s(`])\/(?:Users|home)\/[^\s`)]+/, why: "absolute local path" },
  { re: /\bplan_id\s*:\s*(?![<{$])[\w./-]{4,}/i, why: "concrete local plan id (plan_id: <id>)" },
  { re: /\biteration_id\s*:\s*(?![<{$])[\w./-]{4,}/i, why: "concrete local iteration id (iteration_id: <id>)" },
] as const;

/**
 * Lint one `{SPECS_DIR}` document (knowledge-and-designs.md § `{SPECS_DIR}`):
 * the fixed skeleton, no ADR-only section, no version suffix or date prefix in
 * the filename, balanced fences, and no local harness path or plan/iteration
 * id. `name` is the file's basename; omit it for a pasted document.
 *
 * Factual accuracy — whether the described state still matches the code — is
 * not checkable here and stays a same-PR review duty.
 */
export function lintSpecsDoc(document: string, name?: string): GateResult {
  const violations: ValidationResult[] = [];

  if (name !== undefined) {
    const base = basename(name);
    for (const shape of SPEC_NAMES) {
      if (!shape.re.test(base)) continue;
      violations.push(
        violation(
          "medium",
          "lint.specs.name-shape",
          `${base}: filename carries a ${shape.why} - a spec describes the current state only, with no version history in the tracked layer`,
          "rename it to <topic>.md; the old version belongs in {HARNESS_DIR}/archived/specs/ (local) or nowhere - history lives in Git and ADRs",
        ),
      );
      break;
    }
  }

  const toggles = fenceLines(document);
  if (toggles.length % 2 === 1) {
    violations.push(
      violation(
        "medium",
        "lint.specs.fence-unclosed",
        `${name ?? "document"}:${toggles[toggles.length - 1]} unbalanced fences (${toggles.length} fence lines) - the tail is hidden from every section check`,
        "add the closing fence on its own line - the same fence character, as long as the opening one or longer",
      ),
    );
    return { ok: false, violations };
  }

  const headings = sectionNames(document);
  for (const required of SPECS_REQUIRED_SECTIONS) {
    if (hasSectionName(headings, required)) continue;
    violations.push(
      violation(
        "medium",
        "lint.specs.section-missing",
        `missing required section "## ${required}" (knowledge-and-designs.md, spec skeleton)`,
        `add the "## ${required}" heading; required: ${SPECS_REQUIRED_SECTIONS.join(" / ")}`,
      ),
    );
  }
  for (const banned of SPECS_BANNED_SECTIONS) {
    if (!hasSectionName(headings, banned)) continue;
    violations.push(
      violation(
        "medium",
        "lint.specs.section-banned",
        `banned ADR section "## ${banned}" on a spec - a spec states the current state, not one decision, its plan or its acceptance list`,
        `delete the "## ${banned}" section; the decision and its alternatives belong in an ADR, the plan in {PLAN_DIR}`,
      ),
    );
  }

  for (const { re, why } of SPECS_LOCAL_PATHS) {
    if (!re.test(document)) continue;
    violations.push(
      violation(
        "medium",
        "lint.specs.local-path",
        `spec discloses a ${why} - tracked specs stay repo-relative and carry no local harness state`,
        "rewrite it as a repo-relative path or a placeholder (e.g. {PLAN_DIR}); local plan and iteration ids are not spec content",
      ),
    );
  }

  return { ok: violations.length === 0, violations };
}

/** One `.md` file under a tree, as `<dir-relative path>` + text. */
type TreeDoc = { rel: string; path: string };

/**
 * Walk `dir` for `.md` files, `rel` using `/` separators. Returns `[]` for a
 * missing directory (an empty corpus is not a violation).
 */
function collectMarkdown(dir: string): TreeDoc[] {
  if (!existsSync(dir)) return [];
  const out: TreeDoc[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push({ rel: relative(dir, path).split(sep).join("/"), path });
    }
  };
  visit(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Relative Markdown link targets in `text` (no scheme, no bare anchor).
 * Reads inline links and reference definitions, and ignores fenced code so a
 * quoted example is not mistaken for a real link. */
function relativeLinks(text: string): string[] {
  const out: string[] = [];
  const take = (target: string): void => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) return;
    const clean = target.replace(/^<|>$/g, "").split("#")[0]!;
    if (clean !== "") out.push(clean);
  };
  for (const line of unfencedLines(text)) {
    for (const match of line.matchAll(/\]\(([^)\s]+)/g)) take(match[1]!);
    const definition = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(line);
    if (definition !== null) take(definition[1]!);
  }
  return out;
}

/**
 * Lint a `{SPECS_DIR}` tree (knowledge-and-designs.md § `{SPECS_DIR}`):
 * every spec sits in a `{class}/` subdirectory, the tree is latest-only (no
 * history directory), a `README.md` index exists and links every spec, and no
 * index link is dead. Each spec document is then checked by `lintSpecsDoc`.
 *
 * A missing or empty directory passes — an empty corpus is not a violation.
 */
export function lintSpecsTree(dir: string): GateResult {
  const violations: ValidationResult[] = [];
  const docs = collectMarkdown(dir);
  if (docs.length === 0) return { ok: true, violations };

  const specs = docs.filter((doc) => doc.rel !== "README.md" && !doc.rel.endsWith("/README.md"));
  for (const doc of specs) {
    const segments = doc.rel.split("/");
    const history = segments.slice(0, -1).find((segment) => SPECS_HISTORY_DIRS[segment] === true);
    if (history !== undefined) {
      violations.push(
        violation(
          "medium",
          "lint.specs.location-invalid",
          `${doc.rel}: spec sits under a history directory "${history}" - the tracked layer holds the current state only`,
          "move it to {SPECS_DIR}/<class>/<topic>.md; an old version belongs in {HARNESS_DIR}/archived/specs/ (local) or nowhere",
        ),
      );
    } else if (segments.length < 2) {
      violations.push(
        violation(
          "medium",
          "lint.specs.location-invalid",
          `${doc.rel}: spec sits at the root of the specs tree - every spec lives in a {class}/ subdirectory`,
          "move it to {SPECS_DIR}/<class>/<topic>.md and link it from README.md",
        ),
      );
    }
    for (const found of lintSpecsDoc(readFileSync(doc.path, "utf8"), doc.rel).violations) {
      violations.push({ ...found, message: `${doc.rel}: ${found.message}` });
    }
  }

  const index = docs.find((doc) => doc.rel === "README.md");
  if (index === undefined) {
    if (specs.length > 0) {
      violations.push(
        violation(
          "medium",
          "lint.specs.index-missing",
          `no README.md index in the specs tree (${specs.length} spec${specs.length === 1 ? "" : "s"} unindexed)`,
          "add {SPECS_DIR}/README.md with one relative link per spec; the table is a prose index, the catalog rows remain the registry",
        ),
      );
    }
    return { ok: violations.length === 0, violations };
  }

  const indexText = readFileSync(index.path, "utf8");
  const links = relativeLinks(indexText);
  const linked = new Set(links.map((link) => link.replace(/^\.\//, "")));
  for (const link of linked) {
    if (existsSync(join(dir, link))) continue;
    violations.push(
      violation(
        "medium",
        "lint.specs.link-missing",
        `README.md: index link "${link}" does not resolve`,
        "fix the link target or delete the row - a dead index link is worse than no index",
      ),
    );
  }
  for (const doc of specs) {
    if (linked.has(doc.rel)) continue;
    violations.push(
      violation(
        "medium",
        "lint.specs.link-missing",
        `${doc.rel}: not linked from README.md`,
        `add one row linking ${doc.rel}, or delete the spec if it no longer describes the current state`,
      ),
    );
  }

  return { ok: violations.length === 0, violations };
}

/** ADR lifecycle buckets (`mstar-doc-corpus/references/adr.md` § Directory shape). `archived`
 * is the terminal bucket: only an implemented-shaped record may enter it. */
export const ADR_BUCKETS = ["proposed", "implemented", "rejected", "archived"] as const;
export type AdrBucket = (typeof ADR_BUCKETS)[number];

/** ADR classes — the record's domain, never its fate. */
export const ADR_CLASSES = ["feature", "bug-fix", "simplification", "architecture", "process", "testing"] as const;

/** One ADR tree failure: the file relative to the tree root, the stable code,
 * the message, and a recovery string naming an executable fix. */
export type AdrLintFailure = {
  file: string;
  code:
    | "lint.adr.bucket-unknown"
    | "lint.adr.class-unknown"
    | "lint.adr.status-mismatch"
    | "lint.adr.archive-line-missing"
    | "lint.adr.section-missing"
    | "lint.adr.section-banned"
    | "lint.adr.index-forbidden"
    | "lint.adr.name-shape"
    | "lint.adr.fence-unclosed";
  message: string;
  recovery: string;
};

export type AdrLintResult = { records: number; failures: AdrLintFailure[] };

/** `yyyy-mm-dd-topic.md` — shape only, no calendar math. */
const ADR_RECORD_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** Bare Status line with the U+2014 em dash (ASCII escape: bundle-safe). */
const ADR_STATUS_LINE = /^Status: (proposed|implemented|rejected) \u2014 .+$/;

/** `Archived: YYYY-MM-DD — <reason>`: the one line that turns a fresh record
 * into a frozen snapshot. */
const ADR_ARCHIVED_LINE = /^Archived: \d{4}-\d{2}-\d{2} \u2014 .+$/;

/** Required and banned sections per bucket. `archived` reuses the implemented
 * shape: it accepts implemented records only. */
const ADR_SECTIONS: Record<AdrBucket, { required: readonly string[]; banned: readonly string[] }> = {
  proposed: {
    required: ["Problem", "Proposal", "Alternatives considered", "Acceptance criteria", "Risks"],
    banned: [],
  },
  implemented: {
    required: ["Problem", "Decision", "Alternatives considered", "Consequences"],
    banned: ["Proposal", "Plan", "Migration plan", "Acceptance criteria"],
  },
  rejected: {
    required: ["Problem", "Proposal", "Alternatives considered"],
    banned: [],
  },
  archived: {
    required: ["Problem", "Decision", "Alternatives considered", "Consequences"],
    banned: ["Proposal", "Plan", "Migration plan", "Acceptance criteria"],
  },
};

/** Where a banned implemented section's content belongs instead. */
const ADR_BANNED_RECOVERY: Record<string, string> = {
  Proposal: 'fold its text into "## Decision" in present tense, then delete the "## Proposal" heading',
  Plan: 'delete the "## Plan" section - plan text dies with the proposal',
  "Migration plan": 'delete the "## Migration plan" section - plan text dies with the proposal',
  "Acceptance criteria":
    'fold it into "## Consequences" (accepted criteria become stated behavior), then delete the "## Acceptance criteria" heading',
};

/** The status a bucket's records must declare. Only `implemented` records may
 * be archived, so the archived bucket carries the implemented status. */
const ADR_BUCKET_STATUS: Record<AdrBucket, string> = {
  proposed: "proposed",
  implemented: "implemented",
  rejected: "rejected",
  archived: "implemented",
};

/** Every line before the first level-2 ATX heading. */
function adrHeaderLines(text: string): string[] {
  const lines = unfencedLines(text);
  const end = lines.findIndex((line) => line.startsWith("## "));
  return end === -1 ? lines : lines.slice(0, end);
}

function checkAdrRecord(path: string, relPath: string, bucket: AdrBucket, push: (failure: AdrLintFailure) => void): void {
  if (!ADR_RECORD_NAME.test(basename(path))) {
    push({
      file: relPath,
      code: "lint.adr.name-shape",
      message: `${relPath}: filename is not yyyy-mm-dd-topic.md`,
      recovery:
        "rename it to yyyy-mm-dd-topic.md - a real-shaped date, then a lowercase kebab topic, e.g. 2026-01-01-example-topic.md (the date is the record's original date and never changes across a lifecycle move)",
    });
  }

  const text = readFileSync(path, "utf8");

  // An unterminated fence runs to the document end, so every later heading
  // would vanish from the check below. Refuse the record instead of scanning
  // a truncated document.
  const toggles = fenceLines(text);
  if (toggles.length % 2 === 1) {
    push({
      file: relPath,
      code: "lint.adr.fence-unclosed",
      message: `${relPath}:${toggles[toggles.length - 1]} unbalanced fences (${toggles.length} fence lines) - the record's tail is hidden from every heading check`,
      recovery:
        "add the closing fence on its own line - the same fence character, as long as the opening one or longer (a four-space indented block is not a fence to this check)",
    });
    return;
  }

  const expected = ADR_BUCKET_STATUS[bucket];
  const header = adrHeaderLines(text);
  const statusLines = header.filter((line) => line.startsWith("Status:"));
  if (statusLines.length !== 1) {
    push({
      file: relPath,
      code: "lint.adr.status-mismatch",
      message: `${relPath}: expected exactly one bare "Status: <bucket> \u2014 <why>" header line, found ${statusLines.length}`,
      recovery: `add one bare header line "Status: ${expected} \u2014 <one-line why>" before the first "## " heading`,
    });
  } else {
    const match = statusLines[0]!.match(ADR_STATUS_LINE);
    if (!match) {
      push({
        file: relPath,
        code: "lint.adr.status-mismatch",
        message: `${relPath}: malformed Status line "${statusLines[0]}"`,
        recovery: `rewrite it as "Status: ${expected} \u2014 <one-line why>" (bucket, space, U+2014 em dash, space, non-empty single line)`,
      });
    } else if (match[1] !== expected) {
      push({
        file: relPath,
        code: "lint.adr.status-mismatch",
        message: `${relPath}: Status says ${match[1]} but the record sits under ${bucket}/`,
        recovery: `move the record to docs/adr/${match[1]}/${relPath.split("/").at(-2)}/ or change the Status line to "Status: ${expected} \u2014 <one-line why>"`,
      });
    }
  }

  if (bucket === "archived") {
    // Archived is a freeze, not a fourth fate: the record keeps its implemented
    // Status line and gains exactly one Archived line.
    const archiveLines = header.filter((line) => line.startsWith("Archived:"));
    if (archiveLines.length !== 1) {
      push({
        file: relPath,
        code: "lint.adr.archive-line-missing",
        message: `${relPath}: archived record needs exactly one "Archived: YYYY-MM-DD \u2014 <reason>" header line, found ${archiveLines.length}`,
        recovery:
          'add one bare header line "Archived: <yyyy-mm-dd> \u2014 <why this record no longer guides future work>" right after the Status line; a record without historical value is deleted, not archived',
      });
    } else if (!ADR_ARCHIVED_LINE.test(archiveLines[0]!)) {
      push({
        file: relPath,
        code: "lint.adr.archive-line-missing",
        message: `${relPath}: malformed Archived line "${archiveLines[0]}"`,
        recovery: 'rewrite it as "Archived: <yyyy-mm-dd> \u2014 <reason>" (date, space, U+2014 em dash, space, non-empty single line)',
      });
    }
  }

  const headings = sectionNames(text);
  for (const name of ADR_SECTIONS[bucket].required) {
    if (hasSectionName(headings, name)) continue;
    push({
      file: relPath,
      code: "lint.adr.section-missing",
      message: `${relPath}: missing required "## ${name}" section for a ${bucket} record`,
      recovery: `add the "## ${name}" section (required for every record under ${bucket}/)`,
    });
  }
  for (const name of ADR_SECTIONS[bucket].banned) {
    if (!hasSectionName(headings, name)) continue;
    push({
      file: relPath,
      code: "lint.adr.section-banned",
      message: `${relPath}: banned "## ${name}" section on an implemented record`,
      recovery: ADR_BANNED_RECOVERY[name]!,
    });
  }
}

/**
 * Lint an ADR tree (`mstar-doc-corpus/references/adr.md` contract, one walk of the root):
 * bucket and class membership, `Status` agreeing with the directory, the
 * required and banned sections per bucket, the `Archived:` line on archived
 * records, filename shape, fence closure, and no `INDEX.md`.
 *
 * `dir` is the ADR root itself; failure paths are relative to it. Sanctioned
 * non-record files (`README.md`, `{bucket}/TEMPLATE.md`, `.gitkeep`) are
 * ignored; a missing directory passes with zero records.
 */
export function lintAdrTree(dir: string): AdrLintResult {
  const result: AdrLintResult = { records: 0, failures: [] };
  if (!existsSync(dir)) return result;

  const rel = (path: string): string => relative(dir, path).split(sep).join("/");

  for (const doc of collectMarkdown(dir)) {
    if (basename(doc.path) !== "INDEX.md") continue;
    result.failures.push({
      file: doc.rel,
      code: "lint.adr.index-forbidden",
      message: `${doc.rel}: INDEX.md must not exist under the ADR tree`,
      recovery:
        "delete it - path + directory is the index (bucket gives the fate, class gives the domain, date sorts the rest)",
    });
  }

  for (const bucketEntry of [...readdirSync(dir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!bucketEntry.isDirectory()) continue;
    const bucketDir = join(dir, bucketEntry.name);
    if (!(ADR_BUCKETS as readonly string[]).includes(bucketEntry.name)) {
      result.failures.push({
        file: rel(bucketDir),
        code: "lint.adr.bucket-unknown",
        message: `${rel(bucketDir)}: directory is not one of the four ADR buckets`,
        recovery: `move its records into one of the four legal buckets - ${ADR_BUCKETS.map((bucket) => `docs/adr/${bucket}/`).join(", ")} - and delete this directory`,
      });
      continue;
    }
    const bucket = bucketEntry.name as AdrBucket;

    for (const classEntry of [...readdirSync(bucketDir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name))) {
      // TEMPLATE.md and strays directly under a bucket are out of scope: the
      // walk covers {bucket}/{class}/ only.
      if (!classEntry.isDirectory()) continue;
      const classDir = join(bucketDir, classEntry.name);
      if (!(ADR_CLASSES as readonly string[]).includes(classEntry.name)) {
        result.failures.push({
          file: rel(classDir),
          code: "lint.adr.class-unknown",
          message: `${rel(classDir)}: directory is not one of the six ADR classes`,
          recovery: `move the record into one of the six legal classes - ${ADR_CLASSES.map((kind) => `${kind}/`).join(", ")} - and delete this directory; adding a class needs a validator change in the same PR`,
        });
        continue;
      }
      for (const recordEntry of [...readdirSync(classDir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name))) {
        // Only Markdown records are records; README.md, .gitkeep and any other
        // stray file are not fed to the record contract.
        if (!recordEntry.isFile() || !recordEntry.name.endsWith(".md") || recordEntry.name === "README.md" || recordEntry.name === ".gitkeep") continue;
        result.records++;
        const path = join(classDir, recordEntry.name);
        checkAdrRecord(path, rel(path), bucket, (failure) => result.failures.push(failure));
      }
    }
  }

  return result;
}
