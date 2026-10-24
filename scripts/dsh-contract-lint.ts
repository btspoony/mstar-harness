#!/usr/bin/env bun
/**
 * dsh-contract-lint.ts — machine gates for the tracked dsh host documents.
 *
 * Three prose contracts that only review luck protected, each now one named
 * `file:line <reason>` row (exit 1) instead of a reviewer's memory:
 *
 * 1. Seat bounding (#555 acceptance 1) — every Assignment in
 *    `skills/mstar-host/references/{dsh,dsh-workflow-scripts,dsh-agent-teams}.md`
 *    that the engine's own field gate demands bounding fields for (a review
 *    seat, or an `audit` round) must carry a `Budget` label AND a `Return shape`
 *    label. The engine decides: each `## Assignment` segment is handed whole to
 *    `validateAssignmentFields`, and only its `budget-missing` /
 *    `return-shape-missing` rows are reported, so the checker never re-derives
 *    the header extent, the seat list or the audit trigger.
 * 2. Carrier vocabulary (#555 acceptance 2) — every `<tool>.<field>` carrier
 *    citation in those documents must match the owning carrier map, and
 *    `dsh-agent-teams.md` must still name every carrier tool.
 * 3. README pin (I-000829) — `packages/dsh/README.i18n.yaml` records exactly
 *    the sibling `README*.md` files of its package, one record each, and each
 *    recorded blob hash equals `git hash-object <file>`.
 *
 * Authority rule: the label sets and the carrier map are read from their owning
 * source, never restated here. The engine symbols are imported from the source
 * entry (`../packages/engine/src/index.ts`), the same convention
 * `scripts/drift-lint.ts` uses: the package export resolves to the gitignored
 * `dist` build, which a fresh checkout has not built yet. The dsh carrier map
 * cannot be imported at all (`packages/dsh/package.json` exports no `./src/*`
 * subpath, and its module graph pulls the cordis/dsh runtime plus the engine
 * dist), so it is read structurally from its source file — the
 * `packages/dsh/src/gates/dispatch.ts` declaration, precedent
 * `scripts/lint-ascii-literals.ts`. An unparseable — or partially parsed — map
 * is named line by line; there is no literal fallback.
 *
 * Check 1 is strict: every fenced `## Assignment` segment is read, whether or
 * not a body follows it, so a shape demo copied for a seat cannot skip the
 * bounding contract. Both fence characters count (backtick and tilde, CommonMark
 * closing rule), and an unbalanced fence is itself a row: the tail of such a
 * document would otherwise fall outside every scan. Check 1 also has a coverage
 * floor: a run that scans no segment, or a document whose markers exist but are
 * not fenced, is a row — an empty scan must never read as "all seats are
 * bounded".
 *
 * Usage: bun run scripts/dsh-contract-lint.ts
 * Exit 0 = the documents match their authorities; exit 1 = at least one row.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUDGET_LABELS,
  RETURN_SHAPE_LABELS,
  parseAssignmentFields,
  validateAssignmentFields,
} from "../packages/engine/src/index.ts";

/** The dsh host documents the gates read (relative to the repo root). */
export const DOCS = [
  "skills/mstar-host/references/dsh.md",
  "skills/mstar-host/references/dsh-agent-teams.md",
  "skills/mstar-host/references/dsh-workflow-scripts.md",
] as const;

/** The document that must keep naming every carrier tool. */
export const TEAM_DOC = "skills/mstar-host/references/dsh-agent-teams.md";

/** The dsh package whose README language pair is pinned. */
export const README_RECORDER = "packages/dsh/README.i18n.yaml";
const README_PACKAGE_DIR = "packages/dsh";
const BLANK = /^\s*$/;
// The marker opens a prompt template literal (`agent(`## Assignment`), so it need not start the line.
const ASSIGNMENT_HEADING = /##\s+Assignment\s*$/;
/** A fence line: three or more backticks or tildes, plus its info string. */
const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const EXECUTE_AS = /Execute as/i;
/** A marker that OWNS its line (leading whitespace allowed — a 4-space indent is the code-block shape). */
const ASSIGNMENT_MARKER_LINE = /^\s*#{1,6}\s+Assignment\s*$/;

export type Doc = { rel: string; text: string };

