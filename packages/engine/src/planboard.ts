/** see packages/engine/src/planboard.ts - planboard.ts — the `{HARNESS_DIR}/planboard.md` grammar and its findings. The board holds pointers only: an ordered list of captured issue ids, a list of not-yet-captured candidates with the evidence that names them, and one `review_after` date. It is gitignored local execution state, never mirrored and never sent to a provider, so nothing here is collaboration authority. This module parses the closed grammar and reports drift. It writes nothing, and the caller decides what to do with the findings — the verb that exposes it exits 0 for every finding class because a stale line is the normal state of a board between iterations, not a failure. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { openCollaborationStore, type CollaborationStoreHandle } from "./collaboration-store.js";
import { SWITCHED_NOT_PRESENTED_SQL } from "./cross-authority-move.js";
import type { RemoteIssueRead, RemoteReadView } from "./collaboration-remote-read.js";
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
  /** see packages/engine/src/planboard.ts - The issue id an issue-line finding is about. */
  issueId?: string;
  /** see packages/engine/src/planboard.ts - The candidate text an `overdue` finding is about. */
  candidate?: string;
  /** see packages/engine/src/planboard.ts - The issue store's own refusal code, on `unverified`. */
  storeCode?: string;
};

export type PlanboardFindings = {
  /** see packages/engine/src/planboard.ts - The board file that was read; `null` when it does not exist. */
  path: string | null;
  reviewAfter: string | null;
  /** see packages/engine/src/planboard.ts - The board's clean pointers, in file order: the ordering reason of each well-formed captured line and the candidate text of each well-formed candidate line. The findings are drift; this is what the board says. */
  captured: Array<{ line: number; issueId: string; reason: string }>;
  candidates: Array<{ line: number; candidate: string; evidence: string }>;
  findings: PlanboardFinding[];
};

/** see packages/engine/src/planboard.ts - An issue pointer names either the local display id or the stable portable reference. The display id is local vocabulary; a remote selection addresses its admitted snapshot by the reference, so a board read there must carry it. */
const POINTER = "mstar:issue:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ISSUE_LINE = new RegExp(`^- ((?:I-[0-9]{6})|(?:${POINTER})) \u2014 (.+)$`);
const CANDIDATE_LINE = /^- \? (.+?) \u2014 (.+)$/;
const ISSUE_POINTER = new RegExp(`(?:I-[0-9]{6})|(?:${POINTER})`, "g");
/** see packages/engine/src/planboard.ts - Does this line start with an issue pointer? Compiled once, not per line. */
const HAS_ISSUE_POINTER = new RegExp(`(?:I-[0-9]{6})|(?:${POINTER})`);
const REVIEW_AFTER = /^review_after: ([0-9]{4}-[0-9]{2}-[0-9]{2})$/;
/** see packages/engine/src/planboard.ts - An ADR record name, as the ADR tree spells it. */
const ADR_NAME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*(\.md)?$/;
/** see packages/engine/src/planboard.ts - A repository path: one token, no spaces, with a separator or a file extension. */
const EVIDENCE_PATH = /^[\w.@+-]+(?:\/[\w.@+-]+)+\/?$|^[\w.@+-]+\.(?:[a-z0-9]+)$/i;
/** see packages/engine/src/planboard.ts - The stable portable issue reference, the only address a remote snapshot resolves. */
const ISSUE_REF = new RegExp(`^${POINTER}$`);
/** see packages/engine/src/planboard.ts - A local display issue id, on its own. */
const DISPLAY_ISSUE_ID = /^I-[0-9]{6}$/;

type IssueRef = { line: number; id: string; reason: string };
type CandidateRef = { line: number; candidate: string; evidence: string };

type Parsed = {
  reviewAfter: string | null;
  issues: IssueRef[];
  candidates: CandidateRef[];
  findings: PlanboardFinding[];
};

function malformed(line: number | null, message: string, extra: Partial<PlanboardFinding> = {}): PlanboardFinding {
  return { code: "malformed", line, message, ...extra };
}

