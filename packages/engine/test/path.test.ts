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
 *   plan 20260808-slice2-sdd-iteration Finding (2026-08-08) — the probe
 *   list stays per mstar-plan-conventions (`.mstar` → `.agents` →
 *   `.plans`/`plans`); ad-hoc names are never probed.
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
  resolveKnowledgeDir,
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
# Default-ignore everything under .mstar/, then re-include the tracked results.
.mstar/**
!.mstar/AGENTS.md
!.mstar/knowledge/
!.mstar/knowledge/**
!.mstar/specs/
!.mstar/specs/**
# .mstarc — repo-local harness config (may declare [config] harness_dir=<name>)
.mstarc
`;

/** Legacy snippet text — verbatim from plan-conventions § Git 跟踪策略 ("Legacy `.agents/` 等价"). */
const CANONICAL_SNIPPET_AGENTS = `# Morning Star harness (.agents/) — legacy
# Default-ignore everything under .agents/, then re-include the tracked results.
.agents/**
!.agents/AGENTS.md
!.agents/knowledge/
!.agents/knowledge/**
!.agents/specs/
!.agents/specs/**
`;

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Minimal valid git work tree (no `git init` subprocess): the engine's
 * default boundary runs `git rev-parse --show-cdup`, which only needs a
 * valid `.git` layout (HEAD + config + objects/ + refs/) — no commits.
 */