/**
 * The engine field codes carrying the bounding contract, mapped to the label
 * names (and their accepted forms) used in the failure row. The CODES are the
 * engine's; only the human-readable wording lives here.
 */
const BOUNDING_CODES: Record<string, { label: string; labels: readonly string[] }> = {
  "assignment.field.budget-missing": { label: "Budget", labels: BUDGET_LABELS },
  "assignment.field.return-shape-missing": { label: "Return shape", labels: RETURN_SHAPE_LABELS },
};

export type Fence = { char: string; length: number; line: number };

/**
 * Fence toggles and their content blocks in the CommonMark shape, for BOTH
 * fence characters: a fence closes only on the same character, at least as
 * long, with nothing but whitespace after it. A `~~~` block therefore keeps a
 * ``` line as literal content, and an unclosed fence runs to the document end.
 *
 * `fences` lists every toggle line (1-based), open or close, so an odd count
 * means a fence never closed.
 */
export function scanFences(text: string): { blocks: Array<{ line: number; lines: string[] }>; fences: number[] } {
  const blocks: Array<{ line: number; lines: string[] }> = [];
  const fences: number[] = [];
  let open: Fence | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const match = raw.match(FENCE_OPEN);
    if (open === null) {
      if (match === null) return;
      const marker = match[1]!;
      open = { char: marker[0]!, length: marker.length, line: index + 1 };
      fences.push(index + 1);
      blocks.push({ line: index + 2, lines: [] });
      return;
    }
    const closes =
      match !== null && match[2]!.trim() === "" && match[1]![0] === open.char && match[1]!.length >= open.length;
    if (closes) {
      fences.push(index + 1);
      open = null;
      return;
    }
    blocks[blocks.length - 1]!.lines.push(raw);
  });
  return { blocks, fences };
}

/** Fenced blocks with the 1-based line number of their first content line. */
export function fencedBlocks(text: string): Array<{ line: number; lines: string[] }> {
  return scanFences(text).blocks;
}

/**
 * Unbalanced fences hide the document tail from every scan (the closing line
 * never arrives), so an odd fence count is a failure, named at the last fence.
 * Both fence characters count: counting only backticks would leave a `~~~`
 * document entirely unscanned.
 */
export function checkFenceParity(docs: readonly Doc[]): string[] {
  const rows: string[] = [];
  for (const doc of docs) {
    const { fences } = scanFences(doc.text);
    if (fences.length % 2 === 1) {
      rows.push(
        `${doc.rel}:${fences[fences.length - 1]} unbalanced fences (${fences.length} fence lines) - `
          + "the document tail after the last fence is never scanned",
      );
    }
  }
  return rows;
}

/**
 * Check 1 — seat bounding. Each `## Assignment` segment inside a fence runs to
 * the next `## Assignment` or the fence end and is handed whole to the engine's
 * `validateAssignmentFields`; its bounding rows become one named row each.
 * Header extent, review-seat membership and the `audit` trigger are therefore
 * the engine's, never re-derived here.
 */
