/**
 * Engine path module — harness dir / specs dir / plan dir resolution,
 * scaffold, canonical .gitignore snippet, plan-writing path gate.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - `{HARNESS_DIR}` resolution order + `{PLAN_DIR}` composition:
 *   `skills/mstar-plan-conventions/SKILL.md` § 路径符号 +
 *   § {HARNESS_DIR} 解析顺序（找到即停）— `.mstar/` → `.agents/` →
 *   `.plans/`/`plans/` (rung 3: `{HARNESS_DIR}={PLAN_DIR}`); harness
 *   candidates are dir-existence (the empty-dir rule applies to SPECS only).
 * - `{SPECS_DIR}` resolution (first non-empty candidate wins, empty-dir-as-
 *   absent, default-create `{HARNESS_DIR}/specs/` when all absent; legacy
 *   read-only `designs/` candidates `{HARNESS_DIR}/designs/` → repo-root
 *   `designs/` — 兼容读, never created by init):
 *   `skills/mstar-plan-conventions/SKILL.md` § {SPECS_DIR} 解析（找到非空目录即停）
 *   + § {SPECS_DIR} 解析 Legacy.
 * - Scaffold dirs + status.json empty template:
 *   `skills/mstar-plan-conventions/SKILL.md` § 初始化 Plan 目录 +
 *   `skills/mstar-plan-artifacts/templates/status.empty.json` (embedded as a
 *   constant — engine must not read skill files at runtime, roadmap §8.5).
 * - Canonical `.gitignore` snippet + tracked/ignored sets:
 *   `skills/mstar-plan-conventions/SKILL.md` § Git 跟踪策略.
 * - Plan-writing path gate: `skills/mstar-plan-conventions/SKILL.md`
 *   § Plan-Writing Path Gate — plans live under `{PLAN_DIR}`, no external
 *   default plan directories.
 * - Explicit harness-root override (`MSTAR_HARNESS_DIR` env / option):
 *   plan 20260808-slice2-sdd-iteration Finding (2026-08-08) — default probe
 *   stays per mstar-plan-conventions; `.harness` is NOT added to the probe
 *   (consumer convention stays `.mstar` → `.agents` → `.plans`/`plans`).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertPlanWritingPath,
  assertSafePathComponent,
  emitGitignoreSnippet,
  resolveHarnessDir,
  resolveIterationDir,
  resolvePlanDir,
  resolveSddDir,
  resolveSpecsDir,
  scaffoldHarness,
  validateGitignore,
} from "../src/path.js";

const ENV_KEY = "MSTAR_HARNESS_DIR";

/** Canonical snippet text — verbatim from plan-conventions § Git 跟踪策略. */
const CANONICAL_SNIPPET = `# Morning Star harness (.mstar/)
# Principle: process stays local; results are shared with the team.
# Ignored (process / coordination):
.mstar/archived/
.mstar/iterations/
.mstar/plans/
.mstar/sdd/
.mstar/notes.json
.mstar/status.json
# Tracked (results): .mstar/AGENTS.md, .mstar/knowledge/, .mstar/specs/
`;

/** Legacy snippet text — verbatim from plan-conventions § Git 跟踪策略 ("Legacy `.agents/` 等价"). */
const CANONICAL_SNIPPET_AGENTS = `# Morning Star harness (.agents/) — legacy
.agents/archived/
.agents/iterations/
.agents/plans/
.agents/sdd/
.agents/notes.json
.agents/status.json
# Tracked (results): .agents/AGENTS.md, .agents/knowledge/, .agents/specs/
`;

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Monorepo root (walk up from this test dir to the nearest ancestor holding
 * `skills/`), for byte-parity tests against the skill SSOT files (qc3 F-5).
 */
