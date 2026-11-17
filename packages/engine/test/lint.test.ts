/**
 * Engine lint module — simplify:/temporary markers, SDD TDD triple, plan
 * quality bar, skill frontmatter contract, STRATEGY required sections.
 *
 * Spec sources (each test cites the skill/reference section it enforces;
 * roadmap §8.5 C2 — engine unit tests cite the source section as spec):
 * - simplify:/temporary markers: `mstar-coding-behavior` SKILL.md § Decision
 * Rules: a deliberate shortcut with a known
 * ceiling is marked with a `simplify:` comment naming the ceiling and the
 * upgrade path; a workaround is labeled `simplify:` / `temporary` and the
 * removal path is recorded in the plan/status artifact before the task is
 * claimed complete.
 * - SDD verification evidence: `mstar-sdd/references/file-handoffs.md`
 * § Verification evidence — completion and fix reports retain the affected
 * test file(s), command and actual output, or applicable scoped-check evidence.
 * - Plan quality bar: `mstar-artifacts/references/plan-quality-bar.md`
 * § Quality checklist + `templates/plan.main.md` self-review
 * ("Placeholder scan: no TBD").
 * - Skill frontmatter contract: `mstar-skill-authoring` SKILL.md § Frontmatter
 * Contract — `name` stable lowercase-hyphen; `description` is the trigger
 * contract (not a workflow summary), third person.
 * - STRATEGY.md structure: `mstar-knowledge/references/strategy-document.md`
 * § Shape — six required sections (Vision, What we build, What we don't
 * build, Guiding Principles, Technology Direction, Decision Log).
 * - Ephemeral citations: knowledge `conventions/skill-content-porting-discipline.md`
 * §3 ("No ephemeral citations in durable skill text") + session evaluation
 * 2026-08-16 discrimination contract — placeholder artifact refs
 * (`task-N-*`, `<plan-id>`, `{SDD_DIR}`, `.mstar/sdd/<plan-id>/`) pass;
 * concrete instances (`task-2-report`, `task-1.diff`,
 * `.mstar/sdd/20260815-x/`) are flagged.
 * - Provenance citations: repo AGENTS.md "Git and local artifacts" — tracked
 * code and docs must not disclose provenance with real plan/iteration ids or
 * dated local-harness deeplinks; example slugs, version tokens, placeholder
 * shapes, plain dates and undated layout lines pass.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertSddTddTriple,
  findCommentedCode,
  findEphemeralCitations,
  findProvenanceCitations,
  findSimplifyMarkers,
  findTemporaryMarkers,
  findUnclassifiedComments,
  findUntrackedTodos,
  lintAdrTree,
  lintSkillFrontmatter,
  lintSpecsDoc,
  lintSpecsTree,
  lintStrategySections,
  planQualityBar,
  sourceDialect,
} from "../src/lint.js";

/**
 * Locate the read-only skill corpus: `MSTAR_CONTROL_SKILLS` env override →
 * this checkout's own `skills/`. Returns `null` when no corpus is available
 * so the corpus regression test skips instead of failing on machines
 * without the harness checkout (same pattern as roles.test.ts).
 */