export function checkSeatBounding(docs: readonly Doc[]): { rows: string[]; blocks: number } {
  const rows: string[] = [];
  let blocks = 0;
  for (const doc of docs) {
    const before = blocks;
    for (const block of fencedBlocks(doc.text)) {
      block.lines.forEach((line, index) => {
        if (!ASSIGNMENT_HEADING.test(line)) return;
        blocks++;
        // The segment ends at the next Assignment marker or the fence end; the
        // engine's own header-region rule (body markers) decides what it reads.
        let end = index + 1;
        while (end < block.lines.length && !ASSIGNMENT_HEADING.test(block.lines[end]!)) end++;
        const segment = block.lines.slice(index, end);
        const text = segment.join("\n");
        const executeAs = parseAssignmentFields(text).executeAs?.trim();
        // Point at the role line when there is one, else at the marker itself.
        const roleOffset = segment.findIndex((segLine) => EXECUTE_AS.test(segLine));
        const at = block.line + index + (roleOffset === -1 ? 0 : roleOffset);
        const subject = `Assignment (Execute as: ${executeAs === undefined || executeAs === "" ? "(absent)" : executeAs})`;
        for (const violation of validateAssignmentFields(text, { writable: false }).violations) {
          const bounding = BOUNDING_CODES[violation.code];
          if (bounding === undefined) continue;
          rows.push(
            `${doc.rel}:${at} ${subject} header has no ${bounding.label} label - `
              + `add one of ${bounding.labels.map((label) => `"${label}"`).join(" / ")} (dispatch reports ${violation.code})`,
          );
        }
      });
    }
    // Coverage floor, per document: the marker owns a line but no fenced
    // segment came out of it — de-fenced, 4-space indented, or a renamed fence.
    // An inline mention (mid-line) is prose, not a marker, so it stays clean.
    const markerLines = doc.text
      .split(/\r?\n/)
      .flatMap((line, index) => (ASSIGNMENT_MARKER_LINE.test(line) ? [index + 1] : []));
    if (markerLines.length > 0 && blocks === before) {
      rows.push(
        `${doc.rel}:${markerLines[0]} ${markerLines.length} \`## Assignment\` marker line(s) but no fenced segment was scanned - `
          + "the marker sits outside a fenced block (de-fenced, 4-space indented, or a renamed fence), so its seats are unchecked",
      );
    }
  }
  if (blocks === 0) {
    // Run-level: nothing at all was scanned, which is indistinguishable from a
    // gate that has been switched off by its own inputs.
    rows.push(
      "seat bounding: no fenced `## Assignment` segment was found in any gated document - "
        + "the seat-bounding gate scanned nothing (expected the host docs' Assignment prompt templates)",
    );
  }
  return { rows, blocks };
}

/* ------------------------------------------------------------------ */
/* Carrier map (read structurally from its owning declaration)         */
/* ------------------------------------------------------------------ */

export type CarrierMap =
  | { error: string }
  | { map: Record<string, string>; line: number; problems: Array<{ line: number; text: string }> };

/**
 * Parse `TEAM_DISPATCH_TOOLS` out of its declaration. Every non-blank,
 * non-comment line inside the braces must be a complete `name: 'field'` entry;
 * anything else is reported line by line (a trailing comment, a partial or
 * renamed entry) — a skipped line would silently shrink the authority.
 */
export function parseCarrierMap(source: string): CarrierMap {
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((line) => /export\s+const\s+TEAM_DISPATCH_TOOLS\s*(?::[^=]*)?=\s*\{/.test(line));
  if (at === -1) return { error: "could not locate the `export const TEAM_DISPATCH_TOOLS = {` declaration" };
  const map: Record<string, string> = {};
  const problems: Array<{ line: number; text: string }> = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\}\s*(?:as const|satisfies\b)/.test(line) || /^\}\s*$/.test(line)) {
      if (Object.keys(map).length === 0) return { error: `TEAM_DISPATCH_TOOLS (line ${at + 1}) declares no tool entries` };
      return { map, line: at + 1, problems };
    }
    if (BLANK.test(line) || /^\s*(?:\/\/|\/?\*)/.test(line)) continue;
    const entry = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*['"]([^'"]*)['"]\s*,?\s*$/);
    if (entry) map[entry[1]!] = entry[2]!;
    else problems.push({ line: i + 1, text: line.trim() });
  }
  return { error: `TEAM_DISPATCH_TOOLS (line ${at + 1}) is not closed before end of file` };
}

/**
 * A carrier citation, recognised WITHOUT consulting the map: a snake_case tool
 * name dotted with a field (`` `send_message.message` ``). The boundary is the
 * tool-name shape, which is what lets a citation survive the tool disappearing
 * from the map — a map-anchored pattern would go silent exactly then.
 *
 * shortcut: bare tool mentions (no dotted field) cannot be scanned this way
 * without matching every snake_case token in the prose, so they are only
 * checked for the map's own keys (the team-document leg); upgrade if a second
 * carrier family appears.
 */
const CARRIER_CITATION = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\.([A-Za-z_$][\w$]*)\b/g;

