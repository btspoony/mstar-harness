/**
 * Engine skill-authoring module — frontmatter lint, 5-question body lint,
 * and skill-relative asset-path resolution.
 *
 * Spec sources (each test cites the skill/reference section it enforces;
 * roadmap §8.5 C2 — engine unit tests cite the source section as spec):
 * - Frontmatter contract: `mstar-skill-authoring` SKILL.md § Frontmatter
 *   Contract — `name` stable lowercase-hyphen; `description` is the trigger
 *   contract (not a workflow summary), third person. The frontmatter lint
 *   reuses `lint.lintSkillFrontmatter` (same heuristics, single parser).
 * - 5-question body: `mstar-skill-authoring` SKILL.md § Body 必须回答的 5 问
 *   (when to load / execution order / constraints / success criteria /
 *   extra resources) + § 默认 Body 结构 (Load Order, Scope, Workflow,
 *   Decision Rules, Evidence, References).
 * - Asset paths: `mstar-skill-authoring` SKILL.md § Skill-relative script
 *   and asset paths ("skill `my-skill` → scripts/do-thing"; never a literal
 *   `skills/<name>/...` path from a consumer cwd) + `mstar-host` SKILL.md
 *   § Resolve loaded skill root.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  lintFiveQuestion,
  lintFrontmatter,
  resolveAssetPath,
  RUNTIME_HEADING_ALIASES,
  stripFrontmatter,
} from "../src/skill-authoring.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRONTMATTER_GOOD = `---
name: example-skill
description: Use when the user asks to draft, review, or compress a skill document and the trigger contract must stay precise.
---`;

const FRONTMATTER_UPPERCASE_NAME = `---
name: Example-Skill
description: Use when a trigger contract must stay precise.
---`;

const FRONTMATTER_UNDERSCORE_NAME = `---
name: example_skill
description: Use when a trigger contract must stay precise.
---`;

const FRONTMATTER_NO_NAME = `---
description: Use when a trigger contract must stay precise.
---`;

const FRONTMATTER_NO_DESCRIPTION = `---
name: example-skill
---`;

/** The contract's own bad example (mstar-skill-authoring § Frontmatter
 * Contract): a workflow summary, not a trigger contract. */
const FRONTMATTER_WORKFLOW_SUMMARY = `---
name: example-skill
description: Explains how to write plans with steps, tests, commits, and review gates.
---`;

const FRONTMATTER_FIRST_PERSON = `---
name: example-skill
description: Use when you want me to lint a skill frontmatter for you.
---`;

/** Default body structure (mstar-skill-authoring § 默认 Body 结构): a body
 * answering all five questions with the canonical section headings. */
const BODY_COMPLETE = `# Skill Title

## Load Order

Read mstar-harness-core first.

## Scope

Covers skill authoring lint checks.

## Workflow

1. Parse the frontmatter.
2. Check the body sections.

## Decision Rules

Never flag prose-only skills; keep heuristics conservative.

## Evidence

A passing lint gate with zero violations.

## References

Open references/skillsbench-authoring.md when a full authoring loop is needed.
`;

const BODY_NO_WORKFLOW = `# Skill Title

## Load Order

Read mstar-harness-core first.

## Decision Rules

Never flag prose-only skills.

## Evidence

Zero violations.

## References

Open references/skillsbench-authoring.md when needed.
`;

const BODY_NO_DECISION_RULES = `# Skill Title

## Load Order

Read mstar-harness-core first.

## Workflow

1. Parse the frontmatter.

## Evidence

Zero violations.

## References

Open references/skillsbench-authoring.md when needed.
`;

const BODY_NO_REFERENCES = `# Skill Title

## Load Order

Read mstar-harness-core first.

## Workflow

1. Parse the frontmatter.

## Decision Rules

Keep heuristics conservative.

## Evidence

Zero violations.
`;

const BODY_NO_LOAD_ORDER = `# Skill Title

## Workflow

1. Parse the frontmatter.

## Decision Rules

Keep heuristics conservative.

## Evidence

Zero violations.

## References

Open references/skillsbench-authoring.md when needed.
`;

const BODY_NO_EVIDENCE = `# Skill Title

## Load Order

Read mstar-harness-core first.

## Workflow

1. Parse the frontmatter.

## Decision Rules

Keep heuristics conservative.

## References

Open references/skillsbench-authoring.md when needed.
`;

