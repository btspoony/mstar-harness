/**
 * `lint` over the two document layers (`mstar-artifacts/references/
 * knowledge-and-designs.md`): `--type specs` / `--type adr`, a directory
 * target running the tree check, a file target running one document's check,
 * and the refusal envelope a violating fixture earns.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InvocationContext } from "../types.js";
import { getCommandDefinitions } from "../definitions.js";

function invocation(cwd: string): InvocationContext {
  return {
    cwd,
    controlRoot: null,
    versions: { engine: null, cli: "test", plugin: null, host: null, platform: "test" },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { throw new Error("unused"); },
      async startDashboard() { throw new Error("unused"); },
      async openBrowser() { throw new Error("unused"); },
      writeStderr() {},
    },
  };
}

function lintDefinition() {
  const definition = getCommandDefinitions().find(({ id }) => id === "lint");
  if (definition === undefined) throw new Error("missing lint definition");
  return definition;
}

async function runLint(cwd: string, input: Record<string, unknown>) {
  const definition = lintDefinition();
  return definition.execute(definition.input.parse(input), invocation(cwd));
}

/** Write `files` (relative path -> text) under a fresh temp root. */
function withTree<T>(files: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lint-command-"));
  const done = async (): Promise<T> => {
    try {
      for (const [rel, text] of Object.entries(files)) {
        const target = join(dir, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
      return await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return done();
}

const SPEC = `# Store authority

## Scope

The control-root store.

## Current state

One SQLite file.

## Invariants

Writes go through the domain verbs.

## Where it lives

\`packages/engine/src/store.ts\`

## Change obligations

Update in the same PR as a schema change.
`;

const ADR = `# ADR: Example

Status: implemented \u2014 because

## Problem

Text.

## Decision

Text.

## Alternatives considered

Text.

## Consequences

Text.
`;

const SPECS_README = `# Specs\n\n| Page | Topic |\n|---|---|\n| [store](architecture/store.md) | store |\n`;

describe("lint --type specs|adr — known types", () => {
  test("the usage string lists both document layers", async () => {
    const result = await runLint(tmpdir(), { target: "x", type: "nope" });
    if (result.status !== "usage") throw new Error(`expected a usage envelope, got ${result.status}`);
    expect(result.message).toContain("specs");
    expect(result.message).toContain("adr");
  });

  test("the definition description names both document layers", () => {
    expect(lintDefinition().description).toContain("specs");
    expect(lintDefinition().description).toContain("adr");
  });
});

describe("lint --type specs", () => {
  test("a directory target runs the tree check and passes on an indexed tree", async () => {
    const result = await withTree(
      { "specs/README.md": SPECS_README, "specs/architecture/store.md": SPEC },
      (dir) => runLint(dir, { target: "specs", type: "specs" }),
    );
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  test("a file target checks one document and refuses a version suffix", async () => {
    const result = await withTree(
      { "specs/architecture/store-v2.md": SPEC },
      (dir) => runLint(dir, { target: "specs/architecture/store-v2.md", type: "specs" }),
    );
    expect(result.status).toBe("refused");
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result.details)).toContain("lint.specs.name-shape");
  });

  test("the refusal carries the rerun recovery and per-file results", async () => {
    const result = await withTree(
      { "specs/architecture/store.md": "# Store\n" },
      (dir) => runLint(dir, { target: "specs", type: "specs" }),
    );
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result.details)).toContain("rerun mstar lint");
    const data = result.details as { results: Array<{ file: string; violations: unknown[] }> };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]!.violations.length).toBeGreaterThan(0);
  });
});

/**
 * Run any validation verb with an explicit control root (the resolver's harness anchor).
 * see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
 */
async function runVerb(id: string, cwd: string, input: Record<string, unknown>, controlRoot: string | null = null) {
  const definition = getCommandDefinitions().find((command) => command.id === id);
  if (definition === undefined) throw new Error(`missing ${id} definition`);
  return definition.execute(definition.input.parse(input), { ...invocation(cwd), controlRoot });
}

const EXECUTION_MODE_DOC = `---
execute_as: qc-specialist
delegation: forbidden
task_category: logic
execution_mode: sdd
---

## Task

Review the diff.
`;

const alignmentDoc = (planId: string): string => `---
plan_id: ${planId}
review_range: ac6bda660..HEAD
diff_basis: git
---

## Task

Review.
`;