export function checkCarrierVocabulary(
  docs: readonly Doc[],
  carrier: Record<string, string>,
  teamDoc: string = TEAM_DOC,
): { rows: string[]; citations: number; tools: number } {
  const rows: string[] = [];
  const tools = Object.keys(carrier);
  let citations = 0;
  if (tools.length === 0) {
    return { rows: ["carrier vocabulary: the owning map is empty - no tool to check"], citations, tools: 0 };
  }
  for (const doc of docs) {
    doc.text.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(CARRIER_CITATION)) {
        citations++;
        const [raw, tool, field] = match;
        if (!Object.hasOwn(carrier, tool!)) {
          rows.push(`${doc.rel}:${index + 1} carrier citation "${raw}" names tool "${tool}", which is not in the carrier map`);
          continue;
        }
        const expected = carrier[tool!];
        if (expected !== field) {
          rows.push(
            `${doc.rel}:${index + 1} carrier field "${raw}" is not in the carrier map - ${tool} carries "${expected ?? "nothing"}"`,
          );
        }
      }
    });
  }
  const team = docs.find((doc) => doc.rel === teamDoc);
  if (team === undefined) {
    rows.push(`${teamDoc}:1 the carrier-tool document was not read`);
    return { rows, citations, tools: tools.length };
  }
  for (const tool of tools) {
    if (!team.text.includes(tool)) {
      rows.push(`${teamDoc}:1 carrier tool "${tool}" is no longer documented - the team dispatch route must name all ${tools.length} carriers`);
    }
  }
  return { rows, citations, tools: tools.length };
}

/* ------------------------------------------------------------------ */
/* README pin                                                          */
/* ------------------------------------------------------------------ */

export type ReadmePinInput = {
  recorderRel: string;
  recorderText: string;
  /** Package dir holding the README pair, relative to the root. */
  packageDir: string;
  /** Sibling README file NAMES of that package (`README.md`, `README.zh.md`). */
  siblings: readonly string[];
  /** Blob hash (`git hash-object`) of a repo-relative file, or undefined when absent. */
  hashOf: (rel: string) => string | undefined;
};

/**
 * One recorder entry: `<file>.md: <40-hex blob hash>`, with an optional MATCHED
 * pair of quotes around either value (both are valid YAML). Strict on purpose —
 * a line this does not match is reported, never skipped, because an unread line
 * is exactly how a second record for the same file escapes the duplicate row.
 */
const README_RECORD = /^\s*(["']?)([A-Za-z0-9._-]+\.md)\1\s*:\s*(["']?)([0-9a-f]{40})\3\s*$/;

/** Check 3 — README pin: the recorder names exactly its package's README pair once, and every recorded hash is the file's current blob hash. */
export function checkReadmePin(input: ReadmePinInput): { rows: string[]; recorded: number } {
  const rows: string[] = [];
  const recordedAt = new Map<string, { hash: string; line: number }>();
  input.recorderText.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const match = line.match(README_RECORD);
    if (!match) {
      rows.push(
        `${input.recorderRel}:${index + 1} recorder line is not a \`<file>.md: <40-hex blob hash>\` record: `
          + `${JSON.stringify(trimmed)} - the pin cannot verify this line`,
      );
      return;
    }
    const name = match[2]!;
    const first = recordedAt.get(name);
    if (first !== undefined) {
      // Last-record-wins would let a stale duplicate hide behind a fresh one.
      rows.push(
        `${input.recorderRel}:${index + 1} records "${name}" a second time (first record at line ${first.line}) - `
          + "one record per sibling; delete the duplicate",
      );
      return;
    }
    recordedAt.set(name, { hash: match[4]!, line: index + 1 });
  });
  const siblings = [...input.siblings].sort();
  const siblingSet = new Set(siblings);
  const pathOf = (name: string): string => `${input.packageDir}/${name}`;
  for (const [name, entry] of recordedAt) {
    if (!siblingSet.has(name)) {
      rows.push(
        `${input.recorderRel}:${entry.line} recorded "${name}" is not a README sibling of ${input.packageDir} - `
          + `the pin records exactly ${siblings.join(", ")}`,
      );
      continue;
    }
    const actual = input.hashOf(pathOf(name));
    if (actual === undefined) {
      rows.push(`${input.recorderRel}:${entry.line} recorded "${name}" does not exist (expected at ${pathOf(name)})`);
    } else if (actual !== entry.hash) {
      rows.push(
        `${input.recorderRel}:${entry.line} recorded hash ${entry.hash} for "${name}" is stale - git hash-object ${pathOf(name)} reports ${actual}; `
          + "re-confirm both languages and re-record",
      );
    }
  }
  for (const name of siblings) {
    if (!recordedAt.has(name)) {
      rows.push(
        `${input.recorderRel}:1 the README pair records no hash for "${name}" - `
          + "the language pair is three sibling files and both sides must be pinned",
      );
    }
  }
  return { rows, recorded: recordedAt.size };
}

