/**
 * rule-duplication.ts — Guard 10: cross-file duplicate HARD-rule fingerprints.
 *
 * A skill file may state a HARD rule once. A second file that repeats the same
 * wording must point at the canonical copy (`→ \`<skill>\` § <Section>`) instead
 * of re-vendoring it, because a copy is what drifts (a bilingual variant, a
 * stale tail) once nobody owns the original sentence.
 *
 * The fingerprint matches a candidate when either holds:
 * - a tight block of >=3 consecutive lines carries a rule signal; or
 * - a single line carries a rule signal and is >=8 words long.
 *
 * Rule signal = an upper-case `NEVER` / `MUST` / `MUST NOT` / `HARD` token, or
 * a line made only of upper-case words.
 *
 * Normalization strips what Markdown may vary without changing the rule —
 * blockquote markers, list markers, inline-code backticks — and collapses
 * whitespace. It deliberately preserves the case of the rule text, so a
 * `NEVER` rule and a lower-case `never` sentence never share a fingerprint,
 * and a lower-case token is prose, not a rule signal. Headings keep their
 * markers and a tight run is compared whole, so a partial copy of a longer
 * paragraph is caught by its individual lines, not by the block fingerprint.
 *
 * `scripts/rule-duplication.allowlist.json` records accepted exceptions, one
 * `{ file, normalizedHash, reason }` entry each. A reason that does not name
 * the file it covers fails that entry: the allowlist holds exceptions, never
 * parked duplicates.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RULE_DUPLICATION_ALLOWLIST = "scripts/rule-duplication.allowlist.json";

/** Tight-run length at which a block fingerprint applies. */
const BLOCK_MIN_LINES = 3;
/** Word count at which a single rule line fingerprints on its own. */
const LINE_MIN_WORDS = 8;

