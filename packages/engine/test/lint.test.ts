/**
 * Engine lint module — simplify:/temporary markers, SDD TDD triple, plan
 * quality bar, skill frontmatter contract, STRATEGY required sections.
 *
 * Spec sources (each test cites the skill/reference section it enforces;
 * roadmap §8.5 C2 — engine unit tests cite the source section as spec):
 * - simplify:/temporary markers: `mstar-coding-behavior` SKILL.md § Simplicity
 *   First → "Simplification markers": a deliberate shortcut with a known
 *   ceiling is marked with a `simplify:` comment naming the ceiling and the
 *   upgrade path; a workaround is labeled `simplify:` / `temporary` and the
 *   removal path is recorded in the plan/status artifact before the task is
 *   claimed complete.
 * - SDD TDD triple: `mstar-coding-behavior` SKILL.md § Integration Notes —
 *   SDD implementer reports carry the TDD triple (test file(s), command,
 *   output) in `task-N-report.md`; `mstar-sdd/references/file-handoffs.md` —
 *   fix subagents append covering test file(s), command run, output.
 * - Plan quality bar: `mstar-artifacts/references/plan-quality-bar.md`
 *   § Quality checklist + `templates/plan.main.md` self-review
 *   ("Placeholder scan: no TBD").
 * - Skill frontmatter contract: `mstar-skill-authoring` SKILL.md § Frontmatter
 *   Contract — `name` stable lowercase-hyphen; `description` is the trigger
 *   contract (not a workflow summary), third person.
 * - STRATEGY.md structure: `mstar-strategy` SKILL.md § STRATEGY.md structure —
 *   six required sections (Vision, What we build, What we don't build,
 *   Guiding Principles, Technology Direction, Decision Log).
 * - Ephemeral citations: knowledge `conventions/skill-content-porting-discipline.md`
 *   §3 ("No ephemeral citations in durable skill text") + session evaluation
 *   2026-08-16 discrimination contract — placeholder artifact refs
 *   (`task-N-*`, `<plan-id>`, `{SDD_DIR}`, `.mstar/sdd/<plan-id>/`) pass;
 *   concrete instances (`task-2-report`, `task-1.diff`,
 *   `.mstar/sdd/20260815-x/`) are flagged.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertSddTddTriple,
  findEphemeralCitations,
  findSimplifyMarkers,
  findTemporaryMarkers,
  lintSkillFrontmatter,
  lintStrategySections,
  planQualityBar,
} from "../src/lint.js";

/**
 * Locate the read-only skill corpus: `MSTAR_CONTROL_SKILLS` env override →
 * the control checkout path → this checkout's own `skills/` (identical at
 * the base commit). Returns `null` when no corpus is available so the
 * corpus regression test skips instead of failing on machines without the
 * harness checkout (same pattern as roles.test.ts).
 */
