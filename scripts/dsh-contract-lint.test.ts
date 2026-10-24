/**
 * scripts/dsh-contract-lint.ts — the three dsh document gates.
 *
 * Every authority these tests compare against is read from its owning source
 * (the engine entry for the seat list and label sets, the dsh carrier
 * declaration for the map, `git hash-object` for the README pin), so a
 * renamed role, label or carrier surfaces here instead of in a literal copy.
 * Each check has a seeded-violation case (the fixture fails) and the same
 * fixture clean (it passes), so a check that stopped firing would be visible.
 * Volatile facts stay derived: no absolute path, cwd or hash is pinned.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BUDGET_LABELS,
  RETURN_SHAPE_LABELS,
  REVIEW_SEAT_ROLES,
  parseAssignmentFields,
} from "../packages/engine/src/index.ts";
import {
  DOCS,
  TEAM_DOC,
  checkCarrierVocabulary,
  checkFenceParity,
  checkReadmePin,
  checkSeatBounding,
  parseCarrierMap,
  scanFences,
  type Doc,
} from "./dsh-contract-lint.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const CARRIER_SOURCE = "packages/dsh/src/gates/dispatch.ts";

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** The carrier map, read structurally from its owning declaration (no literal copy). */
function carrierMap(): Record<string, string> {
  const parsed = parseCarrierMap(read(CARRIER_SOURCE));
  if ("error" in parsed) throw new Error(`carrier map unparseable: ${parsed.error}`);
  return parsed.map;
}

/** An `## Assignment` fence: heading + header fields (+ optional prompt text). */
function payload(header: readonly string[], body = "Operator: keep this body."): string {
  return ["# Example", "", "```ts", "## Assignment", "", ...header, "", body, "```", ""].join("\n");
}

/** The 1-based line of the first line matching `pattern` in `text`. */
function lineOf(text: string, pattern: RegExp): number {
  return text.split("\n").findIndex((line) => pattern.test(line)) + 1;
}