/** see packages/engine/src/planboard.ts - A calendar date the parser accepts: `yyyy-mm-dd` that names a real day. */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** see packages/engine/src/planboard.ts - The evidence one candidate may name, exactly: one path token, one ADR record name, or one issue pointer — and nothing else. Anything with words or extra punctuation around the token (`see I-000001 for context`, `I-000001;`) is prose, and the board is not prose. Returns the value that was validated, so the emitted pointer can never be a differently punctuated spelling of the evidence that passed. */
function evidenceOf(text: string): string | null {
  const value = text.trim();
  if (value === "") return null;
  if (DISPLAY_ISSUE_ID.test(value) || ISSUE_REF.test(value) || ADR_NAME.test(value) || EVIDENCE_PATH.test(value)) {
    return value;
  }
  return null;
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
  let dateReported = false;
  let section: "preamble" | "captured" | "candidates" | "unknown" = "preamble";
  let seenCaptured = false;
  let seenCandidates = false;
  let capturedEntries = 0;
  let candidateEntries = 0;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const trimmed = lines[index]!.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("#")) {
      if (trimmed === "## Captured") {
        if (seenCaptured) findings.push(malformed(line, "`## Captured` appears more than once; keep one section"));
        seenCaptured = true;
        section = "captured";
        continue;
      }
      if (trimmed === "## Candidates") {
        if (seenCandidates) findings.push(malformed(line, "`## Candidates` appears more than once; keep one section"));
        seenCandidates = true;
        section = "candidates";
        continue;
      }
      findings.push(malformed(line, `unknown heading \`${trimmed}\`; the board has only \`## Captured\` and \`## Candidates\``));
      // see packages/engine/src/planboard.ts - // invariant: An unknown heading closes the open section. A pointer below it
      // is not under a legal heading, so it is malformed and never looked up.
      section = "unknown";
      continue;
    }

    if (trimmed.startsWith("review_after:")) {
      reviewAfterLines += 1;
      // see packages/engine/src/planboard.ts - // invariant: Exactly one valid preamble date decides `overdue`. A second
      // declaration, a misplaced one, or an unparsable one invalidates the date
      // entirely, so nothing is reported overdue from a half-read header.
      const date = REVIEW_AFTER.exec(trimmed);
      const valid = section === "preamble" && reviewAfterLines === 1 && date !== null && isCalendarDate(date[1]!);
      if (!valid) {
        // see packages/engine/src/planboard.ts - // invariant: One file-level finding covers the whole header, however many
        // ways it is wrong: two declarations are one broken date, not two.
        if (!dateReported) findings.push(malformed(null, "the board declares exactly one valid `review_after: yyyy-mm-dd` before the first heading"));
        dateReported = true;
        reviewAfter = null;
        continue;
      }
      reviewAfter = date[1]!;
      continue;
    }

    const isIssue = trimmed.startsWith("- ") && !trimmed.startsWith("- ? ") && HAS_ISSUE_POINTER.test(trimmed);
    if (isIssue) {
      const ids = trimmed.match(ISSUE_POINTER) ?? [];
      if (section !== "captured") {
        findings.push(malformed(line, "an issue line belongs under `## Captured`"));
        continue;
      }
      if (ids.length > 1) {
        findings.push(malformed(line, "an issue line names exactly one issue id", { issueId: ids[0] }));
        continue;
      }
      const match = ISSUE_LINE.exec(trimmed);
      if (match === null) {
        findings.push(malformed(line, "an issue line is `- I-xxxxxx \u2014 <ordering reason>`", { issueId: ids[0] }));
        continue;
      }
      const reason = match[2]!.trim();
      if (reason === "") {
        findings.push(malformed(line, "an issue line names its ordering reason", { issueId: match[1]! }));
        continue;
      }
      capturedEntries += 1;
      if (capturedEntries > PLANBOARD_SECTION_CAP) {
        // see packages/engine/src/planboard.ts - // invariant: The cap is reported once, and the excess is not walked into
        // per-line findings that would scale with the file.
        if (capturedEntries === PLANBOARD_SECTION_CAP + 1) {
          findings.push(malformed(line, `\`## Captured\` holds at most ${PLANBOARD_SECTION_CAP} entries; the rest were not read`));
        }
        continue;
      }
      issues.push({ line, id: match[1]!, reason });
      continue;
    }

    if (trimmed.startsWith("- ?")) {
      const ids = trimmed.match(ISSUE_POINTER) ?? [];
      if (section !== "candidates") {
        findings.push(malformed(line, "a candidate line belongs under `## Candidates`"));
        continue;
      }
      const match = CANDIDATE_LINE.exec(trimmed);
      // see packages/engine/src/planboard.ts - // invariant: A candidate obeys the same one-id rule as a captured line, and
      // its evidence names a path, an ADR record or an issue — never prose.
      if (ids.length > 1) {
        findings.push(malformed(line, "a candidate line names at most one issue id", { issueId: ids[0] }));
        continue;
      }
      if (match === null || match[1]!.trim() === "") {
        findings.push(malformed(line, "a candidate line is `- ? <candidate> \u2014 <evidence>` with non-empty candidate text"));
        continue;
      }
      candidateEntries += 1;
      if (candidateEntries > PLANBOARD_SECTION_CAP) {
        if (candidateEntries === PLANBOARD_SECTION_CAP + 1) {
          findings.push(malformed(line, `\`## Candidates\` holds at most ${PLANBOARD_SECTION_CAP} entries; the rest were not read`));
        }
        continue;
      }
      const evidence = evidenceOf(match[2]!);
      if (evidence === null) {
        findings.push(malformed(line, "candidate evidence is a path, an ADR name or an issue id", { candidate: match[1]!.trim() }));
        continue;
      }
      candidates.push({ line, candidate: match[1]!.trim(), evidence });
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

/** see packages/engine/src/planboard.ts - One issue line's answer: its disposition, `missing`, or a code. `refusal` is a per-line answer (the store answered, and this id resolved nowhere); `laneRefusal` means the whole lane could not be read, which no further line can improve on. */
type IssueAnswer =
  | Readonly<{ kind: "disposition"; disposition: string }>
  | Readonly<{ kind: "refusal"; code: string }>
  | Readonly<{ kind: "laneRefusal"; code: string }>;

/** see packages/engine/src/planboard.ts - A lane-level refusal: the store never answered, so no line is decided by it. */
const LANE_REFUSAL_CODES = new Set([
  "collaboration.not-initialized",
  "collaboration.stale-binding",
  "collaboration.unreadable",
  "collaboration.cutover-required",
  "collaboration.not-active",
  "store.busy",
  "store.corrupt",
  "store.schema-unsupported",
  "store.unreadable",
  "remote.unavailable",
]);

function refusalOf(error: unknown): IssueAnswer {
  const code = (error as { code?: unknown } | null)?.code;
  const stable = typeof code === "string" ? code : "store.unreadable";
  return LANE_REFUSAL_CODES.has(stable)
    ? { kind: "laneRefusal", code: stable }
    : { kind: "refusal", code: stable };
}

/** see packages/engine/src/planboard.ts - Answer every board id with ONE lane read. why: A per-line open re-enters the lane (and its busy timeout) once per entry, so a contended or unreadable lane would stall a plain report up to the section cap. One read answers the whole board; after a lane-level refusal the remaining lines are reported with the same code and nothing reopens. A remote selection opens its admitted view once and resolves every id against it, so the remote cache follows the same one-read rule. */
async function answersFor(context: StoreContext, ids: readonly string[]): Promise<Map<string, IssueAnswer>> {
  const answers = new Map<string, IssueAnswer>();
  if (ids.length === 0) return answers;
  let mode: string;
  try {
    mode = resolveCollaborationLocation(context).mode;
  } catch (error) {
    // see packages/engine/src/planboard.ts - // note: A checkout whose identity cannot be resolved never reached the lane,
    // so no line is decided by it.
    const refusal = refusalOf(error);
    for (const id of ids) answers.set(id, refusal);
    return answers;
  }
  if (mode === "remote") {
    // see packages/engine/src/planboard.ts - // invariant: ONE admitted view answers the whole board: the cache is opened
    // once, and each id is resolved against the snapshot it already holds. A
    // lane-level refusal answers every remaining line and never reopens; only a
    // per-id answer (not-found, scope-refused) is decided line by line.
    let view: RemoteReadView;
    let remoteIssueRead: (view: RemoteReadView, id: string) => RemoteIssueRead;
    try {
      const remote = await import("./collaboration-remote-read.js");
      remoteIssueRead = remote.remoteIssueRead;
      view = await remote.openRemoteReadView(context);
    } catch (error) {
      const refusal = refusalOf(error);
      for (const id of ids) answers.set(id, refusal);
      return answers;
    }
    for (const id of ids) {
      try {
        const read = remoteIssueRead(view, id);
        // see packages/engine/src/planboard.ts - // note: A provider-only answer is no MStar subject, so the line names an
        // issue this store does not hold.
        answers.set(id, { kind: "disposition", disposition: read.kind === "native" ? "absent" : read.detail.disposition });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "issue.not-found") {
          answers.set(id, { kind: "disposition", disposition: "absent" });
          continue;
        }
        if (code === "issue.scope-refused") {
          answers.set(id, { kind: "refusal", code });
          continue;
        }
        // see packages/engine/src/planboard.ts - // A lane-level cause: no later id can answer differently.
        const refusal = refusalOf(error);
        for (const remaining of ids) if (!answers.has(remaining)) answers.set(remaining, refusal);
        return answers;
      }
    }
    return answers;
  }

  let handle: CollaborationStoreHandle;
  try {
    handle = await openCollaborationStore(context, "read");
  } catch (error) {
    const refusal = refusalOf(error);
    for (const id of ids) answers.set(id, refusal);
    return answers;
  }
  try {
    const db = handle.db;
    // see packages/engine/src/planboard.ts - // note: `openCollaborationStore` already refuses a staged, foreign or
    // otherwise inactive lane (`collaboration.not-active`), so nothing is gated
    // again here — the handle only ever carries an ACTIVE lane.
    for (const id of ids) {
      // see packages/engine/src/planboard.ts - // why: The display id is the row's primary key; the stable portable
      // reference is its own column. A board written in `remote` mode carries the
      // reference, and a local lane that only matched `id` reported it missing.
      const row = db
        .prepare(
          `select disposition from issues where (id = ? or issue_ref = ?) and ${SWITCHED_NOT_PRESENTED_SQL} limit 1`,
        )
        .get(id, id) as { disposition?: unknown } | undefined;
      answers.set(
        id,
        typeof row?.disposition === "string"
          ? { kind: "disposition", disposition: row.disposition }
          : { kind: "disposition", disposition: "absent" },
      );
    }
    return answers;
  } catch (error) {
    const refusal = refusalOf(error);
    for (const id of ids) if (!answers.has(id)) answers.set(id, refusal);
    return answers;
  } finally {
    handle.close();
  }
}