function resolveCorpusRoot(): string | null {
  const fromEnv = process.env.MSTAR_CONTROL_SKILLS;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
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

// TEMPORARY — offline path; plan 20991231-example-plan removes this.
const offline = true;

// temporary: hot-path cache while cold starts hurt.
const fast = true;

The deployment is a temporary measure until the rollout completes.
`;

const TEMPORARY_PLAN_PATH = `
// temporary: offline fallback. See plans/20991231-example.md for removal.
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

/** Provenance hits — sanitized isomorphic samples (synthetic dated slugs in
 * real shapes, never real artifact ids): a standalone plan id, an
 * `iter-`-prefixed iteration token, and dated deeplinks under both harness
 * roots. Every line must be flagged exactly once. */
const PROVENANCE_HITS = `removal tracked in plan 20991231-sample-plan
gate notes for iter-20990101-sample-iteration
deeplink .mstar/plans/20991231-sample-plan/tasks.md
mirror layout .agents/plans/20990102-sample-agent/report.md
`;

/** Zero-false-positive fixture — every excluded shape from the finder's
 * discrimination contract: synthetic example slugs, `.digits` version
 * tokens, placeholder forms, plain dates, generic layout lines without a
 * dated instance segment, and sdd deeplinks (owned by the ephemeral check). */
const PROVENANCE_FALSE_POSITIVES = `removal tracked in plan 20991231-example-plan
see 20260717-example for the template form
version token 20260908-v3.9.0 stays out
placeholder shapes: task-N-plan, <plan-id>, {plan-id}
plain dates 2026-08-16 and 20260816 are not id tokens
layout lines: .mstar/plans/, .mstar/status.json, .mstar/knowledge/<category>/
sdd surface: .mstar/sdd/20991231-sample-plan/task-1-report.md
sdd mirror: .agents/sdd/20991231-sample-plan/
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

/** Prose that mentions running tests and output but carries no evidence shape. */
const TRIPLE_PROSE_ONLY = `
## Task 1 report
Implemented the linter module. I ran the tests and the output looked good.
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
const FRONTMATTER_REAL_ZH_DESCRIPTION = `---
name: real-zh-description-sample
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

/** STRATEGY.md with all six required sections (mstar-knowledge/references/
 * strategy-document.md § Shape). */
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
// findSimplifyMarkers — mstar-coding-behavior § Decision Rules
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

  test("keeps a same-line bound on a trailing marker for every introducer form", () => {
    const cases = [
      "const x = 1; // simplify: naive scan; upgrade: index the map\n",
      "x = 1  # simplify: naive scan; upgrade: index the map\n",
      "; simplify: naive scan; upgrade: index the map\n",
      "SELECT 1 -- simplify: naive scan; upgrade: index the map\n",
      "x = 1; /* simplify: naive scan; upgrade: index the map */\n",
    ];
    for (const text of cases) {
      const markers = findSimplifyMarkers(text);
      expect(markers).toHaveLength(1);
      expect(markers[0]!.bound ?? "").toContain("upgrade: index the map");
    }
  });

  test("a statement terminator never opens a trailing marker", () => {
    // why: a C-family `;` ends a statement, so the marker after it is code.
    expect(findSimplifyMarkers("(define x 1) ; simplify: naive scan\n")).toEqual([]);
    expect(findSimplifyMarkers("let a = 1 ; simplify: naive scan\n")).toEqual([]);
    // why: the line-leading form still opens a Lisp/INI comment.
    expect(findSimplifyMarkers("; simplify: naive scan\n")).toHaveLength(1);
  });

  test("a trailing marker whose line states no bound keeps none (the exit-1 case)", () => {
    const markers = findSimplifyMarkers("x = 1  # simplify: naive scan\n");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.bound).toBeNull();
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

  test("detects a marker opened mid-sentence inside a comment", () => {
    const midSentence = findSimplifyMarkers("// refused. simplify: FIFO chain - one queue.\n");
    expect(midSentence).toHaveLength(1);
    expect(midSentence[0].line).toBe(1);
    const continuation = findSimplifyMarkers(
      "// Serialized request execution: new work after close is refused.\n// simplify: FIFO chain - the store's read transactions are the bottleneck.\n",
    );
    expect(continuation.map((marker) => marker.line)).toEqual([2]);
  });

  test("ignores a quoted or backticked token that names the label", () => {
    expect(findSimplifyMarkers("// A `simplify:` marker records a ceiling.\n")).toEqual([]);
    expect(findSimplifyMarkers('// the "simplify:" label is defined in comments.md\n')).toEqual([]);
  });

  test("ignores marker text inside a string literal (a fixture asserting this check)", () => {
    expect(findSimplifyMarkers('const s = "// simplify: naive scan";\n')).toEqual([]);
    expect(findSimplifyMarkers("const t = `\n// simplify: naive scan\n`;\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findTemporaryMarkers — mstar-coding-behavior § Decision Rules
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

  test("accepts status.json as the removal path", () => {
    const result = findTemporaryMarkers(TEMPORARY_FIXTURE);
    expect(result.markers[0].removalPath).toBe("status.json");
    expect(result.violations.some((v) => v.code === "lint.temporary.no-removal-path")).toBe(true); // only the path-less one
  });

  test("accepts dated plan references and plan paths as removal paths", () => {
    const result = findTemporaryMarkers(TEMPORARY_FIXTURE);
    expect(result.markers[1].removalPath).toBe("plan 20991231-example-plan");

    const byPath = findTemporaryMarkers(TEMPORARY_PLAN_PATH);
    expect(byPath.ok).toBe(true);
    expect(byPath.markers[0].removalPath).toBe("plans/20991231-example.md");
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

  test("ignores marker text inside a string literal (a fixture asserting this check)", () => {
    expect(findTemporaryMarkers("const t = `\n// temporary: hack\n`;\n").markers).toEqual([]);
    expect(findTemporaryMarkers('writeFileSync(file, "// temporary: hack\\n");\n').markers).toEqual([]);
  });

  test("requires the label shape: the ordinary adjective is not a marker", () => {
    const result = findTemporaryMarkers(
      "/**\n * Writes a temporary file beside the ledger.\n * The TEMPORARY table is dropped after the read.\n * temporary harness roots keep each case isolated.\n */\n",
    );
    expect(result.markers).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("accepts the colon and spaced-dash label forms", () => {
    expect(findTemporaryMarkers("// temporary: hack\n").markers).toHaveLength(1);
    expect(findTemporaryMarkers("// TEMPORARY \u2014 offline path\n").markers).toHaveLength(1);
    expect(findTemporaryMarkers("// temporary - offline path\n").markers).toHaveLength(1);
  });

  test("a statement terminator never opens a trailing temporary marker", () => {
    expect(findTemporaryMarkers("let a = 1 ; temporary: hack\n").markers).toEqual([]);
    // why: these are the forms that do open a comment.
    for (const text of [
      "x = 1  # temporary: hack\n",
      "SELECT 1 -- temporary: hack\n",
      "; temporary: hack\n",
      "// temporary: hack\n",
    ]) {
      expect(findTemporaryMarkers(text).markers).toHaveLength(1);
    }
  });

  test("a stray residual word is not a removal path", () => {
    const result = findTemporaryMarkers("// temporary: hack. some residual note\n");
    expect(result.markers[0].removalPath).toBeNull();
    expect(findTemporaryMarkers("// temporary: hack; removal tracked in status.json\n").markers[0].removalPath).toBe(
      "status.json",
    );
  });
});

// ---------------------------------------------------------------------------
// findCommentedCode — skills/mstar-coding-behavior/references/comments.md
// § MUST NOT ("commented-out code: the file's history is the archive")
// ---------------------------------------------------------------------------

describe("findCommentedCode", () => {
  test("reports a complete statement on a comment line", () => {
    const findings = findCommentedCode("const y = 2;\n// const x = 1;\n");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
    expect(findings[0].text).toContain("const x = 1;");
  });

  test("reports one finding per comment run, at the run's first line", () => {
    const findings = findCommentedCode("// const cache = new Map();\n// cache.set(key, value);\nconst live = 1;\n");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });

  test("does not report a wrapped prose continuation that ends in a terminator", () => {
    const source =
      "// The scanner joins every comment line in the run and\n// parses the result as one program;\nconst live = 1;\n";
    expect(findCommentedCode(source)).toEqual([]);
  });

  test("does not report a section heading such as `// Vocabulary (contract §3)`", () => {
    expect(findCommentedCode("// Vocabulary (contract \u00a73)\nconst live = 1;\n")).toEqual([]);
  });

  test("does not report a label-only comment (`// TODO: later` is a TODO, not code)", () => {
    expect(findCommentedCode("// TODO: later\nconst live = 1;\n")).toEqual([]);
  });

  test("does not report prose that parses as a labeled statement", () => {
    expect(findCommentedCode("// fallback: cache;\nconst live = 1;\n")).toEqual([]);
    expect(findCommentedCode("// note: retry once;\nconst live = 1;\n")).toEqual([]);
  });

  test("still reports a labeled statement that carries a call", () => {
    expect(findCommentedCode("// retry: doWork();\nconst live = 1;\n")).toHaveLength(1);
  });

  test("does not report a trailing comment after live code", () => {
    expect(findCommentedCode("const x = 1; // const y = 2;\n")).toEqual([]);
  });

  test("ignores triple-slash directives", () => {
    expect(findCommentedCode("/// <reference path=\"./types.d.ts\" />\nconst live = 1;\n")).toEqual([]);
  });

  test("does not report commented-out code inside a string or template literal", () => {
    expect(findCommentedCode("const t = `\n// const x = 1;\n`;\n")).toEqual([]);
    expect(findCommentedCode('const t = "// const x = 1;";\n')).toEqual([]);
  });

  test("returns [] for empty input", () => {
    expect(findCommentedCode("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findUntrackedTodos — comments.md § MUST NOT ("an ownerless TODO: no name,
// issue reference or removal path means nobody removes it")
// ---------------------------------------------------------------------------

describe("findUntrackedTodos", () => {
  test("reports a TODO comment with no tracking reference", () => {
    const findings = findUntrackedTodos("// TODO: later\nconst x = 1;\n");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].marker).toBe("TODO");
    expect(findings[0].text).toContain("later");
  });

  test("reports FIXME the same way", () => {
    expect(findUntrackedTodos("// FIXME: reset the cache\n").map((finding) => finding.marker)).toEqual(["FIXME"]);
  });

  test("accepts an issue reference in any of the supported forms", () => {
    expect(findUntrackedTodos("// TODO(#123): later\n")).toEqual([]);
    expect(findUntrackedTodos("// TODO: later - tracked in #123\n")).toEqual([]);
    expect(findUntrackedTodos("// TODO(MSTAR-77): later\n")).toEqual([]);
  });

  test("accepts a removal path from the temporary-marker vocabulary", () => {
    expect(findUntrackedTodos("// TODO: drop the shim - removal tracked in status.json\n")).toEqual([]);
  });

  test("a technical standard or encoding name is not a tracking reference", () => {
    expect(findUntrackedTodos("// TODO: handle UTF-8 names\n")).toHaveLength(1);
    expect(findUntrackedTodos("// TODO: SHA-256 the digest\n")).toHaveLength(1);
    expect(findUntrackedTodos("// TODO: ISO-8601 dates\n")).toHaveLength(1);
    expect(findUntrackedTodos("// FIXME: HTTP-2 upgrade\n")).toHaveLength(1);
  });

  test("ignores lowercase prose and marker text outside a comment", () => {
    expect(findUntrackedTodos("// the todo list lives in the plan\n")).toEqual([]);
    expect(findUntrackedTodos('const message = "TODO: later";\n')).toEqual([]);
    expect(findUntrackedTodos('expect(find("// TODO: later")).toBe(1);\n')).toEqual([]);
  });

  test("a code identifier named TODO or FIXME is not a marker", () => {
    expect(findUntrackedTodos("const TODO = 1;\n")).toEqual([]);
    expect(findUntrackedTodos("type FIXME = string;\n")).toEqual([]);
    expect(findUntrackedTodos("const map = new Map<string, TODO>();\n")).toEqual([]);
    expect(findUntrackedTodos("const o = { TODO: 1 };\n")).toEqual([]);
    expect(findUntrackedTodos("x = 1; TODO\n")).toEqual([]);
    expect(findUntrackedTodos("class A { #TODO = 1; }\n")).toEqual([]);
  });

  test("a C statement terminator never opens a trailing comment", () => {
    expect(findUntrackedTodos("class A { #TODO = 1 ; } export function TODO() {}\n")).toEqual([]);
    expect(findUntrackedTodos("const a = f() ; const TODO = 1;\n")).toEqual([]);
    expect(findUntrackedTodos("# TODO: fix\n")).toHaveLength(1);
  });

  test("a rejected code-context marker does not shadow a later comment marker on the line", () => {
    const findings = findUntrackedTodos("class A { #TODO = 1; } // TODO: remove the shim\n");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].marker).toBe("TODO");
    expect(findings[0].text).toContain("remove the shim");
  });

  test("a named owner satisfies the rule (`TODO(alice):`)", () => {
    expect(findUntrackedTodos("// TODO(alice): rewrite the retry loop\n")).toEqual([]);
    expect(findUntrackedTodos("// FIXME(bob): drop the shim\n")).toEqual([]);
  });

  test("an `@name` owner satisfies the rule (`TODO @alice:`)", () => {
    expect(findUntrackedTodos("// TODO @alice: rewrite the retry loop\n")).toEqual([]);
    expect(findUntrackedTodos("// FIXME @bob: drop the shim\n")).toEqual([]);
  });

  test("a marker in a trailing non-C comment is still checked (`#`, `--`)", () => {
    const cases = [
      "echo hi # TODO: fix the retry\n",
      "key: v # FIXME: drop the shim\n",
      "select 1; -- TODO: reindex\n",
      "x = 1 # TODO: fix the retry\n",
    ];
    for (const text of cases) {
      expect(findUntrackedTodos(text)).toHaveLength(1);
    }
  });

  test("a filler word in the parens is not an owner (`TODO(later)` and friends)", () => {
    for (const word of ["later", "see", "note", "none", "fix", "todo", "tbd", "soon"]) {
      expect(findUntrackedTodos(`// TODO(${word}): rewrite the retry loop\n`)).toHaveLength(1);
      expect(findUntrackedTodos(`// FIXME(${word}): rewrite the retry loop\n`)).toHaveLength(1);
    }
  });

  test("a non-C introducer that starts the line is comment context past a non-adjacent marker", () => {
    expect(findUntrackedTodos("# see TODO: fix the retry\n")).toHaveLength(1);
    expect(findUntrackedTodos("; note: TODO: rewrite the retry loop\n")).toHaveLength(1);
    expect(findUntrackedTodos("-- see TODO: reindex after the migration\n")).toHaveLength(1);
    expect(findUntrackedTodos("const TODO = 1;\n")).toEqual([]);
  });

  test("every parenthesised marker on the line is inspected for an owner", () => {
    expect(findUntrackedTodos("// TODO(later) then TODO(alice): rewrite the retry loop\n")).toEqual([]);
    expect(findUntrackedTodos("// TODO(later) then TODO(soon): rewrite the retry loop\n")).toHaveLength(1);
  });
});

// why: comments.md § MUST is the spec - a comment earns its place by a declared
// shape - and the documentation-block exemption is its one carve-out.

describe("findUnclassifiedComments", () => {
  test("reports a comment that restates the code", () => {
    const findings = findUnclassifiedComments("// returns the value\nconst x = f();\n");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].text).toBe("// returns the value");
  });

  test("accepts a declared prefix", () => {
    expect(findUnclassifiedComments("// why: the upstream returns 200 on 429\n")).toEqual([]);
    expect(findUnclassifiedComments("// invariant: callers hold the lock\n")).toEqual([]);
    expect(findUnclassifiedComments("// safety: the write must share the read transaction\n")).toEqual([]);
    expect(findUnclassifiedComments("// note: generated by the bundler\n")).toEqual([]);
  });

  test("accepts a contract pointer", () => {
    expect(findUnclassifiedComments("// see docs/adr/0007\n")).toEqual([]);
    expect(findUnclassifiedComments("// see https://example.com/archive\n")).toEqual([]);
    expect(findUnclassifiedComments("// ADR-0007 owns this ordering\n")).toEqual([]);
    expect(findUnclassifiedComments("// tracked in #123\n")).toEqual([]);
    expect(findUnclassifiedComments("// issue 123 records the tradeoff\n")).toEqual([]);
    expect(findUnclassifiedComments("// plans/20991231-example.md owns the removal\n")).toEqual([]);
    expect(findUnclassifiedComments("// contract \u00a74.2\n")).toEqual([]);
  });

  test("accepts a standalone URL as the pointer target", () => {
    expect(findUnclassifiedComments("// https://example.com/wire-format\n")).toEqual([]);
    expect(findUnclassifiedComments("// https://example.com/wire-format fixes the field order\n")).toEqual([]);
  });

  test("requires a target after see, so the verb alone is not a pointer", () => {
    expect(findUnclassifiedComments("// the only way to see a fold is to open it\n")).toHaveLength(1);
    expect(findUnclassifiedComments("// see the pairing this run leaves behind\n")).toHaveLength(1);
  });

  test("carries the span of a block comment", () => {
    expect(findUnclassifiedComments("/*\n * returns the value\n */\nconst a = 1;\n")[0]).toMatchObject({ line: 1, endLine: 3 });
  });

  test("accepts every marker label", () => {
    expect(findUnclassifiedComments("// simplify: x; upgrade: y\n")).toEqual([]);
    expect(findUnclassifiedComments("// temporary: shim - removal tracked in status.json\n")).toEqual([]);
    expect(findUnclassifiedComments("// shortcut: one queue; upgrade: split per route\n")).toEqual([]);
  });

  test("accepts the generated marker", () => {
    expect(findUnclassifiedComments("// @generated by scripts/build.ts\n")).toEqual([]);
  });

  test("accepts a tracked TODO and reports the ownerless one", () => {
    expect(findUnclassifiedComments("// TODO(#123): drop the shim\n")).toEqual([]);
    expect(findUnclassifiedComments("// TODO(alice): drop the shim\n")).toEqual([]);
    expect(findUnclassifiedComments("// TODO: later\n")).toHaveLength(1);
  });

  test("matches the shapes in every comment form", () => {
    expect(findUnclassifiedComments("/* returns the value */\nconst a = 1;\n")).toHaveLength(1);
    expect(findUnclassifiedComments("/* why: the lock is held by the caller */\n")).toEqual([]);
    expect(findUnclassifiedComments("# why: the CLI probes before linking\n")).toEqual([]);
    expect(findUnclassifiedComments("; why: INI-style reader\n")).toEqual([]);
    expect(findUnclassifiedComments("-- why: reindex after the migration\n")).toEqual([]);
  });

  test("an adjacent run of line comments is one unit, like a block", () => {
    const wrapped = "// returns the value\n// and does it again\nconst a = 1;\n";
    const findings = findUnclassifiedComments(wrapped);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 1, endLine: 2 });
    expect(findUnclassifiedComments("// returns the value\n// why: the lock is held\nconst a = 1;\n")).toEqual([]);
    expect(findUnclassifiedComments("// returns the value\n\n// and again\nconst a = 1;\n")).toHaveLength(2);
  });

  test("a trailing comment on the next line does not join the run above it", () => {
    const findings = findUnclassifiedComments('// returns the value\nconst d = load("docs/spec.md"); // and again\n');
    expect(findings.map(({ line, endLine }) => [line, endLine])).toEqual([[1, 1], [2, 2]]);
    expect(findings[0]?.text).toBe("// returns the value");
  });

  test("reads a block comment's shapes past the continuation stars", () => {
    const block = "/*\n * returns the value\n */\nconst a = 1;\n";
    expect(findUnclassifiedComments(block)).toHaveLength(1);
    const classified = "/*\n * why: the lock is held by the caller\n */\nconst a = 1;\n";
    expect(findUnclassifiedComments(classified)).toEqual([]);
  });

  test("exempts a documentation block whose next line exports", () => {
    expect(findUnclassifiedComments("/** Public API doc. */\nexport function f() {}\n")).toEqual([]);
    expect(findUnclassifiedComments("/**\n * Public API doc.\n */\nexport const x = 1;\n")).toEqual([]);
    const spaced = "/** Public API doc. */\n\nexport type T = string;\n";
    expect(findUnclassifiedComments(spaced)).toEqual([]);
  });

  test("reports a documentation block whose next line is not an export", () => {
    const findings = findUnclassifiedComments("/** Public API doc. */\nconst x = 1;\n");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findUnclassifiedComments("/** Public API doc. */\nfunction f() {}\n")).toHaveLength(1);
    expect(findUnclassifiedComments("/** Public API doc. */\n// helper below\nexport function f() {}\n")).toHaveLength(2);
  });

  test("a private field and a shebang are code, not comments", () => {
    expect(findUnclassifiedComments("class A { #count = 0; }\n")).toEqual([]);
    expect(findUnclassifiedComments("#!/usr/bin/env bun\nconst a = 1;\n")).toEqual([]);
  });

  test("does not report a `//` inside a string or template literal", () => {
    expect(findUnclassifiedComments('const s = "// returns the value";\n')).toEqual([]);
    expect(findUnclassifiedComments("const t = `\n// returns the value\n`;\n")).toEqual([]);
  });

  test("returns [] for empty input", () => {
    expect(findUnclassifiedComments("")).toEqual([]);
  });
});

