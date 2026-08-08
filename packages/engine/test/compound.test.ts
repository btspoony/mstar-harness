/**
 * Engine compound module — knowledge-doc frontmatter schema validation,
 * reference existence checks, index-row obligations, and compound-refresh
 * scope guarding.
 *
 * Spec sources (cited per test): mstar-compound/references/schema.yaml
 * (required/optional fields, track rules), mstar-compound/references/
 * category-mapping.md (problem_type → category directory),
 * mstar-compound SKILL.md Phase 6 (README.md index rows), and
 * mstar-compound-refresh SKILL.md (scope SSOT: knowledge/**, README.md,
 * CONCEPTS.md, status.json).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertIndexRows,
  compoundRefreshScope,
  referenceExists,
  scopeGuard,
  validateSchemaYaml,
} from "../src/compound.js";

const hasCode = (g: { violations: { code: string }[] }, code: string) =>
  g.violations.some((v) => v.code === code);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Bug-track doc frontmatter — every required field per schema.yaml. */
const DOC_BUG_GOOD = `---
module: dispatch
date: 2026-08-08
problem_type: logic_error
category: logic-errors
severity: high
symptoms:
  - "Assignment parser returned null for a valid header"
  - "dispatch tests flaked on parse"
root_cause: "The grammar regex required a trailing colon."
resolution_type: code_fix
tags:
  - sdd
  - dispatch
last_updated: 2026-08-09
---
`;

/** Knowledge-track doc — applies_when optional field present. */
const DOC_KNOWLEDGE_GOOD = `---
module: engine
date: 2026-08-01
problem_type: best_practice
category: best-practices
severity: medium
applies_when:
  - "When adding a new engine module"
related_components:
  - path
  - status
plan_id: "20260808-slice4-lints-scaffolds"
---
`;

/** Missing required fields entirely. */
const DOC_NO_FIELDS = `---
date: 2026-08-08
---
`;

/** Invalid values for date / problem_type / severity + category mismatch. */
const DOC_BAD_VALUES = `---
module: dispatch
date: 08/08/2026
problem_type: not_a_type
category: best-practices
severity: extreme
---
`;

/** Bug track missing symptoms / root_cause / resolution_type. */
const DOC_BUG_MISSING_TRACK = `---
module: dispatch
date: 2026-08-08
problem_type: runtime_error
category: runtime-errors
severity: low
---
`;

/** Bug track with an invalid resolution_type. */
const DOC_BAD_RESOLUTION = `---
module: dispatch
date: 2026-08-08
problem_type: build_error
category: build-errors
severity: medium
symptoms:
  - "bun build failed"
root_cause: "Missing export"
resolution_type: delete_everything
---
`;

/** Knowledge track where category contradicts the category-mapping. */
const DOC_CATEGORY_MISMATCH = `---
module: engine
date: 2026-08-01
problem_type: best_practice
category: runtime-errors
severity: low
---
`;

/** Too many tags (9 > max 8) and a malformed last_updated date. */
const DOC_BAD_OPTIONALS = `---
module: engine
date: 2026-08-01
problem_type: convention
category: conventions
severity: low
tags:
  - a
  - b
  - c
  - d
  - e
  - f
  - g
  - h
  - i
last_updated: "yesterday"
---
`;

/** No frontmatter block. */
const DOC_NONE = `# Knowledge

Body only.
`;

// ---------------------------------------------------------------------------
// validateSchemaYaml — mstar-compound/references/schema.yaml
// ---------------------------------------------------------------------------

