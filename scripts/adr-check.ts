/**
 * adr-check.ts — ADR tree validator: bucket/class membership, Status ↔
 * directory, required sections, banned sections, filename shape, no INDEX.md.
 *
 * Contract: the ADR record contract — `docs/adr/` shape, the required and
 * banned sections per lifecycle, the bare Status line, and the seven failure
 * codes with their recoveries. Wired as drift-lint Guard 12.
 *
 * Scope: one walk of the ADR root. Sanctioned non-record files (`README.md`,
 * `{bucket}/TEMPLATE.md`, `.gitkeep` anywhere) are ignored; files outside
 * `{bucket}/{class}/` are out of scope by design — PR review catches strays.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const ADR_BUCKETS = ["proposed", "implemented", "rejected"] as const;
export const ADR_CLASSES = [
  "feature",
  "bug-fix",
  "simplification",
  "architecture",
  "process",
  "testing",
] as const;

export type AdrBucket = (typeof ADR_BUCKETS)[number];

export type AdrFailureCode =
  | "adr.bucket-unknown"
  | "adr.class-unknown"
  | "adr.status-mismatch"
  | "adr.section-missing"
  | "adr.section-banned"
  | "adr.index-forbidden"
  | "adr.name-shape";

export type AdrFailure = {
  /** Repo-relative path, e.g. `docs/adr/implemented/...`. */
  file: string;
  code: AdrFailureCode;
  message: string;
  recovery: string;
};

export type AdrCheckResult = { records: number; failures: AdrFailure[] };

/** `yyyy-mm-dd-topic.md` — shape only, no calendar math (contract §1). */
const RECORD_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** Bare Status line with the U+2014 em dash (contract §4). */
const STATUS_LINE = /^Status: (proposed|implemented|rejected) \u2014 .+$/;

const SECTIONS: Record<AdrBucket, { required: string[]; banned: string[] }> = {
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
};

/** Where a banned implemented section's content belongs instead (contract §6). */
const BANNED_RECOVERY: Record<string, string> = {
  Proposal: 'fold its text into "## Decision" in present tense, then delete the "## Proposal" heading',
  Plan: 'delete the "## Plan" section — plan text dies with the proposal',
  "Migration plan": 'delete the "## Migration plan" section — plan text dies with the proposal',
  "Acceptance criteria":
    'fold it into "## Consequences" (accepted criteria become stated behavior), then delete the "## Acceptance criteria" heading',
};

const isBucket = (name: string): name is AdrBucket => (ADR_BUCKETS as readonly string[]).includes(name);

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

/** Every line before the first level-2 ATX heading (contract §4). */
function headerLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line) => line.startsWith("## "));
  return end === -1 ? lines : lines.slice(0, end);
}

function headingNames(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
}

/** `^## <Name>\b` (contract §3): the character after the name is not a word
 * character, so `## Proposal: x` still counts while `## Proposals` does not. */
function hasSection(headings: string[], name: string): boolean {
  return headings.some((heading) => heading.startsWith(name) && !/\w/.test(heading.charAt(name.length)));
}

