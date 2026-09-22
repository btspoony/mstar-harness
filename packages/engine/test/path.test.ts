/**
 * Engine path module — harness dir / specs dir / plan dir resolution,
 * scaffold, canonical .gitignore snippet, plan-writing path gate.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - `{HARNESS_DIR}` resolution order + `{PLAN_DIR}` composition:
 * `skills/mstar-conventions/SKILL.md` § 路径符号 +
 * § {HARNESS_DIR} 解析顺序（找到即停）— `.mstar/` → `.agents/` →
 * `.plans/`/`plans/` (rung 3: `{HARNESS_DIR}={PLAN_DIR}`); harness
 * candidates are dir-existence (the empty-dir rule applies to SPECS only).
 * - `{SPECS_DIR}` resolution (first non-empty candidate wins, empty-dir-as-
 * absent, default-create `{HARNESS_DIR}/specs/` when all absent; legacy
 * read-only `designs/` candidates `{HARNESS_DIR}/designs/` → repo-root
 * `designs/` — 兼容读, never created by init):
 * `skills/mstar-conventions/SKILL.md` § {SPECS_DIR} 解析（找到非空目录即停）
 * + § {SPECS_DIR} 解析 Legacy.
 * - Scaffold dirs + status.json empty template:
 * `skills/mstar-conventions/SKILL.md` § 初始化 Plan 目录 +
 * `skills/mstar-artifacts/templates/status.empty.json` (embedded as a
 * constant — engine must not read skill files at runtime, roadmap §8.5).
 * - Canonical `.gitignore` snippet + tracked/ignored sets:
 * `skills/mstar-conventions/SKILL.md` § Git 跟踪策略.
 * - Plan-writing path gate: `skills/mstar-conventions/SKILL.md`
 * § Plan-Writing Path Gate — plans live under `{PLAN_DIR}`, no external
 * default plan directories.
 * - Explicit harness-root override (`MSTAR_HARNESS_DIR` env / option):
 * the probe
 * list stays per mstar-conventions (`.mstar` → `.agents` →
 * `.plans`/`plans`); ad-hoc names are never probed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertPlanWritingPath,
  assertSafePathComponent,
  canonicalizeNearestExisting,
  emitGitignoreSnippet,
  hasHarnessRootDeclaration,
  resolveHarnessDir,
  resolveIterationDir,
  resolveKnowledgeDir,
  resolvePlanDir,
  resolveProjectDir,
  resolveSddDir,
  resolveSpecsDir,
  resolveWorkflowDir,
  scaffoldHarness,
  validateGitignore,
} from "../src/path.js";
import { validateStatusV2 } from "../src/status.js";
import { createFsStore, setArtifactStore } from "../src/store.js";
import { validateRoadmap } from "../src/project.js";

const ENV_KEY = "MSTAR_HARNESS_DIR";

/**
 * `scaffoldHarness` writes its coordination documents through the active
 * ArtifactStore, so a scaffold test pins the store to the harness it is about
 * to create and this hook restores the default for the store-free path tests.
 */
afterEach(() => {
  setArtifactStore(undefined);
});

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
 * `skills/`), for byte-parity tests against the skill SSOT files. */
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
 // Roadmap §7c: the walk-up is
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