const BODY_PARENTHESIZED_HEADINGS = `# Skill Title

## Load Order (Required)

Read mstar-harness-core first.

### Workflow — main path

1. Parse the frontmatter.

## Decision Rules (SSOT)

Keep heuristics conservative.

## Evidence: success criteria

Zero violations.

## References and further reading

Open references/skillsbench-authoring.md when needed.
`;

/** Body answering all five questions via runtime alias headings only
 * (RUNTIME_HEADING_ALIASES): Load Order stays canonical (no alias exists
 * for it), Workflow → process, Decision Rules → hard rules, Evidence →
 * output format, References → dependencies. Fails authoring, passes runtime. */
const BODY_RUNTIME_ALIASES = `# Skill Title

## Load Order

Read mstar-harness-core first.

## Process

1. Parse the frontmatter.
2. Check the body sections.

## Hard Rules

Never flag prose-only skills; keep heuristics conservative.

## Output format

A passing lint gate with zero violations.

## Dependencies

Open references/skillsbench-authoring.md when a full loop is needed.
`;

// ---------------------------------------------------------------------------
// Corpus fixtures — the shipped mstar-* topic-skill pack (runtime mode)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SKILLS_ROOT = join(REPO_ROOT, "skills");

/** Skills excluded from runtime corpus lint: `mstar-harness-core` is exempt
 * by design (hub headings — plan constraint), `mstar-skill-authoring` is the
 * standard's own definition and always lints in authoring/strict mode. */
const CORPUS_EXCLUDED = new Set(["mstar-harness-core", "mstar-skill-authoring"]);

/** Every shipped runtime skill body: the `SKILL.md` under each
 * `skills/mstar-*` directory, minus the corpus exclusions, sorted by name. */
function runtimeCorpus(): Array<{ name: string; body: string }> {
  if (!existsSync(SKILLS_ROOT)) {
    throw new Error(`corpus test requires the repo skills/ tree (missing: ${SKILLS_ROOT})`);
  }
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mstar-") && !CORPUS_EXCLUDED.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      body: stripFrontmatter(readFileSync(join(SKILLS_ROOT, entry.name, "SKILL.md"), "utf8")),
    }));
}

// ---------------------------------------------------------------------------
// lintFrontmatter — reuses lint.lintSkillFrontmatter (single parser)
// ---------------------------------------------------------------------------

describe("lintFrontmatter", () => {
  test("valid frontmatter passes (lowercase-hyphen name + third-person trigger)", () => {
    expect(lintFrontmatter(FRONTMATTER_GOOD).ok).toBe(true);
  });

  test("uppercase name → name.format", () => {
    const result = lintFrontmatter(FRONTMATTER_UPPERCASE_NAME);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("lint.frontmatter.name.format");
  });

  test("underscore name → name.format", () => {
    const result = lintFrontmatter(FRONTMATTER_UNDERSCORE_NAME);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("lint.frontmatter.name.format");
  });

  test("missing name → name.missing", () => {
    const result = lintFrontmatter(FRONTMATTER_NO_NAME);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("lint.frontmatter.name.missing");
  });

  test("missing description → description.missing", () => {
    const result = lintFrontmatter(FRONTMATTER_NO_DESCRIPTION);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("lint.frontmatter.description.missing");
  });

  test("workflow-summary description → description.workflow (contract bad example)", () => {
    const result = lintFrontmatter(FRONTMATTER_WORKFLOW_SUMMARY);
    expect(result.ok).toBe(false);
    const v = result.violations.find((x) => x.code === "lint.frontmatter.description.workflow");
    expect(v).toBeDefined();
    expect(v?.message).toMatch(/workflow/i);
  });

  test("first/second-person description → description.person (third-person contract)", () => {
    const result = lintFrontmatter(FRONTMATTER_FIRST_PERSON);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("lint.frontmatter.description.person");
  });

  test("no frontmatter block → lint.frontmatter.missing", () => {
    const result = lintFrontmatter("# Just a heading\nSome prose.\n");
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("lint.frontmatter.missing");
  });
});

// ---------------------------------------------------------------------------
// lintFiveQuestion — presence of the key sections answering the 5 questions
// ---------------------------------------------------------------------------