/**
 * Read the board and report its drift. An absent file is a clean board; a
 * missing or invalid `review_after` is one file-level `malformed` and
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
    if ((error as { code?: unknown } | null)?.code === "ENOENT") {
      return { path: null, reviewAfter: null, captured: [], candidates: [], findings: [] };
    }
    throw error;
  }

  const parsed = parsePlanboard(text);
  const findings = [...parsed.findings];

  const answers = await answersFor(
    context,
    parsed.issues.map((entry) => entry.id),
  );
  for (const entry of parsed.issues) {
    const answer = answers.get(entry.id) ?? { kind: "laneRefusal", code: "store.unreadable" };
    if (answer.kind === "disposition") {
      if (answer.disposition === "absent") {
        findings.push({
          code: "missing",
          line: entry.line,
          issueId: entry.id,
          message: `${entry.id} is not in the issue store; capture it or remove the line`,
        });
        continue;
      }
      if (answer.disposition !== "open") {
        findings.push({
          code: "stale",
          line: entry.line,
          issueId: entry.id,
          message: `${entry.id} is ${answer.disposition}, so the board line is stale; remove it`,
        });
      }
      continue;
    }
    findings.push({
      code: "unverified",
      line: entry.line,
      issueId: entry.id,
      storeCode: answer.code,
      message: `the issue store did not answer for ${entry.id} (${answer.code})`,
    });
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
  return {
    path,
    reviewAfter: parsed.reviewAfter,
    captured: parsed.issues.map(({ line, id, reason }) => ({ line, issueId: id, reason })),
    candidates: parsed.candidates,
    findings,
  };
}