describe("findUnclassifiedComments — comment dialect follows the language", () => {
  test("Python floor division is code, not a comment", () => {
    expect(findUnclassifiedComments("return numerator // denominator\n", "hash")).toEqual([]);
    // the C default keeps its existing reading, so callers that pass no dialect
    // are unchanged
    expect(findUnclassifiedComments("return numerator // denominator\n")).toHaveLength(1);
  });

  test("a hash comment is one unit, so a URL inside it classifies", () => {
    expect(findUnclassifiedComments("# https://example.com/wire-format\n", "hash")).toEqual([]);
    expect(findUnclassifiedComments("# see docs/adr/0007\n", "hash")).toEqual([]);
    expect(findUnclassifiedComments("# why: the wire format fixes field order\n", "hash")).toEqual([]);
  });

  test("a hash comment that restates the code still fails in a hash language", () => {
    const findings = findUnclassifiedComments("# returns the value\n", "hash");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 1, text: "# returns the value" });
  });

  test("a slash in a shell path opens no comment", () => {
    expect(findUnclassifiedComments("src=/usr/local//bin/run\n", "hash")).toEqual([]);
    expect(findUnclassifiedComments("echo ${#SCREENS[@]}\n", "hash")).toEqual([]);
  });

  test("code and literals before a hash keep their own reading", () => {
    expect(findUnclassifiedComments('x = "a # b"\n', "hash")).toEqual([]);
    expect(findUnclassifiedComments("def f():  # returns the value\n", "hash")).toHaveLength(1);
  });

  test("the dialect is derived from the extension", () => {
    for (const file of ["a/b/scan.py", "run.sh", "x.BASH", "lib.zsh", "task.rb"]) {
      expect(sourceDialect(file)).toBe("hash");
    }
    for (const file of ["scan.ts", "scan.tsx", "main.go", "lib.rs", "README.md", "noext"]) {
      expect(sourceDialect(file)).toBe("c");
    }
  });
});

