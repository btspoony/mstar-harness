/**
 * Engine lint module — deterministic lint checks ported from skill prose.
 *
 * Roadmap §8.2 `lint` row + §4.5 Lint layer (bounded marker presence; SDD TDD
 * triple in completion reports; plan-quality-bar checks; skill frontmatter
 * contract; STRATEGY.md required sections). Skill text stays the semantic
 * SSOT (roadmap D5) — this module implements the deterministic subset and
 * never forks semantics.
 *
 * Spec sources (each function cites the source section):
 * - Marker bounds and shapes: `mstar-coding-behavior/references/comments.md`
 * § Markers — a deliberate shortcut is `simplify:` or its spelling
 * `shortcut:`, naming the ceiling and one bound (`upgrade: <when>` or a
 * tracking reference); a workaround is `temporary:` with its removal path.
 * SKILL.md § Decision Rules keeps the workaround sentence alone.
 * - Commented-out code and ownerless TODO: `skills/mstar-coding-behavior/
 * references/comments.md` § MUST NOT — the file's history is the archive, and
 * a marker with no issue reference, key or removal path holds nobody.
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
 * Enforcement depth: roadmap §8.5 C4 — every check here returns a
 * `ValidationResult`; the caller decides the severity. `mstar lint --type code`
 * treats a missing simplify upgrade path and a missing temporary removal path
 * as violations, and an untracked TODO or commented-out block as an advisory
 * marker.
 *
 * Severity mapping: structural gaps (missing name/description/sections,
 * placeholder tokens, TDD-triple gaps, un-tracked temporary markers) are
 * `medium`; style heuristics (pronouns, workflow-summary shape) are `low`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import vm from "node:vm";
import { SOURCE_CODE, SOURCE_COMMENT, maskLiterals, scanSource } from "./comment-scan.js";
import type { SourceDialect } from "./comment-scan.js";
import type { GateResult, Severity, ValidationResult } from "./core.js";
import {
  DocumentFrontmatterError,
  extractFrontmatterAndBody,
  parseDocumentFrontmatter,
  type JsonObject,
} from "./document-frontmatter.js";
import { validateDocumentFrontmatterExtraction } from "./document-schema.js";

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

/**
 * why: the comment gate's code face is ONE list. The CLI collector builds its
 * extension map from it and the CI selector's `grep -zE` pattern is asserted
 * against it, so a language cannot be added to one side and silently missed by
 * the other — the failure mode a duplicated literal produced.
 */
export const CODE_FILE_EXTENSIONS: readonly string[] = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".sh", ".bash", ".zsh", ".rb", ".java", ".kt", ".swift",
];

/** why: comment syntax follows the language, so the caller's file name decides
 * the dialect. Python, shell and Ruby read `#` and treat `//` as arithmetic or
 * a path; everything else keeps the C rules the lint has always applied. */
export function sourceDialect(file: string): SourceDialect {
  return /\.(?:py|sh|bash|zsh|rb)$/i.test(file) ? "hash" : "c";
}

/** Comment-introducer prefixes before a marker word (line-level scan):
 * `//`, `/*`, `*` (block-comment continuation — must be preceded by
 * whitespace so regex quantifiers like `\s*temporary` are not read as
 * markers), `#` (shell/YAML/TOML), `;` (Lisp-ish), `--` (SQL). The comment
 * context guard keeps prose lines that merely contain "simplify:" /
 * "temporary" out of the marker set. */
const COMMENT_INTRODUCER = "(?:\\/\\/|\\/\\*|#|;|--|\\s\\*)";

/**
 * A bounded-shortcut marker found in a file, with its 1-based line number, the
 * trimmed comment line (lint reporting), which label opened it, and the
 * recorded bound — an `upgrade:` clause or a removal/tracking reference
 * (`null` when the marker names neither). `shortcut:` and `simplify:` are the
 * same label under two spellings: both record a ceiling and a bound.
 */
export type SimplifyMarker = { line: number; text: string; label: "simplify" | "shortcut"; bound: string | null };

/** The `upgrade:` clause of a bounded shortcut (comments.md § Markers: a
 * `simplify:` marker records a ceiling and a bound). Line-scoped: the clause
 * never spans a newline. The colon is required, and so is a value after it —
 * a bare "upgrade" word or an empty "upgrade:" states no plan. */
const UPGRADE_PATH_RE = /\bupgrade\s*:[^\n;,]*/i;
/** The value of the clause's own line, or `null` when the colon closes the
 * line (the value may continue on the next comment line). */
const UPGRADE_TAIL_RE = /^\s*([^\n;,]*)/;

/**
 * Find bounded-shortcut marker comments (mstar-coding-behavior § Decision
 * Rules: a deliberate shortcut with a known ceiling —
 * global lock, O(n²) scan, naive heuristic — is marked with a `simplify:`
 * comment naming the ceiling and the upgrade path; comments.md § Markers
 * spells the same label `simplify:` or `shortcut:`).
 *
 * Heuristic (documented, conservative): the token `simplify:` / `shortcut:`
 * appears inside a comment — case-insensitive, any column, mid-sentence
 * included — and is not a quoted mention of the label (`` `simplify:` ``,
 * `"simplify:"`). String and regex literals are masked first, so a fixture
 * quoting a marker is not read as one, and prose outside a comment carries no
 * marker at all. The bound is searched across the marker's whole comment
 * block, because the house style writes it on a continuation line.
 */
export function findSimplifyMarkers(fileText: string, dialect: SourceDialect = "c"): SimplifyMarker[] {
  const lines = fileText.split(/\r?\n/);
  const masked = maskLiterals(fileText, dialect).split(/\r?\n/);
  const scan = scanSource(fileText, dialect);
  const offsets = lineOffsets(fileText);
  const commentOnly = commentOnlyLines(lines, scan, offsets, dialect);
  const markers: SimplifyMarker[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = SIMPLIFY_TOKEN_RE.exec(lines[i]);
    if (match === null) continue;
    if (!isCommentContext(scan, offsets[i], match.index, masked[i], dialect)) continue;
    if (QUOTE_CHARS[lines[i][match.index - 1]] === true) continue;
    markers.push({
      line: i + 1,
      text: lines[i].trim(),
      label: match[1]!.toLowerCase() as SimplifyMarker["label"],
      bound: commentBlockBound(lines, masked, commentOnly, i, match.index, scan, offsets, dialect),
    });
  }
  return markers;
}

