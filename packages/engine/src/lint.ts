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
 * - simplify:/temporary markers: `mstar-coding-behavior` SKILL.md § Simplicity
 *   First → "Simplification markers": a deliberate shortcut with a known
 *   ceiling is marked with a `simplify:` comment naming the ceiling and the
 *   upgrade path; a workaround is labeled `simplify:` / `temporary`, explains
 *   why, and records the removal path in the plan/status artifact before the
 *   task is claimed complete.
 * - SDD TDD triple: `mstar-coding-behavior` SKILL.md § Integration Notes —
 *   completion evidence must include the TDD triple (test file(s), command,
 *   output) in `task-N-report.md`; `mstar-sdd/references/file-handoffs.md` —
 *   fix subagents append covering test file(s), command run, output.
 * - Plan quality bar: `mstar-artifacts/references/plan-quality-bar.md`
 *   § Quality checklist + `templates/plan.main.md` self-review
 *   ("Placeholder scan: no TBD").
 * - Skill frontmatter contract: `mstar-skill-authoring` SKILL.md § Frontmatter
 *   Contract — `name` stable lowercase-hyphen; `description` is the trigger
 *   contract (not a workflow summary), third person.
 * - STRATEGY.md structure: `mstar-strategy` SKILL.md § STRATEGY.md structure —
 *   six required sections.
 * - Ephemeral citations: knowledge `conventions/skill-content-porting-discipline.md`
 *   §3 ("No ephemeral citations in durable skill text") + session evaluation
 *   2026-08-16 discrimination contract — concrete task-artifact references
 *   and SDD deeplinks are ephemeral; placeholder forms are not.
 *
 * Enforcement depth: roadmap §8.5 C4 — v1 lints are non-blocking
 * `ValidationResult`s; callers surface them as warnings.
 *
 * Severity mapping: structural gaps (missing name/description/sections,
 * placeholder tokens, TDD-triple gaps, un-tracked temporary markers) are
 * `medium`; style heuristics (pronouns, workflow-summary shape) are `low`.
 */
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
 * Find `simplify:` marker comments (mstar-coding-behavior § Simplicity First
 * → "Simplification markers": a deliberate shortcut with a known ceiling —
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
 * Removal-path patterns (mstar-coding-behavior § Simplicity First: "record
 * the removal path in the plan/status artifact"). A marker satisfies the
 * convention when its line references one of these — first match wins:
 * 1. `status.json` (the plan-harness status artifact)
 * 2. `R#<n>` (residual entry)
 * 3. the word `residual` (residual tracker / notes)
 * 4. a `plans/<file>` path (e.g. `plans/20260808-x.md`)
 * 5. a dated plan id ("plan 20260808-slice2")
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
 * Simplicity First — "If a workaround is unavoidable, label it `simplify:` /
 * `temporary`, explain why, and record the removal path in the plan/status
 * artifact before claiming the task complete").
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
          `temporary marker at line ${i + 1} records no removal path (plan/status artifact reference) \u2014 record one before claiming the task complete (mstar-coding-behavior \u00a7 Simplification markers)`,
          'add a plan/status reference to the marker, e.g. "removal tracked in status.json" or "plan 20260808-slice2 removes this"',
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
 *   concrete instance → reported (`task-2-report`, `task-1.diff`).
 *   Placeholders (`task-N-brief`, `task-N-report`, `<plan-id>`,
 *   `{SDD_DIR}/task-N-report.md`) never match.
 * - `.mstar/sdd/<segment>` / `.agents/sdd/<segment>` with a concrete first
 *   segment (`20260815-x`) → reported; `<plan-id>` / `{SDD_DIR}` segments
 *   are template forms → never match.
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

/** Test-file reference: a path ending in `.test.<ext>` / `.spec.<ext>`
 * (mstar-sdd/references/file-handoffs.md "Covering test file(s)"). */
const TEST_FILE_PATH_RE = /[\w./-]+\.(?:test|spec)\.[a-z0-9]+/i;
/** Test-file reference: the template phrase "test file(s)". */
const TEST_FILE_PHRASE_RE = /\btest files?\b/i;

/** Command evidence: a `$`-prefixed shell line with content. */
const COMMAND_PROMPT_RE = /^\s*[$>]\s*\S/;
/** Command evidence: a known package-manager runner invocation
 * (`bun test`, `pnpm run …`), a `npx`/`bunx` exec, or a direct test runner
 * (`tsc`, `vitest`, `jest`, `mocha`, `pytest`, `go test`, `cargo test`). */
const RUNNER_RE =
  /\b(?:bun|pnpm|npm|yarn|npx|bunx)\s+(?:test|run|exec)\b|\b(?:npx|bunx)\s+[\w./-]+\b|\b(?:tsc|vitest|jest|mocha|pytest)\b|\bgo\s+test\b|\bcargo\s+test\b/i;

/** Output evidence: check marks, PASS/FAIL tokens, result counts ("12
 * pass", "0 fail", "23 tests passed"), `N ok` / TAP `ok N` / "all ok"
 * verdicts, or exit-code statements. Bare `OK`/`ERROR` prose ("OK, moving
 * on") deliberately does NOT count — output-shaped forms only (qc2 F-004). */
const OUTPUT_TOKEN_RE =
  /[\u2713\u2714\u2717\u2718]|\b(?:PASS|FAIL)\b|\b\d+\s+(?:pass(?:es|ed)?|fail(?:s|ed|ing)?|skipped|tests?|ok)\b|\bok\s+\d+\b|\ball\s+ok\b|exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?\d+/i;

/**
 * Assert the SDD TDD triple is present in a `task-N-report.md` text
 * (mstar-coding-behavior § Integration Notes — "completion evidence must
 * include TDD triple — test file(s), command, output — in task-N-report.md";
 * mstar-sdd/references/file-handoffs.md — fix subagents append covering test
 * file(s), command run, output).
 *
 * One violation per missing part:
 * - `lint.sdd-tdd.missing-tests` — no test file reference
 * - `lint.sdd-tdd.missing-command` — no runnable command
 * - `lint.sdd-tdd.missing-output` — no output evidence
 *
 * Heuristics (documented, conservative — tuned so prose alone never counts):
 * - tests: a `.test.<ext>` / `.spec.<ext>` path, or the phrase "test file(s)"
 *   (the handoff template's exact header). "I added tests" without a file or
 *   the phrase does not count.
 * - command: a `$`-prefixed line, or a known runner invocation (bun/pnpm/
 *   npm/yarn/npx/bunx test|run|exec, npx/bunx exec, tsc/vitest/jest/mocha/
 *   pytest/go test/cargo test). Prose "run the tests" names no runner and
 *   does not count (plan-quality-bar marks it a weak step anyway).
 * - output: check marks, PASS/FAIL tokens, counts ("12 pass"), `N ok` /
 *   TAP `ok N` / "all ok" verdicts, exit-code statements. Bare prose
 *   `OK`/`ERROR` ("OK, moving on") does NOT count — output evidence must
 *   look like output. Line-based and fence-insensitive: real output usually
 *   lives in fenced blocks, so fence content is scanned too.
 */
export function assertSddTddTriple(reportText: string): GateResult {
  const violations: ValidationResult[] = [];
  const lines = reportText.split(/\r?\n/);
  let hasTests = false;
  let hasCommand = false;
  let hasOutput = false;
  for (const line of lines) {
    if (!hasTests && (TEST_FILE_PATH_RE.test(line) || TEST_FILE_PHRASE_RE.test(line))) hasTests = true;
    if (!hasCommand && (COMMAND_PROMPT_RE.test(line) || RUNNER_RE.test(line))) hasCommand = true;
    if (!hasOutput && OUTPUT_TOKEN_RE.test(line)) hasOutput = true;
    if (hasTests && hasCommand && hasOutput) break;
  }
  if (!hasTests) {
    violations.push(
      violation(
        "medium",
        "lint.sdd-tdd.missing-tests",
        "task report carries no test file reference \u2014 the TDD triple needs covering test file(s) (mstar-coding-behavior \u00a7 Integration Notes; mstar-sdd/references/file-handoffs.md)",
        'add a "Covering test file(s): <path>.test.ts" line or a `.test.<ext>` path to the report',
      ),
    );
  }
  if (!hasCommand) {
    violations.push(
      violation(
        "medium",
        "lint.sdd-tdd.missing-command",
        "task report carries no command \u2014 the TDD triple needs the exact command run (mstar-coding-behavior \u00a7 Integration Notes; mstar-sdd/references/file-handoffs.md)",
        'add a "Command run: `bun test <file>`" line to the report',
      ),
    );
  }
  if (!hasOutput) {
    violations.push(
      violation(
        "medium",
        "lint.sdd-tdd.missing-output",
        "task report carries no output evidence \u2014 the TDD triple needs the run output (pass/fail counts or exit code) (mstar-coding-behavior \u00a7 Integration Notes; mstar-sdd/references/file-handoffs.md)",
        "paste the test-run output (e.g. \"12 pass / 0 fail\") into the report",
      ),
    );
  }
  return { ok: violations.length === 0, violations };
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
 *   forms included) and the prose ellipsis `...`. One finding per line per
 *   token (a line with two TBDs yields one finding).
 * - negation guard: a token preceded by a negation word (`no/not/without/
 *   none`) in the same segment (split at `(`/`[`/`{`/`.`/`;`/`,`/line
 *   start) is an absence assertion ("no TBD/placeholder/TODO" states the
 *   rule), not a placeholder — not flagged.
 * - exemptions: fenced code blocks (```` ``` ```` / `~~~`) and inline code
 *   spans are skipped — `...` in a file-list or example is not a placeholder.
 * - out of scope (judgment stays prompt): "add tests" without code, and
 *   `FIXME`/`XXX` code markers.
 */
export function planQualityBar(planText: string): PlanQualityResult {
  const findings: PlanQualityFinding[] = [];
  const violations: ValidationResult[] = [];
  const lines = planText.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
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
    // flagging TODO (qc2 F-005).
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
 *   "what should I improve" are quoted speech, not author voice). */
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
 *   summary.
 *
 * Accepts a full document (leading `---`-fenced block is parsed) or a bare
 * frontmatter body (`name:`/`description:` lines at the start). Violations:
 * - `lint.frontmatter.missing` — no frontmatter block found
 * - `lint.frontmatter.name.missing` — `name` absent
 * - `lint.frontmatter.name.format` — `name` not lowercase-hyphen
 * - `lint.frontmatter.description.missing` — `description` absent/empty
 * - `lint.frontmatter.description.person` — first/second-person pronoun in
 *   the description (third-person heuristic, low severity)
 * - `lint.frontmatter.description.workflow` — description reads as a
 *   workflow summary (verb-start or paragraph-length heuristic, low
 *   severity)
 *
 * Heuristics (documented, conservative; corpus regression tests in
 * lint.test.ts cover the 20 real skill frontmatters):
 * - pronouns: `I`/`we`/`you`/`my`/`our`/`your`/`us`, word-boundary,
 *   case-insensitive, after stripping quoted and backticked spans; `I/`
 *   (I/O) and all-caps `US` exempt.
 * - workflow shape: description starts with a workflow verb ("Explains how
 *   …", "Describes …") — the contract's own bad example — or exceeds 120
 *   words (corpus max 114). Bold/quote prefixes are stripped before the
 *   verb check. No content judgment (e.g. whether the trigger is narrow
 *   enough) — that stays prompt.
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

/** Required STRATEGY.md sections (mstar-strategy § STRATEGY.md structure). */
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
 * (mstar-strategy § STRATEGY.md structure: Vision, What we build, What we
 * don't build, Guiding Principles, Technology Direction, Decision Log).
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
          `missing required section "${required}" (mstar-strategy \u00a7 STRATEGY.md structure)`,
          "add a `## <Section>` heading; required: Vision, What we build, What we don't build, Guiding Principles, Technology Direction, Decision Log",
        ),
      );
    }
  }
  return { ok: violations.length === 0, violations };
}
