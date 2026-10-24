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
  checkReadmePin,
  checkSeatBounding,
  parseCarrierMap,
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

describe("checkSeatBounding — seat header blocks carry the bounding labels", () => {
  const seat = REVIEW_SEAT_ROLES[0]!;
  const nonSeat = "zz-not-a-review-seat";

  test("a review-seat payload without the labels yields one row per label", () => {
    const text = payload([`Execute as: ${seat}`, "Delegation: forbidden", "Task category: audit"]);
    const doc: Doc = { rel: "fixture.md", text };
    const { rows, blocks } = checkSeatBounding([doc]);
    const executeAsLine = text.split("\n").findIndex((line) => line.startsWith("Execute as:")) + 1;
    expect(blocks).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toStartWith(`fixture.md:${executeAsLine} `);
    expect(rows[0]).toContain(`review seat "${seat}"`);
    expect(rows[0]).toContain(BUDGET_LABELS[0]!);
    expect(rows[0]).toContain("assignment.field.budget-missing");
    expect(rows[1]).toContain(RETURN_SHAPE_LABELS[0]!);
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

  test("a non-seat payload is not gated", () => {
    const text = payload([`Execute as: ${nonSeat}`, "Delegation: forbidden", "Task category: logic"]);
    expect(checkSeatBounding([{ rel: "fixture.md", text }]).rows).toEqual([]);
  });

  test("a fence that ends at its own header is still gated (no shape is skipped)", () => {
    const text = ["```markdown", "## Assignment", "", `Execute as: ${seat}`, "Delegation: forbidden", "Task category: audit", "```", ""].join("\n");
    const result = checkSeatBounding([{ rel: "fixture.md", text }]);
    expect(result.blocks).toBe(1);
    expect(result.rows).toHaveLength(2);
  });
});

describe("checkCarrierVocabulary — citations match the owning carrier map", () => {
  const map = carrierMap();
  const tools = Object.keys(map);
  const tool = tools[0]!;

  test("the owning declaration parses into a non-empty map", () => {
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
    expect(stdout).toContain("Assignment header block(s) scanned");
    expect(stdout).toContain("carrier vocabulary");
    expect(stdout).toContain("README pin");
    expect(stdout).toContain(`${Object.keys(carrierMap()).length} carrier tools`);
  });

  test("the three dsh host documents are the ones the gates read", () => {
    expect(DOCS).toContain(TEAM_DOC);
    for (const rel of DOCS) expect(read(rel).length).toBeGreaterThan(0);
  });
});