/** The bound-label tokens: the label plus the space that opens its ceiling
 * text. `simplify:/temporary` (a prose mention of both labels) is not one, and
 * the captured group names which of the two labels opened the marker. */
const SIMPLIFY_TOKEN_RE = /\b(simplify|shortcut)\s*:(?=\s|$)/i;
/** A quote character immediately before the token turns it into a mention of
 * the label, never a marker. */
const QUOTE_CHARS: Readonly<Record<string, true>> = { "`": true, '"': true, "'": true };

/** Offset of every line start in `text` (1-based line N is `offsets[N - 1]`). */
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** why: a line-leading introducer the C-family scanner does not classify, so such a
 * line is comment content the block search may read. `--` requires following
 * whitespace: `--x` in C-family code is a decrement, not a comment. The `;`
 * form exists only for the non-C dialect (asm/Lisp): in C-family code it ends a
 * statement, so `; TODO later` is code, not comment. */
const LINE_COMMENT_ONLY_RE = /^\s*(?:#|;|--(?=\s|$))/;
const LINE_COMMENT_ONLY_C_RE = /^\s*(?:#|--(?=\s|$))/;

/** why: one gate for every `;` introducer below - the statement terminator of
 * C-family code is a comment introducer only outside that dialect. */
function semicolonIntroducesComment(dialect: SourceDialect): boolean {
  return dialect === "hash";
}

/** why: the dialect's variant of an introducer pattern pair that differs only by
 * `;` - the ONE place that variant is chosen, so the predicate above governs all
 * four `;` paths instead of four inline comparisons agreeing by luck. */
function introducerPattern(dialect: SourceDialect, cFamily: RegExp, nonC: RegExp): RegExp {
  return semicolonIntroducesComment(dialect) ? nonC : cFamily;
}

/** Per-line "comment-only" flag: the line carries comment content and no code.
 * A marker's comment block is the maximal run of adjacent lines that are
 * comment-only, plus the marker line itself. */
function commentOnlyLines(lines: readonly string[], scan: Uint8Array, offsets: readonly number[], dialect: SourceDialect = "c"): boolean[] {
  const introducer = introducerPattern(dialect, LINE_COMMENT_ONLY_C_RE, LINE_COMMENT_ONLY_RE);
  return lines.map((line, index) => {
    const base = offsets[index];
    let hasComment = false;
    for (let i = 0; i < line.length; i++) {
      if (/\s/.test(line[i])) continue;
      if (scan[base + i] !== SOURCE_COMMENT) return introducer.test(line);
      hasComment = true;
    }
    return hasComment;
  });
}

/** why: introducers that open a comment after code on the same line. The match is
 * read from the masked line, so a `#` or `//` inside a literal starts
 * nothing. `--` requires following whitespace: `--x` is a decrement, and `;`
 * opens nothing in a C-family file (it ends the statement). */
const TRAILING_INTRODUCER_HASH_RE = /\/\/|\/\*|#|;|--(?=\s|$)/g;
const TRAILING_INTRODUCER_RE = /\/\/|\/\*|#|--(?=\s|$)/g;

/** The last introducer at or before `before` in `maskedLine`, or -1. The
 * marker line of a trailing marker carries code the scanner classifies
 * SOURCE_CODE, so its comment text starts at this introducer, not at a
 * SOURCE_COMMENT span. */
function introducerBefore(maskedLine: string, before: number, dialect: SourceDialect = "c"): number {
  let found = -1;
  const pattern = introducerPattern(dialect, TRAILING_INTRODUCER_RE, TRAILING_INTRODUCER_HASH_RE);
  for (const match of maskedLine.matchAll(pattern)) {
    if (match.index > before) break;
    found = match.index;
  }
  return found;
}

/** End (exclusive) of the comment run starting at `from`: the scanner stops
 * marking comment content at the first code character, so code following a
 * closed block comment never joins the text (a marker's block comment cannot
 * borrow a bound from the string literal after it). */
function commentRunEnd(line: string, from: number, scan: Uint8Array, base: number): number {
  let end = from;
  while (end < line.length && scan[base + end] === SOURCE_COMMENT) end += 1;
  return end;
}

/** One line's comment text: the whole line when it is comment-only, otherwise
 * the tail from the comment introducer before `before` (or from the scanner's
 * first comment character), cut where the scanner returns to code. A non-C
 * introducer opens a comment to end of line, so its tail is never cut. Code is
 * never a bound, so a code line without a comment contributes nothing. */
function commentLineText(line: string, maskedLine: string, commentOnly: boolean, scan: Uint8Array, base: number, before: number, dialect: SourceDialect = "c"): string {
  if (commentOnly) return line;
  let start = introducerBefore(maskedLine, before, dialect);
  if (start === -1) {
    // No introducer on the line: start at the scanner's first comment character.
    start = -1;
    for (let i = 0; i < line.length && start === -1; i++) {
      if (scan[base + i] === SOURCE_COMMENT) start = i;
    }
    if (start === -1) return "";
  }
  // A non-C introducer (`#`, `;`, `--`) is code to the scanner, and it opens a
  // comment for the whole rest of the line: a `/* ... */` inside that text is
  // content, so it neither ends the tail nor earns a close strip.
  if (scan[base + start] !== SOURCE_COMMENT) return line.slice(start);
  const run = line.slice(start, commentRunEnd(line, start, scan, base));
  // A block-comment close is delimiter, not text; a `//` run has no close, so
  // its `*/` is content the bound search must keep. The run's start may sit
  // inside the comment (`;` / `#` / `--` in the body), so read the opener from
  // the beginning of the comment run itself.
  let runBegin = start;
  while (runBegin > 0 && scan[base + runBegin - 1] === SOURCE_COMMENT) runBegin -= 1;
  return line.startsWith("/*", runBegin) ? run.replace(/\*\/\s*$/, "") : run;
}

/** The comment text of the block around line `index`: the maximal run of
 * adjacent comment-only lines that contains it, plus the marker line itself,
 * each reduced to its comment content. `before` is the marker's column, so a
 * trailing marker's line keeps the comment tail that holds its bound. */
function commentBlockText(lines: readonly string[], masked: readonly string[], commentOnly: readonly boolean[], index: number, before: number, scan: Uint8Array, offsets: readonly number[], dialect: SourceDialect = "c"): string {
  let start = index;
  while (start > 0 && commentOnly[start - 1]) start -= 1;
  let end = index;
  while (end + 1 < lines.length && commentOnly[end + 1]) end += 1;
  const parts: string[] = [];
  for (let i = start; i <= end; i++) {
    parts.push(commentLineText(lines[i], masked[i], commentOnly[i], scan, offsets[i], i === index ? before : Infinity, dialect));
  }
  return parts.join("\n");
}

/** The bound recorded for the marker on line `index`: the first `upgrade:`
 * clause or removal/tracking reference anywhere in its comment block. A
 * clause with nothing after its colon keeps reading on the next comment line,
 * because house style wraps a long bound; the block is already comment-only
 * text, so the continuation cannot be code. */
function commentBlockBound(lines: readonly string[], masked: readonly string[], commentOnly: readonly boolean[], index: number, before: number, scan: Uint8Array, offsets: readonly number[], dialect: SourceDialect = "c"): string | null {
  const block = commentBlockText(lines, masked, commentOnly, index, before, scan, offsets, dialect);
  const clause = UPGRADE_PATH_RE.exec(block);
  if (clause !== null) {
    const tail = UPGRADE_TAIL_RE.exec(clause[0].slice(clause[0].indexOf(":") + 1));
    if (tail !== null && tail[1].trim() !== "") return clause[0].trim();
    const continuation = block.slice(clause.index + clause[0].length).split("\n")
      .map((line) => line.replace(/^\s*(?:\/\/|\/\*|\*|#|;|--)\s*/, "").trim())
      .find((line) => line !== "");
    if (continuation !== undefined) return `${clause[0].trim()} ${continuation}`;
  }
  for (const pattern of REMOVAL_PATH_PATTERNS) {
    const reference = pattern.exec(block);
    if (reference !== null) return reference[0];
  }
  return null;
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
 * Bound patterns (mstar-coding-behavior § Decision Rules: "record the removal
 * path in the plan/status artifact"). A marker satisfies the bound when its
 * comment block references one of these — first match wins:
 * 1. `status.json` (the plan-harness status artifact)
 * 2. `R#<n>` (residual entry) or `residual R<n>`
 * 3. `#<n>` (issue reference, the form comments.md lists)
 * 4. a `plans/<file>` path (e.g. `plans/20991231-example.md`)
 * 5. a dated plan id ("plan 20991231-example-plan")
 * 6. "tracked/recorded/logged/scheduled/listed/noted in <artifact>"
 * 7. an explicit "removal path: <artifact>" label
 *
 * A bare `residual` word is NOT one: it is ordinary prose in a comment that
 * discusses residuals, so it bounds nothing. The pattern requires the entry
 * id ("residual R7").
 */
const REMOVAL_PATH_PATTERNS: readonly RegExp[] = [
  /status\.json/i,
  /R#\d+/i,
  /\bresiduals?\s+R[#-]?\w*\d+/i,
  /#\d+/,
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
 * where the word `temporary` (case-insensitive, word-boundary — so
 * "temporarily" is not a label) opens a label — a colon or a spaced dash.
 * That shape is what separates the label from the ordinary adjective: "a
 * temporary file", "TEMPORARY table" and "it is a temporary measure" carry no
 * label delimiter and are never markers. String and template literals are
 * masked first, so a fixture quoting a marker is not read as one. Removal-path
 * detection uses the pattern set above across the marker's whole comment block;
 * a version mention alone ("remove in v2.0.0") is NOT a plan/status artifact
 * reference and is reported, per the strict convention wording.
 */
export function findTemporaryMarkers(fileText: string, dialect: SourceDialect = "c"): TemporaryMarkerResult {
  const markers: TemporaryMarker[] = [];
  const violations: ValidationResult[] = [];
  const re = new RegExp(`${COMMENT_INTRODUCER}\\s*temporary\\b(?:\\s*:|\\s[\\u2013\\u2014-]\\s)`, "i");
  const lines = fileText.split(/\r?\n/);
  const masked = maskLiterals(fileText, dialect).split(/\r?\n/);
  const scan = scanSource(fileText, dialect);
  const offsets = lineOffsets(fileText);
  const commentOnly = commentOnlyLines(lines, scan, offsets, dialect);
  for (let i = 0; i < lines.length; i++) {
    const labelled = re.exec(masked[i]);
    if (labelled === null) continue;
    // why: the label is judged at its own token, like the simplify label - a
    // statement terminator before it ends the code, it opens no comment.
    if (!isCommentContext(scan, offsets[i], labelled.index + labelled[0].toLowerCase().indexOf("temporary"), masked[i], dialect)) continue;
    const text = lines[i].trim();
    const block = commentBlockText(lines, masked, commentOnly, i, labelled.index, scan, offsets, dialect);
    let removalPath: string | null = null;
    for (const pattern of REMOVAL_PATH_PATTERNS) {
      const match = pattern.exec(block);
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

/** Comment-only line; a run of these is one candidate block. Triple-slash
 * directives (`/// <reference ... />`) are excluded — a directive, not code
 * kept in a comment. */
const COMMENT_ONLY_RE = /^\s*\/\/(?!\/)/;
/** The `//` prefix plus at most one following space, so the body reads as the
 * author wrote it. */
const COMMENT_PREFIX_RE = /^\s*\/\/ ?/;
/** A statement terminator. A label (`TODO: later`) or a bare word is not code. */
const STATEMENT_TERMINATOR_RE = /[;}]$/;
/** A prose label that happens to parse as a labeled statement: `name: value;`
 * where the body is a bare reference — no call, assignment or operator, so the
 * statement does nothing and no one keeps it as code. */
const PROSE_LABEL_RE = /^\s*[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$][\w$.]*\s*;\s*$/;

/**
 * Does this text compile as a program? `vm.Script` parses without running it,
 * which is the real-parser gate a line regex cannot provide: wrapped prose,
 * section headings and label-only comments fail it, commented statements pass.
 * It behaves identically under Bun and Node, so the tests prove the shipped
 * behaviour without an AST package in the engine bundle.
 *
 * shortcut: TypeScript-only syntax (`: T` annotations, `export`, top-level
 * `return`) is not a script, so those commented blocks stay unreported.
 * upgrade: a TypeScript parser, once one fits the shipped engine bundle.
 */
function parsesAsScript(text: string): boolean {
  try {
    new vm.Script(text);
    return true;
  } catch {
    return false;
  }
}

/** A commented-out code block: the 1-based line where its comment run starts,
 * and that run's first line (reporting). */
export type CommentedCodeFinding = { line: number; text: string };

/**
 * Find commented-out code (comments.md § MUST NOT: "commented-out code — it is
 * a live sample that the pattern is current; the file's history is the
 * archive"). Each run of consecutive `//`-only lines is stripped and parsed as
 * one program; a run that ends in a statement terminator and compiles is code
 * kept in a comment, reported at its first line. The run is detected on the
 * masked view, so a `//` line inside a string or template literal (a fixture
 * asserting this very check) is not a comment.
 */
export function findCommentedCode(fileText: string, dialect: SourceDialect = "c"): CommentedCodeFinding[] {
  if (dialect === "hash") return [];
  const findings: CommentedCodeFinding[] = [];
  const lines = fileText.split(/\r?\n/);
  const masked = maskLiterals(fileText).split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (!COMMENT_ONLY_RE.test(masked[i])) {
      i += 1;
      continue;
    }
    const start = i;
    const body: string[] = [];
    while (i < lines.length && COMMENT_ONLY_RE.test(masked[i])) {
      body.push(lines[i].replace(COMMENT_PREFIX_RE, ""));
      i += 1;
    }
    const text = body.join("\n").trimEnd();
    if (PROSE_LABEL_RE.test(text)) continue;
    if (!STATEMENT_TERMINATOR_RE.test(text) || !parsesAsScript(text)) continue;
    findings.push({ line: start + 1, text: body.find((line) => line.trim() !== "")?.trim() ?? "" });
  }
  return findings;
}

/** Tracking references that satisfy the ownerless-TODO rule (comments.md
 * § MUST NOT "an ownerless TODO": "no name, issue reference or removal path
 * means nobody removes it") — an `@name`, an issue number `#123`, an explicit
 * issue/ticket/ADR reference, or the removal-path vocabulary a `temporary`
 * marker already accepts. A named owner in the marker's paren
 * (`TODO(alice)`) is checked against the stop words below, and a bare
 * `KEY-<n>` shape is NOT accepted: it also matches standard and encoding names
 * (`UTF-8`, `SHA-256`, `ISO-8601`), which would exempt exactly the TODO
 * comments most likely to linger. */
const TODO_TRACKING_PATTERNS: readonly RegExp[] = [
  /\b(?:TODO|FIXME)\s+@[A-Za-z][\w.-]*/,
  /#\d+/,
  /\b(?:issue|ticket)\s+#?\d+\b/i,
  /\bADR[-\s]\d+\b/,
  ...REMOVAL_PATH_PATTERNS,
];

/** The paren bodies of the markers (`TODO(alice)`) : the only candidate for a
 * name, since the body shape alone cannot tell one from filler — `TODO(later)`
 * reads identically. A line may carry several (`TODO(later) then TODO(alice)`),
 * so every body is inspected, not just the first. */
const TODO_PAREN_OWNER_RE = /\b(?:TODO|FIXME)\(\s*([A-Za-z][\w.-]*)\s*\)/g;

/** Words that fit the paren body without naming anyone: `TODO(later)` says
 * when, `TODO(note)` says what, and none of them holds an owner. */
const TODO_NON_OWNER_WORDS: ReadonlySet<string> = new Set([
  "later", "see", "note", "none", "fix", "todo", "tbd", "soon",
]);

/** True when the marker text carries a tracking reference — a named owner in
 * its parens, an `@name`, an issue reference, or a removal path. */
function hasTrackingReference(text: string): boolean {
  for (const owner of text.matchAll(TODO_PAREN_OWNER_RE)) {
    if (!TODO_NON_OWNER_WORDS.has(owner[1].toLowerCase())) return true;
  }
  return TODO_TRACKING_PATTERNS.some((pattern) => pattern.test(text));
}

/** A TODO/FIXME comment carrying no tracking reference, at its 1-based line. */
export type UntrackedTodo = { line: number; marker: "TODO" | "FIXME"; text: string };

/** why: whitespace on both sides keeps `x = 1; TODO` (a statement), `#TODO`
 * (a private field) and `--x` (a decrement) out; `;` is absent because
 * C-family code ends a statement there, so the standalone form would read
 * `let a = 1 ; TODO`, or any later marker on that line, as comment content. */
const STANDALONE_NON_C_INTRODUCER_RE = /(?:^|\s)(?:#|--)\s/;

/**
 * why: the marker only counts as comment content when the scanner or an
 * introducer opens a comment before it, so an identifier named after the
 * marker (a declaration, a map key, a private field `#TODO = 1`) is neither.
 * Two fallbacks decide the scanner-missed case, and both are dialect-gated:
 * the line-leading introducer (`#`, `;`, `--`, where only the non-C dialect
 * may read `;` as one) and the standalone introducer before the marker
 * (`STANDALONE_NON_C_INTRODUCER_RE`). A `;` in a C-family file therefore opens
 * nothing, here and in `opensCommentContent`.
 * shortcut: a trailing `#TODO` with no space after its introducer is not
 * detected. upgrade: a per-extension tokenizer, when one fits the bundle.
 */
function isCommentContext(scan: Uint8Array, base: number, at: number, maskedLine: string, dialect: SourceDialect = "c"): boolean {
  if (scan[base + at] === SOURCE_COMMENT) return true;
  if (scan[base + at] !== SOURCE_CODE) return false;
  if (introducerPattern(dialect, LINE_COMMENT_ONLY_C_RE, LINE_COMMENT_ONLY_RE).test(maskedLine)) return true;
  return STANDALONE_NON_C_INTRODUCER_RE.test(maskedLine.slice(0, at));
}

/**
 * Find `TODO` / `FIXME` comments with no tracking reference, so nobody is held
 * to them (comments.md § MUST NOT "an ownerless TODO"). Every marker token on
 * the line is matched and judged on its own, so neither the introducer distance
 * nor a code-context marker earlier on the line decides detection; a line is
 * reported once. Markers are matched case-sensitively in comment context: the
 * convention is uppercase, and lowercase prose ("the todo list") is not a
 * marker.
 */
export function findUntrackedTodos(fileText: string, dialect: SourceDialect = "c"): UntrackedTodo[] {
  const findings: UntrackedTodo[] = [];
  const re = /\b(TODO|FIXME)\b/g;
  const lines = fileText.split(/\r?\n/);
  const masked = maskLiterals(fileText, dialect).split(/\r?\n/);
  const scan = scanSource(fileText, dialect);
  const offsets = lineOffsets(fileText);
  for (let i = 0; i < lines.length; i++) {
    const commentContext = masked[i];
    // Each marker on the line is judged on its own: a code identifier earlier
    // on the line (`class A { #TODO = 1; } // TODO: …`) must not hide a real
    // comment marker after it.
    for (const match of commentContext.matchAll(re)) {
      if (!isCommentContext(scan, offsets[i], match.index, commentContext, dialect)) continue;
      // why: the marker must open the comment content, so prose that merely
      // names it ("the TODO rule") is not a task.
      if (!opensCommentContent(commentContext, match.index, scan, offsets[i]!, dialect)) continue;
      if (hasTrackingReference(commentContext)) break;
      findings.push({ line: i + 1, marker: match[1] as UntrackedTodo["marker"], text: lines[i].trim() });
      break;
    }
  }
  return findings;
}

/** A comment that matches no allowed shape: the 1-based lines it spans (a block
 * is one comment, so the changed-line gate reads the whole span) and its first
 * line's trimmed source text (reporting). */
export type UnclassifiedComment = { line: number; endLine: number; text: string };

/** see skills/mstar-coding-behavior/references/comments.md § MUST — the pointer
 * arms the linter can machine-resolve: a repo path it looks up, or an external
 * URL a reviewer can open. Shared with `findCommentPointers` so an accepted
 * shape is always a resolved claim, and case-sensitive so a spelling the shape
 * accepts is exactly one the finder resolves. */
const POINTER_PATH_SOURCE = "(?:\\.\\/)?(?:docs|skills|packages|scripts)\\/[\\w./-]*[\\w/-]";
const POINTER_URL_SOURCE = "https?:\\/\\/[^\\s)]+";

/** see skills/mstar-coding-behavior/references/comments.md § MUST: four shapes —
 * a bounded marker, a contract pointer, @generated, or a tracked TODO. Anything
 * else is a restatement, a stale note or a changelog line. */
const COMMENT_SHAPES: readonly RegExp[] = [
  // why: the bounded-shortcut vocabulary (comments.md § Markers).
  /\b(?:simplify|shortcut)\s*:/i,
  /\btemporary\s*(?::|[\u2013\u2014-]\s)/i,
  // why: `see` must name its target - the English verb alone ("the way to see
  // a fold") cannot classify a comment as a pointer.
  new RegExp(`\\bsee\\s+${POINTER_URL_SOURCE}`, "i"),
  // why: the target alone is a pointer too (comments.md § MUST: "or that
  // target alone"), and a URL is the one with no in-repo path to anchor on.
  new RegExp(POINTER_URL_SOURCE, "i"),
  new RegExp(`(?<![\\w./-])${POINTER_PATH_SOURCE}`),
  /@generated\b/i,
];

/** why: the marker is a shape only when a tracking reference (an owner, an
 * issue, a removal path) holds somebody to it. */
const TODO_MARKER_RE = /\b(?:TODO|FIXME)\b/;

/** why: the marker must open the comment content, not merely sit on a
 * comment-only line. The prefix is read after the last comment introducer, so
 * trailing code before `//`, a block opener (`/**`, `/*`, a continuation `*`)
 * and a non-C `#`/`;`/`--` all leave an empty prefix. A marker after prose is
 * a mention. A non-C introducer counts only where the scanner sees code, so a
 * `;` or `#` inside comment prose never restarts the content. */
function opensCommentContent(maskedLine: string, at: number, scan: Uint8Array, lineBase: number, dialect: SourceDialect = "c"): boolean {
  const before = maskedLine.slice(0, at);
  if (/^\s*\*\s*$/.test(before)) return true;
  let index = -1;
  const consider = (token: string, rule: "start" | "codeOrStart"): void => {
    let found = before.lastIndexOf(token);
    if (found === -1) return;
    // why: `///` is one line-comment introducer, so back up to the first slash.
    if (token === "//") while (found > 0 && before[found - 1] === "/") found -= 1;
    if (found <= index) return;
    if (rule === "codeOrStart") {
      const code = scan[lineBase + found] === SOURCE_CODE;
      const startsRun = found === 0 || scan[lineBase + found - 1] !== SOURCE_COMMENT;
      if (!code && !startsRun) return;
    } else if (found > 0 && scan[lineBase + found - 1] === SOURCE_COMMENT) {
      return;
    }
    index = found;
  };
  consider("//", "start");
  consider("/*", "start");
  consider("#", "codeOrStart");
  // why: `;` ends a C-family statement, so it opens comment content only where
  // the dialect reads it as an introducer (asm/Lisp); `#` and `--` never mean
  // "statement end" in any C-family syntax, so they stay unconditional.
  if (semicolonIntroducesComment(dialect)) consider(";", "codeOrStart");
  consider("--", "codeOrStart");
  if (index === -1) return before.trim() === "";
  return before.slice(index).replace(/^(?:\/\/+|\/\*+|\*+|#|;|--)/, "").trim() === "";
}

/** why: the changed-line gate reads the whole span, so a unit carries both its
 * first and last line together with the body a shape match reads. */
type CommentUnit = { line: number; endLine: number; body: string; doc: boolean };

/** why: a block or run may start and end far apart, so a position is mapped to
 * its 1-based line by binary search over the line-start table. */
function lineAt(offsets: readonly number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= position) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** why: shapes are matched against the words, not the delimiters, so each
 * line's introducer and the closing delimiter are stripped first. */
function commentBody(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\/\/+|\/\*+|\*+|#|;|--)\s?/, "").replace(/\*+\/\s*$/, "").trim())
    .join("\n");
}

/** why: whitespace is required after the introducer so a TypeScript private
 * field (`#count = 0`) and a shebang (`#!`) stay code, matching the
 * standalone-introducer rule the TODO detector uses. */
const NON_C_COMMENT_LINE_RE = /^\s*(?:#|;)(?=\s|$)|^\s*--(?=\s|$)/;
/** why: the C-family arm of the same rule - `;` is absent because it ends the statement there. */
const NON_C_COMMENT_LINE_C_RE = /^\s*#(?=\s|$)|^\s*--(?=\s|$)/;

/** why: a block and an adjacent run of line comments are each ONE comment
 * because that is how a reader takes them; judging lines apart would report the
 * later lines of one wrapped comment as separate defects. The scanner supplies
 * the C-family spans, then a line a non-C introducer (`#`, `;`, `--`) opens.
 * Only a run that starts its line merges: two comments sharing a line are one
 * unit, but a trailing comment below a line-initial run is a different comment,
 * and joining them would read the code between them as comment text. */
function commentUnits(fileText: string, scan: Uint8Array, masked: readonly string[], offsets: readonly number[], dialect: SourceDialect): CommentUnit[] {
  const runs: { start: number; end: number; doc: boolean; line: boolean; initial: boolean }[] = [];
  let i = 0;
  while (i < fileText.length) {
    if (scan[i] !== SOURCE_COMMENT) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < fileText.length && scan[i] === SOURCE_COMMENT) i += 1;
    runs.push({
      start,
      end: i,
      doc: fileText.startsWith("/**", start) && !fileText.startsWith("/**/", start),
      // why: `#` is a line comment only in a hash language, where an adjacent
      // run of them is one wrapped comment exactly like a `//` run.
      line: fileText.startsWith("//", start) || (dialect === "hash" && fileText.startsWith("#", start)),
      initial: fileText.slice(offsets[lineAt(offsets, start) - 1]!, start).trim() === "",
    });
  }
  // why: a non-C introducer opens a comment the scanner cannot see, and only a
  // line with no comment content of its own is added - a line inside a block
  // already belongs to that block's unit.
  for (let index = 0; index < masked.length; index++) {
    const base = offsets[index]!;
    let hasComment = false;
    for (let column = 0; column < masked[index]!.length && !hasComment; column++) {
      if (scan[base + column] === SOURCE_COMMENT) hasComment = true;
    }
    if (hasComment || !introducerPattern(dialect, NON_C_COMMENT_LINE_C_RE, NON_C_COMMENT_LINE_RE).test(masked[index]!)) continue;
    runs.push({ start: base + masked[index]!.search(/\S/), end: base + masked[index]!.length, doc: false, line: true, initial: true });
  }
  runs.sort((left, right) => left.start - right.start);
  const merged: typeof runs = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    const adjacent = last !== undefined && last.line && run.line && last.initial && run.initial
      && lineAt(offsets, Math.max(last.start, last.end - 1)) + 1 === lineAt(offsets, run.start);
    if (adjacent) { last.end = run.end; continue; }
    merged.push({ ...run });
  }
  return merged.map((run): CommentUnit => ({
    line: lineAt(offsets, run.start),
    endLine: lineAt(offsets, Math.max(run.start, run.end - 1)),
    body: commentBody(fileText.slice(run.start, run.end)),
    doc: run.doc,
  }));
}

/** why: this is the only exemption, recognized structurally because the
 * repository ships no doc generator. Blank lines do not break it; the next
 * line that carries anything must be the export, so an intervening comment or
 * another statement is not exempt. */
function documentsExport(lines: readonly string[], afterLine: number): boolean {
  for (let index = afterLine; index < lines.length; index++) {
    const text = lines[index]!.trim();
    if (text !== "") return /^export\b/.test(text);
  }
  return false;
}

/** why: a TODO/FIXME is a shape only with a tracking reference, and only when
 * it opens the comment content — a mid-sentence mention is prose. */
function hasCommentShape(line: string): boolean {
  if (COMMENT_SHAPES.some((shape) => shape.test(line))) return true;
  if (!TODO_MARKER_RE.test(line) || !hasTrackingReference(line)) return false;
  return line.search(TODO_MARKER_RE) === 0;
}

/**
 * Find comments that match no allowed shape (comments.md § MUST: an external
 * constraint, a contract pointer, a bounded shortcut, a generated marker, a
 * public-API obligation or an uncheckable ordering constraint; § MUST NOT:
 * restating the code, a changelog line, an ownerless TODO, an untracked
 * promise). The verdict is advisory: the caller decides the severity, and the
 * gate reads only the lines a change touches.
 *
 * A `/**` block whose next non-empty line starts with `export` is exempt:
 * that is where the repository's public API documentation lives. A block that
 * documents a non-exported symbol is not exempt, because the plan exempts the
 * declaration form, not the block style.
 *
 * shortcut: only C-family comment runs and line-leading non-C introducers are
 * read, so a trailing `#`/`;`/`--` comment (`x = 1 # note`) is unreported.
 * upgrade: a per-extension comment tokenizer replacing `comment-scan.ts`.
 */
export function findUnclassifiedComments(fileText: string, dialect: SourceDialect = "c"): UnclassifiedComment[] {
  if (fileText === "") return [];
  const lines = fileText.split(/\r?\n/);
  const masked = maskLiterals(fileText, dialect).split(/\r?\n/);
  const scan = scanSource(fileText, dialect);
  const offsets = lineOffsets(fileText);
  const findings: UnclassifiedComment[] = [];
  for (const unit of commentUnits(fileText, scan, masked, offsets, dialect)) {
    if (unit.body.trim() === "") continue;
    if (unit.doc && documentsExport(lines, unit.endLine)) continue;
    if (unit.body.split("\n").some(hasCommentShape)) continue;
    findings.push({ line: unit.line, endLine: unit.endLine, text: lines[unit.line - 1]!.trim() });
  }
  return findings;
}

/**
 * A pointer read from comment text: the pointer's own line (the diagnostic),
 * the comment unit's first and last lines (the ratchet span), and the target
 * token. `target` is a repo-relative path under a resolvable root (`docs/`,
 * `skills/`, `packages/`, `scripts/`); every other pointer form (a URL,
 * `#<n>`, `issue <n>`, `contract §`, an ADR number) is not machine-resolvable
 * here and is not returned.
 */
export type CommentPointer = { line: number; startLine: number; endLine: number; target: string };

/** see skills/mstar-coding-behavior/references/comments.md § MUST — the finder
 * patterns reuse the shape sources, so a shape the gate accepts is exactly one
 * this finder reports for resolution. */
const POINTER_PATH_RE = new RegExp(`(?<![\\w./-])${POINTER_PATH_SOURCE}`, "g");
const URL_SPAN_RE = new RegExp(POINTER_URL_SOURCE, "gi");

/**
 * Find path pointers in comment text (comments.md § MUST: a contract pointer,
 * or its target alone). The shared literal mask means a path inside a string is
 * never read as a comment claim, and an exported API doc block is exempt — the
 * same carve-out `findUnclassifiedComments` applies.
 */
export function findCommentPointers(fileText: string, dialect: SourceDialect = "c"): CommentPointer[] {
  if (fileText === "") return [];
  const lines = fileText.split(/\r?\n/);
  const masked = maskLiterals(fileText, dialect).split(/\r?\n/);
  const scan = scanSource(fileText, dialect);
  const offsets = lineOffsets(fileText);
  const pointers: CommentPointer[] = [];
  for (const unit of commentUnits(fileText, scan, masked, offsets, dialect)) {
    if (unit.doc && documentsExport(lines, unit.endLine)) continue;
    unit.body.split("\n").forEach((text, index) => {
      const line = unit.line + index;
      for (const match of text.replace(URL_SPAN_RE, " ").matchAll(POINTER_PATH_RE)) {
        pointers.push({ line, startLine: unit.line, endLine: unit.endLine, target: match[0].replace(/^\.\//, "") });
      }
    });
  }
  return pointers;
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
 * TBA (singular/plural) — word-boundary, case-insensitive; the lifecycle
 * value `Todo` is skipped at the match site. `FIXME`/`XXX` are
 * deliberately NOT flagged (code-marker territory, not plan placeholders). */
const PLACEHOLDER_TOKEN_RE = /\b(TBDs?|TODOs?|TBAs?)\b/gi;
/** Prose ellipsis placeholder ("a.ts, b.ts, ..."). Intentional ellipsis can
 * use U+2026 `…`, which is exempt. */
const ELLIPSIS_RE = /\.\.\./;

/** Verification-set surface map (plan-quality-bar.md § Verification gates):
 * a Files entry on one of these code surfaces must pair with the check that
 * surface maps to, or `plan-quality-bar` reports
 * `lint.plan-quality.verification-set`. Prose-only plans map to nothing.
 * `scripts/**` maps to that script's own test or its own run — never to
 * `lint:ascii-literals`, which scans nothing under `scripts/`. The
 * `scripts/` surface is the repository root only: `packages/ui/scripts/x.ts`
 * is package-local code whose tests live beside it. A repository-root script
 * path is a path whose left boundary is not a name character or `/`, so a
 * nested `scripts/` directory yields no match. */
const ROOT_SCRIPT_PATH_RE = /(?<![\w/.-])scripts\/[\w.-]+?\.ts\b/;
const SURFACE_CHECKS: ReadonlyArray<{ surface: RegExp; missing: (filesText: string, verificationText: string) => string[] }> = [
  {
    surface: /\bpackages\/(?:engine|cli)\/src\b|\bhooks\/src\b/,
    missing: (_files, verification) => (verification.includes("bun run lint:ascii-literals") ? [] : ["bun run lint:ascii-literals"]),
  },
  {
    surface: /\bskills\//,
    missing: (_files, verification) => (verification.includes("bun run validation:drift") ? [] : ["bun run validation:drift"]),
  },
  {
    surface: ROOT_SCRIPT_PATH_RE,
    missing: (files, verification) => {
      // A script's own check is its test or its own `bun run` entry name
      // (npm scripts spell `:` where the file has `-`).
      const runNames = [...verification.matchAll(/\bbun run ([\w:.-]+)/g)].map((m) => m[1]!.replace(/:/g, "-"));
      return [...new Set([...files.matchAll(new RegExp(ROOT_SCRIPT_PATH_RE, "g"))].map((m) => m[0]))]
        .filter((path) => !path.endsWith(".test.ts"))
        .filter((path) => !verification.includes(path) && !verification.includes(path.replace(/\.ts$/, ".test.ts")) && !runNames.includes(path.slice("scripts/".length, -".ts".length)))
        .map((path) => `bun test ${path.replace(/\.ts$/, ".test.ts")}`);
    },
  },
];
/** Files-list entry labels (`- Modify: \`path\``) in a task's **Files:**
 * block. `Out of scope` is an exclusion, not a surface the plan checks. */
const FILES_ENTRY_RE = /^\s*[-*]\s*\**\s*(?:Create|Modify|Test|Delete|Rename)\s*\**\s*:/i;
/** A Files entry declares surfaces only when its subject is a quoted path
 * list — the first thing after the label is a backticked span. An entry that
 * opens with prose (`only paths …`) or quotes a full command line names no
 * modified surface. */
const FILES_ENTRY_PATH_START_RE = /^[ \t]*`/;
/** A quoted path: a backticked span with no whitespace. */
const QUOTED_PATH_RE = /`([^`\s]+)`/g;
/** Verification lines: a step checkbox or an explicit `Run:` label. Only
 * these count as "the plan verifies this surface" — a command named in
 * constraints prose is a mention, not a gate. */
const VERIFICATION_LINE_RE = /^\s*(?:[-*]\s*\[[ xX]\]|Run\s*:)/;
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
 * `status: Todo` value is not a placeholder — issue #499 item 5); a
 * lifecycle `Todo` anywhere (capital T, lower `odo`) is domain state, while
 * upper-case `TODO`/`TBD`/`TBA` still fail.
 * - verification set: a Files entry on a mapped code surface that names
 * none of that surface's mapped commands yields
 * `lint.plan-quality.verification-set` (surface map in
 * `plan-quality-bar.md` § Verification gates). Fenced examples and the
 * frontmatter block are not read, so a fenced entry adds no surface and a
 * fenced command satisfies no check.
 * - out of scope (judgment stays prompt): "add tests" without code, and
 * `FIXME`/`XXX` code markers.
 */
export function planQualityBar(planText: string): PlanQualityResult {
  const findings: PlanQualityFinding[] = [];
  const violations: ValidationResult[] = [];
  // The front-matter boundary is discovered exactly once, here: the schema
  // check validates the extracted block and the body scan starts after it —
  // an unterminated fence never triggers a second walk of the document.
  const extraction = extractFrontmatterAndBody(planText);
  // Plan schema check (document-schema.ts PLAN_SCHEMA): missing, unknown and
  // invalid plan front-matter fields are reported first under the lint
  // namespace. With no closed fence the whole document is the body, so an
  // unclosed fence is scanned as body exactly as before, and line numbers
  // stay the file's own (the body's start line is the newline count before
  // it, never a second fence search).
  for (const schemaViolation of validateDocumentFrontmatterExtraction("plan", extraction, "plan").violations) {
    violations.push({
      ...schemaViolation,
      code: schemaViolation.code.replace(/^document\.frontmatter\./, "lint.plan.frontmatter."),
    });
  }
  const lines = planText.split(/\r?\n/);
  let start = 0;
  if (extraction.fenced) {
    const prefix = planText.slice(0, planText.length - extraction.body.length);
    start = (prefix.match(/\n/g) ?? []).length;
  }
  let inFence = false;
  // Body lines outside fences and frontmatter: the verification-set pass reads
  // only these, so a fenced example can neither add a surface nor supply a check.
  const bodyLines: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    bodyLines.push(lines[i]);
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
      // A lifecycle `Todo` (capital T, lower odo) is domain state, not a
      // placeholder; only the upper-case token fails.
      if (wordMatch[0] === "Todo") continue;
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
  // Verification set: a Files entry on a mapped code surface must be paired
  // with the check that surface maps to, on a verification line. Only the
  // paths a Files entry lists as its subject are surfaces; prose or a quoted
  // command around them is a mention.
  const filesText = bodyLines
    .filter((line) => FILES_ENTRY_RE.test(line))
    .map((line) => line.replace(FILES_ENTRY_RE, ""))
    .filter((entry) => FILES_ENTRY_PATH_START_RE.test(entry))
    .flatMap((entry) => [...entry.matchAll(QUOTED_PATH_RE)].map((m) => m[1]!))
    .join("\n");
  const verificationText = bodyLines.filter((line) => VERIFICATION_LINE_RE.test(line)).join("\n");
  for (const { surface, missing } of SURFACE_CHECKS) {
    if (!surface.test(filesText)) continue;
    const missingChecks = missing(filesText, verificationText);
    if (missingChecks.length === 0) continue;
    violations.push(
      violation(
        "medium",
        "lint.plan-quality.verification-set",
        `code surface named in Files without its mapped verification: expected ${missingChecks.map((command) => `\`${command}\``).join(", ")}`,
        "name the mapped local check for each code surface the task touches (mstar-artifacts/references/plan-quality-bar.md \u00a7 Verification gates surface map)",
      ),
    );
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
/** Read one frontmatter field as the contract's string scalar: strings pass
 * through, numbers and booleans coerce, null/undefined land as "" (missing),
 * and a list or nested map counts as missing too — it is structurally
 * invalid content, and `String(...)` on it would either pass coerced junk or
 * throw on a non-callable `toString`. */
function scalarAsString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function lintSkillFrontmatter(frontmatterText: string): GateResult {
  const violations: ValidationResult[] = [];
  let fm: JsonObject | null = null;
  let parseFailure: DocumentFrontmatterError | null = null;
  try {
    fm = parseFrontmatter(frontmatterText);
  } catch (error) {
    if (!(error instanceof DocumentFrontmatterError)) throw error;
    parseFailure = error;
  }
  if (fm === null && parseFailure === null) {
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
  if (parseFailure !== null) {
    // The shared reader refuses a line outside the accepted subset (an
    // indented description continuation among them) at the strict gate \u2014
    // the file carries no usable frontmatter, so the missing-contract
    // violation names the offending document line.
    violations.push(
      violation(
        "medium",
        "lint.frontmatter.missing",
        `frontmatter cannot be parsed \u2014 SKILL.md:${parseFailure.line}: ${parseFailure.message.replace(/^SKILL\.md:\d+: /, "")} (mstar-skill-authoring \u00a7 Frontmatter Contract)`,
        parseFailure.fix,
      ),
    );
    return { ok: false, violations };
  }

  // why: the reader's scalars arrive typed (null/number/boolean/string); the
  // contract reads them as text, so a bare `name:` (null) and a numeric
  // scalar both coerce — null lands as "" and counts as missing. A list or
  // nested-map value is not a string scalar at all: coercing it would either
  // smuggle structurally invalid metadata past the gate or crash on a
  // non-callable `toString`, so it counts as missing too.
  const name = scalarAsString(fm!.name);
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

  const description = scalarAsString(fm!.description);
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
 * Parse the leading `---`-fenced frontmatter block of a skill document by
 * delegating to the one shared reader (`document-frontmatter.ts`): BOM and
 * leading blank lines are stripped first (a skill file is a document, not a
 * byte-exact dump), then the block is extracted and parsed with the strict
 * `document` profile. Returns the reader's root `JsonObject`, or `null`
 * when the text carries no closed frontmatter fence. A frontmatter line
 * outside the accepted subset — an indented continuation among them —
 * throws `DocumentFrontmatterError` naming the offending document line;
 * there is no continuation join and no bare unfenced-body parse.
 */
export function parseFrontmatter(text: string): JsonObject | null {
  const bomStripped = text.replace(/^\uFEFF/, "");
  const body = bomStripped.replace(/^\s+/, "");
  // Leading blank lines are stripped before the reader, so a refusal line is
  // short by the count of removed newlines; the count is added back so the
  // diagnostic names the document's real line.
  const stripped = bomStripped.slice(0, bomStripped.length - body.length);
  const removedLines = (stripped.match(/\n/g) ?? []).length;
  const { frontmatter, fenced } = extractFrontmatterAndBody(body);
  if (!fenced) return null;
  try {
    return parseDocumentFrontmatter(frontmatter, "SKILL.md");
  } catch (error) {
    if (error instanceof DocumentFrontmatterError && removedLines > 0) {
      const reason = error.message
        .replace(/^SKILL\.md:\d+: /, "")
        .replace(`: ${JSON.stringify(error.lineText)} (fix: ${error.fix})`, "");
      throw new DocumentFrontmatterError(error.source, error.line + removedLines, error.lineText, reason, error.fix);
    }
    throw error;
  }
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
