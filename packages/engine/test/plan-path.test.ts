/**
 * Registered plan-path resolver — contract §4 of
 * `{SPECS_DIR}/prerequisite-identity-path-contract.md` (one plan-path
 * contract), enforced against `packages/engine/src/plan-path.ts`.
 *
 * Every fixture is a temporary harness root: no live `.mstar` state is read or
 * written. Cases cover both accepted input forms (canonical absolute /
 * harness-relative), the default and configured plan roots (including an
 * external plan root), and each refusal class the contract names — the
 * repository-relative spelling, foreign root, traversal, symlink escape,
 * missing file, directory, another plan's basename, a conflicting/unmatching
 * declaration, and a fenced example that only looks like a declaration.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanPathError, resolveRegisteredPlanFile } from "../src/plan-path.js";

const PLAN_ID = "20260921-plan-path-demo";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temporary repository root holding a harness at `<root>/harness`. */
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mstar-plan-path-"));
  roots.push(root);
  return root;
}

/** Create `dir` and write a plan markdown declaring `declaredPlanId`. */
function writePlan(dir: string, fileName: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, content, "utf8");
  return path;
}

/** A plan markdown whose only declaration is `plan_id`. */
function planMarkdown(planId: string, body = ""): string {
  return [`**plan_id:** ${planId}`, "", "# Plan body", body].join("\n");
}

/** The typed refusal a call must produce (never a bare `Error`). */
function refusalOf(run: () => unknown): PlanPathError {
  try {
    run();
  } catch (error) {
    if (error instanceof PlanPathError) return error;
    throw error;
  }
  throw new Error("expected a PlanPathError refusal, but the call succeeded");
}

describe("resolveRegisteredPlanFile — accepted forms", () => {
  test("resolves the default plan root from a canonical absolute path", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const planDir = join(harness, "plans");
    const planPath = writePlan(planDir, `${PLAN_ID}.md`, planMarkdown(PLAN_ID));

    const result = resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: planPath });

    expect(result).toEqual({
      planPath: realpathSync(planPath),
      planDir: realpathSync(planDir),
      declaredPlanId: PLAN_ID,
    });
  });

  test("resolves a harness-relative pointer against the harness root", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const planDir = join(harness, "plans");
    writePlan(planDir, `${PLAN_ID}.md`, planMarkdown(PLAN_ID));

    const result = resolveRegisteredPlanFile({
      harnessRoot: harness,
      planId: PLAN_ID,
      file: join("plans", `${PLAN_ID}.md`),
    });

    expect(result.planPath).toBe(join(realpathSync(planDir), `${PLAN_ID}.md`));
    expect(result.planDir).toBe(realpathSync(planDir));
    expect(result.declaredPlanId).toBe(PLAN_ID);
  });

  test("honours a .mstarc [config] plan_dir override (both input forms)", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    mkdirSync(harness, { recursive: true });
    writeFileSync(join(harness, ".mstarc"), "[config]\nplan_dir=planning\n", "utf8");
    const planDir = join(harness, "planning");
    const planPath = writePlan(planDir, `${PLAN_ID}.md`, planMarkdown(PLAN_ID));

    expect(resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: planPath }).planDir).toBe(
      realpathSync(planDir),
    );
    expect(
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: `planning/${PLAN_ID}.md` }).planPath,
    ).toBe(join(realpathSync(planDir), `${PLAN_ID}.md`));
  });

  test("honours an external plan root declared outside the harness", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const external = join(root, "external-plans");
    mkdirSync(harness, { recursive: true });
    writeFileSync(join(harness, ".mstarc"), `[config]\nplan_dir=${external}\n`, "utf8");
    const planPath = writePlan(external, `${PLAN_ID}.md`, planMarkdown(PLAN_ID));

    const result = resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: planPath });

    expect(result.planDir).toBe(realpathSync(external));
    expect(result.planPath).toBe(join(realpathSync(external), `${PLAN_ID}.md`));

    // A harness-relative spelling is resolved against the harness root only, so
    // the default plan directory name cannot reach the external root.
    const refusal = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: `plans/${PLAN_ID}.md` }),
    );
    expect(refusal.code).toBe("plan-path.invalid-pointer");
  });

  test("a fenced example mentioning plan_id is not a declaration", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const planDir = join(harness, "plans");
    const content = [
      "# Plan",
      "",
      "Example of the header, inside a longer fence:",
      "",
      "````markdown",
      "```",
      `**plan_id:** 99999999-not-the-plan`,
      "```",
      "````",
      "",
      "And a tilde fence:",
      "",
      "~~~",
      "**plan_id:** 88888888-also-not-the-plan",
      "~~~",
      "",
      planMarkdown(PLAN_ID),
    ].join("\n");
    const planPath = writePlan(planDir, `${PLAN_ID}.md`, content);

    const result = resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: planPath });

    expect(result.declaredPlanId).toBe(PLAN_ID);
  });

  test("accepts the bold-colon-outside and plain header spellings", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const planDir = join(harness, "plans");
    writePlan(planDir, `${PLAN_ID}.md`, ["**plan_id**: " + PLAN_ID, "", "# Plan"].join("\n"));

    expect(resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: `plans/${PLAN_ID}.md` }).declaredPlanId).toBe(
      PLAN_ID,
    );
  });
});

