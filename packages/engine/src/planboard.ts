/**
 * planboard.ts — the `{HARNESS_DIR}/planboard.md` grammar and its findings.
 *
 * The board holds pointers only: an ordered list of captured issue ids, a list
 * of not-yet-captured candidates with the evidence that names them, and one
 * `review_after` date. It is gitignored local execution state, never mirrored
 * and never sent to a provider, so nothing here is collaboration authority.
 *
 * This module parses the closed grammar and reports drift. It writes nothing,
 * and the caller decides what to do with the findings — the verb that exposes
 * it exits 0 for every finding class because a stale line is the normal state
 * of a board between iterations, not a failure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getIssue } from "./issue.js";
import type { StoreContext } from "./store-db.js";

export const PLANBOARD_FILE = "planboard.md";
/** The board caps each section; a 21st entry is a grammar violation, not a list. */
export const PLANBOARD_SECTION_CAP = 20;

export const PLANBOARD_FINDING_CODES = ["malformed", "stale", "missing", "overdue", "unverified"] as const;
export type PlanboardFindingCode = (typeof PLANBOARD_FINDING_CODES)[number];

/** One finding. `line` is 1-based; `null` marks a file-level finding (the date line). */
export type PlanboardFinding = {
  code: PlanboardFindingCode;
  line: number | null;
  message: string;
  /** The issue id an issue-line finding is about. */
  issueId?: string;
  /** The candidate text an `overdue` finding is about. */
  candidate?: string;
  /** The issue store's own refusal code, on `unverified`. */
  storeCode?: string;
};

export type PlanboardFindings = {
  /** The board file that was read; `null` when it does not exist. */
  path: string | null;
  reviewAfter: string | null;
  findings: PlanboardFinding[];
};

const ISSUE_LINE = /^- (I-[0-9]{6}) \u2014 (.+)$/;
const CANDIDATE_LINE = /^- \? (.+?) \u2014 (.+)$/;
const ISSUE_ID = /I-[0-9]{6}/g;
const FIRST_ISSUE_ID = /I-[0-9]{6}/;
const REVIEW_AFTER = /^review_after: ([0-9]{4}-[0-9]{2}-[0-9]{2})$/;

type IssueRef = { line: number; id: string };
type CandidateRef = { line: number; candidate: string };

type Parsed = {
  reviewAfter: string | null;
  issues: IssueRef[];
  candidates: CandidateRef[];
  findings: PlanboardFinding[];
};

function malformed(line: number | null, message: string, extra: Partial<PlanboardFinding> = {}): PlanboardFinding {
  return { code: "malformed", line, message, ...extra };
}

/** A calendar date the parser accepts: `yyyy-mm-dd` that names a real day. */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Parse the closed grammar. Every deviation becomes a `malformed` finding with
 * its line, and a malformed line is never looked up in the issue store: the
 * parse is the only thing that decides what an issue line IS.
 */
