/**
 * scripts/adr-check.ts — ADR tree validator semantics, one case per
 * `AdrFailureCode` in `scripts/adr-check.ts` plus a well-formed positive
 * control. Each case asserts the code (not just failure) and that the recovery
 * names a fix a reader can actually perform.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ADR_BUCKETS, ADR_CLASSES, checkAdrTree } from "./adr-check.ts";

const ADR_ROOT = "docs/adr";

/** Write `files` (path under docs/adr -> text) into a fresh temp repo and
 * hand the repo root to `run`. */
function withTree<T>(files: Record<string, string>, run: (repoRoot: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "adr-check-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      const target = join(dir, ADR_ROOT, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A record body with the given sections, a Status line agreeing with
 * `status`, and nothing else. */
function record(status: string, sections: string[], why = "because"): string {
  const body = sections.flatMap((name) => [`## ${name}`, "", "Body text.", ""]);
  return ["# ADR: Example record", "", `Status: ${status} — ${why}`, "", ...body].join("\n");
}

const IMPLEMENTED_SECTIONS = ["Problem", "Decision", "Alternatives considered", "Consequences"];
const PROPOSED_SECTIONS = ["Problem", "Proposal", "Alternatives considered", "Acceptance criteria", "Risks"];
const REJECTED_SECTIONS = ["Problem", "Proposal", "Alternatives considered"];

describe("checkAdrTree — positive control", () => {
  test("well-formed implemented/architecture record passes with 1 record and no failures", () => {
    const result = withTree(
      { "implemented/architecture/2026-01-01-example.md": record("implemented", IMPLEMENTED_SECTIONS) },
      checkAdrTree,
    );
    expect(result.records).toBe(1);
    expect(result.failures).toEqual([]);
  });
});

describe("checkAdrTree — failure codes", () => {
  test("adr.bucket-unknown: a directory outside the three buckets fails and names all three", () => {
    const result = withTree(
      { "archive/architecture/2026-01-02-old.md": record("implemented", IMPLEMENTED_SECTIONS) },
      checkAdrTree,
    );
    expect(result.failures.map((f) => f.code)).toEqual(["adr.bucket-unknown"]);
    const [failure] = result.failures;
    expect(failure.message).toContain(`${ADR_ROOT}/archive`);
    for (const bucket of ADR_BUCKETS) expect(failure.recovery).toContain(`${bucket}/`);
  });

  test("adr.class-unknown: an unknown class directory fails and lists all six classes", () => {
    const result = withTree(
      { "proposed/refactor/2026-01-03-refactor.md": record("proposed", PROPOSED_SECTIONS) },
      checkAdrTree,
    );
    expect(result.failures.map((f) => f.code)).toEqual(["adr.class-unknown"]);
    const [failure] = result.failures;
    expect(failure.message).toContain(`${ADR_ROOT}/proposed/refactor`);
    for (const cls of ADR_CLASSES) expect(failure.recovery).toContain(`${cls}/`);
  });

  test("adr.status-mismatch: an implemented record under rejected/ fails and the recovery names the move", () => {
    const result = withTree(
      { "rejected/architecture/2026-01-04-moved.md": record("implemented", REJECTED_SECTIONS) },
      checkAdrTree,
    );
    expect(result.failures.map((f) => f.code)).toEqual(["adr.status-mismatch"]);
    const [failure] = result.failures;
    expect(failure.message).toContain(`${ADR_ROOT}/rejected/architecture/2026-01-04-moved.md`);
    expect(failure.recovery).toContain("implemented/architecture");
  });

  test("adr.section-missing: a proposed record without ## Alternatives considered names that heading", () => {
    const result = withTree(
      {
        "proposed/feature/2026-01-05-missing.md": record("proposed", [
          "Problem",
          "Proposal",
          "Acceptance criteria",
          "Risks",
        ]),
      },
      checkAdrTree,
    );
    expect(result.failures.map((f) => f.code)).toEqual(["adr.section-missing"]);
    const [failure] = result.failures;
    expect(failure.message).toContain("## Alternatives considered");
    expect(failure.recovery).toContain("## Alternatives considered");
  });

  test("adr.section-banned: an implemented record carrying ## Proposal fails with the fold/delete recovery", () => {
    const result = withTree(
      {
        "implemented/architecture/2026-01-06-banned.md": record("implemented", [
          ...IMPLEMENTED_SECTIONS,
          "Proposal",
        ]),
      },
      checkAdrTree,
    );
    expect(result.failures.map((f) => f.code)).toEqual(["adr.section-banned"]);
    const [failure] = result.failures;
    expect(failure.message).toContain("## Proposal");
    expect(failure.recovery).toContain("## Decision");
  });

  test("adr.index-forbidden: an INDEX.md under docs/adr/ fails and names the path as the index", () => {
    const result = withTree({ "INDEX.md": "# Index\n" }, checkAdrTree);
    expect(result.failures.map((f) => f.code)).toEqual(["adr.index-forbidden"]);
    const [failure] = result.failures;
    expect(failure.message).toContain(`${ADR_ROOT}/INDEX.md`);
    expect(failure.recovery).toContain("path + directory is the index");
  });

  test("adr.name-shape: a record named example.md fails with the required shape and an example", () => {
    const result = withTree(
      { "implemented/architecture/example.md": record("implemented", IMPLEMENTED_SECTIONS) },
      checkAdrTree,
    );
    expect(result.failures.map((f) => f.code)).toEqual(["adr.name-shape"]);
    const [failure] = result.failures;
    expect(failure.message).toContain(`${ADR_ROOT}/implemented/architecture/example.md`);
    expect(failure.recovery).toContain("yyyy-mm-dd-topic.md");
    expect(failure.recovery).toContain("2026-01-01-example-topic.md");
  });
});

// A fenced block is example text: a `## <name>` line inside it is not a section
// of the record, in either direction.
describe("checkAdrTree — headings inside fenced code blocks", () => {
  test("a banned heading quoted in a fence passes (it is not a section)", () => {
    const body = record("implemented", IMPLEMENTED_SECTIONS).replace(
      "## Decision\n",
      "```markdown\n## Proposal\n\nProposal-era shape, quoted as an example.\n```\n\n## Decision\n",
    );
    const result = withTree({ "implemented/architecture/2026-01-07-fenced.md": body }, checkAdrTree);
    expect(result.failures).toEqual([]);
  });

  test("a required heading that only exists inside a fence does not count", () => {
    const body = record(
      "implemented",
      IMPLEMENTED_SECTIONS.filter((name) => name !== "Decision"),
    ).replace("# ADR: Example record", "# ADR: Example record\n\n```markdown\n## Decision\n\nFenced example only.\n```");
    const result = withTree({ "implemented/architecture/2026-01-08-fenced.md": body }, checkAdrTree);
    expect(result.failures.map((f) => f.code)).toEqual(["adr.section-missing"]);
    const [failure] = result.failures;
    expect(failure.message).toContain("## Decision");
  });
});

// The status-mismatch code has three branches: no single Status line, a
// malformed line, and a bucket disagreement. The cross-bucket case above
// disagrees with its directory; these pin the disagreement whose body and
// directory agree, plus the two line-shape branches.
describe("checkAdrTree — Status line shapes", () => {
  test("a Status line naming another bucket under the right directory offers both repairs", () => {
    const result = withTree(
      { "implemented/architecture/2026-01-09-status.md": record("rejected", IMPLEMENTED_SECTIONS) },
      checkAdrTree,
    );
    expect(result.failures.map((f) => f.code)).toEqual(["adr.status-mismatch"]);
    const [failure] = result.failures;
    expect(failure.message).toContain("Status says rejected but the record sits under implemented/");
    expect(failure.recovery).toContain("rejected/architecture");
    expect(failure.recovery).toContain('change the Status line to "Status: implemented');
  });

  test("an ASCII hyphen instead of the em dash is malformed and names the rewrite", () => {
    const body = record("implemented", IMPLEMENTED_SECTIONS).replace(
      "Status: implemented — because",
      "Status: implemented - because",
    );
    const result = withTree({ "implemented/architecture/2026-01-10-malformed.md": body }, checkAdrTree);
    expect(result.failures.map((f) => f.code)).toEqual(["adr.status-mismatch"]);
    const [failure] = result.failures;
    expect(failure.message).toContain('malformed Status line "Status: implemented - because"');
    expect(failure.recovery).toContain("U+2014 em dash");
  });

  test("two Status lines fail the count with the one-bare-line recovery", () => {
    const body = record("implemented", IMPLEMENTED_SECTIONS).replace(
      "Status: implemented — because",
      "Status: implemented — because\nStatus: implemented — again",
    );
    const result = withTree({ "implemented/architecture/2026-01-11-duplicate.md": body }, checkAdrTree);
    expect(result.failures.map((f) => f.code)).toEqual(["adr.status-mismatch"]);
    const [failure] = result.failures;
    expect(failure.message).toContain("found 2");
    expect(failure.recovery).toContain('before the first "## " heading');
  });
});

// An unterminated fence runs to the end of the document, so every later heading
// would silently disappear from the check: a banned section escapes and required
// sections read as missing. The record must fail on the fence instead.
describe("checkAdrTree — an unterminated fence", () => {
  test("adr.fence-unclosed: the tail is not scanned, so the record fails on the fence", () => {
    const rel = `${ADR_ROOT}/implemented/architecture/2026-01-12-unclosed.md`;
    const body = record("implemented", IMPLEMENTED_SECTIONS).replace(
      "## Decision\n",
      "```markdown\n## Decision\n\nQuoted shape with no closing fence.\n",
    );
    const fenceLine = body.split("\n").findIndex((line) => line.startsWith("```")) + 1;
    const result = withTree({ "implemented/architecture/2026-01-12-unclosed.md": body }, checkAdrTree);
    expect(result.failures.map((f) => f.code)).toEqual(["adr.fence-unclosed"]);
    const [failure] = result.failures;
    expect(failure.file).toBe(rel);
    expect(failure.message).toContain(`${rel}:${fenceLine}`);
    expect(failure.message).toContain("unbalanced fences (1 fence lines)");
    expect(failure.recovery).toContain("closing fence");
  });
});