/** Upper-case rule tokens only: a lower-case `must` is prose, not a rule signal. */
const RULE_TOKEN = /\b(?:NEVER|MUST(?: NOT)?|HARD)\b/;
/** One-line pointer into another skill's section: never a rule site of its own. */
const POINTER = /→\s*\S+\s*§/;
/** One word that belongs to an all-upper-case line. */
const UPPER_WORD = /^[\p{Lu}][\p{Lu}\d'’.-]*$/u;

export type RuleHit = { file: string; line: number };

export type RuleDuplicateGroup = {
  /** Normalized rule text shared by every hit. */
  normalized: string;
  /** Sites that still duplicate: the group fails on these. */
  hits: RuleHit[];
  /** Sites accepted by the allowlist; reported, never failing. */
  exempt: RuleHit[];
};

export type RuleDuplicationResult = {
  filesChecked: number;
  /** Groups that still duplicate after allowlist exemptions. */
  duplicates: RuleDuplicateGroup[];
  /** Groups every remaining site of which was allowlisted. */
  exemptGroups: RuleDuplicateGroup[];
  /** Malformed allowlist entries; each one is a failure row. */
  allowlistFailures: string[];
};

export type RuleDuplicationAllowlistEntry = {
  file: string;
  normalizedHash: string;
  reason: string;
};

export type RuleCandidate = { normalized: string; line: number };

/**
 * Strip blockquote and list markers plus inline-code backticks, collapse
 * whitespace, and keep the case of the rule text.
 */
export function normalizeRuleLine(line: string): string {
  return line
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Rule signal: an upper-case rule token, or a line of only upper-case words. */
export function hasRuleSignal(line: string): boolean {
  if (RULE_TOKEN.test(line)) return true;
  const words = line.split(" ").filter((word) => /\p{L}/u.test(word));
  return words.length >= 2 && words.every((word) => UPPER_WORD.test(word));
}

/** Stable allowlist key for one normalized rule text. */
export function ruleFingerprintHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/**
 * Candidate fingerprints in one file: every tight run of >=3 lines that
 * carries a rule signal, plus every single rule line of >=8 words (so a
 * duplicated sentence inside a longer paragraph still registers).
 * Pointer and blank lines end a run and are never rule sites themselves.
 */
export function collectRuleCandidates(text: string): RuleCandidate[] {
  const candidates: RuleCandidate[] = [];
  let run: RuleCandidate[] = [];

  const flush = (): void => {
    if (run.length >= BLOCK_MIN_LINES && run.some((entry) => hasRuleSignal(entry.normalized))) {
      candidates.push({
        normalized: run.map((entry) => entry.normalized).join(" "),
        line: run[0].line,
      });
    }
    run = [];
  };

  text.split(/\r?\n/).forEach((raw, index) => {
    const normalized = normalizeRuleLine(raw);
    if (normalized === "" || POINTER.test(normalized)) {
      flush();
      return;
    }
    const line = index + 1;
    run.push({ normalized, line });
    if (hasRuleSignal(normalized) && normalized.split(" ").length >= LINE_MIN_WORDS) {
      candidates.push({ normalized, line });
    }
  });
  flush();
  return candidates;
}

/**
 * Read the allowlist. A malformed shape throws (the file is SSOT, so an
 * unreadable one must not silently exempt nothing); an entry whose reason
 * does not name its own file is reported per entry.
 */
export function readRuleDuplicationAllowlist(root: string): {
  entries: RuleDuplicationAllowlistEntry[];
  failures: string[];
} {
  const raw: unknown = JSON.parse(readFileSync(join(root, RULE_DUPLICATION_ALLOWLIST), "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`${RULE_DUPLICATION_ALLOWLIST} must be an array of { file, normalizedHash, reason } entries`);
  }
  const entries: RuleDuplicationAllowlistEntry[] = [];
  const failures: string[] = [];
  for (const item of raw) {
    const { file, normalizedHash, reason } = (item ?? {}) as Record<string, unknown>;
    if (typeof file !== "string" || !file.startsWith("skills/")) {
      throw new Error(`${RULE_DUPLICATION_ALLOWLIST}: every entry needs a repo-relative "skills/..." file`);
    }
    if (typeof normalizedHash !== "string" || normalizedHash === "") {
      throw new Error(`${RULE_DUPLICATION_ALLOWLIST}: "${file}" needs a normalizedHash`);
    }
    if (typeof reason !== "string" || !reason.includes(file)) {
      failures.push(
        `${RULE_DUPLICATION_ALLOWLIST}: "${file}" (${normalizedHash}) needs a reason naming that file - the allowlist records accepted exceptions, never parked duplicates`,
      );
      continue;
    }
    entries.push({ file, normalizedHash, reason });
  }
  return { entries, failures };
}

/**
 * Compare the rule fingerprints of `files` (repo-relative, read under `root`)
 * and report every group duplicated across at least two files.
 */
export function checkRuleDuplication(root: string, files: string[]): RuleDuplicationResult {
  const { entries, failures: allowlistFailures } = readRuleDuplicationAllowlist(root);
  const allowed = new Set(entries.map((entry) => `${entry.file}\u0000${entry.normalizedHash}`));

  const sites = new Map<string, RuleHit[]>();
  for (const file of files) {
    for (const candidate of collectRuleCandidates(readFileSync(join(root, file), "utf8"))) {
      const hits = sites.get(candidate.normalized);
      if (hits) hits.push({ file, line: candidate.line });
      else sites.set(candidate.normalized, [{ file, line: candidate.line }]);
    }
  }

  const duplicates: RuleDuplicateGroup[] = [];
  const exemptGroups: RuleDuplicateGroup[] = [];
  for (const [normalized, allHits] of sites) {
    if (new Set(allHits.map((hit) => hit.file)).size < 2) continue;
    const hash = ruleFingerprintHash(normalized);
    const exempt = allHits.filter((hit) => allowed.has(`${hit.file}\u0000${hash}`));
    const hits = allHits.filter((hit) => !allowed.has(`${hit.file}\u0000${hash}`));
    if (new Set(hits.map((hit) => hit.file)).size < 2) {
      if (exempt.length > 0) exemptGroups.push({ normalized, hits, exempt });
      continue;
    }
    duplicates.push({ normalized, hits, exempt });
  }

  duplicates.sort((a, b) => (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0));
  exemptGroups.sort((a, b) => (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0));
  return { filesChecked: files.length, duplicates, exemptGroups, allowlistFailures };
}
