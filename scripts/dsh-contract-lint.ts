#!/usr/bin/env bun
/**
 * dsh-contract-lint.ts — machine gates for the tracked dsh host documents.
 *
 * Three prose contracts that only review luck protected, each now one named
 * `file:line <reason>` row (exit 1) instead of a reviewer's memory:
 *
 * 1. Seat bounding (#555 acceptance 1) — every Assignment header block in
 *    `skills/mstar-host/references/{dsh,dsh-workflow-scripts,dsh-agent-teams}.md`
 *    whose `Execute as` role is a review seat must carry a `Budget` label AND a
 *    `Return shape` label, exactly the shape `validateAssignmentFields`
 *    enforces at dispatch. A header block is the lines between the
 *    `## Assignment` heading and the blank line (or heading) that closes it.
 * 2. Carrier vocabulary (#555 acceptance 2) — every `<tool>.<field>` carrier
 *    citation in those documents must match the owning carrier map, and
 *    `dsh-agent-teams.md` must still name every carrier tool.
 * 3. README pin (I-000829) — `packages/dsh/README.i18n.yaml` records exactly
 *    the sibling `README*.md` files of its package, and each recorded blob
 *    hash equals `git hash-object <file>`.
 *
 * Authority rule: the role list, the two label sets and the carrier map are
 * read from their owning source, never restated here. The engine symbols are
 * imported from the source entry (`../packages/engine/src/index.ts`), the same
 * convention `scripts/drift-lint.ts` uses: the package export resolves to the
 * gitignored `dist` build, which a fresh checkout has not built yet. The dsh
 * carrier map cannot be imported at all (`packages/dsh/package.json` exports no
 * `./src/*` subpath, and its module graph pulls the cordis/dsh runtime plus the
 * engine dist), so it is read structurally from its source file — the
 * `packages/dsh/src/gates/dispatch.ts` declaration, precedent
 * `scripts/lint-ascii-literals.ts`. An unparseable map fails loudly; there is
 * no literal fallback.
 *
 * Check 1 is strict: every fenced `## Assignment` header block is read, whether
 * or not a body follows it, so a shape demo copied for a seat cannot skip the
 * bounding contract.
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
  REVIEW_SEAT_ROLES,
  parseAssignmentFields,
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
const HEADING = /^#{1,6}\s/;
// The marker opens a prompt template literal (`agent(`## Assignment`), so it need not start the line.
const ASSIGNMENT_HEADING = /##\s+Assignment\s*$/;

export type Doc = { rel: string; text: string };

/** Engine-absent-value semantics: absent, blank, or an explicit `N/A`. */
function absent(value: string | undefined): boolean {
  return value === undefined || value.trim() === "" || value.trim().toLowerCase() === "n/a";
}

/**
 * The engine's role-token normalization for the `Execute as` value (strip a
 * `@` mention, first whitespace token, case-insensitive). Kept to these three
 * steps so `Execute as: @QC-Specialist-2 (security lens)` still resolves.
 */
function roleToken(value: string | undefined): string {
  return (value ?? "").trim().replace(/^@/, "").toLowerCase().split(/\s+/)[0] ?? "";
}