describe("validateSchemaYaml", () => {
  test("passes a complete bug-track doc", () => {
    const result = validateSchemaYaml(DOC_BUG_GOOD);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("passes a complete knowledge-track doc with optionals", () => {
    const result = validateSchemaYaml(DOC_KNOWLEDGE_GOOD);
    expect(result.ok).toBe(true);
  });

  test("reports missing required fields", () => {
    const result = validateSchemaYaml(DOC_NO_FIELDS);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.schema.missing-field")).toBe(true);
    const missing = result.violations
      .filter((v) => v.code === "compound.schema.missing-field")
      .map((v) => v.message)
      .join("\n");
    expect(missing).toContain("module");
    expect(missing).toContain("problem_type");
  });

  test("reports invalid date, problem_type, and severity", () => {
    const result = validateSchemaYaml(DOC_BAD_VALUES);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.schema.invalid-date")).toBe(true);
    expect(hasCode(result, "compound.schema.invalid-problem-type")).toBe(true);
    expect(hasCode(result, "compound.schema.invalid-severity")).toBe(true);
  });

  test("reports bug-track docs missing symptoms / root_cause / resolution_type", () => {
    const result = validateSchemaYaml(DOC_BUG_MISSING_TRACK);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.schema.missing-track-field")).toBe(true);
    const messages = result.violations
      .filter((v) => v.code === "compound.schema.missing-track-field")
      .map((v) => v.message)
      .join("\n");
    expect(messages).toContain("symptoms");
    expect(messages).toContain("root_cause");
    expect(messages).toContain("resolution_type");
  });

  test("reports an invalid resolution_type", () => {
    const result = validateSchemaYaml(DOC_BAD_RESOLUTION);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.schema.invalid-resolution-type")).toBe(true);
  });

  test("reports category that contradicts the category-mapping", () => {
    const result = validateSchemaYaml(DOC_CATEGORY_MISMATCH);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.schema.category-mismatch")).toBe(true);
    const v = result.violations.find((x) => x.code === "compound.schema.category-mismatch")!;
    expect(v.message).toContain("best-practices");
  });

  test("reports >8 tags and malformed last_updated", () => {
    const result = validateSchemaYaml(DOC_BAD_OPTIONALS);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.schema.tags-too-many")).toBe(true);
    expect(hasCode(result, "compound.schema.invalid-last-updated")).toBe(true);
  });

  test("reports missing frontmatter", () => {
    const result = validateSchemaYaml(DOC_NONE);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.schema.missing-frontmatter")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// referenceExists — compound-refresh Phase 2 (referenced code still exists?)
// ---------------------------------------------------------------------------

describe("referenceExists", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-compound-ref-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const repo = join(tmp, "repo");
  beforeAll(() => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "core.ts"), "export function validateStatus() {}\n");
    writeFileSync(join(repo, "README.md"), "# Repo\n");
  });

  test("accepts referenced files that exist on disk", () => {
    const doc = "See `src/core.ts` and `README.md` for details.";
    const result = referenceExists(repo, doc);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2);
  });

  test("flags referenced paths that do not exist", () => {
    const doc = "See `src/missing.ts` and `status.json`.";
    const result = referenceExists(repo, doc);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.reference.missing-file")).toBe(true);
    const messages = result.violations.map((v) => v.message).join("\n");
    expect(messages).toContain("src/missing.ts");
    expect(messages).toContain("status.json");
  });

  test("skips URLs, placeholders, and glob patterns", () => {
    const doc = "See https://example.com/x.md, `{KNOWLEDGE_DIR}/x.md`, and `src/*.ts`.";
    const result = referenceExists(repo, doc);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
  });

  test("module.symbol refs resolve via the module-file heuristic", () => {
    const doc = "Call `core.validateStatus` to check the gate.";
    const result = referenceExists(repo, doc);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });

  test("flags module.symbol refs whose module file is missing (heuristic, low)", () => {
    const doc = "Call `nope.validateThing` in the hook.";
    const result = referenceExists(repo, doc);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.reference.module-missing")).toBe(true);
    const v = result.violations.find((x) => x.code === "compound.reference.module-missing")!;
    expect(v.severity).toBe("low");
  });

  test("handles line-number suffixes on path refs", () => {
    const doc = "See `src/core.ts:42-58` for the implementation.";
    const result = referenceExists(repo, doc);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// assertIndexRows — mstar-compound SKILL.md Phase 6 (index obligations)
// ---------------------------------------------------------------------------

describe("assertIndexRows", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-compound-idx-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("passes when every doc has a README.md index row", () => {
    const kd = join(tmp, "knowledge-ok");
    mkdirSync(join(kd, "runtime-errors"), { recursive: true });
    mkdirSync(join(kd, "best-practices"), { recursive: true });
    writeFileSync(join(kd, "runtime-errors", "parser-null.md"), "# x\n");
    writeFileSync(join(kd, "best-practices", "engine-modules.md"), "# y\n");
    writeFileSync(
      join(kd, "README.md"),
      `# Knowledge Index\n\n| Document | Source Plan | Description | Status |\n|----------|-------------|-------------|--------|\n| [Parser null](runtime-errors/parser-null.md) | 2026-a | Parser null fix | active |\n| [Engine modules](best-practices/engine-modules.md) | 2026-b | Module guide | active |\n`,
    );
    const result = assertIndexRows(kd);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("flags docs missing from the index", () => {
    const kd = join(tmp, "knowledge-missing");
    mkdirSync(join(kd, "logic-errors"), { recursive: true });
    writeFileSync(join(kd, "logic-errors", "grammar-regex.md"), "# x\n");
    writeFileSync(
      join(kd, "README.md"),
      `# Knowledge Index\n\n| Document | Source Plan | Description | Status |\n|----------|-------------|-------------|--------|\n| [Something else](logic-errors/other.md) | 2026-a | Other | active |\n`,
    );
    const result = assertIndexRows(kd);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.index.missing-row")).toBe(true);
    const v = result.violations.find((x) => x.code === "compound.index.missing-row")!;
    expect(v.message).toContain("logic-errors/grammar-regex.md");
  });

  test("ignores README.md and index.md files themselves", () => {
    const kd = join(tmp, "knowledge-readme");
    mkdirSync(join(kd, "conventions"), { recursive: true });
    writeFileSync(join(kd, "conventions", "index.md"), "# x\n");
    writeFileSync(join(kd, "README.md"), "# Knowledge Index\n");
    const result = assertIndexRows(kd);
    expect(result.ok).toBe(true);
  });

  test("reports a missing README.md index", () => {
    const kd = join(tmp, "knowledge-no-readme");
    mkdirSync(join(kd, "conventions"), { recursive: true });
    writeFileSync(join(kd, "conventions", "naming.md"), "# x\n");
    const result = assertIndexRows(kd);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "compound.index.missing-readme")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scopeGuard / compoundRefreshScope — mstar-compound-refresh scope SSOT
// ---------------------------------------------------------------------------

describe("scopeGuard", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-compound-scope-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const harness = join(tmp, ".mstar");
  const roots = compoundRefreshScope(harness, tmp);

  test("accepts knowledge/**, knowledge/README.md, CONCEPTS.md, status.json", () => {
    expect(scopeGuard(join(harness, "knowledge", "logic-errors", "x.md"), roots).ok).toBe(true);
    expect(scopeGuard(join(harness, "knowledge", "README.md"), roots).ok).toBe(true);
    expect(scopeGuard(join(tmp, "CONCEPTS.md"), roots).ok).toBe(true);
    expect(scopeGuard(join(harness, "status.json"), roots).ok).toBe(true);
  });

  test("rejects docs/, plans/, iterations/, specs/ and arbitrary paths", () => {
    for (const p of [
      join(tmp, "docs", "guide.md"),
      join(harness, "plans", "2026-x.md"),
      join(harness, "iterations", "2026-x", "compass.md"),
      join(harness, "specs", "x.md"),
      join(tmp, "package.json"),
    ]) {
      const result = scopeGuard(p, roots);
      expect(result.ok).toBe(false);
      expect(hasCode(result, "compound.scope.outside")).toBe(true);
    }
  });

  test("allows an exact file root but not siblings", () => {
    const roots2 = [join(tmp, "CONCEPTS.md")];
    expect(scopeGuard(join(tmp, "CONCEPTS.md"), roots2).ok).toBe(true);
    expect(scopeGuard(join(tmp, "CONCEPTS.draft.md"), roots2).ok).toBe(false);
  });

  test("compoundRefreshScope returns the four documented paths", () => {
    expect(roots).toEqual([
      join(harness, "knowledge"),
      join(harness, "knowledge", "README.md"),
      join(tmp, "CONCEPTS.md"),
      join(harness, "status.json"),
    ]);
  });
});