describe("assignment files resolve through the ONE source resolver", () => {
  test("review seats reads the POINTED document's execution_mode (a pointer is not an empty mode)", async () => {
    const root = mkdtempSync(join(tmpdir(), "assign-source-"));
    try {
      const harness = join(root, ".mstar");
      mkdirSync(join(harness, "assignments"), { recursive: true });
      const document = join(harness, "assignments", "exec.md");
      writeFileSync(document, EXECUTION_MODE_DOC);
      const input = join(root, "input.md");
      writeFileSync(input, `Assignment file: ${document}\n`);

      const envelope = await runVerb("review.seats", root, { assignmentFile: input }, harness);
      expect(envelope.status).toBe("ok");
      if (envelope.status !== "ok") return;
      expect((envelope.data as { mode: string }).mode).toBe("sdd");
      expect((envelope.data as { n: number }).n).toBe(3);

      // The pointer line itself declares no execution mode: reading the file
      // bytes without the resolver answers "" and refuses the verb.
      // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
      const bare = await runVerb("review.seats", root, { assignmentFile: input }, null);
      expect(bare.status).toBe("refused");
      expect(bare.code).toBe("dispatch.assignment.path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("worktree qc-alignment aligns the POINTED documents", async () => {
    const root = mkdtempSync(join(tmpdir(), "assign-align-"));
    try {
      const harness = join(root, ".mstar");
      mkdirSync(join(harness, "assignments"), { recursive: true });
      const writePointer = (name: string, text: string): string => {
        const document = join(harness, "assignments", `${name}.md`);
        writeFileSync(document, text);
        const input = join(root, `${name}-input.md`);
        writeFileSync(input, `Assignment file: ${document}\n`);
        return input;
      };
      const first = writePointer("qc1", alignmentDoc("20261125-demo"));
      const second = writePointer("qc2", alignmentDoc("20261125-demo"));

      const aligned = await runVerb("worktree.qc-alignment", root, { files: [first, second] }, harness);
      expect(aligned.status).toBe("ok");

      const divergent = writePointer("qc3", alignmentDoc("20261125-other"));
      const mismatch = await runVerb("worktree.qc-alignment", root, { files: [first, divergent] }, harness);
      expect(mismatch.status).toBe("refused");
      expect(JSON.stringify(mismatch.details)).toContain("qc.alignment.mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("worktree qc-alignment names a duplicate key instead of three missing fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "assign-align-dup-"));
    try {
      const harness = join(root, ".mstar");
      mkdirSync(join(harness, "assignments"), { recursive: true });
      const document = join(harness, "assignments", "dup.md");
      writeFileSync(document, `---\nplan_id: 20261125-demo\nplan_id: 20261125-other\nreview_range: ac6bda660..HEAD\ndiff_basis: git\n---\n\n## Task\n\nReview.\n`);

      const duplicate = await runVerb("worktree.qc-alignment", root, { files: [document] }, harness);

      expect(duplicate.status).toBe("refused");
      // The repeated key blocks the read; reporting plan_id/review_range/
      // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
      // diff_basis as missing would send the caller after the wrong defect.
      // The message names the RESOLVED source (pointer target included) and
      // its line, so the caller can open the defective document directly.
      expect(duplicate).toMatchObject({ code: "qc.alignment.field.duplicate" });
      if (duplicate.status === "refused") {
        expect(duplicate.message).toContain("duplicate");
        expect(duplicate.message).toContain(`${document}:3:`);
      }

      // A genuinely absent field still reports as missing.
      // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
      const absent = join(harness, "assignments", "absent.md");
      writeFileSync(absent, `---\nplan_id: 20261125-demo\n---\n\n## Task\n\nReview.\n`);
      const missing = await runVerb("worktree.qc-alignment", root, { files: [absent] }, harness);
      expect(missing).toMatchObject({ code: "qc.alignment.field.missing" });
      // The missing-field row also names the file it belongs to.
      // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
      if (missing.status === "refused") expect(missing.message).toContain(`${absent}: missing`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("worktree qc-alignment reports a malformed front matter as itself, naming the source and line", async () => {
    const root = mkdtempSync(join(tmpdir(), "assign-align-bad-"));
    try {
      const harness = join(root, ".mstar");
      mkdirSync(join(harness, "assignments"), { recursive: true });
      // A line outside the accepted subset is the document's real defect: the
      // three alignment keys are present, so reporting them missing would send
      // the caller after the wrong problem.
      // see docs/knowledge/conventions/plan-frontmatter-declarations.md
      const document = join(harness, "assignments", "bad.md");
      writeFileSync(document, `---\nplan_id: 20261125-demo\nreview_range: ac6bda660..HEAD\ndiff_basis: git\nbad line here\n---\n\n## Task\n\nReview.\n`);

      const malformed = await runVerb("worktree.qc-alignment", root, { files: [document] }, harness);
      expect(malformed).toMatchObject({ code: "qc.alignment.field.malformed" });
      if (malformed.status === "refused") {
        expect(malformed.message).toContain(`${document}:5:`);
        expect(malformed.message).toContain("not a key: line");
      }

      // A present-but-non-scalar key is invalid, not absent: dispatch refuses
      // the same shape, so aligning on a block scalar's text would pass a pack
      // the next gate rejects.
      // see docs/knowledge/conventions/plan-frontmatter-declarations.md
      const blocked = join(harness, "assignments", "blocked.md");
      writeFileSync(blocked, `---\nplan_id: |\n  the-plan\nreview_range: ac6bda660..HEAD\ndiff_basis: git\n---\n`);
      const shape = await runVerb("worktree.qc-alignment", root, { files: [blocked] }, harness);
      expect(shape).toMatchObject({ code: "qc.alignment.field.malformed" });
      if (shape.status === "refused") expect(shape.message).toContain(`${blocked}:2: invalid plan_id`);

      // A bare `key:` declares nothing, so it reads as missing — not invalid.
      // see docs/knowledge/conventions/plan-frontmatter-declarations.md
      const bare = join(harness, "assignments", "bare.md");
      writeFileSync(bare, `---\nplan_id:\nreview_range: ac6bda660..HEAD\ndiff_basis: git\n---\n`);
      const bareResult = await runVerb("worktree.qc-alignment", root, { files: [bare] }, harness);
      expect(bareResult).toMatchObject({ code: "qc.alignment.field.missing" });

      // An opening fence that never closes is invalid, not absent.
      // see docs/knowledge/conventions/plan-frontmatter-declarations.md
      const unterminated = join(harness, "assignments", "open.md");
      writeFileSync(unterminated, `---\nplan_id: 20261125-demo\nreview_range: ac6bda660..HEAD\ndiff_basis: git\n\n## Task\n\nReview.\n`);
      const open = await runVerb("worktree.qc-alignment", root, { files: [unterminated] }, harness);
      expect(open).toMatchObject({ code: "qc.alignment.field.malformed" });
      if (open.status === "refused") expect(open.message).toContain(`${unterminated}:1:`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("worktree qc-alignment reads plan_id from the RAW lexeme, never the typed scalar", async () => {
    const root = mkdtempSync(join(tmpdir(), "assign-align-num-"));
    try {
      const harness = join(root, ".mstar");
      mkdirSync(join(harness, "assignments"), { recursive: true });
      // `5.0` is the id spelling: the typed scalar would read `5`, and the
      // typed `20261125` would lose nothing while `5.0` loses its decimal.
      // see docs/knowledge/conventions/plan-frontmatter-declarations.md
      const document = join(harness, "assignments", "num.md");
      writeFileSync(document, `---\nplan_id: 5.0\nreview_range: ac6bda660..HEAD\ndiff_basis: git\n---\n\n## Task\n\nReview.\n`);

      const result = await runVerb("worktree.qc-alignment", root, { files: [document] }, harness);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect((result.data as { assignments: { planId: string }[] }).assignments[0]!.planId).toBe("5.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("worktree qc-alignment names every unreadable file, not just the first", async () => {
    const root = mkdtempSync(join(tmpdir(), "assign-align-many-"));
    try {
      const harness = join(root, ".mstar");
      mkdirSync(join(harness, "assignments"), { recursive: true });
      const first = join(harness, "assignments", "dup-a.md");
      const second = join(harness, "assignments", "dup-b.md");
      writeFileSync(first, `---\nplan_id: a\nplan_id: b\nreview_range: r\ndiff_basis: d\n---\n`);
      writeFileSync(second, `---\nplan_id: a\nplan_id: b\nreview_range: r\ndiff_basis: d\n---\n`);

      const result = await runVerb("worktree.qc-alignment", root, { files: [first, second] }, harness);
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      // Both defects survive the refusal: a tri pack's two broken documents
      // are two fixes, and only the first would be found on a rerun.
      // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
      const failures = result.details?.failures;
      expect(Array.isArray(failures)).toBe(true);
      if (!Array.isArray(failures)) return;
      expect(failures).toHaveLength(2);
      expect(JSON.stringify(failures[0])).toContain(first);
      expect(JSON.stringify(failures[1])).toContain(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const ACCEPTANCE_REPORT = `---
plan_id: 20261125-demo
gate: pm-acceptance
verdict: Approve
generated_at: 2026-11-26T08:00:00Z
---

# PM Acceptance Report

## Scope
`;

describe("lint --type acceptance", () => {
  test("the definition description names the acceptance type", () => {
    expect(lintDefinition().description).toContain("acceptance");
  });

  test("a complete acceptance report passes", async () => {
    const result = await withTree(
      { "review/pm-acceptance.md": ACCEPTANCE_REPORT },
      (dir) => runLint(dir, { target: "review/pm-acceptance.md", type: "acceptance" }),
    );
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  test("a missing gate reports lint.acceptance.frontmatter.missing", async () => {
    const result = await withTree(
      { "review/pm-acceptance.md": ACCEPTANCE_REPORT.replace("gate: pm-acceptance\n", "") },
      (dir) => runLint(dir, { target: "review/pm-acceptance.md", type: "acceptance" }),
    );
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result.details)).toContain("lint.acceptance.frontmatter.missing");
  });

  test("gate: qc reports invalid", async () => {
    const result = await withTree(
      { "review/pm-acceptance.md": ACCEPTANCE_REPORT.replace("gate: pm-acceptance", "gate: qc") },
      (dir) => runLint(dir, { target: "review/pm-acceptance.md", type: "acceptance" }),
    );
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result.details)).toContain("lint.acceptance.frontmatter.invalid");
  });

  test("verdict: okay reports the accepted enum", async () => {
    const result = await withTree(
      { "review/pm-acceptance.md": ACCEPTANCE_REPORT.replace("verdict: Approve", "verdict: okay") },
      (dir) => runLint(dir, { target: "review/pm-acceptance.md", type: "acceptance" }),
    );
    expect(result.status).toBe("refused");
    const details = JSON.stringify(result.details);
    expect(details).toContain("lint.acceptance.frontmatter.invalid");
    expect(details).toContain("Approve with residuals");
  });

  test("a directory target is refused, naming the report file", async () => {
    const result = await withTree(
      { "review/pm-acceptance.md": ACCEPTANCE_REPORT.replace("gate: pm-acceptance\n", "") },
      (dir) => runLint(dir, { target: "review", type: "acceptance" }),
    );
    expect(result.status).toBe("usage");
    if (result.status !== "usage") throw new Error(`expected a usage envelope, got ${result.status}`);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("--type acceptance");
    expect(result.message).toContain("report file");
  });

  test("the refusal recovery keeps the type that selected the check", async () => {
    const result = await withTree(
      { "review/pm-acceptance.md": ACCEPTANCE_REPORT.replace("gate: pm-acceptance\n", "") },
      (dir) => runLint(dir, { target: "review/pm-acceptance.md", type: "acceptance" }),
    );
    expect(result.status).toBe("refused");
    // pm-acceptance.md is not auto-detected, so a recovery without the flag
    // would rerun a different check.
    // see docs/knowledge/conventions/brief-acceptance-declarations.md
    expect(result.details?.recovery).toContain("--type acceptance");
    expect(JSON.stringify(result.details)).toContain("lint.acceptance.frontmatter.missing");
  });
});

describe("lint --type adr", () => {
  test("a directory target runs the tree check and passes on a valid tree", async () => {
    const result = await withTree(
      { "adr/implemented/architecture/2026-01-01-example.md": ADR },
      (dir) => runLint(dir, { target: "adr", type: "adr" }),
    );
    expect(result.status).toBe("ok");
  });

  test("an archived record without an Archived: line is refused", async () => {
    const result = await withTree(
      { "adr/archived/architecture/2026-01-02-old.md": ADR },
      (dir) => runLint(dir, { target: "adr", type: "adr" }),
    );
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result.details)).toContain("lint.adr.archive-line-missing");
  });

  test("a file target checks that record, and a path outside {bucket}/{class}/ is a usage error", async () => {
    const inside = await withTree(
      { "adr/rejected/architecture/2026-01-03-moved.md": ADR },
      (dir) => runLint(dir, { target: "adr/rejected/architecture/2026-01-03-moved.md", type: "adr" }),
    );
    expect(inside.status).toBe("refused");
    expect(JSON.stringify(inside.details)).toContain("lint.adr.status-mismatch");

    const outside = await withTree(
      { "notes/2026-01-04-loose.md": ADR },
      (dir) => runLint(dir, { target: "notes/2026-01-04-loose.md", type: "adr" }),
    );
    expect(outside.status).toBe("usage");

    const bucketRoot = await withTree(
      { "adr/proposed/TEMPLATE.md": ADR },
      (dir) => runLint(dir, { target: "adr/proposed/TEMPLATE.md", type: "adr" }),
    );
    expect(bucketRoot.status).toBe("usage");
  });
});
