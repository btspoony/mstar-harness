import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DocumentFrontmatterError } from "./document-frontmatter.js";
import { planFrontMatter } from "./plan-frontmatter.test-support.js";
import { PlanPathError, planDeclaredHeaders, planDeclaredHeadersFromContent, resolveRegisteredPlanFile } from "./plan-path.js";

const PLAN_ID = "20261125-plan-alpha";

function writePlanFile(content: string): { harnessRoot: string; planPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mstar-plan-path-test-"));
  const harnessRoot = join(root, ".mstar");
  const planDir = join(harnessRoot, "plans");
  mkdirSync(planDir, { recursive: true });
  const written = join(planDir, `${PLAN_ID}.md`);
  writeFileSync(written, content);
  const planPath = realpathSync(written);
  return { harnessRoot, planPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The shared renderer carries the valid-plan shape; this wrapper only names
// the branch values these tests assert on — the fence layout itself is never
// re-rendered locally.
function frontMatterPlan(bodyLines: string[] = []): string {
  return planFrontMatter(PLAN_ID, bodyLines.join("\n"), {
    main_worktree_branch: "feature/main-wt",
    working_branch: "feature/work",
  });
}

function refusalOf(run: () => unknown): PlanPathError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PlanPathError);
    return error as PlanPathError;
  }
  throw new Error("expected a PlanPathError refusal, none was thrown");
}

describe("planDeclaredHeadersFromContent", () => {
  test("a front-matter plan resolves all three consulted values", () => {
    const headers = planDeclaredHeadersFromContent(frontMatterPlan(), "diagnostic-label");
    expect(headers.get("plan_id")).toBe(PLAN_ID);
    expect(headers.get("main worktree branch")).toBe("feature/main-wt");
    expect(headers.get("working branch")).toBe("feature/work");
  });

  test("the raw lexeme is the declaration \u2014 `main_worktree_branch: 5.0` keeps its written spelling", () => {
    // CF-01 regression: the typed scalar `5` must never replace the branch
    // spelling `5.0`; a numeric-looking value keeps exactly what the file says.
    const content = ["---", `plan_id: ${PLAN_ID}`, "main_worktree_branch: 5.0", "working_branch: 2.0", "---", ""].join("\n");
    const headers = planDeclaredHeadersFromContent(content, "diagnostic-label");
    expect(headers.get("main worktree branch")).toBe("5.0");
    expect(headers.get("working branch")).toBe("2.0");
  });

  test("a non-scalar consulted declaration refuses identity-mismatch naming the invalid key", () => {
    // CF-02 regression: `main_worktree_branch: [other]` is present-but-invalid,
    // never dropped to the absent-key fallback.
    const content = ["---", `plan_id: ${PLAN_ID}`, "main_worktree_branch: [other]", "---", ""].join("\n");
    let error: unknown;
    try {
      planDeclaredHeadersFromContent(content, "my-plan.md");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlanPathError);
    expect((error as PlanPathError).code).toBe("plan-path.identity-mismatch");
    expect((error as PlanPathError).message).toContain("main_worktree_branch");
  });

  test("an unterminated front matter fence refuses identity-mismatch, never absent declarations", () => {
    // CF-02 regression: an opening fence without a closing one is invalid —
    // the declarations it swallows can never read as genuinely absent.
    const content = ["---", `plan_id: ${PLAN_ID}`, "main_worktree_branch: main", "# no closing fence"].join("\n");
    let error: unknown;
    try {
      planDeclaredHeadersFromContent(content, "my-plan.md");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlanPathError);
    expect((error as PlanPathError).code).toBe("plan-path.identity-mismatch");
    expect((error as PlanPathError).message).toContain("never closed");
  });

  test("a `**plan_id:**` line in the body with no front matter declares nothing", () => {
    const headers = planDeclaredHeadersFromContent(`# Plan\n\n**plan_id:** ${PLAN_ID}\n`, "diagnostic-label");
    expect(headers.get("plan_id")).toBeUndefined();
    expect(headers.size).toBe(0);
  });

  test("two different `plan_id` values in the body are never read and never refuse", () => {
    const headers = planDeclaredHeadersFromContent(
      frontMatterPlan([`**plan_id:** ${PLAN_ID}`, "", "**plan_id:** some-other-plan", ""]),
      "diagnostic-label",
    );
    expect(headers.get("plan_id")).toBe(PLAN_ID);
  });

  test("a `plan_id` twice in front matter refuses from the shared reader", () => {
    const content = ["---", `plan_id: ${PLAN_ID}`, `plan_id: ${PLAN_ID}`, "---", ""].join("\n");
    let error: unknown;
    try {
      planDeclaredHeadersFromContent(content, "diagnostic-label");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DocumentFrontmatterError);
    expect((error as Error).message).toContain("diagnostic-label");
  });

  test("a fenced example inside the body is never read", () => {
    const headers = planDeclaredHeadersFromContent(
      frontMatterPlan(["```", "**plan_id:** quoted-example", "```"]),
      "diagnostic-label",
    );
    expect(headers.get("plan_id")).toBe(PLAN_ID);
  });

  test("an unsupported front matter line propagates the reader error naming file:line", () => {
    const content = ["---", `plan_id: ${PLAN_ID}`, "*bad-alias-line", "---", ""].join("\n");
    let error: unknown;
    try {
      planDeclaredHeadersFromContent(content, "my-plan.md");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DocumentFrontmatterError);
    expect((error as DocumentFrontmatterError).source).toBe("my-plan.md");
    expect((error as DocumentFrontmatterError).line).toBeGreaterThan(1);
    expect((error as Error).message).toContain("my-plan.md:");
  });
});

