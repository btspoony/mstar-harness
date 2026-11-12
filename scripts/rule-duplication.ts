/**
 * rule-duplication.ts — Guard 10: cross-file duplicate HARD-rule fingerprints.
 *
 * A skill file may state a HARD rule once. A second file that repeats the same
 * wording must point at the canonical copy (`→ \`<skill>\` § <Section>`) instead
 * of re-vendoring it, because a copy is what drifts (a bilingual variant, a
 * stale tail) once nobody owns the original sentence.
 *
 * A pointer is exempt only when the line *is* the pointer: the callout is
 * removed before fingerprinting, so wording retained around it still registers
 * as a rule site and appending a token can never silence a duplicate. Only a
 * line left with no wording of its own ends a run as a pointer.
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
 * `{ file, normalizedHash, reason }` entry each. A reason must name the owner
 * of the rule: another `skills/` path, or the covered file itself together
 * with the word `owner`. A reason that only repeats the covered file parks a
 * duplicate instead of recording an exception, so it fails that entry; so
 * does an entry whose `file` + `normalizedHash` matches no scanned site.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RULE_DUPLICATION_ALLOWLIST = "scripts/rule-duplication.allowlist.json";

/** Tight-run length at which a block fingerprint applies. */
const BLOCK_MIN_LINES = 3;
/** Word count at which a single rule line fingerprints on its own. */
const LINE_MIN_WORDS = 8;

/**
 * Upper-case rule tokens only: a lower-case `must` is prose, not a rule signal.
 * Both signals are ASCII and case-shaped (the second is "every word is
 * upper-case"), so a HARD rule written in a caseless script — the Chinese rules
 * this corpus carries most of — has no rule signal at all and is structurally
 * invisible to this guard.
 */
const RULE_TOKEN = /\b(?:NEVER|MUST(?: NOT)?|HARD)\b/;
/**
 * A pointer callout: arrow, target, section marker, section name. It is a
 * citation token, not wording, so it is removed before fingerprinting; what
 * surrounds it decides whether the line is a pointer at all. Deliberately
 * narrow — removing everything from the first `→` would also eat prose arrows
 * such as `Relocate → Condense → Raise`.
 */
const POINTER_CALLOUT = /→\s*\S+\s*§\s*\S+/;
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

/**
 * The rule wording of a normalized line, excluding any pointer callout and
 * whatever follows it. Empty means the line is a pointer, not a rule site; a
 * line that leads with a callout but states a rule after it keeps that rule.
 */
function ruleContent(normalized: string): string {
  const at = normalized.search(POINTER_CALLOUT);
  if (at < 0) return normalized;
  const head = normalized.slice(0, at).trim();
  const tail = normalized.slice(at).replace(POINTER_CALLOUT, "").trim();
  return head === "" && hasRuleSignal(tail) ? tail : head;
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

  // A leading BOM is not content: strip it (parity with markdown-wrap.ts) so
  // line 1 of a BOM-prefixed file fingerprints like the same line without one.
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((raw, index) => {
    const content = ruleContent(normalizeRuleLine(raw));
    if (content === "") {
      flush();
      return;
    }
    const line = index + 1;
    run.push({ normalized: content, line });
    if (hasRuleSignal(content) && content.split(" ").length >= LINE_MIN_WORDS) {
      candidates.push({ normalized: content, line });
    }
  });
  flush();
  return candidates;
}

/** A `skills/...` path inside a reason: the owner an exception names. */
const SKILL_PATH = /skills\/[\w./-]+/g;

/**
 * Whether a reason identifies the owning rule site: a `skills/` path other
 * than the covered file, or the covered file together with the word `owner`.
 * A reason that only repeats the covered file parks a duplicate instead of
 * recording an accepted exception, so it fails.
 */
function namesOwner(file: string, reason: string): boolean {
  const paths = (reason.match(SKILL_PATH) ?? []).map((path) => path.replace(/[.,;:]+$/, ""));
  if (paths.some((path) => path !== file)) return true;
  return paths.includes(file) && /\bowner\b/i.test(reason);
}

/**
 * Read the allowlist. A malformed shape throws (the file is SSOT, so an
 * unreadable one must not silently exempt nothing); an entry whose reason
 * names no owner is reported per entry.
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
    if (typeof reason !== "string" || !namesOwner(file, reason)) {
      failures.push(
        `${RULE_DUPLICATION_ALLOWLIST}: "${file}" (${normalizedHash}) needs a reason naming the owner - another skills/ path, or this file plus the word "owner"; the allowlist records accepted exceptions, never parked duplicates`,
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

  // An entry that no longer matches a scanned site hides a deletion or a
  // wording change: name it, matching Guard 9's manifest-stale direction.
  const liveSites = new Set<string>();
  for (const [normalized, allHits] of sites) {
    const hash = ruleFingerprintHash(normalized);
    for (const hit of allHits) liveSites.add(`${hit.file}\u0000${hash}`);
  }
  for (const entry of entries) {
    if (liveSites.has(`${entry.file}\u0000${entry.normalizedHash}`)) continue;
    allowlistFailures.push(
      `${RULE_DUPLICATION_ALLOWLIST}: "${entry.file}" (${entry.normalizedHash}) matches no scanned rule site - drop the entry`,
    );
  }

  const duplicates: RuleDuplicateGroup[] = [];
  const exemptGroups: RuleDuplicateGroup[] = [];
  for (const [normalized, allHits] of sites) {
    if (new Set(allHits.map((hit) => hit.file)).size < 2) continue;
    const hash = ruleFingerprintHash(normalized);
    const exempt = allHits.filter((hit) => allowed.has(`${hit.file}\u0000${hash}`));
    const hits = allHits.filter((hit) => !allowed.has(`${hit.file}\u0000${hash}`));
    // One entry silences its whole group: exempting one site drops the group
    // below two active files, so it leaves `duplicates` entirely and the
    // remaining copies appear only in the exemptGroups advisory row.
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