describe("resolveHarnessDir — workspace-root stop boundary (roadmap §7c)", () => {
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

describe("resolveWorkflowDir / resolveProjectDir (v3 workflow lifecycle layout)", () => {
  test("default composition: {HARNESS_DIR}/workflows and {HARNESS_DIR}/projects", () => {
    const root = tmpRoot("path-wf-default-");
    try {
      mkdirSync(join(root, ".mstar"), { recursive: true });
      expect(resolveWorkflowDir(root)).toBe(join(root, ".mstar", "workflows"));
      expect(resolveProjectDir(root)).toBe(join(root, ".mstar", "projects"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workflow_dir / project_dir overrides from a repo-root .mstarc, resolved against the config dir", () => {
    const root = tmpRoot("path-wf-rc-");
    try {
      mkdirSync(join(root, ".mstar"), { recursive: true });
      writeFileSync(
        join(root, ".mstarc"),
        "[config]\nworkflow_dir=process/workflows\nproject_dir=runtime/projects\n",
      );
      expect(resolveWorkflowDir(root)).toBe(join(root, "process", "workflows"));
      expect(resolveProjectDir(root)).toBe(join(root, "runtime", "projects"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absolute workflow_dir declaration is used as-is", () => {
    const root = tmpRoot("path-wf-abs-");
    try {
      mkdirSync(join(root, ".mstar"), { recursive: true });
      const custom = join(root, "absolute-workflows");
      writeFileSync(join(root, ".mstarc"), `[config]\nworkflow_dir=${custom}\n`);
      expect(resolveWorkflowDir(root)).toBe(custom);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .mstarc inside the harness dir also applies", () => {
    const root = tmpRoot("path-wf-inner-");
    try {
      mkdirSync(join(root, ".mstar"), { recursive: true });
      writeFileSync(join(root, ".mstar", ".mstarc"), "[config]\nworkflow_dir=inner-wf\nproject_dir=inner-proj\n");
      expect(resolveWorkflowDir(root)).toBe(join(root, ".mstar", "inner-wf"));
      expect(resolveProjectDir(root)).toBe(join(root, ".mstar", "inner-proj"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .mstarc above the repo root is never adopted", () => {
    const root = tmpRoot("path-wf-above-");
    try {
      mkdirSync(join(root, "proj", ".mstar"), { recursive: true });
      writeFileSync(join(root, ".mstarc"), "[config]\nworkflow_dir=outer-wf\n");
 // Harness under proj/.mstar — the override walk stops at the repo
 // root (proj), so the outer config does not apply.
      expect(resolveWorkflowDir(join(root, "proj"))).toBe(join(root, "proj", ".mstar", "workflows"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MSTAR_HARNESS_DIR interplay: explicit harness root wins, overrides resolve against the config", () => {
    const root = tmpRoot("path-wf-env-");
    try {
      mkdirSync(join(root, "custom-harness"), { recursive: true });
      writeFileSync(join(root, ".mstarc"), "[config]\nworkflow_dir=runtime/wf\nproject_dir=store/projects\n");
      withEnv(join(root, "custom-harness"), () => {
        expect(resolveWorkflowDir(root)).toBe(join(root, "runtime", "wf"));
        expect(resolveProjectDir(root)).toBe(join(root, "store", "projects"));
 // No declaration: defaults compose under the explicit harness dir.
        writeFileSync(join(root, ".mstarc"), "[config]\n");
        expect(resolveWorkflowDir(root)).toBe(join(root, "custom-harness", "workflows"));
        expect(resolveProjectDir(root)).toBe(join(root, "custom-harness", "projects"));
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no harness dir → throws (fail closed, no silent default)", () => {
    const root = tmpRoot("path-wf-none-");
    try {
      expect(() => resolveWorkflowDir(root)).toThrow(/harness dir not found/);
      expect(() => resolveProjectDir(root)).toThrow(/harness dir not found/);
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
  test("creates .mstar/{plans,iterations,knowledge,specs,sdd} and a v2 status.json from the empty template", async () => {
    const root = tmpRoot("path-scaffold-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const harnessDir = await scaffoldHarness(root);
      expect(harnessDir).toBe(resolve(root, ".mstar"));
      expect(readdirSync(harnessDir).sort()).toEqual([
        "iterations",
        "knowledge",
        "plans",
        "projects",
        "sdd",
        "specs",
        "status.json",
      ]);
 // Byte-identical to skills/mstar-artifacts/templates/status.empty.json
 // (embedded constant — engine never reads skill files at runtime).
 // Ruling: the template is the v2 shape so a scaffolded
 // harness is never an un-migrated (v1) tree.
      const statusPath = join(harnessDir, "status.json");
      expect(readFileSync(statusPath, "utf8")).toBe(
        '{\n  "version": 2,\n  "updated_at": "1970-01-01",\n  "workflows": []\n}\n',
      );
 // The scaffolded root validates clean under the v2 validator.
      expect(validateStatusV2(statusPath).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prebuilds projects/_default/ with a valid roadmap.md and no legacy register", async () => {
    const root = tmpRoot("path-scaffold-project-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const harnessDir = await scaffoldHarness(root);
      const projectDir = join(harnessDir, "projects", "_default");
      // The register is retired (issue-governance cutover G2a): the issue store
      // is the findings authority, so a scaffold must not recreate the legacy
      // file next to the roadmap it does own.
      expect(readdirSync(projectDir).sort()).toEqual(["roadmap.md"]);
 // Roadmap frontmatter: project_id _default, non-empty title, status
 // active, created_at today, plus a `## Direction` body placeholder —
 // 0 violations (the missing goal-item task list is a warning only).
      const roadmapPath = join(projectDir, "roadmap.md");
      const roadmap = validateRoadmap(roadmapPath);
      expect(roadmap.ok).toBe(true);
      expect(roadmap.violations).toEqual([]);
      const roadmapText = readFileSync(roadmapPath, "utf8");
      expect(roadmapText).toContain("project_id: _default");
      expect(roadmapText).toContain("title: Default Project");
      expect(roadmapText).toContain("status: active");
      expect(roadmapText).toContain(`created_at: ${new Date().toISOString().slice(0, 10)}`);
      expect(roadmapText).toContain("## Direction");
      expect(existsSync(join(projectDir, "residuals.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to reinitialize an existing malformed status.json, leaving its bytes unchanged", async () => {
    const root = tmpRoot("path-scaffold-idem-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      await scaffoldHarness(root);
      const statusPath = join(root, ".mstar", "status.json");
      const custom = '{\n  "version": 1,\n  "updated_at": "2026-08-08",\n  "plans": [],\n  "residual_findings": {},\n  "metadata": {}\n}\n';
      writeFileSync(statusPath, custom);
      // Create-only (spec §C4): an existing document the validators reject is
      // never silently replaced — the run fails and the bytes survive.
      await expect(scaffoldHarness(root)).rejects.toThrow(/already exists but is invalid/);
      expect(readFileSync(statusPath, "utf8")).toBe(custom);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors .mstarc [config] harness_dir when resolving the scaffold target", async () => {
    const root = tmpRoot("path-scaffold-mstarc-harness-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.custom\n", "utf8");
      setArtifactStore(createFsStore(resolve(root, ".custom")));
      const harnessDir = await scaffoldHarness(root);
 // Files land under the declared dir, not the default .mstar/.
      expect(harnessDir).toBe(resolve(root, ".custom"));
      expect(existsSync(join(root, ".custom", "status.json"))).toBe(true);
      expect(existsSync(join(root, ".custom", "plans"))).toBe(true);
      expect(existsSync(join(root, ".custom", "projects", "_default", "roadmap.md"))).toBe(true);
      expect(existsSync(join(root, ".mstar"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors MSTAR_HARNESS_DIR env override for the scaffold target", async () => {
    const root = tmpRoot("path-scaffold-mstarc-env-");
    try {
      const custom = join(root, "env-harness");
      const previous = process.env[ENV_KEY];
      process.env[ENV_KEY] = custom;
      try {
        setArtifactStore(createFsStore(custom));
        const harnessDir = await scaffoldHarness(root);
        expect(harnessDir).toBe(custom);
        expect(existsSync(join(custom, "status.json"))).toBe(true);
        expect(existsSync(join(custom, "projects", "_default", "roadmap.md"))).toBe(true);
      } finally {
        if (previous === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = previous;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors .mstarc [config] project_dir independently of the harness dir", async () => {
    const root = tmpRoot("path-scaffold-mstarc-project-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nproject_dir=process/projects\n", "utf8");
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const harnessDir = await scaffoldHarness(root);
 // Harness stays at the default .mstar/; _default lands under the
 // RESOLVED {PROJECT_DIR} (project_dir resolved against the .mstarc
 // file's directory), not {HARNESS_DIR}/projects.
      expect(harnessDir).toBe(resolve(root, ".mstar"));
      expect(existsSync(join(root, ".mstar", "status.json"))).toBe(true);
      expect(existsSync(join(root, "process", "projects", "_default", "roadmap.md"))).toBe(true);
      // No register is scaffolded under the resolved project dir either.
      expect(existsSync(join(root, "process", "projects", "_default", "residuals.json"))).toBe(false);
      expect(existsSync(join(root, ".mstar", "projects"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors .mstarc harness_dir AND project_dir independently (both keys)", async () => {
    const root = tmpRoot("path-scaffold-mstarc-both-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.custom\nproject_dir=process/projects\n", "utf8");
      setArtifactStore(createFsStore(resolve(root, ".custom")));
      const harnessDir = await scaffoldHarness(root);
      expect(harnessDir).toBe(resolve(root, ".custom"));
      expect(existsSync(join(root, ".custom", "status.json"))).toBe(true);
      expect(existsSync(join(root, "process", "projects", "_default", "roadmap.md"))).toBe(true);
      expect(existsSync(join(root, ".custom", "projects"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is idempotent: preserves user-edited roadmap.md and an existing legacy register", async () => {
    const root = tmpRoot("path-scaffold-idem-project-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      await scaffoldHarness(root);
      const roadmapPath = join(root, ".mstar", "projects", "_default", "roadmap.md");
      const registerPath = join(root, ".mstar", "projects", "_default", "residuals.json");
      const customRoadmap = `---
project_id: _default
title: Custom Roadmap
status: active
created_at: 2026-08-01
---

## Direction

Custom direction.
`;
      const customRegister = '{\n  "entries": {}\n}\n';
      writeFileSync(roadmapPath, customRoadmap);
      // A register the workspace already holds is migration history the
      // scaffold neither creates nor rewrites (issue authority).
      writeFileSync(registerPath, customRegister);
      await scaffoldHarness(root);
      expect(readFileSync(roadmapPath, "utf8")).toBe(customRoadmap);
      expect(readFileSync(registerPath, "utf8")).toBe(customRegister);
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

  test("validateGitignore succeeds as author-declared for a declaration of either root (kind undetected)", () => {
    const root = tmpRoot("path-gi-ok-");
    try {
      writeFileSync(join(root, ".gitignore"), `${CANONICAL_SNIPPET}\nnode_modules\n`);
      const mstar = validateGitignore(root);
      expect(mstar.ok).toBe(true);
      expect(mstar.code).toBe("gitignore.author-declared");

      writeFileSync(join(root, ".gitignore"), `${CANONICAL_SNIPPET_AGENTS}\nnode_modules\n`);
      const agents = validateGitignore(root);
      expect(agents.ok).toBe(true);
      expect(agents.code).toBe("gitignore.author-declared");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validateGitignore accepts a legacy .agents/ declaration for a detected .mstar harness", () => {
    const root = tmpRoot("path-gi-mstar-kind-");
    try {
      mkdirSync(join(root, ".mstar"));
      writeFileSync(join(root, ".gitignore"), CANONICAL_SNIPPET_AGENTS);
      const result = validateGitignore(root);
      expect(result.ok).toBe(true);
      expect(result.code).toBe("gitignore.author-declared");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validateGitignore accepts a .mstar/ declaration for a detected legacy .agents harness", () => {
    const root = tmpRoot("path-gi-agents-kind-");
    try {
      mkdirSync(join(root, ".agents"));
      writeFileSync(join(root, ".gitignore"), CANONICAL_SNIPPET);
      const result = validateGitignore(root);
      expect(result.ok).toBe(true);
      expect(result.code).toBe("gitignore.author-declared");
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

  test("validateGitignore refuses an undeclared file and lists the canonical entries it lacks", () => {
    const root = tmpRoot("path-gi-undeclared-");
    try {
      writeFileSync(
        join(root, ".gitignore"),
        "# Morning Star harness (.mstar/)\nnode_modules\ndist/\n.mstarc\n",
      );
      const result = validateGitignore(root);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("gitignore.missing-entries");
      expect(result.severity).toBe("medium");
      // Unknown kind — the diagnostic reports the default .mstar/ set.
      expect(result.message).toContain(".mstar/**");
      expect(result.message).toContain("!.mstar/knowledge/");
      expect(result.message).toContain("!.mstar/specs/**");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("harness root declaration (compass D25: ^!?/?\\.(?:mstar|agents)(?:/|$))", () => {
  test("recognizes harness-root rules of both layouts, with or without a leading slash", () => {
    for (const line of [".mstar", ".mstar/", ".mstar/**", "/.mstar/", ".mstar/plans/", ".agents", ".agents/", ".agents/**", "/.agents/"]) {
      expect(hasHarnessRootDeclaration(line)).toBe(true);
    }
  });

  test("recognizes negations of either root", () => {
    for (const line of ["!.mstar/specs/", "!.mstar/specs/**", "!/.mstar/", "!.agents/knowledge/**"]) {
      expect(hasHarnessRootDeclaration(line)).toBe(true);
    }
  });

  test("recognizes a partial declaration — canonical completion is intentionally suppressed", () => {
    expect(hasHarnessRootDeclaration(".mstar/**\n")).toBe(true);
    expect(hasHarnessRootDeclaration("!.mstar/specs/\n")).toBe(true);
    expect(hasHarnessRootDeclaration(".agents/knowledge/**\n")).toBe(true);
  });

  test("recognizes a declaration among unrelated rules, blank lines and CRLF (trimmed for recognition only)", () => {
    expect(hasHarnessRootDeclaration("node_modules\r\n\r\n  .mstar/plans/  \r\ndist/\r\n")).toBe(true);
  });

  test("excludes comments, blank content and comment-only files", () => {
    expect(hasHarnessRootDeclaration("")).toBe(false);
    expect(hasHarnessRootDeclaration("\n \r\n\t\n")).toBe(false);
    expect(hasHarnessRootDeclaration("# Morning Star harness (.mstar/)\n# .mstarc\n")).toBe(false);
  });

  test("excludes `.mstarc` alone and unrelated paths", () => {
    expect(hasHarnessRootDeclaration(".mstarc\n")).toBe(false);
    expect(hasHarnessRootDeclaration(".mstarc\nnode_modules\ndist/\n*.log\n")).toBe(false);
    expect(hasHarnessRootDeclaration(".mstarish/\n.mstar-plans/\nagents/\n.agentsx/\n")).toBe(false);
  });

  test("declared-file validation is read-only (authored bytes and the directory stay untouched)", () => {
    const root = tmpRoot("path-decl-readonly-");
    try {
      const authored = "# mine\r\nnode_modules\r\n.mstar/**\r\ndist/\r\n.mstar/**\r\n!.mstar/specs/**";
      writeFileSync(join(root, ".gitignore"), authored);
      const result = validateGitignore(root);
      expect(result.ok).toBe(true);
      expect(result.code).toBe("gitignore.author-declared");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(authored);
      expect(readdirSync(root)).toEqual([".gitignore"]);
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

  test("rejects an existing plan symlink whose canonical target escapes {PLAN_DIR}", () => {
    const root = tmpRoot("path-symlink-escape-");
    try {
      const harnessDir = join(root, ".mstar");
      const planDir = join(harnessDir, "plans");
      mkdirSync(planDir, { recursive: true });
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "secret");
      symlinkSync(outside, join(planDir, "evil.md"));
      const result = assertPlanWritingPath(join(planDir, "evil.md"), harnessDir);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("plan-path.symlink-escape");
      expect(result.severity).toBe("high");
      expect(result.message).toContain(resolve(outside));
      expect(result.message).toContain(resolve(planDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts an internal plan symlink whose canonical target stays under {PLAN_DIR}", () => {
    const root = tmpRoot("path-symlink-internal-");
    try {
      const harnessDir = join(root, ".mstar");
      const planDir = join(harnessDir, "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, "real.md"), "plan");
      symlinkSync(join(planDir, "real.md"), join(planDir, "alias.md"));
      const result = assertPlanWritingPath(join(planDir, "alias.md"), harnessDir);
      expect(result.ok).toBe(true);
      expect(result.code).toBe("plan-path.ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts a non-existent plan path (first write) with only the lexical check", () => {
    const root = tmpRoot("path-symlink-missing-");
    try {
      const harnessDir = join(root, ".mstar");
      const planDir = join(harnessDir, "plans");
      mkdirSync(planDir, { recursive: true });
      const result = assertPlanWritingPath(join(planDir, "2024-new.md"), harnessDir);
      expect(result.ok).toBe(true);
      expect(result.code).toBe("plan-path.ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts a whole-dir plans/ symlink to a directory outside the harness", () => {
    const root = tmpRoot("path-symlink-dir-");
    try {
      const harnessDir = join(root, ".mstar");
      mkdirSync(harnessDir, { recursive: true });
      const sharedPlans = join(root, "shared-plans");
      mkdirSync(sharedPlans, { recursive: true });
      writeFileSync(join(sharedPlans, "x.md"), "plan");
      symlinkSync(sharedPlans, join(harnessDir, "plans"));
      const result = assertPlanWritingPath(join(harnessDir, "plans", "x.md"), harnessDir);
      expect(result.ok).toBe(true);
      expect(result.code).toBe("plan-path.ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assertSafePathComponent / resolveSddDir (path traversal guard(", () => {
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

describe("byte-parity with skill SSOT files ", () => {
  const repoRoot = findRepoRoot();

  test("emitGitignoreSnippet(\"mstar\") is byte-identical to the plan-conventions .mstar/ fence", () => {
    const skillPath = join(repoRoot, "skills", "mstar-conventions", "SKILL.md");
    expect(emitGitignoreSnippet("mstar")).toBe(gitignoreFence(skillPath, 0));
  });

  test("emitGitignoreSnippet(\"agents\") is byte-identical to the plan-conventions legacy .agents/ fence", () => {
    const skillPath = join(repoRoot, "skills", "mstar-conventions", "SKILL.md");
    expect(emitGitignoreSnippet("agents")).toBe(gitignoreFence(skillPath, 1));
  });

  test("scaffoldHarness status.json is byte-identical to templates/status.empty.json", async () => {
    const root = tmpRoot("path-scaffold-byte-");
    try {
      const template = readFileSync(
        join(repoRoot, "skills", "mstar-artifacts", "templates", "status.empty.json"),
        "utf8",
      );
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const harnessDir = await scaffoldHarness(root);
      expect(readFileSync(join(harnessDir, "status.json"), "utf8")).toBe(template);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("canonicalizeNearestExisting — A3 nonexistent-leaf canonicalization", () => {
  function tmpRoot(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  test("an existing path canonicalizes to its realpath (macOS /var → /private/var included)", () => {
    const root = tmpRoot("path-can-exist-");
    try {
      mkdirSync(join(root, "dir"));
      const p = join(root, "dir", "file.txt");
      writeFileSync(p, "x\n");
      expect(canonicalizeNearestExisting(p)).toBe(realpathSync(p));
      expect(canonicalizeNearestExisting(join(root, "dir"))).toBe(realpathSync(join(root, "dir")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a nonexistent leaf canonicalizes through its nearest existing ancestor", () => {
    const root = tmpRoot("path-can-leaf-");
    try {
      mkdirSync(join(root, "existing"));
      const missing = join(root, "existing", "a", "b", "new.md");
      expect(canonicalizeNearestExisting(missing)).toBe(join(realpathSync(join(root, "existing")), "a", "b", "new.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`..` segments collapse lexically before the ancestor walk", () => {
    const root = tmpRoot("path-can-dotdot-");
    try {
      mkdirSync(join(root, "a"));
      const weird = join(root, "a", "..", "b", "missing.txt");
      expect(canonicalizeNearestExisting(weird)).toBe(join(realpathSync(root), "b", "missing.txt"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlinked ancestor canonicalizes to its target (escape becomes visible)", () => {
    const root = tmpRoot("path-can-symlink-");
    try {
      const real = join(root, "real");
      const elsewhere = join(root, "elsewhere");
      mkdirSync(real);
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(real, "link"));
      const viaLink = join(real, "link", "sub", "new.md");
      expect(canonicalizeNearestExisting(viaLink)).toBe(join(realpathSync(elsewhere), "sub", "new.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is read-only: the missing intermediate directories are never created", () => {
    const root = tmpRoot("path-can-readonly-");
    try {
      const missing = join(root, "x", "y", "z.md");
      expect(canonicalizeNearestExisting(missing)).toBe(join(realpathSync(root), "x", "y", "z.md"));
      expect(existsSync(join(root, "x"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a path with no existing ancestor falls back to the lexical resolve", () => {
    const absentRoot = join(realpathSync("/"), "no-such-ancestor-canonicalize-test");
    const p = join(absentRoot, "a", "b.md");
    expect(canonicalizeNearestExisting(p)).toBe(p);
  });
});

// ---------------------------------------------------------------------------
// coordinated-writer — scaffoldHarness is a create-only bootstrap (spec C4)
// ---------------------------------------------------------------------------

describe("coordinated-writer — scaffoldHarness create-only bootstrap", () => {
  test("writes status.json through the authorized context on a fresh root", async () => {
    const root = tmpRoot("coordinated-writer-scaffold-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const harnessDir = await scaffoldHarness(root);
      const statusPath = join(harnessDir, "status.json");
      expect(existsSync(statusPath)).toBe(true);
      expect(validateStatusV2(statusPath).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an existing empty status.json and leaves its bytes unchanged", async () => {
    const root = tmpRoot("coordinated-writer-scaffold-empty-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const statusPath = join(root, ".mstar", "status.json");
      mkdirSync(dirname(statusPath), { recursive: true });
      writeFileSync(statusPath, "{}\n", "utf8");

      // The old bootstrap silently reinitialized an empty document; the
      // create-only contract fails validation instead and touches nothing.
      await expect(scaffoldHarness(root)).rejects.toThrow(/already exists but is invalid/);
      expect(readFileSync(statusPath, "utf8")).toBe("{}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves an existing legacy register alone instead of validating or rewriting it", async () => {
    const root = tmpRoot("coordinated-writer-scaffold-register-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const registerPath = join(root, ".mstar", "projects", "_default", "residuals.json");
      mkdirSync(dirname(registerPath), { recursive: true });
      writeFileSync(registerPath, "{}\n", "utf8");

      // The scaffold owns no register any more (issue authority): even a
      // malformed legacy file is neither a precondition nor a write target, so
      // the run completes and the bytes survive for the migration to read.
      await scaffoldHarness(root);
      expect(readFileSync(registerPath, "utf8")).toBe("{}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