describe("resolveRegisteredPlanFile — refusals", () => {
  test("refuses the repository-relative .mstar/plans spelling", () => {
    const root = tmpRoot();
    const harness = join(root, ".mstar");
    const planDir = join(harness, "plans");
    writePlan(planDir, `${PLAN_ID}.md`, planMarkdown(PLAN_ID));

    const refusal = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: `.mstar/plans/${PLAN_ID}.md` }),
    );

    expect(refusal.code).toBe("plan-path.invalid-pointer");
    expect(refusal.details.expected).toBe(join(realpathSync(planDir), `${PLAN_ID}.md`));
    expect(refusal.details.received).toBe(`.mstar/plans/${PLAN_ID}.md`);
  });

  test("refuses a same-named plan file under a foreign root", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const planDir = join(harness, "plans");
    writePlan(planDir, `${PLAN_ID}.md`, planMarkdown(PLAN_ID));
    const foreign = writePlan(join(root, "elsewhere"), `${PLAN_ID}.md`, planMarkdown(PLAN_ID));

    const refusal = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: foreign }),
    );

    expect(refusal.code).toBe("plan-path.invalid-pointer");
    expect(refusal.details.form).toBe("canonical-absolute");
    expect((refusal.details.permitted as string[]).length).toBe(2);
  });

  test("refuses traversal even when the destination holds a matching plan", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    // The decoy is a valid plan with the right declaration, so only the path
    // equality check can refuse it.
    writePlan(join(harness, "plans"), `${PLAN_ID}.md`, planMarkdown(PLAN_ID));
    writePlan(join(root, "plans"), `${PLAN_ID}.md`, planMarkdown(PLAN_ID));

    const refusal = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: `../plans/${PLAN_ID}.md` }),
    );

    expect(refusal.code).toBe("plan-path.invalid-pointer");
    expect(refusal.details.base).toBe(realpathSync(harness));
    expect(refusal.details.actual).toBe(join(realpathSync(root), "plans", `${PLAN_ID}.md`));
  });

  test("refuses a symlink at the registered path that escapes the plan root", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const planDir = join(harness, "plans");
    mkdirSync(planDir, { recursive: true });
    const outside = writePlan(join(root, "outside"), `${PLAN_ID}.md`, planMarkdown(PLAN_ID));
    symlinkSync(outside, join(planDir, `${PLAN_ID}.md`));

    const refusal = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: join(planDir, `${PLAN_ID}.md`) }),
    );

    expect(refusal.code).toBe("plan-path.invalid-pointer");
    expect(refusal.details.actual).toBe(realpathSync(outside));
  });

  test("refuses a missing plan file and a directory at the registered path", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const planDir = join(harness, "plans");
    mkdirSync(planDir, { recursive: true });

    const missing = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: join(planDir, `${PLAN_ID}.md`) }),
    );
    expect(missing.code).toBe("plan-path.not-a-file");

    mkdirSync(join(planDir, `${PLAN_ID}.md`));
    const directory = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: join(planDir, `${PLAN_ID}.md`) }),
    );
    expect(directory.code).toBe("plan-path.not-a-file");
  });

  test("refuses another plan's basename", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const planDir = join(harness, "plans");
    writePlan(planDir, `${PLAN_ID}.md`, planMarkdown(PLAN_ID));
    const other = writePlan(planDir, "20260920-some-other-plan.md", planMarkdown("20260920-some-other-plan"));

    const refusal = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: other }),
    );

    expect(refusal.code).toBe("plan-path.invalid-pointer");
  });

  test("refuses a plan id that is not a single safe path component", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    writePlan(join(harness, "plans"), `${PLAN_ID}.md`, planMarkdown(PLAN_ID));

    const refusal = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: `../${PLAN_ID}`, file: `plans/${PLAN_ID}.md` }),
    );

    expect(refusal.code).toBe("plan-path.invalid-pointer");
  });

  test("refuses a declaration that names another plan or none at all", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const planDir = join(harness, "plans");
    writePlan(planDir, `${PLAN_ID}.md`, planMarkdown("19990101-different-plan"));
    const mismatch = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: `plans/${PLAN_ID}.md` }),
    );
    expect(mismatch.code).toBe("plan-path.identity-mismatch");
    expect(mismatch.details.actual).toBe("19990101-different-plan");

    writePlan(planDir, `${PLAN_ID}.md`, "# Plan with no declaration\n");
    expect(
      refusalOf(() => resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: `plans/${PLAN_ID}.md` })).code,
    ).toBe("plan-path.identity-mismatch");
  });

  test("refuses conflicting plan_id declarations instead of picking one", () => {
    const root = tmpRoot();
    const harness = join(root, "harness");
    const planDir = join(harness, "plans");
    writePlan(
      planDir,
      `${PLAN_ID}.md`,
      [`**plan_id:** ${PLAN_ID}`, "", `plan_id: 19990101-different-plan`, "", "# Plan"].join("\n"),
    );

    const refusal = refusalOf(() =>
      resolveRegisteredPlanFile({ harnessRoot: harness, planId: PLAN_ID, file: `plans/${PLAN_ID}.md` }),
    );

    expect(refusal.code).toBe("plan-path.conflicting-declaration");
    expect(refusal.details.header).toBe("plan_id");
    // The pointer diagnostic still accompanies the reader's own detail.
    expect(refusal.details.received).toBe(`plans/${PLAN_ID}.md`);
  });
});