describe("resolveRegisteredPlanFile", () => {
  test("target-mismatch refusal first line names both permitted forms", () => {
    const harnessRoot = mkdtempSync(join(tmpdir(), "mstar-plan-path-test-"));
    let message = "";

    try {
      resolveRegisteredPlanFile({ harnessRoot, planId: "sample-plan", file: "elsewhere/sample-plan.md" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    const firstLine = message.split("\n", 1)[0]!;
    expect(firstLine).toContain("permitted forms are canonical absolute path");
    expect(firstLine).toContain("normalized harness-relative path resolved against");
  });

  test("a front-matter plan resolves and its declared plan id is consumed", () => {
    const fixture = writePlanFile(frontMatterPlan());
    try {
      const resolved = resolveRegisteredPlanFile({ harnessRoot: fixture.harnessRoot, planId: PLAN_ID, file: fixture.planPath });
      expect(resolved.declaredPlanId).toBe(PLAN_ID);
      expect(resolved.planPath).toBe(fixture.planPath);
    } finally {
      fixture.cleanup();
    }
  });

  test("a plan with `**plan_id:**` in the body and no front matter refuses identity-mismatch", () => {
    const fixture = writePlanFile(`# Plan\n\n**plan_id:** ${PLAN_ID}\n`);
    try {
      const refusal = refusalOf(() =>
        resolveRegisteredPlanFile({ harnessRoot: fixture.harnessRoot, planId: PLAN_ID, file: fixture.planPath }),
      );
      expect(refusal.code).toBe("plan-path.identity-mismatch");
      expect(refusal.message).toContain("front matter");
    } finally {
      fixture.cleanup();
    }
  });

  test("a front matter `plan_id` differing from the pointer's plan id refuses identity-mismatch", () => {
    const fixture = writePlanFile(["---", "plan_id: some-other-plan", "---", ""].join("\n"));
    try {
      const refusal = refusalOf(() =>
        resolveRegisteredPlanFile({ harnessRoot: fixture.harnessRoot, planId: PLAN_ID, file: fixture.planPath }),
      );
      expect(refusal.code).toBe("plan-path.identity-mismatch");
    } finally {
      fixture.cleanup();
    }
  });

  test("malformed front matter propagates the reader error naming file:line", () => {
    const fixture = writePlanFile(["---", `plan_id: ${PLAN_ID}`, "*bad-alias-line", "---", ""].join("\n"));
    try {
      let error: unknown;
      try {
        resolveRegisteredPlanFile({ harnessRoot: fixture.harnessRoot, planId: PLAN_ID, file: fixture.planPath });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DocumentFrontmatterError);
      expect((error as DocumentFrontmatterError).source).toBe(fixture.planPath);
      expect((error as DocumentFrontmatterError).line).toBe(3);
      expect((error as Error).message).toContain(`${fixture.planPath}:3`);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("planDeclaredHeaders", () => {
  test("reads the same front matter map from the file bytes", () => {
    const fixture = writePlanFile(frontMatterPlan());
    try {
      const headers = planDeclaredHeaders(fixture.planPath);
      expect(headers.get("plan_id")).toBe(PLAN_ID);
      expect(headers.get("working branch")).toBe("feature/work");
    } finally {
      fixture.cleanup();
    }
  });
});