function gitInit(root: string): void {
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, ".git", "refs"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
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

  test("walks up from a nested startDir to the first match within an explicit workspaceRoot", () => {
    const root = tmpRoot("path-harness-walkup-");
    try {
      mkdirSync(join(root, ".mstar"));
      const nested = join(root, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      // Roadmap §7c / plan 20260810-harness-root-boundary: the walk-up is
      // now bounded — a non-git start without workspaceRoot probes only
      // itself, so the nested probe must carry the workspace boundary.
      expect(resolveHarnessDir(nested, { workspaceRoot: root })).toBe(resolve(root, ".mstar"));
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

  test("does not probe non-convention names (probe list fixed per plan-conventions)", () => {
    const root = tmpRoot("path-harness-noconvention-");
    try {
      mkdirSync(join(root, ".custom-root"));
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

describe("resolveHarnessDir — `.mstarc` [config] harness_dir (plan-conventions § {HARNESS_DIR} 解析顺序 step 2)", () => {
  test("declares the harness root relative to the .mstarc directory (dir need not exist)", () => {
    const root = tmpRoot("path-rc-rel-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.custom_dir\n");
      expect(resolveHarnessDir(root)).toBe(resolve(root, ".custom_dir"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("found from a nested start dir (find-first-stop walk-up)", () => {
    const root = tmpRoot("path-rc-walk-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.custom_dir\n");
      mkdirSync(join(root, "a", "b"), { recursive: true });
      expect(resolveHarnessDir(join(root, "a", "b"), { workspaceRoot: root })).toBe(resolve(root, ".custom_dir"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absolute harness_dir is used as-is", () => {
    const root = tmpRoot("path-rc-abs-");
    try {
      const custom = join(root, "custom-dir");
      writeFileSync(join(root, ".mstarc"), `[config]\nharness_dir=${custom}\n`);
      expect(resolveHarnessDir(root)).toBe(custom);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .mstarc without [config] harness_dir falls through to probing", () => {
    const root = tmpRoot("path-rc-empty-");
    try {
      writeFileSync(join(root, ".mstarc"), "# no harness_dir declared\n");
      mkdirSync(join(root, ".mstar"));
      expect(resolveHarnessDir(root)).toBe(resolve(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the nearest .mstarc wins when several exist up the tree", () => {
    const root = tmpRoot("path-rc-nearest-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.outer_dir\n");
      mkdirSync(join(root, "inner"));
      writeFileSync(join(root, "inner", ".mstarc"), "[config]\nharness_dir=.inner_dir\n");
      expect(resolveHarnessDir(join(root, "inner"), { workspaceRoot: root })).toBe(resolve(root, "inner", ".inner_dir"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .mstarc above the workspace boundary is never adopted", () => {
    const root = tmpRoot("path-rc-boundary-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.above_dir\n");
      mkdirSync(join(root, "proj"), { recursive: true });
      expect(resolveHarnessDir(join(root, "proj"), { workspaceRoot: join(root, "proj") })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MSTAR_HARNESS_DIR env beats .mstarc; opts.harnessDir beats env", () => {
    const root = tmpRoot("path-rc-precedence-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.rc_dir\n");
      const envDir = join(root, "env-harness");
      const optDir = join(root, "opt-harness");
      withEnv(envDir, () => {
        expect(resolveHarnessDir(root)).toBe(envDir);
        expect(resolveHarnessDir(root, { harnessDir: optDir })).toBe(optDir);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveHarnessDir — workspace-root stop boundary (roadmap §7c / plan 20260810-harness-root-boundary)", () => {
  test("(a) explicit workspaceRoot: a `.mstar` fixture in the parent chain ABOVE the boundary is never returned", () => {
    const root = tmpRoot("path-boundary-a-");
    try {
      // "global" fixture: `.mstar` sits above the workspace root, exactly
      // like the `~/.mstar` CLI-install root the defect adopted.
      mkdirSync(join(root, ".mstar"));
      const workspace = join(root, "project");
      const probe = join(workspace, "src", "deep");
      mkdirSync(probe, { recursive: true });
      // probe starts inside the workspace; the boundary stops the walk-up.
      expect(resolveHarnessDir(probe, { workspaceRoot: workspace })).toBeNull();
      // a harness BELOW the start still wins (never the fixture above).
      mkdirSync(join(workspace, ".mstar"));
      expect(resolveHarnessDir(probe, { workspaceRoot: workspace })).toBe(resolve(workspace, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(b) workspaceRoot = probe start (boundary = start, no walk-up): only a `.mstar` above → null", () => {
    const root = tmpRoot("path-boundary-b-");
    try {
      mkdirSync(join(root, ".mstar"));
      const probe = join(root, "sub");
      mkdirSync(probe, { recursive: true });
      expect(resolveHarnessDir(probe, { workspaceRoot: probe })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(b2) boundary at start still finds a harness AT the start itself", () => {
    const root = tmpRoot("path-boundary-b2-");
    try {
      mkdirSync(join(root, ".mstar"));
      const probe = join(root, "sub");
      mkdirSync(join(probe, ".mstar"), { recursive: true });
      expect(resolveHarnessDir(probe, { workspaceRoot: probe })).toBe(resolve(probe, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(c) explicit workspaceRoot: subdir probe still finds the repo-root `.mstar`", () => {
    const root = tmpRoot("path-boundary-c-");
    try {
      mkdirSync(join(root, ".mstar"));
      const probe = join(root, "src", "deep");
      mkdirSync(probe, { recursive: true });
      expect(resolveHarnessDir(probe, { workspaceRoot: root })).toBe(resolve(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(c2) default git boundary: a `.git` repo-root harness still resolves from a subdir without explicit workspaceRoot", () => {
    const root = tmpRoot("path-boundary-c2-");
    try {
      // Real git repo fixture: default boundary = `git rev-parse
      // --show-cdup` from the start dir = the repo root.
      gitInit(root);
      mkdirSync(join(root, ".mstar"));
      const probe = join(root, "src", "deep");
      mkdirSync(probe, { recursive: true });
      expect(resolveHarnessDir(probe)).toBe(resolve(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(c3) non-git start without workspaceRoot probes only itself (deliberate tightening — no walk-up)", () => {
    const root = tmpRoot("path-boundary-c3-");
    try {
      mkdirSync(join(root, ".mstar"));
      const probe = join(root, "sub");
      mkdirSync(probe, { recursive: true });
      // tmp root is not a git repo → default boundary = start → null even
      // though `.mstar` exists one level up.
      expect(resolveHarnessDir(probe)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(d) explicit overrides still win when the boundary would otherwise forbid them", () => {
    const root = tmpRoot("path-boundary-d-");
    try {
      const workspace = join(root, "project");
      const probe = join(workspace, "src");
      mkdirSync(probe, { recursive: true });
      const outside = join(root, "outside-harness");
      mkdirSync(outside, { recursive: true });
      // opts.harnessDir points ABOVE the workspaceRoot → override authority.
      expect(resolveHarnessDir(probe, { workspaceRoot: workspace, harnessDir: outside })).toBe(outside);
      // env override too.
      withEnv(outside, () => {
        expect(resolveHarnessDir(probe, { workspaceRoot: workspace })).toBe(outside);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(d2) relative workspaceRoot resolves against the start dir", () => {
    const root = tmpRoot("path-boundary-d2-");
    try {
      mkdirSync(join(root, ".mstar"));
      const probe = join(root, "sub");
      mkdirSync(probe, { recursive: true });
      // ".." = the parent of the start dir — a boundary at the tmp root.
      expect(resolveHarnessDir(probe, { workspaceRoot: ".." })).toBe(resolve(root, ".mstar"));
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

describe("resolveXDir — `.mstarc` [config] sub-directory keys (plan-conventions § 路径符号 / `.mstarc` 格式)", () => {
  test("plan_dir / sdd_dir / iteration_dir / knowledge_dir overrides from a repo-root .mstarc", () => {
    const root = tmpRoot("path-rc-dirs-");
    try {
      writeFileSync(
        join(root, ".mstarc"),
        "[config]\nplan_dir=planning\nsdd_dir=process/sdd\niteration_dir=process/iterations\nknowledge_dir=knowledge\n",
      );
      expect(resolvePlanDir(join(root, ".mstar"))).toBe(join(root, "planning"));
      expect(resolveSddDir(join(root, ".mstar"), "20260808-p1")).toBe(join(root, "process", "sdd", "20260808-p1"));
      expect(resolveIterationDir(join(root, ".mstar"))).toBe(join(root, "process", "iterations"));
      expect(resolveKnowledgeDir(join(root, ".mstar"))).toBe(join(root, "knowledge"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absolute sub-dir declaration is used as-is", () => {
    const root = tmpRoot("path-rc-dirs-abs-");
    try {
      const custom = join(root, "absolute-plans");
      writeFileSync(join(root, ".mstarc"), `[config]\nplan_dir=${custom}\n`);
      expect(resolvePlanDir(join(root, ".mstar"))).toBe(custom);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("specs_dir declaration is authoritative — skips the candidate chain and create-on-miss", () => {
    const root = tmpRoot("path-rc-dirs-specs-");
    try {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "spec.md"), "# spec\n");
      mkdirSync(join(root, "docs", "specs"), { recursive: true });
      writeFileSync(join(root, "docs", "specs", "spec.md"), "# spec\n");
      writeFileSync(join(root, ".mstarc"), "[config]\nspecs_dir=specs/custom\n");
      // The declared dir wins even though other candidates are non-empty.
      expect(resolveSpecsDir(join(root, ".mstar"))).toBe(join(root, "specs", "custom"));
      // create: false still returns the declared dir (no candidate fallback).
      expect(resolveSpecsDir(join(root, ".mstar"), { create: false })).toBe(join(root, "specs", "custom"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .mstarc inside the harness dir also applies (find from harness dir)", () => {
    const root = tmpRoot("path-rc-dirs-inner-");
    try {
      mkdirSync(join(root, ".mstar"), { recursive: true });
      writeFileSync(join(root, ".mstar", ".mstarc"), "[config]\nplan_dir=inner-plans\n");
      expect(resolvePlanDir(join(root, ".mstar"))).toBe(join(root, ".mstar", "inner-plans"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no declaration → default composition (no .mstarc, or [config] without keys)", () => {
    const root = tmpRoot("path-rc-dirs-none-");
    try {
      expect(resolvePlanDir(join(root, ".mstar"))).toBe(join(root, ".mstar", "plans"));
      writeFileSync(join(root, ".mstarc"), "# no dirs\n");
      expect(resolveIterationDir(join(root, ".mstar"))).toBe(join(root, ".mstar", "iterations"));
      expect(resolveKnowledgeDir(join(root, ".mstar"))).toBe(join(root, ".mstar", "knowledge"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .mstarc above the repo root is never adopted for sub-directory keys", () => {
    const root = tmpRoot("path-rc-dirs-above-");
    try {
      mkdirSync(join(root, "proj"), { recursive: true });
      writeFileSync(join(root, ".mstarc"), "[config]\nplan_dir=outer-plans\n");
      // Harness under proj/.mstar — the walk from proj/.mstar stops at the
      // repo root (proj), so the outer config does not apply.
      expect(resolvePlanDir(join(root, "proj", ".mstar"))).toBe(join(root, "proj", ".mstar", "plans"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
        "# Morning Star harness (.mstar/)\n.mstar/**\n!.mstar/AGENTS.md\n",
      );
      const result = validateGitignore(root);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("gitignore.missing-entries");
      // Unknown kind — reports the set needing the fewest additions (.mstar/ here).
      expect(result.message).toContain("!.mstar/knowledge/");
      expect(result.message).toContain("!.mstar/knowledge/**");
      expect(result.message).toContain("!.mstar/specs/");
      expect(result.message).toContain("!.mstar/specs/**");
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