describe("lintFiveQuestion", () => {
  test("complete default body passes", () => {
    expect(lintFiveQuestion(BODY_COMPLETE).ok).toBe(true);
  });

  test("missing Workflow → five-question.workflow", () => {
    const result = lintFiveQuestion(BODY_NO_WORKFLOW);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("skill-authoring.five-question.workflow");
  });

  test("missing Decision Rules → five-question.decision-rules", () => {
    const result = lintFiveQuestion(BODY_NO_DECISION_RULES);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("skill-authoring.five-question.decision-rules");
  });

  test("missing References → five-question.references", () => {
    const result = lintFiveQuestion(BODY_NO_REFERENCES);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("skill-authoring.five-question.references");
  });

  test("missing Load Order → five-question.load-order", () => {
    const result = lintFiveQuestion(BODY_NO_LOAD_ORDER);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("skill-authoring.five-question.load-order");
  });

  test("missing Evidence → five-question.evidence", () => {
    const result = lintFiveQuestion(BODY_NO_EVIDENCE);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("skill-authoring.five-question.evidence");
  });

  test("parenthesized / suffixed / deeper headings still match", () => {
    expect(lintFiveQuestion(BODY_PARENTHESIZED_HEADINGS).ok).toBe(true);
  });

  test("heading matching is case-insensitive", () => {
    const body = BODY_COMPLETE.replace(/## Load Order/, "## load order");
    expect(lintFiveQuestion(body).ok).toBe(true);
  });

  test("fenced fake headings never count as coverage (fence-aware, both modes)", () => {
    // A gitignore-style fence containing a `# Workflow ...` comment line must
    // not satisfy the workflow question — in either mode. The only in-fence
    // "heading" in the corpus was exactly this shape (mstar-conventions
    // gitignore snippet) and previously produced a false green.
    const body = `# Skill Title

## Load Order

Read core first.

## Decision Rules

Never break the gates.

## Evidence

A report.

## References

Open refs.

\`\`\`gitignore
# Workflow: run the pipeline in order.
\`\`\`
`;
    expect(lintFiveQuestion(body, "authoring").ok).toBe(false);
    const runtime = lintFiveQuestion(body, "runtime");
    expect(runtime.ok).toBe(false);
    expect(runtime.violations.map((v) => v.code)).toContain("skill-authoring.five-question.workflow");
  });

  test("~~~ fences are skipped too; real headings after the closing fence still count", () => {
    const body = `# Skill Title

## Load Order

\`\`\`
# Workflow inside backtick fence
\`\`\`

## Hard Rules

Never X.

## Output format

A report.

## Dependencies

Open refs.

~~~text
# Evidence inside tilde fence
~~~

## Workflow

1. Go.
`;
    expect(lintFiveQuestion(body, "runtime").ok).toBe(true);
  });

  test("empty body → all five questions uncovered", () => {
    const result = lintFiveQuestion("");
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual([
      "skill-authoring.five-question.load-order",
      "skill-authoring.five-question.workflow",
      "skill-authoring.five-question.decision-rules",
      "skill-authoring.five-question.evidence",
      "skill-authoring.five-question.references",
    ]);
  });

  test("default mode is authoring (canonical-only, unchanged 1-arg callers)", () => {
    // Runtime alias headings must NOT satisfy the default mode…
    expect(lintFiveQuestion(BODY_RUNTIME_ALIASES).ok).toBe(false);
    // …and must fail identically when passed explicitly.
    expect(lintFiveQuestion(BODY_RUNTIME_ALIASES, "authoring").ok).toBe(false);
    // Canonical headings satisfy both modes.
    expect(lintFiveQuestion(BODY_COMPLETE, "authoring").ok).toBe(true);
    expect(lintFiveQuestion(BODY_COMPLETE, "runtime").ok).toBe(true);
  });

  test("runtime mode accepts the locked alias headings; authoring rejects them", () => {
    const result = lintFiveQuestion(BODY_RUNTIME_ALIASES, "runtime");
    expect(result.ok).toBe(true);
  });

  test("runtime alias matching is case-insensitive (alias substrings, any level)", () => {
    const body = BODY_RUNTIME_ALIASES
      .replace(/## Output format/, "### output FORMAT")
      .replace(/## Hard Rules/, "## hard rules — locked")
      .replace(/## Dependencies/, "#### DEPENDENCIES");
    expect(lintFiveQuestion(body, "runtime").ok).toBe(true);
  });

  test("greenfield body without canonical headings still fails in BOTH modes", () => {
    // BODY_NO_EVIDENCE lacks Evidence and carries no alias heading for it:
    // authoring fails (canonical missing), runtime fails (no alias covers it).
    const authoring = lintFiveQuestion(BODY_NO_EVIDENCE, "authoring");
    const runtime = lintFiveQuestion(BODY_NO_EVIDENCE, "runtime");
    expect(authoring.ok).toBe(false);
    expect(runtime.ok).toBe(false);
    expect(runtime.violations.map((v) => v.code)).toContain("skill-authoring.five-question.evidence");
    // A canonical-less greenfield body (no canonical / no alias headings at
    // all) fails every question in runtime mode too — aliases do not weaken
    // "section present" into "any heading exists".
    const bare = "# Skill Title\n\n## Scope\n\nCovers lint checks.\n";
    const bareRuntime = lintFiveQuestion(bare, "runtime");
    expect(bareRuntime.ok).toBe(false);
    expect(bareRuntime.violations.map((v) => v.code)).toEqual([
      "skill-authoring.five-question.load-order",
      "skill-authoring.five-question.workflow",
      "skill-authoring.five-question.decision-rules",
      "skill-authoring.five-question.evidence",
      "skill-authoring.five-question.references",
    ]);
  });

  test("runtime mode does not skip load-order (no alias exists for it)", () => {
    // Workflow/decision-rules/evidence/references covered by aliases, but
    // load-order has no alias row — the question stays uncovered.
    const body = `# Skill Title

## Workflow

1. Go.

## Hard Rules

Never X.

## Output format

A report.

## Dependencies

Open references/x.md.
`;
    const result = lintFiveQuestion(body, "runtime");
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["skill-authoring.five-question.load-order"]);
  });

  test("alias table shape is locked (plan Step 2 verbatim rows)", () => {
    expect(RUNTIME_HEADING_ALIASES).toEqual({
      workflow: ["process", "playbook"],
      "decision-rules": ["hard rules", "core rules", "rule", "gate", "not to do", "red flags", "反模式", "红线", "规则", "门禁"],
      evidence: ["output format", "证据"],
      references: ["dependencies", "关系"],
    });
  });

  test("corpus: every shipped mstar-* runtime skill passes runtime-mode lint", () => {
    const corpus = runtimeCorpus();
    expect(corpus.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const { name, body } of corpus) {
      const result = lintFiveQuestion(body, "runtime");
      if (!result.ok) {
        failures.push(`${name}: ${result.violations.map((v) => v.code).join(", ")}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveAssetPath — skill-relative asset paths per host resolution table
// ---------------------------------------------------------------------------

describe("resolveAssetPath", () => {
  test("omp resolves to the skill:// URI", () => {
    expect(resolveAssetPath("my-skill", "scripts/do-thing", "omp")).toBe(
      "skill `my-skill` → scripts/do-thing (skill://my-skill/scripts/do-thing)",
    );
  });

  test("cursor resolves via the global plugin skills root", () => {
    expect(resolveAssetPath("my-skill", "scripts/do-thing", "cursor")).toBe(
      "skill `my-skill` → scripts/do-thing (~/.cursor/plugins/local/morning-star-harness/skills/my-skill/scripts/do-thing)",
    );
  });

  test("opencode resolves via the package-internal harness-skills root", () => {
    expect(resolveAssetPath("my-skill", "scripts/do-thing", "opencode")).toBe(
      "skill `my-skill` → scripts/do-thing (harness-skills/my-skill/scripts/do-thing)",
    );
  });

  test("codex resolves via the plugin-mounted skills root", () => {
    expect(resolveAssetPath("my-skill", "scripts/do-thing", "codex")).toBe(
      "skill `my-skill` → scripts/do-thing (skills/my-skill/scripts/do-thing)",
    );
  });

  test("kimi and zcode resolve via the plugin mount ./skills root", () => {
    const expected = "skill `my-skill` → scripts/do-thing (./skills/my-skill/scripts/do-thing)";
    expect(resolveAssetPath("my-skill", "scripts/do-thing", "kimi")).toBe(expected);
    expect(resolveAssetPath("my-skill", "scripts/do-thing", "zcode")).toBe(expected);
  });

  test("pi stays deferred; dsh resolves via the bundled skill-local root", () => {
    expect(resolveAssetPath("my-skill", "scripts/do-thing", "pi")).toMatch(/deferred/);
    expect(resolveAssetPath("my-skill", "scripts/do-thing", "dsh")).toBe(
      "skill `my-skill` → scripts/do-thing ($DSH_BUNDLED_SKILL_DIR/my-skill/scripts/do-thing)",
    );
  });

  test("references/ assets resolve the same way (progressive disclosure)", () => {
    expect(resolveAssetPath("mstar-skill-authoring", "references/skillsbench-authoring.md", "omp")).toBe(
      "skill `mstar-skill-authoring` → references/skillsbench-authoring.md (skill://mstar-skill-authoring/references/skillsbench-authoring.md)",
    );
  });
});