function resolveCorpusRoot(): string | null {
  const fromEnv = process.env.MSTAR_CONTROL_SKILLS;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const control = "/Users/bibi/workspace/ai/mstar-harness/skills";
  if (existsSync(join(control, "mstar-roles", "SKILL.md"))) return control;
  let dir = import.meta.dir;
  for (;;) {
    const candidate = join(dir, "skills");
    if (existsSync(join(candidate, "mstar-roles", "SKILL.md"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const CORPUS = resolveCorpusRoot();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Marker samples — comment forms (`//`, `/* * /`, `#`) naming ceilings and
 * upgrade paths, plus a prose line that must NOT be reported. */
const SIMPLIFY_FIXTURE = `
// simplify: global lock on cache misses. Replace with per-key lock if throughput matters.
export const cache = new Map();

/*
 * simplify: O(n^2) dedupe scan. Upgrade path: index by id first.
 */
export function dedupe(xs: string[]) { ... }

# simplify: single-threaded runner; move to worker pool when >10 jobs.

const tmp = 1; // simplify: hardcoded 10s timeout; make it configurable when real users appear.

This paragraph says we simplify: the interface — not a marker (no comment prefix).
`;

const SIMPLIFY_UPPERCASE = `
// SIMPLIFY: global lock on cache misses. Replace with per-key lock if throughput matters.
`;

/** Temporary markers: one with a status.json removal path, one with a dated
 * plan reference, one WITHOUT any removal path, and a prose line that must
 * not be flagged. */
const TEMPORARY_FIXTURE = `
// temporary: fallback mirror while the primary is down. Removal tracked in status.json (R12).
export const mirror = ...;

// TEMPORARY — offline path; plan 20260808-slice2 removes this.
const offline = true;

// temporary: hot-path cache while cold starts hurt.
const fast = true;

The deployment is a temporary measure until the rollout completes.
`;

const TEMPORARY_PLAN_PATH = `
// temporary: offline fallback. See plans/20260808-slice2.md for removal.
`;

const TEMPORARY_REMOVAL_PATH_LABEL = `
// temporary: fast path. removal path: status.json residual R7.
`;

/** Concrete ephemeral citations — every line must be flagged: concrete task
 * artifacts (report / dot-diff / fix-report) and a concrete sdd-deeplink. */
const EPHEMERAL_CONCRETE = `- write report to task-2-report.md
- review diff at task-1.diff
- fix report at task-3-fix-report.md
- deeplink .mstar/sdd/20260815-x/
`;

/** Placeholder-shaped references that must NOT be flagged (discrimination
 * contract: letter `N`, `<...>`, `{...}` are template forms, not citations). */
const EPHEMERAL_PLACEHOLDERS = `- placeholder brief task-N-brief.md
- placeholder report task-N-report
- template <plan-id>
- report path {SDD_DIR}/task-N-report.md
- deeplink .mstar/sdd/<plan-id>/review/
- deeplink .mstar/sdd/{SDD_DIR}/
`;

/** Real corpus line — `skills/mstar-sdd/references/file-handoffs.md` line 26
 * ("Implementer writes full report to `task-N-report.md`."). The mstar-sdd
 * SKILL.md itself carries no `task-N-*` literal, so the corpus regression
 * uses the same skill's reference file. Placeholder `N` → must pass. */
const EPHEMERAL_REAL_CORPUS = `Implementer writes full report to \`task-N-report.md\`. Return to PM only:
`;

/** Real corpus regression — `skills/mstar-artifacts/references/
 * plan-files-and-reports.md` line 80: a global path-allowlist glob
 * (`.mstar/sdd/**`) is a pattern, not a concrete deeplink → must pass. */
const EPHEMERAL_REAL_GLOB = `全局 agent 提示词应允许 \`.mstar/sdd/**\`、\`.agents/sdd/**\` 及 worktree 下对应路径。
`;

/** One line carrying both citation kinds — source order must be preserved. */
const EPHEMERAL_MULTI = `both on one line: .mstar/sdd/20260815-x/ contains task-3-report.md
`;

/** Complete TDD triple per mstar-sdd/references/file-handoffs.md:
 * covering test file(s) + command run + output. */
const TRIPLE_COMPLETE = `
## Task 1 report
Implemented the linter module.

Covering test file(s): packages/engine/test/lint.test.ts
Command run: \`bun test packages/engine/test/lint.test.ts\`
Output:
\`\`\`
 12 pass
 0 fail
\`\`\`
`;

const TRIPLE_NO_TESTS = `
## Task 1 report
Implemented the linter module.
Command run: \`bun test\`
Output:
\`\`\`
 12 pass
 0 fail
\`\`\`
`;

const TRIPLE_NO_COMMAND = `
## Task 1 report
Implemented the linter module.
Covering test file(s): packages/engine/test/lint.test.ts
Output:
\`\`\`
 12 pass
 0 fail
\`\`\`
`;

const TRIPLE_NO_OUTPUT = `
## Task 1 report
Implemented the linter module.
Covering test file(s): packages/engine/test/lint.test.ts
Command run: \`bun test\`
`;

/** Prose that mentions running tests and output but carries none of the
 * triple's evidence shapes (no test file, no runnable command, no output). */
const TRIPLE_PROSE_ONLY = `
## Task 1 report
Implemented the linter module. I ran the tests and the output looked good.
`;

/** Alternate evidence forms: spec-style file list, `$` prompt command,
 * check-mark output. */
const TRIPLE_ALT_FORMS = `
## Task 2 report
Tests: test/sdd.test.ts, test/iteration.test.ts
$ bun run test -- filter
\`\`\`
✓ 23 tests passed
\`\`\`
`;

/** Plan with placeholder tokens: TBD, TODO, TBA, prose ellipsis. */
const PLAN_WITH_PLACEHOLDERS = `# Sample plan
- [ ] Task 1: figure out TBD details
- [ ] Task 2: TODO list
The API version is TBA.
Files: a.ts, b.ts, ...
`;

const PLAN_CLEAN = `# Sample plan
- [ ] Task 1: implement findSimplifyMarkers
- [ ] Task 2: run \`bun test packages/engine/test/lint.test.ts\` — expect PASS
- [ ] Task 3: commit
`;

/** Ellipsis inside a fenced code block and an inline code span is a
 * legitimate file-list / example form — must NOT be flagged. */
const PLAN_ELLIPSIS_IN_CODE = `# Plan
\`\`\`
src/{core,path,status,...}.ts
\`\`\`
Inline: \`...\` stays exempt.
`;

const PLAN_PLACEHOLDER_MIXED_CASE = `# Plan
- [ ] tbd lower-case
- [ ] tOdo mixed case
`;

/** Contract-compliant frontmatter (mstar-skill-authoring § Frontmatter
 * Contract good example). */
const FRONTMATTER_GOOD = `---
name: example-skill
description: Use when a non-trivial task has a spec or requirements and needs a written implementation plan before code changes.
---`;

const FRONTMATTER_NO_BLOCK = `# Skill Title
Some body without frontmatter.
`;

const FRONTMATTER_NO_NAME = `---
description: Use when building X.
---`;

const FRONTMATTER_BAD_NAME = `---
name: Example_Skill
description: Use when building X.
---`;

const FRONTMATTER_NO_DESCRIPTION = `---
name: example-skill
---`;

const FRONTMATTER_SECOND_PERSON = `---
name: example-skill
description: Use when you need to write a plan before making code changes.
---`;

/** Quoted user utterances are exempt from the pronoun check (regression for
 * the real mstar-audit description, which quotes "what should I improve"). */
const FRONTMATTER_QUOTED_SPEECH = `---
name: mstar-audit
description: Use when the user says 'what should I improve' or asks "should we fix this now".
---`;

/** Workflow-summary description — the mstar-skill-authoring bad example. */
const FRONTMATTER_WORKFLOW_SUMMARY = `---
name: example-skill
description: Explains how to write plans with steps, tests, commits, and review gates.
---`;

/** Paragraph-length description — exceeds the documented 120-word threshold
 * (corpus max 114 words, mstar-design-md, measured 2026-08-08). */
const FRONTMATTER_LONG_DESCRIPTION = `---
name: example-skill
description: ${Array.from({ length: 121 }, (_, i) => `word${i}`).join(" ")}
---`;

/** Real corpus regression — current skill frontmatter must pass the lints
 * (no false-positive storms on the 20-skill corpus, 2026-08-08). */
const FRONTMATTER_REAL_STRATEGY = `---
name: mstar-strategy
description: Morning Star 全局战略方向 —— 创建并维护 \`STRATEGY.md\`（项目级战略文档），作为 brainstorm/plan 的上游锚点。定义产品愿景、技术方向、不做事项、决策原则。触发：项目初始化、方向性决策变更、或 PM 要求战略对齐时。
---`;

const FRONTMATTER_REAL_DESIGN_MD = `---
name: mstar-design-md
description: DESIGN.md design system specification for Morning Star projects. Create, audit, and maintain project-level design tokens (Colors, Typography, Spacing, Elevation, Motion, Shapes, Components, Voice & Content) using Vercel Geist as reference template. Three-level completeness checklist (MVP/Standard/Production) with built-in upgrade placeholders. Supports light/dark dual-theme via DESIGN.md + DESIGN.dark.md sharing same token names with different values. Prepare 阶段由 @architect 主责创建，@product-manager 提供设计需求；@frontend-dev / @fullstack-dev 实现 UI 时消费；@qc-specialist / @qa-engineer 审查 UI 对齐 DESIGN.md。Read when PM assigns DESIGN.md creation in Prepare, initiating a new UI project, @architect defining a design system, implementing styled components, adding dark theme, or user mentions "DESIGN.md" / "design tokens" / "design system".
---`;

const FRONTMATTER_US_ACRONYM = `---
name: example-skill
description: Use when auditing US-based repositories.
---`;

const FRONTMATTER_IO = `---
name: example-skill
description: Use when handling I/O errors in file readers.
---`;

/** STRATEGY.md with all six required sections (mstar-strategy § STRATEGY.md
 * structure). */
const STRATEGY_COMPLETE = `# Strategy
## Vision
Become the default harness.
## What we build
Deterministic tooling for agents.
## What we don't build
UIs.
## Guiding Principles
- Simple over clever.
## Technology Direction
TypeScript, bun.
## Decision Log
- 2026-08: chose the engine split.
`;

const STRATEGY_MISSING = `# Strategy
## Vision
Become the default harness.
## Guiding Principles
- Simple over clever.
## Decision Log
- 2026-08: chose the engine split.
`;

const STRATEGY_MIXED_CASE = `# Strategy
## VISION
Become the default harness.
### WHAT WE BUILD
Deterministic tooling.
## What We Don't Build
UIs.
## GUIDING PRINCIPLES
- Simple.
## Technology Direction
TypeScript.
## DECISION LOG
- 2026-08: engine split.
`;

const STRATEGY_WITH_OPTIONALS = `${STRATEGY_COMPLETE}
## Current Focus
Slice 4.
`;

// ---------------------------------------------------------------------------
// findSimplifyMarkers — mstar-coding-behavior § Simplification markers
// ---------------------------------------------------------------------------

describe("findSimplifyMarkers", () => {
  test("reports comment markers (//, block, #) with 1-based line numbers and full text", () => {
    const markers = findSimplifyMarkers(SIMPLIFY_FIXTURE);
    expect(markers.map((m) => m.line)).toEqual([2, 6, 10, 12]);
    expect(markers[0].text).toContain("global lock on cache misses");
    expect(markers[1].text).toContain("O(n^2) dedupe scan");
    expect(markers[2].text).toContain("single-threaded runner");
    expect(markers[3].text).toContain("hardcoded 10s timeout");
  });

  test("detects inline trailing markers after code (const x = 1; // simplify: …)", () => {
    const markers = findSimplifyMarkers("const tmp = 1; // simplify: hardcoded timeout; make configurable later.");
    expect(markers).toHaveLength(1);
    expect(markers[0].line).toBe(1);
  });

  test("matches SIMPLIFY: case-insensitively", () => {
    const markers = findSimplifyMarkers(SIMPLIFY_UPPERCASE);
    expect(markers).toHaveLength(1);
    expect(markers[0].line).toBe(2);
  });

  test("ignores prose containing simplify: outside comments (false-positive guard)", () => {
    const markers = findSimplifyMarkers(SIMPLIFY_FIXTURE);
    expect(markers.some((m) => m.text.includes("This paragraph says"))).toBe(false);
  });

  test("returns [] for empty input", () => {
    expect(findSimplifyMarkers("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findTemporaryMarkers — mstar-coding-behavior § Simplification markers
// ("record the removal path in the plan/status artifact")
// ---------------------------------------------------------------------------

describe("findTemporaryMarkers", () => {
  test("flags temporary markers lacking a removal path as lint.temporary.no-removal-path", () => {
    const result = findTemporaryMarkers(TEMPORARY_FIXTURE);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].code).toBe("lint.temporary.no-removal-path");
    expect(result.violations[0].message).toContain("line 8");
    expect(result.markers).toHaveLength(3);
    expect(result.markers[2].removalPath).toBeNull();
  });

  test("accepts markers referencing status.json / residual as the removal path", () => {
    const result = findTemporaryMarkers(TEMPORARY_FIXTURE);
    expect(result.markers[0].removalPath).toBe("status.json");
    expect(result.violations.some((v) => v.code === "lint.temporary.no-removal-path")).toBe(true); // only the path-less one
  });

  test("accepts dated plan references and plan paths as removal paths", () => {
    const result = findTemporaryMarkers(TEMPORARY_FIXTURE);
    expect(result.markers[1].removalPath).toBe("plan 20260808-slice2");

    const byPath = findTemporaryMarkers(TEMPORARY_PLAN_PATH);
    expect(byPath.ok).toBe(true);
    expect(byPath.markers[0].removalPath).toBe("plans/20260808-slice2.md");
  });

  test("accepts an explicit 'removal path:' label", () => {
    const result = findTemporaryMarkers(TEMPORARY_REMOVAL_PATH_LABEL);
    expect(result.ok).toBe(true);
    expect(result.markers[0].removalPath).toContain("status.json");
  });

  test("matches TEMPORARY case-insensitively and ignores prose uses outside comments", () => {
    const result = findTemporaryMarkers(TEMPORARY_FIXTURE);
    expect(result.markers.some((m) => m.text.includes("The deployment"))).toBe(false);
    expect(result.markers[1].text).toContain("TEMPORARY");
  });

  test("regex quantifiers are not markers (regression: `\\s*temporary` in code)", () => {
    // The `*` before "temporary" here is a quantifier, not a block-comment
    // continuation — a bare `*` introducer would false-positive on it.
    const result = findTemporaryMarkers('const re = /\\s*temporary\\b/;');
    expect(result.ok).toBe(true);
    expect(result.markers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findEphemeralCitations — knowledge conventions/
// skill-content-porting-discipline.md §3 ("no ephemeral citations in durable
// skill text") + session evaluation 2026-08-16 discrimination contract:
// placeholders pass, concrete instances fail.
// ---------------------------------------------------------------------------

describe("findEphemeralCitations", () => {
  test("flags concrete task artifacts with kind task-artifact and 1-based lines", () => {
    const citations = findEphemeralCitations(EPHEMERAL_CONCRETE);
    expect(citations).toHaveLength(4);
    expect(citations.map((c) => c.line)).toEqual([1, 2, 3, 4]);
    expect(citations.map((c) => c.kind)).toEqual([
      "task-artifact",
      "task-artifact",
      "task-artifact",
      "sdd-deeplink",
    ]);
    expect(citations.map((c) => c.match)).toEqual([
      "task-2-report",
      "task-1.diff",
      "task-3-fix-report",
      ".mstar/sdd/20260815-x",
    ]);
  });

  test("matches multi-digit task numbers and the bare (extension-less) forms", () => {
    const citations = findEphemeralCitations(
      "- task-12-report\n- task-1-brief\n- task-2-diff\n",
    );
    expect(citations.map((c) => c.match)).toEqual([
      "task-12-report",
      "task-1-brief",
      "task-2-diff",
    ]);
  });

  test("does not treat task-N-* / <...> placeholder references as citations", () => {
    expect(findEphemeralCitations(EPHEMERAL_PLACEHOLDERS)).toEqual([]);
  });

  test("word boundary keeps task-2-reporting out of the artifact set", () => {
    expect(findEphemeralCitations("mentions task-2-reporting")).toEqual([]);
  });

  test("flags concrete sdd-deeplinks under both .mstar/sdd/ and .agents/sdd/", () => {
    const citations = findEphemeralCitations(
      "- .agents/sdd/20260815-x/\n- .mstar/sdd/20260816-example/task-3-report.md\n",
    );
    expect(citations).toHaveLength(3);
    expect(citations[0].kind).toBe("sdd-deeplink");
    expect(citations[0].match).toBe(".agents/sdd/20260815-x");
    // concrete first segment → deeplink, plus the concrete task artifact inside
    expect(citations[1]).toEqual({
      line: 2,
      match: ".mstar/sdd/20260816-example",
      kind: "sdd-deeplink",
    });
    expect(citations[2]).toEqual({
      line: 2,
      match: "task-3-report",
      kind: "task-artifact",
    });
  });

  test("passes the real mstar-sdd corpus line (placeholder task-N-report.md)", () => {
    expect(findEphemeralCitations(EPHEMERAL_REAL_CORPUS)).toEqual([]);
  });

  test("passes the real corpus path-allowlist glob (.mstar/sdd/**)", () => {
    expect(findEphemeralCitations(EPHEMERAL_REAL_GLOB)).toEqual([]);
  });

  test("reports all citations on one line in source order", () => {
    const citations = findEphemeralCitations(EPHEMERAL_MULTI);
    expect(citations).toHaveLength(2);
    expect(citations[0].kind).toBe("sdd-deeplink");
    expect(citations[1].kind).toBe("task-artifact");
    expect(citations[0].line).toBe(1);
    expect(citations[1].line).toBe(1);
  });

  test("returns [] for empty input", () => {
    expect(findEphemeralCitations("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assertSddTddTriple — mstar-coding-behavior § Integration Notes +
// mstar-sdd/references/file-handoffs.md (test file(s) + command + output)
// ---------------------------------------------------------------------------

describe("assertSddTddTriple", () => {
  test("ok for a report with test file reference + command + output", () => {
    const result = assertSddTddTriple(TRIPLE_COMPLETE);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("missing-tests violation when no test file reference is present", () => {
    const result = assertSddTddTriple(TRIPLE_NO_TESTS);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.sdd-tdd.missing-tests"]);
  });

  test("missing-command violation when no runnable command is present", () => {
    const result = assertSddTddTriple(TRIPLE_NO_COMMAND);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.sdd-tdd.missing-command"]);
  });

  test("missing-output violation when no output evidence is present", () => {
    const result = assertSddTddTriple(TRIPLE_NO_OUTPUT);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.sdd-tdd.missing-output"]);
  });

  test("prose-only report ('ran the tests, output looked good') yields all three violations", () => {
    const result = assertSddTddTriple(TRIPLE_PROSE_ONLY);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code).sort()).toEqual([
      "lint.sdd-tdd.missing-command",
      "lint.sdd-tdd.missing-output",
      "lint.sdd-tdd.missing-tests",
    ]);
  });

  test("empty report yields all three violations", () => {
    const result = assertSddTddTriple("");
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(3);
  });

  test("accepts alternate evidence forms: file list, $ prompt command, check marks", () => {
    const result = assertSddTddTriple(TRIPLE_ALT_FORMS);
    expect(result.ok).toBe(true);
  });

  test("prose 'OK' alone is not output evidence", () => {
    const result = assertSddTddTriple(`## Task 1 report
Covering test file(s): packages/engine/test/lint.test.ts
Command run: \`bun test packages/engine/test/lint.test.ts\`
OK, moving on — everything looks fine.
`);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.sdd-tdd.missing-output"]);
  });

  test("'N ok' verdicts count as output evidence", () => {
    const result = assertSddTddTriple(`## Task 1 report
Covering test file(s): packages/engine/test/lint.test.ts
Command run: \`bun test packages/engine/test/lint.test.ts\`
\`\`\`
12 ok
\`\`\`
`);
    expect(result.ok).toBe(true);
  });

  test("TAP-style 'ok N - name' lines count as output evidence", () => {
    const result = assertSddTddTriple(`## Task 1 report
Covering test file(s): test/lint.test.ts
Command run: bun test test/lint.test.ts
ok 1 - findSimplifyMarkers
`);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// planQualityBar — mstar-artifacts plan-quality-bar.md + plan.main.md
// placeholder scan (no TBD / TODO / placeholders)
// ---------------------------------------------------------------------------

describe("planQualityBar", () => {
  test("flags TBD/TODO/TBA and prose ellipsis, one violation per token with location", () => {
    const result = planQualityBar(PLAN_WITH_PLACEHOLDERS);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      { token: "TBD", line: 2, text: "- [ ] Task 1: figure out TBD details" },
      { token: "TODO", line: 3, text: "- [ ] Task 2: TODO list" },
      { token: "TBA", line: 4, text: "The API version is TBA." },
      { token: "...", line: 5, text: "Files: a.ts, b.ts, ..." },
    ]);
    expect(result.violations).toHaveLength(4);
    expect(result.violations.every((v) => v.code === "lint.plan-quality.placeholder")).toBe(true);
    expect(result.violations[0].message).toContain('"TBD"');
    expect(result.violations[0].message).toContain("line 2");
  });

  test("matches tbd/todo case-insensitively", () => {
    const result = planQualityBar(PLAN_PLACEHOLDER_MIXED_CASE);
    expect(result.findings.map((f) => f.token)).toEqual(["TBD", "TODO"]);
  });

  test("ignores ellipsis inside fenced code blocks and inline code spans (false-positive guard)", () => {
    const result = planQualityBar(PLAN_ELLIPSIS_IN_CODE);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("negation guard: 'no TBD/placeholder/TODO' asserts the rule, not a placeholder", () => {
    const result = planQualityBar(`# Plan
- Produces: \`planQualityBar\` (no TBD/placeholder/TODO), per the quality bar.
- [ ] Version: TBD
`);
    expect(result.findings).toEqual([{ token: "TBD", line: 3, text: "- [ ] Version: TBD" }]);
  });

  test("plural placeholder forms (TODOs:) are still flagged, normalized to the singular token", () => {
    const result = planQualityBar("# Plan\n- [ ] TODOs: wire the gate\n");
    expect(result.findings).toEqual([{ token: "TODO", line: 2, text: "- [ ] TODOs: wire the gate" }]);
  });

  test("negation does not leak across a comma: 'no TBD yet, and TODO...' still flags TODO", () => {
    const result = planQualityBar("This plan has no TBD yet, and TODO items remain.");
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.token)).toEqual(["TODO"]);
    expect(result.findings[0].line).toBe(1);
  });

  test("clean plan passes", () => {
    const result = planQualityBar(PLAN_CLEAN);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lintSkillFrontmatter — mstar-skill-authoring § Frontmatter Contract
// ---------------------------------------------------------------------------

describe("lintSkillFrontmatter", () => {
  test("ok for contract-compliant frontmatter (lowercase-hyphen name, third-person trigger description)", () => {
    const result = lintSkillFrontmatter(FRONTMATTER_GOOD);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("missing frontmatter block → lint.frontmatter.missing", () => {
    const result = lintSkillFrontmatter(FRONTMATTER_NO_BLOCK);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.frontmatter.missing"]);
  });

  test("missing name → lint.frontmatter.name.missing", () => {
    const result = lintSkillFrontmatter(FRONTMATTER_NO_NAME);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.frontmatter.name.missing"]);
  });

  test("name not lowercase-hyphen → lint.frontmatter.name.format", () => {
    const result = lintSkillFrontmatter(FRONTMATTER_BAD_NAME);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.frontmatter.name.format"]);
    expect(result.violations[0].message).toContain("Example_Skill");
  });

  test("missing description → lint.frontmatter.description.missing", () => {
    const result = lintSkillFrontmatter(FRONTMATTER_NO_DESCRIPTION);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.frontmatter.description.missing"]);
  });

  test("first/second-person pronouns → lint.frontmatter.description.person", () => {
    const result = lintSkillFrontmatter(FRONTMATTER_SECOND_PERSON);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.frontmatter.description.person"]);
    expect(result.violations[0].message).toContain("you");
  });

  test("quoted user utterances are exempt from the pronoun check (mstar-audit regression)", () => {
    const result = lintSkillFrontmatter(FRONTMATTER_QUOTED_SPEECH);
    expect(result.ok).toBe(true);
  });

  test("workflow-summary verb start → lint.frontmatter.description.workflow", () => {
    const result = lintSkillFrontmatter(FRONTMATTER_WORKFLOW_SUMMARY);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.frontmatter.description.workflow"]);
  });

  test("paragraph-length description → lint.frontmatter.description.workflow (length heuristic)", () => {
    const result = lintSkillFrontmatter(FRONTMATTER_LONG_DESCRIPTION);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.frontmatter.description.workflow"]);
  });

  test("current corpus regression: real mstar-strategy and mstar-design-md frontmatter pass", () => {
    expect(lintSkillFrontmatter(FRONTMATTER_REAL_STRATEGY).ok).toBe(true);
    expect(lintSkillFrontmatter(FRONTMATTER_REAL_DESIGN_MD).ok).toBe(true);
  });

  test.skipIf(CORPUS === null)(
    "real corpus: every skills/*/SKILL.md frontmatter passes (20-skill smoke, durable)",
    () => {
      const corpus = CORPUS as string;
      const failed: string[] = [];
      let checked = 0;
      for (const entry of readdirSync(corpus)) {
        const dir = join(corpus, entry);
        if (!statSync(dir).isDirectory()) continue;
        const skillMd = join(dir, "SKILL.md");
        if (!existsSync(skillMd)) continue;
        const frontmatter = /^---\r?\n[\s\S]*?\r?\n---/.exec(readFileSync(skillMd, "utf8"));
        if (frontmatter === null) continue;
        checked++;
        const result = lintSkillFrontmatter(frontmatter[0]);
        if (!result.ok) failed.push(`${entry}: ${result.violations.map((v) => v.code).join(", ")}`);
      }
      expect(checked).toBeGreaterThan(10);
      expect(failed).toEqual([]);
    },
  );

  test("all-caps US acronym and I/O are not pronoun false positives", () => {
    expect(lintSkillFrontmatter(FRONTMATTER_US_ACRONYM).ok).toBe(true);
    expect(lintSkillFrontmatter(FRONTMATTER_IO).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lintStrategySections — mstar-strategy § STRATEGY.md structure
// ---------------------------------------------------------------------------

describe("lintStrategySections", () => {
  test("ok when all six required sections are present", () => {
    const result = lintStrategySections(STRATEGY_COMPLETE);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("missing sections → one lint.strategy.missing-section per missing heading", () => {
    const result = lintStrategySections(STRATEGY_MISSING);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(3);
    expect(result.violations.every((v) => v.code === "lint.strategy.missing-section")).toBe(true);
    const names = result.violations.map((v) => v.message);
    expect(names.some((m) => m.includes("What we build"))).toBe(true);
    expect(names.some((m) => m.includes("What we don't build"))).toBe(true);
    expect(names.some((m) => m.includes("Technology Direction"))).toBe(true);
  });

  test("matches headings case-insensitively at any level (## VISION, ### WHAT WE BUILD)", () => {
    const result = lintStrategySections(STRATEGY_MIXED_CASE);
    expect(result.ok).toBe(true);
  });

  test("optional sections are not required", () => {
    const result = lintStrategySections(STRATEGY_WITH_OPTIONALS);
    expect(result.ok).toBe(true);
  });

  test("empty doc → six violations", () => {
    const result = lintStrategySections("");
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(6);
  });
});