/** Fenced blocks (` ``` `-delimited) with the 1-based line of their first content line. */
export function fencedBlocks(text: string): Array<{ line: number; lines: string[] }> {
  const blocks: Array<{ line: number; lines: string[] }> = [];
  let current: { line: number; lines: string[] } | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*```/.test(raw)) {
      if (current === null) current = { line: index + 2, lines: [] };
      else {
        blocks.push(current);
        current = null;
      }
      return;
    }
    if (current !== null) current.lines.push(raw);
  });
  if (current !== null) blocks.push(current);
  return blocks;
}

/**
 * Check 1 — seat bounding. Every `## Assignment` header block whose role is a
 * review seat carries a `Budget` and a `Return shape` label; the labels are the
 * engine's own, and the field values come from the engine parser that consumes
 * them (so the check and the dispatch gate agree on what a label is). No header
 * shape is skipped: a fence that ends at its own header is read like any other.
 */
export function checkSeatBounding(
  docs: readonly Doc[],
  seats: readonly string[] = REVIEW_SEAT_ROLES,
): { rows: string[]; blocks: number } {
  const rows: string[] = [];
  let blocks = 0;
  for (const doc of docs) {
    for (const block of fencedBlocks(doc.text)) {
      // One fence can carry several prompts (a shared template rendered per seat).
      block.lines.forEach((line, index) => {
        if (!ASSIGNMENT_HEADING.test(line)) return;
        // The header block runs from the first field line to the blank line that
        // closes it (or to the fence end / the next heading).
        let start = index + 1;
        while (start < block.lines.length && BLANK.test(block.lines[start]!)) start++;
        let end = start;
        while (end < block.lines.length && !BLANK.test(block.lines[end]!) && !HEADING.test(block.lines[end]!)) end++;
        blocks++;
        const fields = parseAssignmentFields(["## Assignment", ...block.lines.slice(start, end)].join("\n"));
        const role = roleToken(fields.executeAs);
        if (!seats.includes(role)) return;
        for (const [label, labels, value] of [
          ["Budget", BUDGET_LABELS, fields.budget],
          ["Return shape", RETURN_SHAPE_LABELS, fields.returnShape],
        ] as const) {
          if (!absent(value)) continue;
          const code = label === "Budget" ? "budget" : "return-shape";
          rows.push(
            `${doc.rel}:${block.line + start} review seat "${role}" header has no ${label} label - `
              + `add one of ${labels.map((l) => `"${l}"`).join(" / ")} (dispatch would report assignment.field.${code}-missing)`,
          );
        }
      });
    }
  }
  return { rows, blocks };
}

/**
 * Check 2 — carrier vocabulary. Parses the carrier map out of its owning
 * declaration; every `<tool>.<field>` citation must match the map's value for
 * that tool, and `teamDoc` must name every tool. An unparseable declaration is
 * one named failure row, never a literal fallback.
 */
export function parseCarrierMap(source: string): { map: Record<string, string>; line: number } | { error: string } {
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((line) => /export\s+const\s+TEAM_DISPATCH_TOOLS\s*(?::[^=]*)?=\s*\{/.test(line));
  if (at === -1) return { error: "could not locate the `export const TEAM_DISPATCH_TOOLS = {` declaration" };
  const map: Record<string, string> = {};
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\}\s*(?:as const|satisfies\b)/.test(line) || /^\}\s*$/.test(line)) {
      return Object.keys(map).length === 0
        ? { error: `TEAM_DISPATCH_TOOLS (line ${at + 1}) declares no tool entries` }
        : { map, line: at + 1 };
    }
    const entry = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*['"]([^'"]*)['"]\s*,?\s*$/);
    if (entry) map[entry[1]!] = entry[2]!;
  }
  return { error: `TEAM_DISPATCH_TOOLS (line ${at + 1}) is not closed before end of file` };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function checkCarrierVocabulary(
  docs: readonly Doc[],
  carrier: Record<string, string>,
  teamDoc: string = TEAM_DOC,
): { rows: string[]; citations: number; tools: number } {
  const rows: string[] = [];
  const tools = Object.keys(carrier);
  let citations = 0;
  if (tools.length === 0) return { rows: ["carrier vocabulary: the owning map is empty - no tool to check"], citations, tools: 0 };
  const citation = new RegExp(`\\b(${tools.map(escapeRegExp).join("|")})\\.([A-Za-z_$][\\w$]*)`, "g");
  for (const doc of docs) {
    doc.text.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(citation)) {
        citations++;
        const [raw, tool, field] = match;
        const expected = carrier[tool!];
        if (expected !== field) {
          rows.push(`${doc.rel}:${index + 1} carrier field "${raw}" is not in the carrier map - ${tool} carries "${expected ?? "nothing"}"`);
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

/** Check 3 — README pin: the recorder names exactly its package's README pair, and every recorded hash is the file's current blob hash. */
export function checkReadmePin(input: ReadmePinInput): { rows: string[]; recorded: number } {
  const rows: string[] = [];
  const recordedAt = new Map<string, { hash: string; line: number }>();
  input.recorderText.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^\s*([A-Za-z0-9._-]+\.md)\s*:\s*([0-9a-f]{40})\s*$/);
    if (match) recordedAt.set(match[1]!, { hash: match[2]!, line: index + 1 });
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

if (import.meta.main) {
  const root = process.cwd();
  const rows: string[] = [];

  const docs = readDocs(root, rows);

  const seats = checkSeatBounding(docs);
  rows.push(...seats.rows);

  const carrierSourceRel = "packages/dsh/src/gates/dispatch.ts";
  const carrierSource = (() => {
    try {
      return readFileSync(join(root, carrierSourceRel), "utf8");
    } catch {
      return null;
    }
  })();
  let carrierSummary = "carrier map unread";
  let carriers: { rows: string[]; citations: number; tools: number } = { rows: [], citations: 0, tools: 0 };
  if (carrierSource === null) {
    rows.push(`${carrierSourceRel}:1 could not read the carrier map source - the check has no authority to compare against`);
  } else {
    const parsed = parseCarrierMap(carrierSource);
    if ("error" in parsed) {
      rows.push(`${carrierSourceRel}:1 ${parsed.error} - the check has no authority to compare against and does not fall back to a literal copy`);
    } else {
      carriers = checkCarrierVocabulary(docs, parsed.map);
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