export function parsePlanboard(text: string): Parsed {
  const findings: PlanboardFinding[] = [];
  const issues: IssueRef[] = [];
  const candidates: CandidateRef[] = [];
  let reviewAfter: string | null = null;
  let reviewAfterLines = 0;
  let section: "preamble" | "captured" | "candidates" = "preamble";
  let seenCaptured = false;
  let seenCandidates = false;
  let capturedEntries = 0;
  let candidateEntries = 0;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index]!;
    const trimmed = raw.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("#")) {
      if (trimmed === "## Captured") {
        if (seenCaptured) {
          findings.push(malformed(line, "`## Captured` appears more than once; keep one section"));
        }
        seenCaptured = true;
        section = "captured";
        continue;
      }
      if (trimmed === "## Candidates") {
        if (seenCandidates) {
          findings.push(malformed(line, "`## Candidates` appears more than once; keep one section"));
        }
        seenCandidates = true;
        section = "candidates";
        continue;
      }
      findings.push(malformed(line, `unknown heading \`${trimmed}\`; the board has only \`## Captured\` and \`## Candidates\``));
      continue;
    }

    if (trimmed.startsWith("review_after:")) {
      reviewAfterLines += 1;
      if (section !== "preamble") {
        findings.push(malformed(line, "`review_after:` belongs before the first heading"));
        continue;
      }
      if (reviewAfterLines > 1) {
        findings.push(malformed(line, "`review_after:` appears more than once; keep one date"));
        continue;
      }
      const date = REVIEW_AFTER.exec(trimmed);
      if (date === null || !isCalendarDate(date[1]!)) {
        // invariant: An unparsable date is ONE file-level finding: it is the
        // board's date line, not an unknown line, and overdue is then undecided.
        findings.push(malformed(null, "`review_after:` must be one `yyyy-mm-dd` calendar date"));
        continue;
      }
      reviewAfter = date[1]!;
      continue;
    }

    const isIssue = trimmed.startsWith("- ") && !trimmed.startsWith("- ? ") && FIRST_ISSUE_ID.test(trimmed);

    if (isIssue) {
      if (section !== "captured") {
        findings.push(malformed(line, "an issue line belongs under `## Captured`"));
        continue;
      }
      const ids = trimmed.match(ISSUE_ID) ?? [];
      if (ids.length > 1) {
        findings.push(malformed(line, "an issue line names exactly one issue id", { issueId: ids[0] }));
        continue;
      }
      const match = ISSUE_LINE.exec(trimmed);
      if (match === null) {
        findings.push(malformed(line, "an issue line is `- I-xxxxxx \u2014 <ordering reason>`", { issueId: ids[0] }));
        continue;
      }
      capturedEntries += 1;
      if (capturedEntries > PLANBOARD_SECTION_CAP) {
        findings.push(malformed(line, `\`## Captured\` holds at most ${PLANBOARD_SECTION_CAP} entries`, { issueId: match[1]! }));
        continue;
      }
      issues.push({ line, id: match[1]! });
      continue;
    }

    if (trimmed.startsWith("- ?")) {
      if (section !== "candidates") {
        findings.push(malformed(line, "a candidate line belongs under `## Candidates`"));
        continue;
      }
      const match = CANDIDATE_LINE.exec(trimmed);
      if (match === null) {
        findings.push(malformed(line, "a candidate line is `- ? <candidate> \u2014 <evidence>` with non-empty evidence"));
        continue;
      }
      candidateEntries += 1;
      if (candidateEntries > PLANBOARD_SECTION_CAP) {
        findings.push(malformed(line, `\`## Candidates\` holds at most ${PLANBOARD_SECTION_CAP} entries`, { candidate: match[1]! }));
        continue;
      }
      candidates.push({ line, candidate: match[1]! });
      continue;
    }

    findings.push(
      malformed(line, "the line is outside the board grammar; the board holds no checkbox, status, history or milestone line"),
    );
  }

  if (reviewAfterLines === 0) {
    findings.push(malformed(null, "the board has no `review_after: yyyy-mm-dd` line before the first heading"));
  }

  return { reviewAfter, issues, candidates, findings };
}

/**
 * The finding for one issue line against a completed store answer. A refused or
 * incomplete answer is `unverified` and carries the store's own code — a read
 * that did not answer is never taken as "open".
 */
export function issueFinding(line: number, id: string, answer: { disposition: string } | { refusal: string }): PlanboardFinding | null {
  if ("refusal" in answer) {
    return {
      code: "unverified",
      line,
      issueId: id,
      storeCode: answer.refusal,
      message: `the issue store did not answer for ${id} (${answer.refusal})`,
    };
  }
  if (answer.disposition === "open") return null;
  return {
    code: "stale",
    line,
    issueId: id,
    message: `${id} is ${answer.disposition}, so the board line is stale; remove it`,
  };
}

/** One issue line's answer: its disposition, `missing`, or the store's refusal code. */
async function answerFor(context: StoreContext | null, id: string): Promise<{ disposition: string } | { refusal: string }> {
  if (context === null) return { refusal: "store.unreadable" };
  try {
    const issue = await getIssue(context, id);
    return { disposition: issue.disposition };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // `issue.not-found` is a completed answer: the store opened and holds no such row.
    if (code === "issue.not-found") return { disposition: "absent" };
    return { refusal: typeof code === "string" ? code : "store.unreadable" };
  }
}

/**
 * Read the board and report its drift. An absent file is a clean board; a
 * missing or unparsable `review_after` is one file-level `malformed` and
 * `overdue` is then not decided.
 */
export async function checkPlanboard(
  context: StoreContext,
  options: { today?: string } = {},
): Promise<PlanboardFindings> {
  const path = join(context.harnessDir, PLANBOARD_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return { path: null, reviewAfter: null, findings: [] };
    throw error;
  }

  const parsed = parsePlanboard(text);
  const findings = [...parsed.findings];

  for (const entry of parsed.issues) {
    const answer = await answerFor(context, entry.id);
    if ("disposition" in answer && answer.disposition === "absent") {
      findings.push({
        code: "missing",
        line: entry.line,
        issueId: entry.id,
        message: `${entry.id} is not in the issue store; capture it or remove the line`,
      });
      continue;
    }
    const finding = issueFinding(entry.line, entry.id, answer);
    if (finding !== null) findings.push(finding);
  }

  if (parsed.reviewAfter !== null) {
    const today = options.today ?? new Date().toISOString().slice(0, 10);
    if (today > parsed.reviewAfter) {
      for (const entry of parsed.candidates) {
        findings.push({
          code: "overdue",
          line: entry.line,
          candidate: entry.candidate,
          message: `review_after ${parsed.reviewAfter} has passed; capture this candidate with \`mstar issue add\` or drop the line`,
        });
      }
    }
  }

  findings.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
  return { path, reviewAfter: parsed.reviewAfter, findings };
}