describe("findSimplifyMarkers completeness", () => {
  test("the shortcut label carries a bound exactly like simplify", () => {
    const unbounded = findSimplifyMarkers("// shortcut: one queue\n");
    expect(unbounded).toHaveLength(1);
    expect(unbounded[0]).toMatchObject({ line: 1, label: "shortcut", bound: null });
    const bounded = findSimplifyMarkers("// shortcut: one queue; upgrade: split per route\n");
    expect(bounded[0]).toMatchObject({ line: 1, label: "shortcut" });
    expect(bounded[0]!.bound).toContain("upgrade: split per route");
    expect(findSimplifyMarkers("// simplify: naive scan\n")[0]).toMatchObject({ label: "simplify", bound: null });
  });

  test("records a missing bound as null", () => {
    const markers = findSimplifyMarkers("// simplify: naive scan\n");
    expect(markers).toHaveLength(1);
    expect(markers[0].bound).toBeNull();
  });

  test("records the upgrade clause when the marker carries one", () => {
    const markers = findSimplifyMarkers("// simplify: naive scan; upgrade: index the map\n");
    expect(markers[0].bound).toContain("upgrade: index the map");
  });

  test("accepts an upgrade clause on a continuation line of the same comment block", () => {
    const markers = findSimplifyMarkers("// simplify: naive scan\n// upgrade: index the map\n");
    expect(markers[0].bound).toContain("upgrade: index the map");
  });

  test("accepts a removal/tracking reference as the bound", () => {
    const markers = findSimplifyMarkers("// simplify: naive scan\n// removal tracked in status.json\n");
    expect(markers[0].bound).toContain("status.json");
  });

  test("a comment block with neither bound form records null", () => {
    const markers = findSimplifyMarkers("// simplify: naive scan\n// the scan is quadratic\n");
    expect(markers[0].bound).toBeNull();
  });

  test("accepts the #123 tracking reference comments.md lists", () => {
    const markers = findSimplifyMarkers("// simplify: naive scan; removal tracked in #123\n");
    expect(markers[0].bound).toBe("#123");
  });

  test("a bare upgrade word is not the bound clause (only upgrade: is)", () => {
    const markers = findSimplifyMarkers("// simplify: naive scan; upgrade later maybe\n");
    expect(markers[0].bound).toBeNull();
    expect(findSimplifyMarkers("// simplify: naive scan; upgrade: index the map\n")[0].bound).toBe(
      "upgrade: index the map",
    );
  });

  test("reads the bound across a shell/YAML comment block (# and ; introducers)", () => {
    for (const introducer of ["#", ";", "--"]) {
      const block = `${introducer} simplify: naive scan\n${introducer} upgrade: index the map\n`;
      expect(findSimplifyMarkers(block)[0].bound).toBe("upgrade: index the map");
    }
  });

  test("a `--x` decrement line is code, so a bound on it is invisible", () => {
    const markers = findSimplifyMarkers("// simplify: naive scan\n--x; upgrade: index the map\n");
    expect(markers).toHaveLength(1);
    expect(markers[0].bound).toBeNull();
  });

  test("an apostrophe in a comment does not hide the rest of the block", () => {
    const markers = findSimplifyMarkers(
      "# don't retry the batch on a partial write\n# simplify: naive scan\n# upgrade: index the map\n",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0].bound).toBe("upgrade: index the map");
  });

  test("a code line in the block does not satisfy the bound", () => {
    const markers = findSimplifyMarkers("// simplify: naive scan\nconst residual = computeResidual();\n");
    expect(markers[0].bound).toBeNull();
  });

  test("a stray residual word is not a tracking reference", () => {
    expect(findSimplifyMarkers("// simplify: naive scan\n// some residual note\n")[0].bound).toBeNull();
    expect(findSimplifyMarkers("// simplify: naive scan; upgrade later\n")[0].bound).toBeNull();
  });

  test("an `upgrade:` clause with no value after the colon states no plan", () => {
    expect(findSimplifyMarkers("// simplify: naive scan; upgrade:\n")[0].bound).toBeNull();
    expect(findSimplifyMarkers("x = 1; // simplify: naive scan upgrade:\n")[0].bound).toBeNull();
  });

  test("an `upgrade:` clause whose value wraps to the next comment line still bounds", () => {
    const markers = findSimplifyMarkers("// simplify: naive scan; upgrade:\n// index the map when the scan shows up\n");
    expect(markers[0].bound).toBe("upgrade: index the map when the scan shows up");
  });

  test("code after a closed block comment is not the marker's bound", () => {
    const markers = findSimplifyMarkers('/* simplify: naive scan */ const p = "plans/y.md";\n');
    expect(markers).toHaveLength(1);
    expect(markers[0].bound).toBeNull();
    expect(findSimplifyMarkers("/* simplify: naive scan; upgrade: index */ const p = 1;\n")[0].bound).toBe(
      "upgrade: index",
    );
  });

  test("a division after a closed string or template still opens the trailing comment", () => {
    for (const literal of ['"4"', "'4'", "`4`"]) {
      const markers = findSimplifyMarkers(`const n = ${literal} / 2 // simplify: naive scan\n`);
      expect(markers).toHaveLength(1);
      expect(markers[0].line).toBe(1);
      expect(markers[0].bound).toBeNull();
    }
  });

  test("a `//` comment whose bound ends in `*/` keeps that text", () => {
    expect(findSimplifyMarkers("x = 1; // simplify: naive scan; upgrade: wrap in /* */\n")[0].bound).toBe(
      "upgrade: wrap in /* */",
    );
    expect(findSimplifyMarkers("x = 1; // simplify: naive scan; upgrade: */\n")[0].bound).toBe("upgrade: */");
  });

  test("a block-comment close is stripped when the comment body carries an introducer character", () => {
    // The `;` after `#12` is comment text, not an opener: the run still
    // belongs to the `/*` block, so its close is delimiter, never the bound.
    const markers = findSimplifyMarkers("doIt(); /* fix #12; simplify: naive scan, upgrade: v2 */\n");
    expect(markers).toHaveLength(1);
    expect(markers[0].bound).toBe("upgrade: v2");
  });

  test("a trailing non-C comment keeps its whole tail past a block-comment close", () => {
    const markers = findSimplifyMarkers(
      "x=1 # simplify: strip /* old */; upgrade: use a parser when nesting is needed\n",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0].bound).toBe("upgrade: use a parser when nesting is needed");
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
// findProvenanceCitations — repo AGENTS.md provenance rule ("tracked code
// and docs must not depend on local harness artifacts or disclose their
// provenance") + the attribution contract shared with findEphemeralCitations:
// sdd deeplinks are the ephemeral check's exclusive surface.
// ---------------------------------------------------------------------------

describe("findProvenanceCitations", () => {
  test("flags dated plan ids, iteration tokens, and dated harness paths with 1-based lines", () => {
    const citations = findProvenanceCitations(PROVENANCE_HITS);
    expect(citations).toHaveLength(4);
    expect(citations.map((c) => c.kind)).toEqual(["plan-id", "plan-id", "harness-path", "harness-path"]);
    expect(citations.map((c) => c.match)).toEqual([
      "20991231-sample-plan",
      "20990101-sample-iteration",
      ".mstar/plans/20991231-sample-plan/tasks.md",
      ".agents/plans/20990102-sample-agent/report.md",
    ]);
    expect(citations.map((c) => c.line)).toEqual([1, 2, 3, 4]);
  });

  test("reports a dated token once as harness-path inside a path, and standalone occurrences as plan-id", () => {
    const citations = findProvenanceCitations(
      ".mstar/plans/20991231-sample-plan.md ships with 20991231-sample-plan mentioned",
    );
    expect(citations).toEqual([
      { line: 1, match: ".mstar/plans/20991231-sample-plan.md", kind: "harness-path" },
      { line: 1, match: "20991231-sample-plan", kind: "plan-id" },
    ]);
  });

  test("trims trailing sentence punctuation from the reported match (finding kept, match clean)", () => {
    const citations = findProvenanceCitations("tracked in .mstar/plans/20991231-sample-plan/tasks.md.");
    expect(citations).toEqual([
      { line: 1, match: ".mstar/plans/20991231-sample-plan/tasks.md", kind: "harness-path" },
    ]);
  });

  test("keeps sdd deeplinks unreported — the ephemeral check owns that surface", () => {
    expect(findProvenanceCitations("report at .mstar/sdd/20991231-sample-plan/task-1-report.md")).toEqual([]);
    expect(findProvenanceCitations("mirror at .agents/sdd/20991231-sample-plan/")).toEqual([]);
  });

  test("zero false positives on every excluded shape (example slugs, versions, placeholders, dates, layout, sdd)", () => {
    expect(findProvenanceCitations(PROVENANCE_FALSE_POSITIVES)).toEqual([]);
  });

  test("globs and template path tails never carry a dated instance segment", () => {
    expect(findProvenanceCitations("allow `.mstar/sdd/**` and `.agents/sdd/**` globs")).toEqual([]);
    expect(findProvenanceCitations("template .mstar/plans/<plan-id>/tasks.md")).toEqual([]);
  });

  test("returns [] for empty input", () => {
    expect(findProvenanceCitations("")).toEqual([]);
  });

  test.skipIf(CORPUS === null)(
    "real corpus: zero provenance citations across the whole skills corpus",
    () => {
      const corpus = CORPUS as string;
      const stack = [corpus];
      const hits: string[] = [];
      let checked = 0;
      while (stack.length > 0) {
        const dir = stack.pop() as string;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) stack.push(path);
          else if (entry.isFile()) {
            checked++;
            const found = findProvenanceCitations(readFileSync(path, "utf8"));
            if (found.length > 0) hits.push(`${path}: ${found.map((c) => `${c.kind}:${c.match}`).join(", ")}`);
          }
        }
      }
      expect(checked).toBeGreaterThan(100);
      expect(hits).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// assertSddTddTriple — mstar-sdd/references/file-handoffs.md
// § Verification evidence (declared structure only; execution is PM/QC's)
// ---------------------------------------------------------------------------

describe("assertSddTddTriple", () => {
  const scopedReport = `Verification mode: scoped-check
Changed files: skills/example/SKILL.md
Tests: N/A
Reason: Policy text changed; the affected trigger and scope contract are checked.
Check command: rg -n 'scoped rule' skills/example/SKILL.md
Check result: exit 0; the changed rule and referenced boundary are present.
`;

  test("accepts actual static output without unit-test status tokens", () => {
    for (const output of ["skills/example/SKILL.md:12: scoped rule", "README.md -> README_CN.md", '{"valid":true}']) {
      expect(assertSddTddTriple(scopedReport.replace("exit 0; the changed rule and referenced boundary are present.", output)).ok).toBe(true);
    }
  });

  test("append-only verification rounds validate the active round", () => {
    const report = `## Verification round: initial\n${scopedReport}\n## Verification round: fix 1\n${scopedReport}`;
    expect(assertSddTddTriple(report).ok).toBe(true);
  });

  test("active duplicate declarations remain invalid after a valid historical round", () => {
    const report = `${scopedReport}\n## Verification round: fix 1\nVerification mode: scoped-check\n${scopedReport}`;
    expect(assertSddTddTriple(report).ok).toBe(false);
  });

  test("active round validates only its own declared fields", () => {
    for (const active of [scopedReport.replace("Check command: rg -n 'scoped rule' skills/example/SKILL.md\n", ""), scopedReport.replace("Verification mode: scoped-check\n", "")]) {
      expect(assertSddTddTriple(`${TRIPLE_COMPLETE}\n${scopedReport}\n## Verification round: fix 1\n${active}`).ok).toBe(false);
    }
    expect(assertSddTddTriple(`${scopedReport}\n## Verification round: fix 1\n`).ok).toBe(true);
  });

  test("malformed active round label cannot reuse a completed historical report", () => {
    for (const label of ["", "TBD"]) {
      expect(assertSddTddTriple(`${scopedReport}\n## Verification round: ${label}\n`).ok).toBe(false);
    }
  });

  test("active executable test triple remains valid after historical scoped evidence", () => {
    expect(assertSddTddTriple(`${scopedReport}\n## Verification round: code fix\n${TRIPLE_COMPLETE}`).ok).toBe(true);
  });

  test("accepts scoped-check policy evidence without invented tests", () => {
    expect(assertSddTddTriple(scopedReport)).toEqual({ ok: true, violations: [] });
  });

  for (const field of ["Changed files", "Tests", "Reason", "Check command", "Check result"]) {
    for (const value of ["", "TBD", "..."]) {
      test(`rejects scoped-check ${field} with placeholder ${JSON.stringify(value)}`, () => {
        const report = scopedReport.split("\n").map((line) => line.startsWith(`${field}:`) ? `${field}: ${value}` : line).join("\n");
        expect(assertSddTddTriple(report).ok).toBe(false);
      });
    }
    test(`rejects scoped-check missing ${field}`, () => {
      expect(assertSddTddTriple(scopedReport.split("\n").filter((line) => !line.startsWith(`${field}:`)).join("\n")).ok).toBe(false);
    });
  }

  test("rejects unknown or empty verification modes even with a valid triple", () => {
    for (const mode of ["docs-only", "full", ""]) {
      expect(assertSddTddTriple(`Verification mode: ${mode}\n${TRIPLE_COMPLETE}`).ok).toBe(false);
    }
  });

  test("rejects duplicate modes and duplicate evidence fields", () => {
    expect(assertSddTddTriple(`Verification mode: scoped-check\n${scopedReport}`).ok).toBe(false);
    expect(assertSddTddTriple(`${scopedReport}Reason: another claim\n`).ok).toBe(false);
  });

  test("rejects placeholder scoped-check result and non-N/A tests", () => {
    expect(assertSddTddTriple(scopedReport.replace("exit 0; the changed rule and referenced boundary are present.", "N/A")).ok).toBe(false);
    expect(assertSddTddTriple(scopedReport.replace("Tests: N/A", "Tests: skipped")).ok).toBe(false);
  });

  test("rejects bare N/A test-file claim outside scoped-check", () => {
    expect(assertSddTddTriple("Covering test file(s): N/A\nCommand run: bun test\n12 pass / 0 fail").ok).toBe(false);
  });

  test("accepts a report carrying no mode declaration", () => {
    const result = assertSddTddTriple(TRIPLE_COMPLETE);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("prose without any evidence shape passes — the lint no longer certifies execution", () => {
    expect(assertSddTddTriple(TRIPLE_PROSE_ONLY)).toEqual({ ok: true, violations: [] });
    expect(assertSddTddTriple("")).toEqual({ ok: true, violations: [] });
  });

  test("rejects a bare Tests: N/A claim outside scoped-check", () => {
    const result = assertSddTddTriple("## Task 1 report\nTests: N/A\nDid the work.\n");
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.sdd-evidence.bare-tests-na"]);
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

  test("skips a leading frontmatter block: `status: Todo` is not a placeholder, a body TBD still is", () => {
    const result = planQualityBar("---\nplan_id: example\nstatus: Todo\n---\n\n# Plan\n\n- [ ] Version: TBD\n");
    expect(result.findings).toEqual([{ token: "TBD", line: 8, text: "- [ ] Version: TBD" }]);
  });

  test("an unclosed leading `---` stays body: a frontmatter-shaped file without a closing fence is still scanned", () => {
    const result = planQualityBar("---\n- [ ] Version: TBD\n");
    expect(result.findings).toEqual([{ token: "TBD", line: 2, text: "- [ ] Version: TBD" }]);
  });

  test("lifecycle Todo is domain state, an unowned TODO still fails", () => {
    const lifecycle = planQualityBar("# Plan\n\nstatus: open maps to Todo\n\n- [ ] Phase: Todo\n");
    expect(lifecycle.findings).toEqual([]);
    const unowned = planQualityBar("# Plan\n- [ ] Status: Todo\n- [ ] TODO: wire the gate\n");
    expect(unowned.findings).toEqual([{ token: "TODO", line: 3, text: "- [ ] TODO: wire the gate" }]);
  });
});

// ---------------------------------------------------------------------------
// planQualityBar — verification set (plan-quality-bar.md § Verification gates
// surface map): a Files entry on a code surface names its mapped check.
// ---------------------------------------------------------------------------

describe("planQualityBar verification-set", () => {
  const ENGINE_PLAN = `# Plan

**Files:**
- Modify: \`packages/engine/src/lint.ts\`

- [ ] Run: \`bun test packages/engine/test/lint.test.ts\`
`;

  test("a code surface without its mapped check is flagged", () => {
    const result = planQualityBar(ENGINE_PLAN);
    expect(result.violations.map((v) => v.code)).toEqual(["lint.plan-quality.verification-set"]);
    expect(result.violations[0]!.message).toContain("bun run lint:ascii-literals");
  });

  test("the same plan passes once it names the mapped check", () => {
    const covered = ENGINE_PLAN.replace("- [ ] Run: ", "- [ ] Run: `bun run lint:ascii-literals`; ");
    expect(planQualityBar(covered).violations).toEqual([]);
  });

  test("skills and scripts surfaces map to the drift check and the script's own test", () => {
    const plan = "# Plan\n\n**Files:**\n- Modify: `skills/mstar-artifacts/SKILL.md`\n- Modify: `scripts/rule-duplication.ts`\n";
    const codes = planQualityBar(plan).violations;
    expect(codes).toHaveLength(2);
    expect(codes.every((v) => v.code === "lint.plan-quality.verification-set")).toBe(true);
    expect(codes.map((v) => v.message).join("\n")).toContain("bun run validation:drift");
    expect(codes.map((v) => v.message).join("\n")).toContain("bun test scripts/rule-duplication.test.ts");
  });

  test("a prose-only plan names no code surface and is not flagged", () => {
    expect(planQualityBar("# Plan\n\n- [ ] Rewrite the rationale paragraph.\n- [ ] Read the referenced contract.\n").violations).toEqual([]);
  });

  test("a script's own run counts as its check; a mention outside a verification line does not", () => {
    const run = "**Files:**\n- Modify: `scripts/lint-refusal-quality.ts`\n\n- [ ] Scoped-check: `bun run lint:refusal-quality` exits 0.\n";
    expect(planQualityBar(run).violations).toEqual([]);
    const mention = "**Files:**\n- Modify: `scripts/rule-duplication.ts`\n\nGlobal constraint: `bun test scripts/rule-duplication.test.ts` exists.\n";
    expect(planQualityBar(mention).violations.map((v) => v.code)).toEqual(["lint.plan-quality.verification-set"]);
  });

  test("a package-local scripts path is not the root surface (no invented root command)", () => {
    const plan = "**Files:**\n- Modify: `packages/ui/scripts/declaration-diff.ts`, `packages/judgment/scripts/evaluate.ts`\n\n- [ ] Run: `bun test packages/ui/test/declaration-diff.test.ts`\n";
    expect(planQualityBar(plan).violations).toEqual([]);
  });

  test("a Files entry quoting a command names no surface", () => {
    const plan = "**Files:**\n- Modify: only the paths `bun run release:prepare -- --minor` rewrites under `.changes/archive/`\n\n- [ ] Run: `bun run release:validate` once after the fragment moves.\n";
    expect(planQualityBar(plan).violations).toEqual([]);
  });

  test("a root script path with no check, no test and no run entry is still flagged", () => {
    const plan = "**Files:**\n- Modify: `scripts/adr-check.ts`\n\n- [ ] Run: `bun test packages/engine/test/lint.test.ts`\n";
    const violations = planQualityBar(plan).violations;
    expect(violations.map((v) => v.code)).toEqual(["lint.plan-quality.verification-set"]);
    expect(violations[0]!.message).toContain("bun test scripts/adr-check.test.ts");
  });

  test("a fenced Files example names no surface", () => {
    const plan = "# Plan\n\n- [ ] Rewrite the rationale paragraph.\n\n```markdown\n- Modify: `skills/example/SKILL.md`\n```\n";
    expect(planQualityBar(plan).violations).toEqual([]);
  });

  test("a fenced command satisfies no missing check", () => {
    const plan = "# Plan\n\n**Files:**\n- Modify: `skills/mstar-artifacts/SKILL.md`\n\n```\n- [ ] Run: `bun run validation:drift`\n```\n";
    expect(planQualityBar(plan).violations.map((v) => v.code)).toEqual(["lint.plan-quality.verification-set"]);
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

  test("current corpus regression: real-corpus Chinese description and mstar-design-md frontmatter pass", () => {
    expect(lintSkillFrontmatter(FRONTMATTER_REAL_ZH_DESCRIPTION).ok).toBe(true);
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
// lintStrategySections — mstar-knowledge/references/strategy-document.md § Shape
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

// ---------------------------------------------------------------------------
// lintSpecsDoc / lintSpecsTree — knowledge-and-designs.md § `{SPECS_DIR}`
// ---------------------------------------------------------------------------

/** A spec skeleton in the required shape, one section each. */
const SPEC_COMPLETE = `# Architecture: store authority

## Scope

The control-root store and its lifecycle.

## Current state

One SQLite file holds the catalog and execution rows.

## Invariants

Writes go through the domain verbs.

## Where it lives

\`packages/engine/src/store.ts\`

## Change obligations

Update this page in the same PR as any schema change.
`;

/** Write `files` (path under the temp root -> text) and hand the root to `run`. */
function withTree<T>(files: Record<string, string>, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "lint-tree-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function codes(result: { violations: Array<{ code: string }> }): string[] {
  return result.violations.map((item) => item.code);
}

describe("lintSpecsDoc", () => {
  test("a valid skeleton passes", () => {
    const result = lintSpecsDoc(SPEC_COMPLETE, "architecture/store-authority.md");
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a -v<N> filename fails as name-shape", () => {
    const result = lintSpecsDoc(SPEC_COMPLETE, "architecture/store-authority-v2.md");
    expect(codes(result)).toEqual(["lint.specs.name-shape"]);
    expect(result.violations[0]!.message).toContain("-v<N>");
  });

  test("a date-prefixed filename fails as name-shape", () => {
    expect(codes(lintSpecsDoc(SPEC_COMPLETE, "architecture/2026-11-09-store.md"))).toEqual(["lint.specs.name-shape"]);
    expect(codes(lintSpecsDoc(SPEC_COMPLETE, "architecture/20261109-store.md"))).toEqual(["lint.specs.name-shape"]);
  });

  test("a missing ## Scope fails and names every required section", () => {
    const result = lintSpecsDoc(SPEC_COMPLETE.replace("## Scope", "## Overview"), "architecture/x.md");
    expect(codes(result)).toEqual(["lint.specs.section-missing"]);
    expect(result.violations[0]!.message).toContain("## Scope");
    expect(result.violations[0]!.fix).toContain("Current state");
  });

  test("a banned ## Decision section fails (the decision belongs in an ADR)", () => {
    const result = lintSpecsDoc(`${SPEC_COMPLETE}\n## Decision\n\nWe chose SQLite.\n`, "architecture/x.md");
    expect(codes(result)).toEqual(["lint.specs.section-banned"]);
    expect(result.violations[0]!.fix).toContain("ADR");
  });

  test("a .mstar/ mention fails as local-path disclosure", () => {
    const result = lintSpecsDoc(`${SPEC_COMPLETE}\nSee \`.mstar/plans/x.md\`.\n`, "architecture/x.md");
    expect(codes(result)).toEqual(["lint.specs.local-path"]);
  });

  test("a resolution-chain candidate is product convention, not local state", () => {
    const result = lintSpecsDoc(`${SPEC_COMPLETE}\nResolution: \`.mstarc\` → \`.mstar\` → \`.agents/specs/\` → \`docs/specs/\`.\n`, "architecture/x.md");
    expect(codes(result)).toEqual([]);
  });

  test("a plan_id: field fails as local-path disclosure", () => {
    const result = lintSpecsDoc(`${SPEC_COMPLETE}\nplan_id: 20261109-x\n`, "architecture/x.md");
    expect(codes(result)).toEqual(["lint.specs.local-path"]);
  });

  test("a placeholder id example is documentation, not local state", () => {
    const result = lintSpecsDoc(`${SPEC_COMPLETE}\nInput shape: \`plan_id: <plan-id>\`, \`iteration_id: \${ITERATION_ID}\`.\n`, "architecture/x.md");
    expect(codes(result)).toEqual([]);
  });

  test("a four-space indented fence is an indented block, not a toggle", () => {
    const result = lintSpecsDoc(`${SPEC_COMPLETE}\n    \`\`\`\n    example\n    \`\`\`\n`, "architecture/x.md");
    expect(codes(result)).toEqual([]);
  });

  test("an unclosed fence fails and stops the section scan", () => {
    const result = lintSpecsDoc(`# Spec\n\n\`\`\`md\n## Scope\n`, "architecture/x.md");
    expect(codes(result)).toEqual(["lint.specs.fence-unclosed"]);
  });

  test("a heading quoted inside a fence is not a section, in either direction", () => {
    const quotedBanned = SPEC_COMPLETE.replace("## Current state", "```md\n## Decision\n```\n\n## Current state");
    expect(lintSpecsDoc(quotedBanned, "architecture/x.md").violations).toEqual([]);
  });
});

describe("lintSpecsTree", () => {
  const README = `# Specs\n\n| Page | Topic |\n|---|---|\n| [store](architecture/store.md) | store authority |\n`;

  test("a classed, indexed tree passes", () => {
    const result = withTree(
      { "README.md": README, "architecture/store.md": SPEC_COMPLETE },
      lintSpecsTree,
    );
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a reference-style index link counts as an index link", () => {
    const result = withTree(
      {
        "README.md": `# Specs\n\nSee [store][store].\n\n[store]: architecture/store.md\n`,
        "architecture/store.md": SPEC_COMPLETE,
      },
      lintSpecsTree,
    );
    expect(result.violations).toEqual([]);
  });

  test("a link quoted inside a fence is not a dead link", () => {
    const result = withTree(
      {
        "README.md": `${README}\n\`\`\`md\n[example](architecture/missing.md)\n\`\`\`\n`,
        "architecture/store.md": SPEC_COMPLETE,
      },
      lintSpecsTree,
    );
    expect(result.violations).toEqual([]);
  });

  test("a missing tree passes (empty corpus)", () => {
    const result = withTree({}, (dir) => lintSpecsTree(join(dir, "absent")));
    expect(result.ok).toBe(true);
  });

  test("a spec at the tree root fails as location-invalid", () => {
    const result = withTree({ "README.md": README, "store.md": SPEC_COMPLETE }, lintSpecsTree);
    expect(codes(result)).toContain("lint.specs.location-invalid");
  });

  test("a history directory fails as location-invalid", () => {
    const result = withTree(
      { "README.md": README, "architecture/history/store.md": SPEC_COMPLETE },
      lintSpecsTree,
    );
    expect(codes(result)).toContain("lint.specs.location-invalid");
  });

  test("an unindexed spec and a dead index link each fail as link-missing", () => {
    const result = withTree(
      {
        "README.md": `${README}| [gone](architecture/gone.md) | removed |\n`,
        "architecture/store.md": SPEC_COMPLETE,
        "architecture/other.md": SPEC_COMPLETE,
      },
      lintSpecsTree,
    );
    expect(codes(result).filter((code) => code === "lint.specs.link-missing")).toHaveLength(2);
  });

  test("a tree with specs but no README fails as index-missing", () => {
    const result = withTree({ "architecture/store.md": SPEC_COMPLETE }, lintSpecsTree);
    expect(codes(result)).toEqual(["lint.specs.index-missing"]);
  });

  test("per-file violations carry the tree-relative path", () => {
    const result = withTree(
      { "README.md": README, "architecture/store.md": "# Spec\n" },
      lintSpecsTree,
    );
    expect(result.violations.every((item) => item.message.startsWith("architecture/store.md:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lintAdrTree — docs/adr/README.md contract, four buckets (archived included)
// ---------------------------------------------------------------------------

/** A record body with `sections`, a Status line, and an optional Archived line. */
function adrRecord(status: string, sections: string[], archivedLine?: string): string {
  const body = sections.flatMap((name) => [`## ${name}`, "", "Body text.", ""]);
  const header = [`# ADR: Example record`, "", `Status: ${status} \u2014 because`];
  if (archivedLine !== undefined) header.push(archivedLine);
  return [...header, "", ...body].join("\n");
}

const ADR_IMPLEMENTED = ["Problem", "Decision", "Alternatives considered", "Consequences"];
const ADR_PROPOSED = ["Problem", "Proposal", "Alternatives considered", "Acceptance criteria", "Risks"];

describe("lintAdrTree", () => {
  test("an archived implemented record with a Status and Archived line passes", () => {
    const result = withTree(
      {
        "archived/architecture/2026-01-01-example.md": adrRecord(
          "implemented",
          ADR_IMPLEMENTED,
          "Archived: 2026-02-01 \u2014 the mechanism was removed",
        ),
      },
      lintAdrTree,
    );
    expect(result.records).toBe(1);
    expect(result.failures).toEqual([]);
  });

  test("an archived record without an Archived: line fails as archive-line-missing", () => {
    const result = withTree(
      { "archived/architecture/2026-01-02-old.md": adrRecord("implemented", ADR_IMPLEMENTED) },
      lintAdrTree,
    );
    expect(result.failures.map((failure) => failure.code)).toEqual(["lint.adr.archive-line-missing"]);
    expect(result.failures[0]!.recovery).toContain("Archived:");
  });

  test("an archived record with a malformed Archived line fails", () => {
    const result = withTree(
      {
        "archived/architecture/2026-01-03-old.md": adrRecord(
          "implemented",
          ADR_IMPLEMENTED,
          "Archived: 2026-02-01 - the mechanism was removed",
        ),
      },
      lintAdrTree,
    );
    expect(result.failures.map((failure) => failure.code)).toEqual(["lint.adr.archive-line-missing"]);
    expect(result.failures[0]!.recovery).toContain("U+2014");
  });

  test("a proposed record inside archived/ fails (only implemented records may be archived)", () => {
    const result = withTree(
      {
        "archived/architecture/2026-01-04-proposed.md": adrRecord(
          "proposed",
          ADR_PROPOSED,
          "Archived: 2026-02-01 \u2014 should never have been archived",
        ),
      },
      lintAdrTree,
    );
    const failureCodes = result.failures.map((failure) => failure.code);
    expect(failureCodes).toContain("lint.adr.status-mismatch");
    expect(failureCodes).toContain("lint.adr.section-missing");
  });

  test("an archived record keeping a banned ## Proposal section fails", () => {
    const result = withTree(
      {
        "archived/architecture/2026-01-05-half.md": adrRecord(
          "implemented",
          [...ADR_IMPLEMENTED, "Proposal"],
          "Archived: 2026-02-01 \u2014 retired",
        ),
      },
      lintAdrTree,
    );
    expect(result.failures.map((failure) => failure.code)).toEqual(["lint.adr.section-banned"]);
  });

  test("Status disagreeing with the directory fails as status-mismatch naming the move", () => {
    const result = withTree(
      { "rejected/architecture/2026-01-06-moved.md": adrRecord("implemented", ADR_PROPOSED) },
      lintAdrTree,
    );
    expect(result.failures.map((failure) => failure.code)).toEqual(["lint.adr.status-mismatch"]);
    expect(result.failures[0]!.recovery).toContain("implemented/architecture");
  });

  test("an unknown bucket and an unknown class each fail, naming the legal names", () => {
    const result = withTree(
      {
        "archive/architecture/2026-01-07-old.md": adrRecord("implemented", ADR_IMPLEMENTED),
        "proposed/refactor/2026-01-08-refactor.md": adrRecord("proposed", ADR_PROPOSED),
      },
      lintAdrTree,
    );
    expect(result.failures.map((failure) => failure.code).sort()).toEqual([
      "lint.adr.bucket-unknown",
      "lint.adr.class-unknown",
    ]);
    const bucketFailure = result.failures.find((failure) => failure.code === "lint.adr.bucket-unknown")!;
    for (const bucket of ["proposed", "implemented", "rejected", "archived"]) {
      expect(bucketFailure.recovery).toContain(`${bucket}/`);
    }
  });

  test("a stray non-record file in a class directory is ignored", () => {
    const result = withTree(
      {
        "implemented/architecture/2026-01-09-record.md": adrRecord("implemented", ADR_IMPLEMENTED),
        "implemented/architecture/README.md": "# Notes\n",
        "implemented/architecture/.DS_Store": "junk",
      },
      lintAdrTree,
    );
    expect(result.records).toBe(1);
    expect(result.failures).toEqual([]);
  });

  test("an INDEX.md fails as index-forbidden and a wrong filename as name-shape", () => {
    const result = withTree(
      {
        "INDEX.md": "# Index\n",
        "implemented/architecture/example.md": adrRecord("implemented", ADR_IMPLEMENTED),
      },
      lintAdrTree,
    );
    expect(result.failures.map((failure) => failure.code)).toContain("lint.adr.index-forbidden");
    expect(result.failures.map((failure) => failure.code)).toContain("lint.adr.name-shape");
  });

  test("an unterminated fence fails the record instead of hiding its tail", () => {
    const body = adrRecord("implemented", ADR_IMPLEMENTED).replace("## Decision\n", "```md\n## Decision\n");
    const result = withTree({ "implemented/architecture/2026-01-09-unclosed.md": body }, lintAdrTree);
    expect(result.failures.map((failure) => failure.code)).toEqual(["lint.adr.fence-unclosed"]);
  });

  test("a missing tree passes with zero records", () => {
    const result = withTree({}, (dir) => lintAdrTree(join(dir, "absent")));
    expect(result).toEqual({ records: 0, failures: [] });
  });
});