function findRepoRoot(): string {
  let dir = import.meta.dir;
  for (;;) {
    if (existsSync(join(dir, "skills")) && existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not locate the monorepo root from the test dir");
    dir = parent;
  }
}

/** Extract the Nth ```gitignore fence from a skill file. */
function gitignoreFence(skillPath: string, fenceIndex: number): string {
  const content = readFileSync(skillPath, "utf8");
  const blocks = [...content.matchAll(/```gitignore\n([\s\S]*?)```/g)];
  const block = blocks[fenceIndex];
  if (block === undefined) throw new Error(`no gitignore fence ${fenceIndex} in ${skillPath}`);
  return block[1];
}

function withEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  }
}

describe("resolveHarnessDir — resolution order (plan-conventions § {HARNESS_DIR} 解析顺序)", () => {
  test("finds `.mstar` by dir-existence even when the dir is empty", () => {
    const root = tmpRoot("path-harness-mstar-");
    try {
      mkdirSync(join(root, ".mstar"));
      expect(resolveHarnessDir(root)).toBe(resolve(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to `.agents` (legacy) when `.mstar` is absent", () => {
    const root = tmpRoot("path-harness-agents-");
    try {
      mkdirSync(join(root, ".agents"));
      expect(resolveHarnessDir(root)).toBe(resolve(root, ".agents"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts legacy `.plans` when `.mstar` and `.agents` are absent", () => {
    const root = tmpRoot("path-harness-dotplans-");
    try {
      mkdirSync(join(root, ".plans"));
      expect(resolveHarnessDir(root)).toBe(resolve(root, ".plans"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts legacy `plans` when `.mstar`, `.agents`, `.plans` are absent", () => {
    const root = tmpRoot("path-harness-plans-");
    try {
      mkdirSync(join(root, "plans"));
      expect(resolveHarnessDir(root)).toBe(resolve(root, "plans"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prefers `.mstar` over coexisting `.agents` / `.plans` / `plans`", () => {
    const root = tmpRoot("path-harness-priority-");
    try {
      for (const dir of [".mstar", ".agents", ".plans", "plans"]) mkdirSync(join(root, dir));
      expect(resolveHarnessDir(root)).toBe(resolve(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("walks up from a nested startDir to the first match", () => {
    const root = tmpRoot("path-harness-walkup-");
    try {
      mkdirSync(join(root, ".mstar"));
      const nested = join(root, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      expect(resolveHarnessDir(nested)).toBe(resolve(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null when no candidate exists up the tree", () => {
    const root = tmpRoot("path-harness-none-");
    try {
      expect(resolveHarnessDir(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not probe `.harness` (consumer convention stays per plan-conventions)", () => {
    const root = tmpRoot("path-harness-noharness-");
    try {
      mkdirSync(join(root, ".harness"));
      expect(resolveHarnessDir(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveHarnessDir — explicit override (slice-2 finding 2026-08-08)", () => {
  test("opts.harnessDir overrides default probing", () => {
    const root = tmpRoot("path-harness-opt-");
    try {
      mkdirSync(join(root, ".mstar"));
      mkdirSync(join(root, "custom"));
      expect(resolveHarnessDir(root, { harnessDir: "custom" })).toBe(resolve(root, "custom"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absolute opts.harnessDir is used as-is", () => {
    const root = tmpRoot("path-harness-optabs-");
    try {
      const custom = join(root, "custom");
      mkdirSync(custom);
      expect(resolveHarnessDir(root, { harnessDir: custom })).toBe(custom);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns the override path even when it does not exist (authoritative)", () => {
    const root = tmpRoot("path-harness-optnew-");
    try {
      const custom = join(root, "not-yet-created");
      expect(resolveHarnessDir(root, { harnessDir: custom })).toBe(custom);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MSTAR_HARNESS_DIR env overrides default probing", () => {
    const root = tmpRoot("path-harness-env-");
    try {
      mkdirSync(join(root, ".mstar"));
      const custom = join(root, "env-harness");
      withEnv(custom, () => {
        expect(resolveHarnessDir(root)).toBe(custom);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opts.harnessDir wins over MSTAR_HARNESS_DIR env", () => {
    const root = tmpRoot("path-harness-envopt-");
    try {
      const envDir = join(root, "env-harness");
      const optDir = join(root, "opt-harness");
      withEnv(envDir, () => {
        expect(resolveHarnessDir(root, { harnessDir: optDir })).toBe(optDir);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unset env does not affect default probing", () => {
    const root = tmpRoot("path-harness-envunset-");
    try {
      mkdirSync(join(root, ".mstar"));
      withEnv(undefined, () => {
        expect(resolveHarnessDir(root)).toBe(resolve(root, ".mstar"));
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolvePlanDir / resolveSddDir / resolveIterationDir (plan-conventions § 路径符号)", () => {
  test("resolvePlanDir composes {HARNESS_DIR}/plans for .mstar and .agents", () => {
    expect(resolvePlanDir(join("/r", ".mstar"))).toBe(join("/r", ".mstar", "plans"));
    expect(resolvePlanDir(join("/r", ".agents"))).toBe(join("/r", ".agents", "plans"));
  });

  test("resolvePlanDir returns the legacy plans dir itself when the harness root is `.plans` or `plans` (rung 3: {HARNESS_DIR}={PLAN_DIR})", () => {
    expect(resolvePlanDir(join("/r", ".plans"))).toBe(join("/r", ".plans"));
    expect(resolvePlanDir(join("/r", "plans"))).toBe(join("/r", "plans"));
  });

  test("resolveSddDir composes {HARNESS_DIR}/sdd/<plan-id>", () => {
    expect(resolveSddDir(join("/r", ".mstar"), "20260808-p1")).toBe(join("/r", ".mstar", "sdd", "20260808-p1"));
  });

  test("resolveIterationDir composes {HARNESS_DIR}/iterations", () => {
    expect(resolveIterationDir(join("/r", ".mstar"))).toBe(join("/r", ".mstar", "iterations"));
  });
});

describe("resolveSpecsDir (plan-conventions § {SPECS_DIR} 解析)", () => {
  test("first non-empty candidate wins: {HARNESS_DIR}/specs", () => {
    const root = tmpRoot("path-specs-first-");
    try {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      mkdirSync(join(root, "docs", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "spec.md"), "# spec\n");
      expect(resolveSpecsDir(join(root, ".mstar"))).toBe(join(root, ".mstar", "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty {HARNESS_DIR}/specs is treated as absent → docs/specs", () => {
    const root = tmpRoot("path-specs-second-");
    try {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      mkdirSync(join(root, "docs", "specs"), { recursive: true });
      writeFileSync(join(root, "docs", "specs", "spec.md"), "# spec\n");
      expect(resolveSpecsDir(join(root, ".mstar"))).toBe(join(root, "docs", "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty docs/specs too → repo-root specs/", () => {
    const root = tmpRoot("path-specs-third-");
    try {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      mkdirSync(join(root, "docs", "specs"), { recursive: true });
      mkdirSync(join(root, "specs"), { recursive: true });
      writeFileSync(join(root, "specs", "spec.md"), "# spec\n");
      expect(resolveSpecsDir(join(root, ".mstar"))).toBe(join(root, "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a candidate holding only empty subdirectories counts as absent (empty-dir rule is recursive)", () => {
    const root = tmpRoot("path-specs-nestedempty-");
    try {
      mkdirSync(join(root, ".mstar", "specs", "empty-sub"), { recursive: true });
      mkdirSync(join(root, "specs"), { recursive: true });
      writeFileSync(join(root, "specs", "spec.md"), "# spec\n");
      expect(resolveSpecsDir(join(root, ".mstar"))).toBe(join(root, "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("all candidates absent → default-creates {HARNESS_DIR}/specs", () => {
    const root = tmpRoot("path-specs-default-");
    try {
      const specsDir = resolveSpecsDir(join(root, ".mstar"));
      expect(specsDir).toBe(join(root, ".mstar", "specs"));
      expect(readdirSync(specsDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("create: false skips the directory creation side effect", () => {
    const root = tmpRoot("path-specs-nocreate-");
    try {
      const specsDir = resolveSpecsDir(join(root, ".mstar"), { create: false });
      expect(specsDir).toBe(join(root, ".mstar", "specs"));
      expect(() => readdirSync(specsDir)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy {HARNESS_DIR}/designs is picked when the primary candidates miss (compat read)", () => {
    const root = tmpRoot("path-specs-designs-harness-");
    try {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      mkdirSync(join(root, ".mstar", "designs"), { recursive: true });
      mkdirSync(join(root, "designs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "designs", "arch.md"), "# arch\n");
      writeFileSync(join(root, "designs", "other.md"), "# other\n");
      expect(resolveSpecsDir(join(root, ".mstar"))).toBe(join(root, ".mstar", "designs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty legacy {HARNESS_DIR}/designs is skipped → repo-root designs/", () => {
    const root = tmpRoot("path-specs-designs-skip-");
    try {
      mkdirSync(join(root, ".mstar", "designs"), { recursive: true });
      mkdirSync(join(root, "designs"), { recursive: true });
      writeFileSync(join(root, "designs", "arch.md"), "# arch\n");
      expect(resolveSpecsDir(join(root, ".mstar"))).toBe(join(root, "designs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty legacy repo-root designs/ is skipped → default-creates {HARNESS_DIR}/specs", () => {
    const root = tmpRoot("path-specs-designs-empty-");
    try {
      mkdirSync(join(root, ".mstar", "designs"), { recursive: true });
      mkdirSync(join(root, "designs"), { recursive: true });
      const specsDir = resolveSpecsDir(join(root, ".mstar"));
      expect(specsDir).toBe(join(root, ".mstar", "specs"));
      expect(readdirSync(specsDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("create: false with empty legacy designs/ keeps the no-side-effect behavior", () => {
    const root = tmpRoot("path-specs-designs-nocreate-");
    try {
      mkdirSync(join(root, ".mstar", "designs"), { recursive: true });
      mkdirSync(join(root, "designs"), { recursive: true });
      const specsDir = resolveSpecsDir(join(root, ".mstar"), { create: false });
      expect(specsDir).toBe(join(root, ".mstar", "specs"));
      expect(() => readdirSync(specsDir)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scaffoldHarness (plan-conventions § 初始化 Plan 目录 + templates/status.empty.json)", () => {
  test("creates .mstar/{plans,iterations,knowledge,specs,sdd} and status.json from the empty template", () => {
    const root = tmpRoot("path-scaffold-");
    try {
      const harnessDir = scaffoldHarness(root);
      expect(harnessDir).toBe(resolve(root, ".mstar"));
      expect(readdirSync(harnessDir).sort()).toEqual([
        "iterations",
        "knowledge",
        "plans",
        "sdd",
        "specs",
        "status.json",
      ]);
      // Byte-identical to skills/mstar-plan-artifacts/templates/status.empty.json
      // (embedded constant — engine never reads skill files at runtime).
      expect(readFileSync(join(harnessDir, "status.json"), "utf8")).toBe(
        '{\n  "version": 1,\n  "updated_at": "1970-01-01",\n  "plans": [],\n  "residual_findings": {},\n  "metadata": {}\n}\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is idempotent: preserves an existing non-empty status.json", () => {
    const root = tmpRoot("path-scaffold-idem-");
    try {
      scaffoldHarness(root);
      const statusPath = join(root, ".mstar", "status.json");
      const custom = '{\n  "version": 1,\n  "updated_at": "2026-08-08",\n  "plans": [],\n  "residual_findings": {},\n  "metadata": {}\n}\n';
      writeFileSync(statusPath, custom);
      scaffoldHarness(root);
      expect(readFileSync(statusPath, "utf8")).toBe(custom);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("emitGitignoreSnippet / validateGitignore (plan-conventions § Git 跟踪策略)", () => {
  test("emitGitignoreSnippet(\"mstar\") returns the exact canonical .mstar/ snippet", () => {
    expect(emitGitignoreSnippet("mstar")).toBe(CANONICAL_SNIPPET);
  });

  test("emitGitignoreSnippet(\"agents\") returns the exact legacy .agents/ snippet", () => {
    expect(emitGitignoreSnippet("agents")).toBe(CANONICAL_SNIPPET_AGENTS);
  });

  test("emitGitignoreSnippet() with unknown kind returns both snippets", () => {
    expect(emitGitignoreSnippet()).toBe(`${CANONICAL_SNIPPET}${CANONICAL_SNIPPET_AGENTS}`);
  });

  test("validateGitignore passes when .gitignore contains the .mstar/ set (kind undetected → either set accepted)", () => {
    const root = tmpRoot("path-gi-ok-");
    try {
      writeFileSync(join(root, ".gitignore"), `${CANONICAL_SNIPPET}\nnode_modules\n`);
      const result = validateGitignore(root);
      expect(result.ok).toBe(true);
      expect(result.code).toBe("gitignore.ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validateGitignore passes when .gitignore contains only the legacy .agents/ set", () => {
    const root = tmpRoot("path-gi-agents-ok-");
    try {
      writeFileSync(join(root, ".gitignore"), `${CANONICAL_SNIPPET_AGENTS}\nnode_modules\n`);
      const result = validateGitignore(root);
      expect(result.ok).toBe(true);
      expect(result.code).toBe("gitignore.ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validateGitignore requires the .mstar/ set when a .mstar harness is detected", () => {
    const root = tmpRoot("path-gi-mstar-kind-");
    try {
      mkdirSync(join(root, ".mstar"));
      writeFileSync(join(root, ".gitignore"), CANONICAL_SNIPPET);
      expect(validateGitignore(root).ok).toBe(true);
      // The .agents/ set alone does NOT fence a .mstar harness.
      writeFileSync(join(root, ".gitignore"), CANONICAL_SNIPPET_AGENTS);
      const result = validateGitignore(root);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("gitignore.missing-entries");
      expect(result.message).toContain(".mstar/ set");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validateGitignore requires the .agents/ set when a legacy .agents harness is detected", () => {
    const root = tmpRoot("path-gi-agents-kind-");
    try {
      mkdirSync(join(root, ".agents"));
      writeFileSync(join(root, ".gitignore"), CANONICAL_SNIPPET_AGENTS);
      expect(validateGitignore(root).ok).toBe(true);
      // The .mstar/ set alone does NOT fence a legacy .agents harness.
      writeFileSync(join(root, ".gitignore"), CANONICAL_SNIPPET);
      const result = validateGitignore(root);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("gitignore.missing-entries");
      expect(result.message).toContain(".agents/ set");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validateGitignore fails when .gitignore is missing", () => {
    const root = tmpRoot("path-gi-missing-");
    try {
      const result = validateGitignore(root);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("gitignore.missing");
      expect(result.severity).toBe("medium");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validateGitignore fails and lists the missing entries when no complete set is present", () => {
    const root = tmpRoot("path-gi-partial-");
    try {
      writeFileSync(
        join(root, ".gitignore"),
        "# Morning Star harness (.mstar/)\n.mstar/plans/\n.mstar/status.json\n",
      );
      const result = validateGitignore(root);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("gitignore.missing-entries");
      // Unknown kind — reports the set needing the fewest additions (.mstar/ here).
      expect(result.message).toContain(".mstar/archived/");
      expect(result.message).toContain(".mstar/iterations/");
      expect(result.message).toContain(".mstar/sdd/");
      expect(result.message).toContain(".mstar/notes.json");
      expect(result.severity).toBe("medium");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assertPlanWritingPath (plan-conventions § Plan-Writing Path Gate)", () => {
  test("accepts plans under {PLAN_DIR} for .mstar and .agents harnesses", () => {
    const result = assertPlanWritingPath(join("/r", ".mstar", "plans", "20260808-x.md"), join("/r", ".mstar"));
    expect(result.ok).toBe(true);
    expect(result.code).toBe("plan-path.ok");
  });

  test("accepts plans in the legacy same-dir layout ({HARNESS_DIR}={PLAN_DIR})", () => {
    const result = assertPlanWritingPath(join("/r", ".plans", "20260808-x.md"), join("/r", ".plans"));
    expect(result.ok).toBe(true);
  });

  test("rejects external default plan dirs (repo-root plans/) when .mstar is the harness", () => {
    const result = assertPlanWritingPath(join("/r", "plans", "20260808-x.md"), join("/r", ".mstar"));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("plan-path.outside-plan-dir");
    expect(result.severity).toBe("high");
    expect(result.message).toContain(join("/r", ".mstar", "plans"));
  });

  test("rejects paths sharing only a prefix with {PLAN_DIR}", () => {
    const result = assertPlanWritingPath(join("/r", ".mstar", "plans-other", "x.md"), join("/r", ".mstar"));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("plan-path.outside-plan-dir");
  });

  test("rejects any plan path when no harness dir is resolved", () => {
    const result = assertPlanWritingPath(join("/r", "plans", "20260808-x.md"), null);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("plan-path.no-harness");
    expect(result.severity).toBe("high");
  });
});

describe("assertSafePathComponent / resolveSddDir (path traversal guard, qc2 F-001)", () => {
  test("safe plan ids pass and compose {HARNESS_DIR}/sdd/<plan-id>", () => {
    expect(resolveSddDir(join("/r", ".mstar"), "20260808-p1")).toBe(join("/r", ".mstar", "sdd", "20260808-p1"));
    for (const safe of ["plan-a", "2026.08.08_x-1", "P1_2.3"]) {
      expect(() => resolveSddDir(join("/r", ".mstar"), safe)).not.toThrow();
    }
  });

  test("traversal attempts are rejected with a clear error", () => {
    for (const bad of ["", ".", "..", "../escape", "a/b", "a\\b", "..%2f", "a/../../tmp/pwn", "a b", "../.."]) {
      expect(() => resolveSddDir(join("/r", ".mstar"), bad)).toThrow(/single safe path component/);
      expect(() => assertSafePathComponent(bad, "planId")).toThrow(/single safe path component/);
    }
  });

  test("the guard message names the value", () => {
    expect(() => assertSafePathComponent("../escape", "planId")).toThrow(/planId/);
    expect(() => assertSafePathComponent("../escape", "planId")).toThrow(/"\.\.\/escape"/);
  });
});

describe("byte-parity with skill SSOT files (qc3 F-5)", () => {
  const repoRoot = findRepoRoot();

  test("emitGitignoreSnippet(\"mstar\") is byte-identical to the plan-conventions .mstar/ fence", () => {
    const skillPath = join(repoRoot, "skills", "mstar-plan-conventions", "SKILL.md");
    expect(emitGitignoreSnippet("mstar")).toBe(gitignoreFence(skillPath, 0));
  });

  test("emitGitignoreSnippet(\"agents\") is byte-identical to the plan-conventions legacy .agents/ fence", () => {
    const skillPath = join(repoRoot, "skills", "mstar-plan-conventions", "SKILL.md");
    expect(emitGitignoreSnippet("agents")).toBe(gitignoreFence(skillPath, 1));
  });

  test("scaffoldHarness status.json is byte-identical to templates/status.empty.json", () => {
    const root = tmpRoot("path-scaffold-byte-");
    try {
      const template = readFileSync(
        join(repoRoot, "skills", "mstar-plan-artifacts", "templates", "status.empty.json"),
        "utf8",
      );
      const harnessDir = scaffoldHarness(root);
      expect(readFileSync(join(harnessDir, "status.json"), "utf8")).toBe(template);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