/* ------------------------------------------------------------------ */
/* Entry                                                              */
/* ------------------------------------------------------------------ */

function readDocs(root: string, rows: string[]): Doc[] {
  const docs: Doc[] = [];
  for (const rel of DOCS) {
    try {
      docs.push({ rel, text: readFileSync(join(root, rel), "utf8") });
    } catch {
      rows.push(`${rel}:1 could not read the dsh host document`);
    }
  }
  return docs;
}

/** `git hash-object` for a repo-relative file, or undefined when git cannot answer. */
function blobHash(root: string, rel: string): string | undefined {
  try {
    return execFileSync("git", ["hash-object", "--", rel], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** The package's README sibling NAMES (`README.md` / `README.<lang>.md`). */
function readmeSiblings(root: string): string[] {
  return readdirSync(join(root, README_PACKAGE_DIR))
    .filter((name) => /^README(\.[A-Za-z0-9-]+)?\.md$/.test(name))
    .sort();
}

const CARRIER_SOURCE_REL = "packages/dsh/src/gates/dispatch.ts";

if (import.meta.main) {
  const root = process.cwd();
  const rows: string[] = [];

  const docs = readDocs(root, rows);
  rows.push(...checkFenceParity(docs));

  const seats = checkSeatBounding(docs);
  rows.push(...seats.rows);

  const carrierSource = (() => {
    try {
      return readFileSync(join(root, CARRIER_SOURCE_REL), "utf8");
    } catch {
      return null;
    }
  })();
  let carrierSummary = "carrier map unread";
  if (carrierSource === null) {
    rows.push(
      `${CARRIER_SOURCE_REL}:1 could not read the carrier map source - the check has no authority to compare against`,
    );
  } else {
    const parsed = parseCarrierMap(carrierSource);
    if ("error" in parsed) {
      rows.push(
        `${CARRIER_SOURCE_REL}:1 ${parsed.error} - the check has no authority to compare against and does not fall back to a literal copy`,
      );
    } else if (parsed.problems.length > 0) {
      // A partially parsed map is not an authority: name every unreadable line
      // and skip the vocabulary scan rather than compare against a short map.
      for (const problem of parsed.problems) {
        rows.push(
          `${CARRIER_SOURCE_REL}:${problem.line} carrier map entry is not a complete \`name: 'field'\` line: `
            + `${JSON.stringify(problem.text)} - fix the declaration (a trailing comment or a partial entry would silently drop the tool)`,
        );
      }
      carrierSummary = `${parsed.problems.length} unparsed carrier map line(s), vocabulary not checked`;
    } else {
      const carriers = checkCarrierVocabulary(docs, parsed.map);
      rows.push(...carriers.rows);
      carrierSummary = `${carriers.tools} carrier tools, ${carriers.citations} field citations across ${docs.length} documents`;
    }
  }

  let pinSummary = "recorder unread";
  if (!existsSync(join(root, README_RECORDER))) {
    rows.push(`${README_RECORDER}:1 the README language-pair recorder is missing`);
  } else {
    const pin = checkReadmePin({
      recorderRel: README_RECORDER,
      recorderText: readFileSync(join(root, README_RECORDER), "utf8"),
      packageDir: README_PACKAGE_DIR,
      siblings: readmeSiblings(root),
      hashOf: (rel) => (existsSync(join(root, rel)) ? blobHash(root, rel) : undefined),
    });
    rows.push(...pin.rows);
    pinSummary = `${pin.recorded} recorded blob hashes match git hash-object`;
  }

  const seatSummary = `${seats.blocks} Assignment header block(s) scanned, ${seats.rows.length} seat-bounding violation(s); carrier vocabulary ${carrierSummary}; README pin ${pinSummary}`;

  if (rows.length > 0) {
    console.error(`dsh-contract-lint: ${rows.length} violation(s) found\n`);
    for (const row of rows) console.error(`  \u2717 ${row}`);
    console.error(`\ndsh-contract-lint: FAILED - ${seatSummary}`);
    process.exit(1);
  }
  console.log(`dsh-contract-lint: OK - ${seatSummary}`);
}