function checkRecord(
  path: string,
  relPath: string,
  bucket: AdrBucket,
  push: (failure: AdrFailure) => void,
): void {
  if (!RECORD_NAME.test(basename(path))) {
    push({
      file: relPath,
      code: "adr.name-shape",
      message: `${relPath}: filename is not yyyy-mm-dd-topic.md`,
      recovery:
        "rename it to yyyy-mm-dd-topic.md - a real-shaped date, then a lowercase kebab topic, e.g. 2026-01-01-example-topic.md (the date is the record's original date and never changes across a lifecycle move)",
    });
  }

  const text = readFileSync(path, "utf8");
  const statusLines = headerLines(text).filter((line) => line.startsWith("Status:"));
  if (statusLines.length !== 1) {
    push({
      file: relPath,
      code: "adr.status-mismatch",
      message: `${relPath}: expected exactly one bare "Status: <bucket> — <why>" header line, found ${statusLines.length}`,
      recovery: `add one bare header line "Status: ${bucket} — <one-line why>" before the first "## " heading`,
    });
  } else {
    const match = statusLines[0].match(STATUS_LINE);
    if (!match) {
      push({
        file: relPath,
        code: "adr.status-mismatch",
        message: `${relPath}: malformed Status line "${statusLines[0]}"`,
        recovery: `rewrite it as "Status: ${bucket} — <one-line why>" (bucket, space, U+2014 em dash, space, non-empty single line)`,
      });
    } else if (match[1] !== bucket) {
      push({
        file: relPath,
        code: "adr.status-mismatch",
        message: `${relPath}: Status says ${match[1]} but the record sits under ${bucket}/`,
        recovery: `move the record to docs/adr/${match[1]}/${relPath.split("/").at(-2)}/ or change the Status line to "Status: ${bucket} — <one-line why>"`,
      });
    }
  }

  const headings = headingNames(text);
  for (const name of SECTIONS[bucket].required) {
    if (hasSection(headings, name)) continue;
    push({
      file: relPath,
      code: "adr.section-missing",
      message: `${relPath}: missing required "## ${name}" section for a ${bucket} record`,
      recovery: `add the "## ${name}" section (required for every record under ${bucket}/)`,
    });
  }
  for (const name of SECTIONS[bucket].banned) {
    if (!hasSection(headings, name)) continue;
    push({
      file: relPath,
      code: "adr.section-banned",
      message: `${relPath}: banned "## ${name}" section on an implemented record`,
      recovery: BANNED_RECOVERY[name],
    });
  }
}

export function checkAdrTree(repoRoot: string): AdrCheckResult {
  const result: AdrCheckResult = { records: 0, failures: [] };
  const adrRoot = join(repoRoot, "docs/adr");
  if (!existsSync(adrRoot)) return result;

  const rel = (path: string): string => relative(repoRoot, path);

  for (const path of walkFiles(adrRoot)) {
    if (basename(path) !== "INDEX.md") continue;
    result.failures.push({
      file: rel(path),
      code: "adr.index-forbidden",
      message: `${rel(path)}: INDEX.md must not exist under docs/adr/`,
      recovery:
        "delete it - path + directory is the index (bucket gives the fate, class gives the domain, date sorts the rest)",
    });
  }

  for (const bucketEntry of readdirSync(adrRoot, { withFileTypes: true })) {
    if (!bucketEntry.isDirectory()) continue;
    const bucketDir = join(adrRoot, bucketEntry.name);
    if (!isBucket(bucketEntry.name)) {
      result.failures.push({
        file: rel(bucketDir),
        code: "adr.bucket-unknown",
        message: `${rel(bucketDir)}: directory is not one of the three ADR buckets`,
        recovery: `move its records into one of the three legal buckets - docs/adr/proposed/, docs/adr/implemented/, docs/adr/rejected/ - and delete this directory`,
      });
      continue;
    }

    const bucket = bucketEntry.name;
    for (const classEntry of readdirSync(bucketDir, { withFileTypes: true })) {
      // TEMPLATE.md and strays directly under a bucket are out of scope (§1).
      if (!classEntry.isDirectory()) continue;
      const classDir = join(bucketDir, classEntry.name);
      if (!(ADR_CLASSES as readonly string[]).includes(classEntry.name)) {
        result.failures.push({
          file: rel(classDir),
          code: "adr.class-unknown",
          message: `${rel(classDir)}: directory is not one of the six ADR classes`,
          recovery: `move the record into one of the six legal classes - feature/, bug-fix/, simplification/, architecture/, process/, testing/ - and delete this directory; adding a class needs a validator change in the same PR`,
        });
        continue;
      }
      for (const recordEntry of readdirSync(classDir, { withFileTypes: true })) {
        if (!recordEntry.isFile() || recordEntry.name === ".gitkeep") continue;
        result.records++;
        const path = join(classDir, recordEntry.name);
        checkRecord(path, rel(path), bucket, (failure) => result.failures.push(failure));
      }
    }
  }

  return result;
}

/** Guard 12 footer fragment: `Guard 12 ADR format N records, M failures`. */
export function summarizeAdrCheck(result: AdrCheckResult): string {
  return `Guard 12 ADR format ${result.records} records, ${result.failures.length} failures`;
}