describe("checkSeatBounding — seat header blocks carry the bounding labels", () => {
  const seat = REVIEW_SEAT_ROLES[0]!;
  const nonSeat = "zz-not-a-review-seat";
  const boundingLabels = (label: string): string => (label === "Budget" ? BUDGET_LABELS[0]! : RETURN_SHAPE_LABELS[0]!);

  test("a review-seat payload without the labels yields one row per label", () => {
    const text = payload([`Execute as: ${seat}`, "Delegation: forbidden", "Task category: audit"]);
    const doc: Doc = { rel: "fixture.md", text };
    const { rows, blocks } = checkSeatBounding([doc]);
    expect(blocks).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toStartWith(`fixture.md:${lineOf(text, /^Execute as:/)} `);
    expect(rows[0]).toContain(`Execute as: ${seat}`);
    expect(rows[0]).toContain(boundingLabels("Budget"));
    expect(rows[0]).toContain("assignment.field.budget-missing");
    expect(rows[1]).toContain(boundingLabels("Return shape"));
    expect(rows[1]).toContain("assignment.field.return-shape-missing");
  });

  test("F1: the header extent is the engine's, so a blank line between fields does not skip the gate", () => {
    // Would pass silently under a "header ends at the first blank line" reading,
    // yet the dispatch gate refuses it: the engine scans the whole region.
    const text = payload(["Delegation: forbidden", "", `Execute as: ${seat}`, "Task category: audit"]);
    // The engine finds the role across the blank line; the rows below prove the
    // checker inherited that extent instead of closing the header early.
    expect(parseAssignmentFields(["## Assignment", "Delegation: forbidden", "", `Execute as: ${seat}`].join("\n")).executeAs).toBe(seat);
    const { rows } = checkSeatBounding([{ rel: "fixture.md", text }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("assignment.field.budget-missing");
    expect(rows[1]).toContain("assignment.field.return-shape-missing");
  });

  test("the same payload with both labels passes, whichever accepted label form is used", () => {
    // The bare labels parse in the plain form; the parenthesized ones need bold
    // (the engine's own grammar — never widened here).
    const header = [`Execute as: ${seat}`, "Delegation: forbidden", "Task category: audit"];
    for (const labels of [
      [BUDGET_LABELS[1]!, RETURN_SHAPE_LABELS[1]!],
      [`**${BUDGET_LABELS[0]}**`, `**${RETURN_SHAPE_LABELS[0]}**`],
    ]) {
      const text = payload([...header, `${labels[0]}: /1 round`, `${labels[1]}: verdict and findings`]);
      // Guard the assumption: the engine parser is what decides, not this test.
      const fields = parseAssignmentFields(
        ["## Assignment", ...header, `${labels[0]}: x`, `${labels[1]}: y`].join("\n"),
      );
      expect(fields.budget).toBe("x");
      expect(fields.returnShape).toBe("y");
      expect(checkSeatBounding([{ rel: "fixture.md", text }]).rows).toEqual([]);
    }
  });

  test("every engine review-seat role is gated (the seat list stays the engine's)", () => {
    for (const role of REVIEW_SEAT_ROLES) {
      const text = payload([`Execute as: ${role}`, "Delegation: forbidden", "Task category: review"]);
      expect(checkSeatBounding([{ rel: "fixture.md", text }]).rows).toHaveLength(2);
    }
  });

  test("F6: an audit round on a non-seat role is gated too, exactly as the engine does", () => {
    const audit = payload([`Execute as: ${nonSeat}`, "Delegation: forbidden", "Task category: audit"]);
    const rows = checkSeatBounding([{ rel: "fixture.md", text: audit }]).rows;
    expect(rows).toHaveLength(2);
    // ... while the same role on a normal round needs no bounding labels.
    const normal = payload([`Execute as: ${nonSeat}`, "Delegation: forbidden", "Task category: logic"]);
    expect(checkSeatBounding([{ rel: "fixture.md", text: normal }]).rows).toEqual([]);
  });

  test("b2: a review-seat header inside a tilde fence yields both bounding rows", () => {
    const text = ["~~~markdown", "## Assignment", "", `Execute as: ${seat}`, "Delegation: forbidden", "Task category: audit", "~~~", ""].join("\n");
    const result = checkSeatBounding([{ rel: "fixture.md", text }]);
    expect(result.blocks).toBe(1);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toContain("assignment.field.budget-missing");
    expect(result.rows[1]).toContain("assignment.field.return-shape-missing");
  });

  test("a fence that ends at its own header is still gated (no shape is skipped)", () => {
    const text = ["```markdown", "## Assignment", "", `Execute as: ${seat}`, "Delegation: forbidden", "Task category: audit", "```", ""].join("\n");
    const result = checkSeatBounding([{ rel: "fixture.md", text }]);
    expect(result.blocks).toBe(1);
    expect(result.rows).toHaveLength(2);
  });

  test("F-1: a marker that owns a line but is not fenced yields the per-document coverage row", () => {
    // Both shapes the review named: the fence removed, and the marker re-indented
    // into a 4-space code block (which is not a fence at all).
    for (const lines of [
      ["# Example", "", "## Assignment", "", `Execute as: ${seat}`, "Delegation: forbidden", "Task category: audit", ""],
      ["# Example", "", "    ## Assignment", `    Execute as: ${seat}`, "    Delegation: forbidden", "    Task category: audit", ""],
    ]) {
      const text = lines.join("\n");
      const result = checkSeatBounding([{ rel: "fixture.md", text }]);
      expect(result.blocks).toBe(0);
      const coverage = result.rows.filter((row) => row.includes("no fenced segment was scanned"));
      expect(coverage).toHaveLength(1);
      expect(coverage[0]).toStartWith(`fixture.md:${lineOf(text, /^\s*## Assignment/)} `);
      expect(coverage[0]).toContain("1 `## Assignment` marker line(s) but no fenced segment was scanned");
      // ... and the run-level row also fires, because nothing was scanned at all.
      expect(result.rows.some((row) => row.includes("the seat-bounding gate scanned nothing"))).toBe(true);
    }
  });

  test("F-1: a corpus with no marker at all yields the zero-coverage row", () => {
    const result = checkSeatBounding([{ rel: "fixture.md", text: "# Empty\n\nnothing about dispatches here\n" }]);
    expect(result.blocks).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toContain("no fenced `## Assignment` segment was found in any gated document");
    expect(result.rows[0]).toContain("the seat-bounding gate scanned nothing");
  });

  test("F-1: an inline marker mention is prose, not a coverage hole", () => {
    // The doc mentions the marker mid-line and carries no segment; a sibling doc
    // does, so neither the per-document nor the run-level floor may fire.
    const docs: Doc[] = [
      { rel: "inline.md", text: "# Doc\n\nThe `## Assignment` header region is parsed by the engine.\n" },
      { rel: "real.md", text: payload([`Execute as: ${nonSeat}`, "Delegation: forbidden", "Task category: logic"]) },
    ];
    const result = checkSeatBounding(docs);
    expect(result.blocks).toBe(1);
    expect(result.rows).toEqual([]);
  });

  test("F-1: the three real dsh documents scan their segments and stay clean", () => {
    const docs: Doc[] = DOCS.map((rel) => ({ rel, text: read(rel) }));
    const result = checkSeatBounding(docs);
    // Derived, never pinned: the floor is "at least one segment", not a count.
    expect(result.blocks).toBeGreaterThan(0);
    expect(result.rows).toEqual([]);
  });

  test("several Assignment segments in one fence are each checked", () => {
    const text = [
      "```ts",
      "## Assignment",
      "",
      `Execute as: ${seat}`,
      "Delegation: forbidden",
      "Task category: audit",
      "body one",
      "## Assignment",
      "",
      `Execute as: ${seat}`,
      "Delegation: forbidden",
      "Task category: audit",
      "body two",
      "```",
      "",
    ].join("\n");
    const result = checkSeatBounding([{ rel: "fixture.md", text }]);
    expect(result.blocks).toBe(2);
    expect(result.rows).toHaveLength(4);
  });
});

describe("checkFenceParity — an unbalanced fence cannot hide a document tail", () => {
  test("F4: an odd fence count is a named row at the last fence", () => {
    const text = ["```ts", "## Assignment", "", "Execute as: x", "```", "", "```ts", "unclosed tail", ""].join("\n");
    const rows = checkFenceParity([{ rel: "fixture.md", text }]);
    const lastFence = text.split("\n").reduce((last, line, index) => (/^\s*```/.test(line) ? index : last), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith(`fixture.md:${lastFence + 1} `);
    expect(rows[0]).toContain("unbalanced fences (3 fence lines)");
  });

  test("balanced fences pass", () => {
    expect(checkFenceParity([{ rel: "fixture.md", text: "```ts\nbody\n```\n" }])).toEqual([]);
  });

  test("b2: an odd tilde-fence count is a named parity row too", () => {
    const text = ["~~~markdown", "## Assignment", "", "Execute as: x", "~~~", "", "~~~markdown", "unclosed tail", ""].join("\n");
    const rows = checkFenceParity([{ rel: "fixture.md", text }]);
    const lastFence = text.split("\n").reduce((last, line, index) => (/^~~~/.test(line) ? index : last), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith(`fixture.md:${lastFence + 1} `);
    expect(rows[0]).toContain("unbalanced fences (3 fence lines)");
  });

  test("b2: a shorter or different-character fence line does not close the block", () => {
    const text = ["~~~~", "still inside", "~~~", "also inside", "```", "five tildes close:", "~~~~~", "outside", ""].join("\n");
    const { blocks, fences } = scanFences(text);
    expect(fences).toEqual([1, 7]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines).toEqual(["still inside", "~~~", "also inside", "```", "five tildes close:"]);
  });
});

describe("checkCarrierVocabulary — citations match the owning carrier map", () => {
  const map = carrierMap();
  const tools = Object.keys(map);
  const tool = tools[0]!;

  test("the owning declaration parses into a complete map", () => {
    const parsed = parseCarrierMap(read(CARRIER_SOURCE));
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.problems).toEqual([]);
    expect(tools.length).toBeGreaterThan(0);
    expect(typeof map[tool]).toBe("string");
  });

  test("every tool named in the map, cited correctly, passes", () => {
    const text = tools.map((name) => `\`${name}.${map[name]}\``).join(" and ");
    const docs: Doc[] = [
      { rel: TEAM_DOC, text },
      { rel: "fixture.md", text },
    ];
    const result = checkCarrierVocabulary(docs, map);
    expect(result.rows).toEqual([]);
    expect(result.citations).toBe(tools.length * 2);
    expect(result.tools).toBe(tools.length);
  });

  test("a cited field the map does not carry yields a named row", () => {
    const wrong = `${tool}.${tool}_field_that_does_not_exist`;
    const docs: Doc[] = [
      { rel: TEAM_DOC, text: tools.map((name) => `\`${name}.${map[name]}\``).join(" and ") },
      { rel: "fixture.md", text: `The carrier is \`${wrong}\`.` },
    ];
    const rows = checkCarrierVocabulary(docs, map).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith("fixture.md:1 ");
    expect(rows[0]).toContain(wrong);
    expect(rows[0]).toContain(map[tool]!);
  });

  test("F2: a citation for a tool dropped from the map still reddens (pattern is map-independent)", () => {
    const dropped = tools[tools.length - 1]!;
    const partial = Object.fromEntries(Object.entries(map).filter(([name]) => name !== dropped));
    const docs: Doc[] = [
      { rel: TEAM_DOC, text: Object.keys(partial).map((name) => `\`${name}.${partial[name]}\``).join(" and ") },
      { rel: "fixture.md", text: `Still cited: \`${dropped}.${map[dropped]}\`.` },
    ];
    const rows = checkCarrierVocabulary(docs, partial).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith("fixture.md:1 ");
    expect(rows[0]).toContain(`names tool "${dropped}", which is not in the carrier map`);
  });

  test("a carrier tool dropped from the team document yields a named row", () => {
    const missing = tools[tools.length - 1]!;
    const text = tools
      .filter((name) => name !== missing)
      .map((name) => `\`${name}.${map[name]}\``)
      .join(" and ");
    const rows = checkCarrierVocabulary([{ rel: TEAM_DOC, text }], map).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith(`${TEAM_DOC}:1 `);
    expect(rows[0]).toContain(`"${missing}"`);
  });

  test("an unparseable carrier declaration fails loudly instead of falling back to a literal", () => {
    expect(parseCarrierMap("const somethingElse = 1;\n")).toEqual({
      error: "could not locate the `export const TEAM_DISPATCH_TOOLS = {` declaration",
    });
    expect(checkCarrierVocabulary([{ rel: TEAM_DOC, text: "" }], {}).rows[0]).toContain("owning map is empty");
  });

  test("F3: a partially parsed declaration is reported line by line", () => {
    const source = [
      "const x = 1",
      "export const TEAM_DISPATCH_TOOLS = {",
      `  ${tool}: '${map[tool]}',`,
      `  ${tool}_second: 'field', // trailing comment`,
      "} as const",
    ].join("\n");
    const parsed = parseCarrierMap(source);
    if ("error" in parsed) throw new Error(`unexpected error: ${parsed.error}`);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toEqual({ line: 4, text: `${tool}_second: 'field', // trailing comment` });
    // The valid entry is still parsed, but the caller must not treat the map as
    // an authority while a line went unread.
    expect(parsed.map).toEqual({ [tool]: map[tool]! });
  });

  test("F3: a comment-only line inside the declaration is not a problem", () => {
    const parsed = parseCarrierMap(
      ["export const TEAM_DISPATCH_TOOLS = {", "  // a note", "  /* another */", `  ${tool}: '${map[tool]}',`, "} as const"].join("\n"),
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.problems).toEqual([]);
  });
});

describe("checkReadmePin — recorded blob hashes equal git hash-object", () => {
  const recorderRel = "pkg/README.i18n.yaml";
  const packageDir = "pkg";
  const siblings = ["README.md", "README.zh.md"];
  const siblingPath = (name: string): string => `${packageDir}/${name}`;
  const hash = (seed: string): string => seed.repeat(40).slice(0, 40);
  const recorder = (entries: Array<[string, string]>): string =>
    ["# pin", ...entries.map(([name, value]) => `${name}: ${value}`), ""].join("\n");

  test("a complete, matching record passes", () => {
    const text = recorder([
      [siblings[0]!, hash("a")],
      [siblings[1]!, hash("b")],
    ]);
    const result = checkReadmePin({
      recorderRel,
      recorderText: text,
      packageDir,
      siblings,
      hashOf: (rel) => (rel === siblingPath(siblings[0]!) ? hash("a") : hash("b")),
    });
    expect(result.rows).toEqual([]);
    expect(result.recorded).toBe(2);
  });

  test("a stale hash names the file and both hashes", () => {
    const rows = checkReadmePin({
      recorderRel,
      recorderText: recorder([
        [siblings[0]!, hash("a")],
        [siblings[1]!, hash("b")],
      ]),
      packageDir,
      siblings,
      hashOf: (rel) => (rel === siblingPath(siblings[0]!) ? hash("c") : hash("b")),
    }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith(`${recorderRel}:2 `);
    expect(rows[0]).toContain(hash("a"));
    expect(rows[0]).toContain(hash("c"));
    expect(rows[0]).toContain(siblingPath(siblings[0]!));
  });

  test("F5: a duplicate record for the same sibling is named, so a stale duplicate cannot hide", () => {
    const rows = checkReadmePin({
      recorderRel,
      recorderText: recorder([
        [siblings[0]!, hash("a")],
        [siblings[0]!, hash("d")],
        [siblings[1]!, hash("b")],
      ]),
      packageDir,
      siblings,
      hashOf: (rel) => (rel === siblingPath(siblings[0]!) ? hash("a") : hash("b")),
    }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith(`${recorderRel}:3 `);
    expect(rows[0]).toContain(`records "${siblings[0]}" a second time (first record at line 2)`);
  });

  test("b1: a quoted duplicate record is named, so it cannot hide behind the first one", () => {
    const rows = checkReadmePin({
      recorderRel,
      recorderText: recorder([
        [siblings[0]!, hash("a")],
        [`"${siblings[0]}"`, `"${hash("d")}"`],
        [siblings[1]!, hash("b")],
      ]),
      packageDir,
      siblings,
      hashOf: (rel) => (rel === siblingPath(siblings[0]!) ? hash("a") : hash("b")),
    }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith(`${recorderRel}:3 `);
    expect(rows[0]).toContain(`records "${siblings[0]}" a second time (first record at line 2)`);
  });

  test("b1: a quoted stale hash is compared, not ignored", () => {
    const rows = checkReadmePin({
      recorderRel,
      recorderText: recorder([
        [siblings[0]!, `"${hash("c")}"`],
        [`'${siblings[1]!}'`, `'${hash("b")}'`],
      ]),
      packageDir,
      siblings,
      hashOf: (rel) => (rel === siblingPath(siblings[0]!) ? hash("a") : hash("b")),
    }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith(`${recorderRel}:2 `);
    expect(rows[0]).toContain(hash("c"));
    expect(rows[0]).toContain(hash("a"));
  });

  test("b1: an unparseable recorder line is named instead of skipped", () => {
    const rows = checkReadmePin({
      recorderRel,
      recorderText: recorder([
        [siblings[0]!, hash("a")],
        [siblings[1]!, hash("b")],
        ["README.md", "not-a-hash"],
      ]),
      packageDir,
      siblings,
      hashOf: (rel) => (rel === siblingPath(siblings[0]!) ? hash("a") : hash("b")),
    }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith(`${recorderRel}:4 `);
    expect(rows[0]).toContain("recorder line is not a");
    expect(rows[0]).toContain("not-a-hash");
  });

  test("b1: a quoted non-sibling record is named", () => {
    const rows = checkReadmePin({
      recorderRel,
      recorderText: recorder([
        [`"README.xx.md"`, `"${hash("a")}"`],
        [siblings[0]!, hash("a")],
        [siblings[1]!, hash("b")],
      ]),
      packageDir,
      siblings,
      hashOf: (rel) => (rel === siblingPath(siblings[0]!) ? hash("a") : hash("b")),
    }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("README.xx.md");
    expect(rows[0]).toContain("is not a README sibling");
  });

  test("a missing sibling entry and a non-sibling entry are each named", () => {
    const rows = checkReadmePin({
      recorderRel,
      recorderText: recorder([
        ["README.xx.md", hash("a")],
        [siblings[1]!, hash("b")],
      ]),
      packageDir,
      siblings,
      hashOf: () => hash("b"),
    }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("README.xx.md");
    expect(rows[1]).toContain(`records no hash for "${siblings[0]}"`);
  });

  test("an absent sibling file is named rather than silently skipped", () => {
    const rows = checkReadmePin({
      recorderRel,
      recorderText: recorder([
        [siblings[0]!, hash("a")],
        [siblings[1]!, hash("b")],
      ]),
      packageDir,
      siblings,
      hashOf: () => undefined,
    }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(`does not exist (expected at ${siblingPath(siblings[0]!)})`);
  });
});

describe("dsh-contract-lint executable — the current tree passes", () => {
  const SCRIPT = join(REPO_ROOT, "scripts/dsh-contract-lint.ts");

  function run(): { status: number; stdout: string; stderr: string } {
    try {
      return {
        status: 0,
        stdout: execFileSync("bun", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }),
        stderr: "",
      };
    } catch (error) {
      const err = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
      return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
    }
  }

  test("exits 0 and its summary names the three checks with their counts", () => {
    const { status, stdout, stderr } = run();
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("dsh-contract-lint: OK");
    const scanned = stdout.match(/(\d+) Assignment header block\(s\) scanned/);
    expect(scanned).not.toBeNull();
    expect(Number(scanned![1])).toBeGreaterThan(0);
    expect(stdout).toContain("carrier vocabulary");
    expect(stdout).toContain("README pin");
    expect(stdout).toContain(`${Object.keys(carrierMap()).length} carrier tools`);
  });

  test("the three dsh host documents are the ones the gates read", () => {
    expect(DOCS).toContain(TEAM_DOC);
    for (const rel of DOCS) expect(read(rel).length).toBeGreaterThan(0);
  });
});
