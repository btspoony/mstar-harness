/**
 * Engine path module — harness dir / specs dir / plan dir resolution,
 * scaffold, canonical .gitignore snippet, plan-writing path gate.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - `{HARNESS_DIR}` fixed-root resolution (ADR
 * `docs/adr/proposed/architecture/2026-11-20-fixed-harness-root.md`):
 * `<git main worktree>/.mstar` only — `harness_dir` declarations,
 * `MSTAR_HARNESS_DIR` and the `.agents/`/`.plans/`/`plans/` candidates
 * are retired and refused with a named recovery; `opts.harnessDir` is a
 * caller-held assertion returned verbatim.
 * - `{SPECS_DIR}` resolution (first non-empty candidate wins, empty-dir-as-
 * absent, default-create `<repoRoot>/.agents/specs/` when all absent; legacy
 * read-only `designs/` candidates and the `{HARNESS_DIR}/specs/` tail —
 * 兼容读, never created by init):
 * `skills/mstar-conventions/SKILL.md` § {SPECS_DIR} 解析（找到非空目录即停）
 * + § {SPECS_DIR} 解析 Legacy.
 * - Scaffold dirs: `skills/mstar-conventions/SKILL.md` § 初始化 Plan 目录.
 * - Canonical `.gitignore` snippet + tracked/ignored sets:
 * `skills/mstar-conventions/SKILL.md` § Git 跟踪策略.
 * - Plan-writing path gate: `skills/mstar-conventions/SKILL.md`
 * § Plan-Writing Path Gate — plans live under `{PLAN_DIR}`, no external
 * default plan directories.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertPlanWritingPath,
  assertSafePathComponent,
  canonicalizeNearestExisting,
  emitGitignoreSnippet,
  HarnessRootRetiredError,
  hasHarnessRootDeclaration,
  resolveAdrDir,
  resolveHarnessDir,
  resolveIterationDir,
  resolveKnowledgeDir,
  resolvePlanDir,
  resolveProjectDir,
  resolveReviewDir,
  resolveReviewRunDir,
  resolveSddDir,
  resolveScaffoldDirs,
  resolveSpecsDir,
  resolveWorkflowDir,
  reviewRunDirName,
  scaffoldHarness,
  validateGitignore,
} from "../src/path.js";
import type { ReviewRunLevel } from "../src/path.js";
import { readJson } from "../src/core.js";
import { parseMstarc } from "../src/mstarc.js";
import { initializeStore, openStore, resolveProcessHarnessDir } from "../src/index.js";
import { createFsStore, setArtifactStore } from "../src/store.js";

const ENV_KEY = "MSTAR_HARNESS_DIR";

/**
 * `scaffoldHarness` uses the catalog domain to register the default project.
 * Tests pin the filesystem store to the harness being created.
 */
afterEach(() => {
  setArtifactStore(undefined);
});

/** Canonical snippet text — verbatim from plan-conventions § Git 跟踪策略. */
const CANONICAL_SNIPPET = `# Morning Star harness: the process root stays local.
# Tracked results live under .agents/ and .mstarc declares the layout.
.mstar/
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
!.agents/adr/
!.agents/adr/**
`;
function tmpRoot(prefix: string): string {
  // why: Git answers with the real path (macOS /var → /private/var), so fixture
  // roots are canonicalized up front: a `resolve()` of a raw tmpdir path
  // would compare unequal to the worktree-list record.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** why: Run git inside a fixture repo; trimmed stdout. */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** why: Real git repo with one commit (worktree-add requires a HEAD). */
function gitRepo(root: string): void {
  git(["init", "-q"], root);
  git(["config", "user.email", "path-test@example.com"], root);
  git(["config", "user.name", "Path Test"], root);
  git(["commit", "-q", "--allow-empty", "-m", "init"], root);
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

describe("resolveHarnessDir — fixed root (ADR 2026-11-20)", () => {
  test("a git checkout resolves <main>/.mstar by dir-existence (empty dir counts)", () => {
    const root = tmpRoot("path-fixed-mstar-");
    try {
      gitInit(root);
      mkdirSync(join(root, ".mstar"));
      expect(resolveHarnessDir(root)).toBe(join(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a linked worktree resolves the MAIN worktree's .mstar, never its own", () => {
    const main = tmpRoot("path-fixed-main-");
    const parent = tmpRoot("path-fixed-parent-");
    try {
      gitRepo(main);
      mkdirSync(join(main, ".mstar"));
      const linked = join(parent, "linked");
      git(["worktree", "add", "-q", linked, "-b", "feature/linked"], main);
      // why: A shadow .mstar inside the linked checkout is never adopted.
      mkdirSync(join(linked, ".mstar"));
      const nested = join(linked, "src", "deep");
      mkdirSync(nested, { recursive: true });
      expect(resolveHarnessDir(linked)).toBe(join(main, ".mstar"));
      expect(resolveHarnessDir(nested)).toBe(join(main, ".mstar"));
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a linked worktree without a main .mstar resolves null (fail-closed, never local)", () => {
    const main = tmpRoot("path-fixed-mainnone-");
    const parent = tmpRoot("path-fixed-parentnone-");
    try {
      gitRepo(main);
      const linked = join(parent, "linked");
      git(["worktree", "add", "-q", linked, "-b", "feature/linked-none"], main);
      mkdirSync(join(linked, ".mstar"));
      expect(resolveHarnessDir(linked)).toBeNull();
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a non-git directory resolves null even when a local .mstar exists", () => {
    const root = tmpRoot("path-fixed-nongit-");
    try {
      mkdirSync(join(root, ".mstar"));
      expect(resolveHarnessDir(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an existing .mstar beats coexisting legacy layout dirs (no refusal)", () => {
    const root = tmpRoot("path-fixed-priority-");
    try {
      gitInit(root);
      for (const dir of [".mstar", ".agents", ".plans", "plans"]) mkdirSync(join(root, dir));
      expect(resolveHarnessDir(root)).toBe(join(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a legacy-only layout refuses, naming scaffold and upgrade as the recovery", () => {
    for (const legacy of [".agents", ".plans", "plans"]) {
      const root = tmpRoot(`path-fixed-legacy-${legacy.replace(/\W/g, "")}-`);
      try {
        gitInit(root);
        mkdirSync(join(root, legacy));
        writeFileSync(join(root, legacy, "status.json"), "{}");
        let err: unknown;
        try {
          resolveHarnessDir(root);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(HarnessRootRetiredError);
        const message = (err as HarnessRootRetiredError).message;
        expect(message).toContain(legacy);
        expect(message).toContain("mstar harness scaffold");
        expect(message).toContain("mstar store upgrade");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("a .mstarc harness_dir declaration refuses, naming the line and recovery", () => {
    const root = tmpRoot("path-fixed-rc-");
    try {
      gitInit(root);
      mkdirSync(join(root, ".mstar"));
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.mstar\n");
      let err: unknown;
      try {
        resolveHarnessDir(root);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HarnessRootRetiredError);
      const message = (err as HarnessRootRetiredError).message;
      expect(message).toContain("harness_dir");
      expect(message).toContain(join(root, ".mstarc"));
      expect(message).toContain("mstar path resolve");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .mstarc without harness_dir does not affect resolution", () => {
    const root = tmpRoot("path-fixed-rc-clean-");
    try {
      gitInit(root);
      mkdirSync(join(root, ".mstar"));
      writeFileSync(join(root, ".mstarc"), "[config]\nproject_dir=projects\n");
      expect(resolveHarnessDir(root)).toBe(join(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a retired declaration committed at main refuses from the linked worktree too", () => {
    const main = tmpRoot("path-fixed-mainrc-");
    const parent = tmpRoot("path-fixed-parenrc-");
    try {
      gitRepo(main);
      writeFileSync(join(main, ".mstarc"), "[config]\nharness_dir=.custom\n");
      git(["add", ".mstarc"], main);
      git(["commit", "-q", "-m", "declare"], main);
      const linked = join(parent, "linked");
      git(["worktree", "add", "-q", linked, "-b", "feature/linked-rc"], main);
      expect(() => resolveHarnessDir(linked)).toThrow(HarnessRootRetiredError);
      expect(() => resolveHarnessDir(main)).toThrow(HarnessRootRetiredError);
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("non-convention names are never adopted", () => {
    const root = tmpRoot("path-fixed-custom-");
    try {
      gitInit(root);
      mkdirSync(join(root, ".custom-root"));
      expect(resolveHarnessDir(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveHarnessDir — opts.harnessDir assertion", () => {
  test("a relative value resolves against startDir, verbatim and without probing", () => {
    const root = tmpRoot("path-opt-rel-");
    try {
      expect(resolveHarnessDir(root, { harnessDir: "custom" })).toBe(resolve(root, "custom"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absolute value is used as-is even when it does not exist", () => {
    const root = tmpRoot("path-opt-abs-");
    try {
      const custom = join(root, "not-yet-created");
      expect(resolveHarnessDir(root, { harnessDir: custom })).toBe(custom);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the assertion short-circuits before the retired-declaration refusal", () => {
    const root = tmpRoot("path-opt-rc-");
    try {
      gitInit(root);
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.custom\n");
      expect(resolveHarnessDir(root, { harnessDir: join(root, ".mstar") })).toBe(join(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MSTAR_HARNESS_DIR is ignored by the engine", () => {
    const root = tmpRoot("path-opt-env-");
    try {
      gitInit(root);
      mkdirSync(join(root, ".mstar"));
      const envDir = join(root, "env-harness");
      withEnv(envDir, () => {
        expect(resolveHarnessDir(root)).toBe(join(root, ".mstar"));
        const optDir = join(root, "opt-harness");
        expect(resolveHarnessDir(root, { harnessDir: optDir })).toBe(optDir);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveHarnessDir — localProbe boundary (roadmap §7c)", () => {
  test("(a) explicit workspaceRoot: a `.mstar` ABOVE the boundary is never returned", () => {
    const root = tmpRoot("path-boundary-a-");
    try {
      // why: "global" fixture: `.mstar` sits above the workspace root, exactly
      // like the `~/.mstar` CLI-install root the defect adopted.
      mkdirSync(join(root, ".mstar"));
      const workspace = join(root, "project");
      const probe = join(workspace, "src", "deep");
      mkdirSync(probe, { recursive: true });
      expect(resolveHarnessDir(probe, { localProbe: true, workspaceRoot: workspace })).toBeNull();
      // why: a harness BELOW the start still wins (never the fixture above).
      mkdirSync(join(workspace, ".mstar"));
      expect(resolveHarnessDir(probe, { localProbe: true, workspaceRoot: workspace })).toBe(resolve(workspace, ".mstar"));
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
      expect(resolveHarnessDir(probe, { localProbe: true, workspaceRoot: probe })).toBeNull();
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
      expect(resolveHarnessDir(probe, { localProbe: true, workspaceRoot: probe })).toBe(resolve(probe, ".mstar"));
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
      expect(resolveHarnessDir(probe, { localProbe: true, workspaceRoot: root })).toBe(resolve(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(c2) default git boundary: a `.git` repo-root harness still resolves from a subdir without explicit workspaceRoot", () => {
    const root = tmpRoot("path-boundary-c2-");
    try {
      // why: Real git repo fixture: the default local-probe boundary is `git
      // rev-parse --show-cdup` from the start dir = the repo root.
      gitInit(root);
      mkdirSync(join(root, ".mstar"));
      const probe = join(root, "src", "deep");
      mkdirSync(probe, { recursive: true });
      expect(resolveHarnessDir(probe, { localProbe: true })).toBe(resolve(root, ".mstar"));
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
      // why: tmp root is not a git repo → default boundary = start → null even
      // though `.mstar` exists one level up.
      expect(resolveHarnessDir(probe, { localProbe: true })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(d) opts.harnessDir still answers verbatim above the boundary", () => {
    const root = tmpRoot("path-boundary-d-");
    try {
      const workspace = join(root, "project");
      const probe = join(workspace, "src");
      mkdirSync(probe, { recursive: true });
      const outside = join(root, "outside-harness");
      mkdirSync(outside, { recursive: true });
      expect(resolveHarnessDir(probe, { localProbe: true, workspaceRoot: workspace, harnessDir: outside })).toBe(outside);
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
      // why: ".." = the parent of the start dir — a boundary at the tmp root.
      expect(resolveHarnessDir(probe, { localProbe: true, workspaceRoot: ".." })).toBe(resolve(root, ".mstar"));
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
      expect(resolveKnowledgeDir(join(root, ".mstar"), { create: false })).toBe(join(root, ".agents", "knowledge"));
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
      gitInit(root);
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
      gitInit(root);
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
      gitInit(root);
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
      gitInit(root);
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
      // why: The override walk stops at the harness dir's parent, so the
      // outer config does not apply.
      expect(resolveWorkflowDir(join(root, "proj"), { harnessDir: join(root, "proj", ".mstar") })).toBe(
        join(root, "proj", ".mstar", "workflows"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opts.harnessDir assertion: overrides resolve against the config", () => {
    const root = tmpRoot("path-wf-opt-");
    try {
      mkdirSync(join(root, "custom-harness"), { recursive: true });
      writeFileSync(join(root, ".mstarc"), "[config]\nworkflow_dir=runtime/wf\nproject_dir=store/projects\n");
      const opts = { harnessDir: join(root, "custom-harness") };
      expect(resolveWorkflowDir(root, opts)).toBe(join(root, "runtime", "wf"));
      expect(resolveProjectDir(root, opts)).toBe(join(root, "store", "projects"));
      // why: No declaration: defaults compose under the asserted harness dir.
      writeFileSync(join(root, ".mstarc"), "[config]\n");
      expect(resolveWorkflowDir(root, opts)).toBe(join(root, "custom-harness", "workflows"));
      expect(resolveProjectDir(root, opts)).toBe(join(root, "custom-harness", "projects"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MSTAR_HARNESS_DIR is ignored by the engine", () => {
    const root = tmpRoot("path-wf-env-");
    try {
      gitInit(root);
      mkdirSync(join(root, ".mstar"), { recursive: true });
      writeFileSync(join(root, ".mstarc"), "[config]\nworkflow_dir=runtime/wf\nproject_dir=store/projects\n");
      withEnv(join(root, "custom-harness"), () => {
        // why: The env pin must not redirect the fixed root.
        expect(resolveWorkflowDir(root)).toBe(join(root, "runtime", "wf"));
        expect(resolveProjectDir(root)).toBe(join(root, "store", "projects"));
        writeFileSync(join(root, ".mstarc"), "[config]\n");
        expect(resolveWorkflowDir(root)).toBe(join(root, ".mstar", "workflows"));
        expect(resolveProjectDir(root)).toBe(join(root, ".mstar", "projects"));
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("no harness dir → throws (fail closed, no silent default)", () => {
    const root = tmpRoot("path-wf-none-");
    try {
      gitInit(root);
      expect(() => resolveWorkflowDir(root)).toThrow(/harness dir not found/);
      expect(() => resolveProjectDir(root)).toThrow(/harness dir not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveReviewDir / review-run dir names ({REVIEW_DIR}, review-report contract §1/§2)", () => {
  test("defaults to {HARNESS_DIR}/reviews; a .mstarc review_dir wins (relative and absolute)", () => {
    const root = tmpRoot("path-review-dir-");
    try {
      gitInit(root);
      mkdirSync(join(root, ".mstar"), { recursive: true });
      expect(resolveReviewDir(root)).toBe(join(root, ".mstar", "reviews"));

      writeFileSync(join(root, ".mstarc"), "[config]\nreview_dir=process/reviews\n");
      expect(resolveReviewDir(root)).toBe(join(root, "process", "reviews"));

      const absolute = join(root, "elsewhere", "reviews");
      writeFileSync(join(root, ".mstarc"), `[config]\nreview_dir=${absolute}\n`);
      expect(resolveReviewDir(root)).toBe(absolute);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no harness dir → throws (fail closed, no silent default)", () => {
    const root = tmpRoot("path-review-none-");
    try {
      gitInit(root);
      expect(() => resolveReviewDir(root)).toThrow(/harness dir not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reviewRunDirName shapes every variant (date, level, round, slug, short sha)", () => {
    expect(reviewRunDirName("2026-08-24", { kind: "codebase", level: "standard", round: 2 })).toBe(
      "2026-08-24-codebase-standard-2",
    );
    expect(reviewRunDirName("2026-08-24", { kind: "pr", n: 134 })).toBe("2026-08-24-pr134");
    expect(reviewRunDirName("2026-08-24", { kind: "branch", slug: "feat-x" })).toBe("2026-08-24-branch-feat-x");
    expect(reviewRunDirName("2026-08-24", { kind: "diff", headSha: "abc1234def5678" })).toBe("2026-08-24-diff-abc1234");
 // Absent OR empty headSha => the bare `-diff` name; never fabricated.
    expect(reviewRunDirName("2026-08-24", { kind: "diff" })).toBe("2026-08-24-diff");
    expect(reviewRunDirName("2026-08-24", { kind: "diff", headSha: "" })).toBe("2026-08-24-diff");
  });

  test("reviewRunDirName rejects an invalid date, level, round, pr n and unsafe slug", () => {
    for (const date of ["20260824", "2026-8-24", ""]) {
      expect(() => reviewRunDirName(date, { kind: "pr", n: 1 })).toThrow(/YYYY-MM-DD/);
    }
    expect(() =>
      reviewRunDirName("2026-08-24", { kind: "codebase", level: "shallow" as unknown as ReviewRunLevel, round: 1 }),
    ).toThrow(/quick \| standard \| deep/);
    for (const round of [0, -1, 1.5]) {
      expect(() => reviewRunDirName("2026-08-24", { kind: "codebase", level: "quick", round })).toThrow(/positive integer/);
    }
    for (const n of [0, -2, 1.5]) {
      expect(() => reviewRunDirName("2026-08-24", { kind: "pr", n })).toThrow(/positive integer/);
    }
    for (const slug of ["", "..", "a/b", "a\\b"]) {
      expect(() => reviewRunDirName("2026-08-24", { kind: "branch", slug })).toThrow(/single safe path component/);
    }
  });

  test("resolveReviewRunDir allocates the next codebase round and never creates anything", () => {
    const root = tmpRoot("path-review-run-");
    try {
      const reviews = join(root, "reviews");
 // No reviews dir yet: round 1 — and no listing read creates it.
      expect(
        resolveReviewRunDir({ reviewsDir: reviews, date: "2026-08-24", spec: { kind: "codebase", level: "standard" } }),
      ).toBe(join(reviews, "2026-08-24-codebase-standard-1"));
      expect(existsSync(reviews)).toBe(false);

      mkdirSync(join(reviews, "2026-08-24-codebase-standard-1"), { recursive: true });
      mkdirSync(join(reviews, "2026-08-24-codebase-standard-3"), { recursive: true });
 // A gap is never filled: the highest round present + 1.
      expect(
        resolveReviewRunDir({ reviewsDir: reviews, date: "2026-08-24", spec: { kind: "codebase", level: "standard" } }),
      ).toBe(join(reviews, "2026-08-24-codebase-standard-4"));
 // An explicit round is that exact directory (a session reusing its own run).
      expect(
        resolveReviewRunDir({ reviewsDir: reviews, date: "2026-08-24", spec: { kind: "codebase", level: "standard", round: 2 } }),
      ).toBe(join(reviews, "2026-08-24-codebase-standard-2"));
 // Levels allocate on their own ladder.
      expect(
        resolveReviewRunDir({ reviewsDir: reviews, date: "2026-08-24", spec: { kind: "codebase", level: "deep" } }),
      ).toBe(join(reviews, "2026-08-24-codebase-deep-1"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolveReviewRunDir is deterministic + idempotent for pr/branch/diff, and defaults the date locally", () => {
    const root = tmpRoot("path-review-deterministic-");
    try {
      const reviews = join(root, "reviews");
      expect(resolveReviewRunDir({ reviewsDir: reviews, date: "2026-08-24", spec: { kind: "pr", n: 7 } })).toBe(
        join(reviews, "2026-08-24-pr7"),
      );
      expect(resolveReviewRunDir({ reviewsDir: reviews, date: "2026-08-24", spec: { kind: "branch", slug: "topic" } })).toBe(
        join(reviews, "2026-08-24-branch-topic"),
      );
      expect(resolveReviewRunDir({ reviewsDir: reviews, date: "2026-08-24", spec: { kind: "diff", headSha: "deadbee1234" } })).toBe(
        join(reviews, "2026-08-24-diff-deadbee"),
      );

      const today = new Date();
      const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      expect(resolveReviewRunDir({ reviewsDir: reviews, spec: { kind: "pr", n: 1 } })).toBe(join(reviews, `${local}-pr1`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveSpecsDir (plan-conventions § {SPECS_DIR} 解析)", () => {
  test("candidate order: .agents/specs → docs/specs → repo-root specs → legacy {HARNESS_DIR}/specs", () => {
    const root = tmpRoot("path-specs-order-");
    try {
      const harness = join(root, ".mstar");
      mkdirSync(join(harness, "specs"), { recursive: true });
      writeFileSync(join(harness, "specs", "spec.md"), "# spec\n");
      expect(resolveSpecsDir(harness, { create: false })).toBe(join(harness, "specs"));

      mkdirSync(join(root, "specs"), { recursive: true });
      writeFileSync(join(root, "specs", "spec.md"), "# spec\n");
      expect(resolveSpecsDir(harness, { create: false })).toBe(join(root, "specs"));

      mkdirSync(join(root, "docs", "specs"), { recursive: true });
      writeFileSync(join(root, "docs", "specs", "spec.md"), "# spec\n");
      expect(resolveSpecsDir(harness, { create: false })).toBe(join(root, "docs", "specs"));

      mkdirSync(join(root, ".agents", "specs"), { recursive: true });
      writeFileSync(join(root, ".agents", "specs", "spec.md"), "# spec\n");
      expect(resolveSpecsDir(harness, { create: false })).toBe(join(root, ".agents", "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty {HARNESS_DIR}/specs is treated as absent → docs/specs (legacy dir never wins by existing)", () => {
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

  test("no .mstarc, empty repo → creates <repoRoot>/.agents/specs", () => {
    const root = tmpRoot("path-specs-default-");
    try {
      const specsDir = resolveSpecsDir(join(root, ".mstar"));
      expect(specsDir).toBe(join(root, ".agents", "specs"));
      expect(readdirSync(specsDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("create: false performs no filesystem writes", () => {
    const root = tmpRoot("path-specs-nocreate-");
    try {
      const specsDir = resolveSpecsDir(join(root, ".mstar"), { create: false });
      expect(specsDir).toBe(join(root, ".agents", "specs"));
      expect(() => readdirSync(specsDir)).toThrow();
      expect(existsSync(join(root, ".agents"))).toBe(false);
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

  test("empty legacy repo-root designs/ is skipped → default-creates <repoRoot>/.agents/specs", () => {
    const root = tmpRoot("path-specs-designs-empty-");
    try {
      mkdirSync(join(root, ".mstar", "designs"), { recursive: true });
      mkdirSync(join(root, "designs"), { recursive: true });
      const specsDir = resolveSpecsDir(join(root, ".mstar"));
      expect(specsDir).toBe(join(root, ".agents", "specs"));
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
      expect(specsDir).toBe(join(root, ".agents", "specs"));
      expect(() => readdirSync(specsDir)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveSpecsDir — tracked `.agents/specs` rung", () => {
  test("empty {HARNESS_DIR}/specs falls through to <repoRoot>/.agents/specs", () => {
    const root = tmpRoot("path-specs-agents-");
    try {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      mkdirSync(join(root, ".agents", "specs"), { recursive: true });
      writeFileSync(join(root, ".agents", "specs", "spec.md"), "# spec\n");
      expect(resolveSpecsDir(join(root, ".mstar"))).toBe(join(root, ".agents", "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-empty .agents/specs wins over a non-empty legacy {HARNESS_DIR}/specs", () => {
    const root = tmpRoot("path-specs-agents-precedence-");
    try {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "spec.md"), "# spec\n");
      mkdirSync(join(root, ".agents", "specs"), { recursive: true });
      writeFileSync(join(root, ".agents", "specs", "other.md"), "# other\n");
      expect(resolveSpecsDir(join(root, ".mstar"))).toBe(join(root, ".agents", "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a `.agents` harness reaches its own specs dir by the empty-dir rule (candidate dedupe)", () => {
    const root = tmpRoot("path-specs-agents-harness-");
    try {
      // `<repo>/.agents/specs` and `{HARNESS_DIR}/specs` are the same directory
      // here; an empty one must still fall through, not be returned twice.
      mkdirSync(join(root, ".agents", "specs"), { recursive: true });
      mkdirSync(join(root, "docs", "specs"), { recursive: true });
      writeFileSync(join(root, "docs", "specs", "spec.md"), "# spec\n");
      expect(resolveSpecsDir(join(root, ".agents"))).toBe(join(root, "docs", "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveKnowledgeDir (plan-conventions § 路径符号 / tracked-results chain)", () => {
  test("no .mstarc, empty repo → creates <repoRoot>/.agents/knowledge", () => {
    const root = tmpRoot("path-knowledge-default-");
    try {
      const dir = resolveKnowledgeDir(join(root, ".mstar"));
      expect(dir).toBe(join(root, ".agents", "knowledge"));
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-empty .agents/knowledge wins over a non-empty legacy {HARNESS_DIR}/knowledge", () => {
    const root = tmpRoot("path-knowledge-first-");
    try {
      mkdirSync(join(root, ".mstar", "knowledge"), { recursive: true });
      writeFileSync(join(root, ".mstar", "knowledge", "kb.md"), "# kb\n");
      mkdirSync(join(root, ".agents", "knowledge"), { recursive: true });
      writeFileSync(join(root, ".agents", "knowledge", "tracked.md"), "# tracked\n");
      expect(resolveKnowledgeDir(join(root, ".mstar"))).toBe(join(root, ".agents", "knowledge"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy {HARNESS_DIR}/knowledge is still read when nothing preferred exists, and never created", () => {
    const root = tmpRoot("path-knowledge-legacy-");
    try {
      const legacy = join(root, ".mstar", "knowledge");
      expect(resolveKnowledgeDir(join(root, ".mstar"), { create: false })).toBe(join(root, ".agents", "knowledge"));
      expect(existsSync(join(root, ".agents"))).toBe(false);

      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "kb.md"), "# kb\n");
      expect(resolveKnowledgeDir(join(root, ".mstar"), { create: false })).toBe(legacy);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("create: false performs no filesystem writes", () => {
    const root = tmpRoot("path-knowledge-nocreate-");
    try {
      const dir = resolveKnowledgeDir(join(root, ".mstar"), { create: false });
      expect(dir).toBe(join(root, ".agents", "knowledge"));
      expect(existsSync(join(root, ".agents"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`.mstarc knowledge_dir` stays authoritative over a non-empty `.agents/knowledge`", () => {
    const root = tmpRoot("path-knowledge-declared-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nknowledge_dir=docs/knowledge\n");
      mkdirSync(join(root, ".agents", "knowledge"), { recursive: true });
      writeFileSync(join(root, ".agents", "knowledge", "tracked.md"), "# tracked\n");
      expect(resolveKnowledgeDir(join(root, ".mstar"), { create: false })).toBe(join(root, "docs", "knowledge"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveAdrDir (tracked-results chain)", () => {
  test("candidate order: .agents/adr → docs/adr → legacy {HARNESS_DIR}/adr", () => {
    const root = tmpRoot("path-adr-chain-");
    try {
      const harness = join(root, ".mstar");
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(join(root, "docs", "adr", "0001.md"), "# adr\n");
      expect(resolveAdrDir(harness, { create: false })).toBe(join(root, "docs", "adr"));

      mkdirSync(join(root, ".agents", "adr"), { recursive: true });
      writeFileSync(join(root, ".agents", "adr", "0002.md"), "# adr\n");
      expect(resolveAdrDir(harness, { create: false })).toBe(join(root, ".agents", "adr"));

      rmSync(join(root, ".agents", "adr"), { recursive: true, force: true });
      expect(resolveAdrDir(harness, { create: false })).toBe(join(root, "docs", "adr"));

      rmSync(join(root, "docs", "adr"), { recursive: true, force: true });
      mkdirSync(join(harness, "adr"), { recursive: true });
      writeFileSync(join(harness, "adr", "0003.md"), "# adr\n");
      expect(resolveAdrDir(harness, { create: false })).toBe(join(harness, "adr"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-empty .agents/adr beats a non-empty docs/adr", () => {
    const root = tmpRoot("path-adr-agents-first-");
    try {
      mkdirSync(join(root, ".agents", "adr"), { recursive: true });
      writeFileSync(join(root, ".agents", "adr", "0001.md"), "# adr\n");
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(join(root, "docs", "adr", "0002.md"), "# adr\n");
      expect(resolveAdrDir(join(root, ".mstar"), { create: false })).toBe(join(root, ".agents", "adr"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty candidate counts as absent (empty-dir rule)", () => {
    const root = tmpRoot("path-adr-empty-");
    try {
      const harness = join(root, ".mstar");
      mkdirSync(join(harness, "adr", "empty-sub"), { recursive: true });
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(join(root, "docs", "adr", "0001.md"), "# adr\n");
      expect(resolveAdrDir(harness, { create: false })).toBe(join(root, "docs", "adr"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("all candidates absent → creates <repoRoot>/.agents/adr; create: false writes nothing", () => {
    const root = tmpRoot("path-adr-fallback-");
    try {
      const dir = resolveAdrDir(join(root, ".mstar"));
      expect(dir).toBe(join(root, ".agents", "adr"));
      expect(existsSync(dir)).toBe(true);
      expect(resolveAdrDir(join(root, ".mstar"), { create: false })).toBe(dir);
      expect(existsSync(join(root, ".mstar", "adr"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("create: false performs no filesystem writes", () => {
    const root = tmpRoot("path-adr-nocreate-");
    try {
      const dir = resolveAdrDir(join(root, ".mstar"), { create: false });
      expect(dir).toBe(join(root, ".agents", "adr"));
      expect(existsSync(join(root, ".agents"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`.mstarc adr_dir` is authoritative", () => {
    const root = tmpRoot("path-adr-declared-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nadr_dir=docs/decisions\n");
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(join(root, "docs", "adr", "0001.md"), "# adr\n");
      expect(resolveAdrDir(join(root, ".mstar"), { create: false })).toBe(join(root, "docs", "decisions"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolvers — `repoRoot` anchors the `.agents/` default to a checkout", () => {
  test("a harness outside the checkout keeps the created corpus inside it, not beside the harness", () => {
    const root = tmpRoot("path-repo-root-anchor-");
    try {
      const checkout = join(root, "checkout");
      const harness = join(root, "state", "harness");
      mkdirSync(checkout, { recursive: true });
      expect(resolveSpecsDir(harness, { repoRoot: checkout })).toBe(join(checkout, ".agents", "specs"));
      expect(existsSync(join(checkout, ".agents", "specs"))).toBe(true);
      expect(resolveKnowledgeDir(harness, { repoRoot: checkout })).toBe(join(checkout, ".agents", "knowledge"));
      expect(resolveAdrDir(harness, { repoRoot: checkout })).toBe(join(checkout, ".agents", "adr"));
      // Nothing is created beside the harness: that directory is not a checkout.
      expect(existsSync(join(root, "state", ".agents"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`repoRoot` also anchors the candidate chain, so a checkout's docs/specs wins", () => {
    const root = tmpRoot("path-repo-root-chain-");
    try {
      const checkout = join(root, "checkout");
      const harness = join(root, "state", "harness");
      mkdirSync(join(checkout, "docs", "specs"), { recursive: true });
      writeFileSync(join(checkout, "docs", "specs", "spec.md"), "# spec\n");
      // Without an anchor the chain looks beside the harness and creates a
      // default there; the anchor must make the checkout's own rung win.
      expect(resolveSpecsDir(harness, { create: false, repoRoot: checkout })).toBe(join(checkout, "docs", "specs"));
      expect(existsSync(join(root, "state", ".agents"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an omitted `repoRoot` keeps the harness dir's parent as the anchor", () => {
    const root = tmpRoot("path-repo-root-omitted-");
    try {
      const harness = join(root, ".mstar");
      expect(resolveSpecsDir(harness, { create: false })).toBe(join(root, ".agents", "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`.mstarc` stays authoritative when a `repoRoot` is passed", () => {
    const root = tmpRoot("path-repo-root-declared-");
    try {
      const checkout = join(root, "checkout");
      const harness = join(root, ".mstar");
      mkdirSync(checkout, { recursive: true });
      writeFileSync(join(root, ".mstarc"), "[config]\nspecs_dir=docs/specs\n");
      expect(resolveSpecsDir(harness, { create: false, repoRoot: checkout })).toBe(join(root, "docs", "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scaffoldHarness", () => {
  test("a linked checkout scaffolds the main worktree, never its own tree", async () => {
    const root = tmpRoot("path-scaffold-linked-");
    try {
      gitInit(root);
      git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], root);
      const linked = join(root, ".worktree-task");
      git(["worktree", "add", "-q", linked, "-b", "feature/linked-scaffold"], root);
      expect(resolveScaffoldDirs(linked).harnessDir).toBe(join(realpathSync(root), ".mstar"));
      await scaffoldHarness(linked);
      expect(existsSync(join(root, ".mstar"))).toBe(true);
      expect(existsSync(join(linked, ".mstar"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("creates the process dirs, the tracked corpora and the .mstarc declaration without writing status.json", async () => {
    const root = tmpRoot("path-scaffold-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const harnessDir = await scaffoldHarness(root);
      expect(harnessDir).toBe(resolve(root, ".mstar"));
      expect(readdirSync(harnessDir).sort()).toEqual([
        "iterations", "plans", "projects", "reviews", "sdd",
      ]);
      expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
      // Tracked results live outside the process root.
      for (const dir of ["knowledge", "specs", "adr"]) {
        expect(existsSync(join(root, ".agents", dir))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fresh scaffold stores at {harness}/store.db, not the `plans/` child (I-000270)", async () => {
    const root = tmpRoot("path-scaffold-store-path-");
    try {
      gitInit(root);
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const scaffolded = await scaffoldHarness(root);
      // Canonical form: discovery shells `git` (readMainWorktree), which
      // returns the real path, so the literal tmpdir path would not compare.
      const harnessDir = realpathSync(scaffolded);
      const discovered = resolveProcessHarnessDir(root);
      expect(discovered).toBe(harnessDir);
      expect(existsSync(join(harnessDir, "plans"))).toBe(true);

      // The store init the commands perform, against that resolved root.
      const initialized = await initializeStore({ harnessDir: discovered! });
      initialized.close();
      expect(existsSync(join(harnessDir, "store.db"))).toBe(true);
      expect(existsSync(join(harnessDir, "plans", "store.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes .mstarc at the repo root declaring only the corpus layout (no harness_dir)", async () => {
    const root = tmpRoot("path-scaffold-mstarc-write-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const harnessDir = await scaffoldHarness(root);
      const text = readFileSync(join(root, ".mstarc"), "utf8");
      const config = parseMstarc(text);
      // The root is fixed: the retired key is never written (ADR 2026-11-20).
      expect(text).not.toContain("harness_dir");
      expect(config.harnessDir).toBeUndefined();
      expect(config.knowledgeDir).toBe(".agents/knowledge");
      expect(config.specsDir).toBe(".agents/specs");
      expect(config.adrDir).toBe(".agents/adr");
      // The declaration is authoritative: the resolvers land on `.agents/*`.
      expect(resolveKnowledgeDir(harnessDir, { create: false })).toBe(join(root, ".agents", "knowledge"));
      expect(resolveSpecsDir(harnessDir, { create: false })).toBe(join(root, ".agents", "specs"));
      expect(resolveAdrDir(harnessDir, { create: false })).toBe(join(root, ".agents", "adr"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an options.harnessDir that differs from the fixed root is refused", async () => {
    const root = tmpRoot("path-scaffold-mstarc-mismatch-");
    try {
      const nested = join(root, "runtime", "harness");
      await expect(scaffoldHarness(root, { harnessDir: nested })).rejects.toThrow(HarnessRootRetiredError);
      // why: Nothing was scaffolded at the refused location.
      expect(existsSync(join(root, "runtime"))).toBe(false);
      // why: The equal assertion is accepted.
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const harnessDir = await scaffoldHarness(root, { harnessDir: join(root, ".mstar") });
      expect(harnessDir).toBe(join(root, ".mstar"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolveScaffoldDirs asserts the fixed root and resolves project_dir independently", () => {
    const root = tmpRoot("path-scaffolddirs-");
    try {
      expect(resolveScaffoldDirs(root)).toEqual({
        harnessDir: join(root, ".mstar"),
        projectDir: join(root, ".mstar", "projects"),
      });
      expect(resolveScaffoldDirs(root, { harnessDir: join(root, ".mstar") }).harnessDir).toBe(join(root, ".mstar"));
      expect(() => resolveScaffoldDirs(root, { harnessDir: join(root, "elsewhere") })).toThrow(HarnessRootRetiredError);
      writeFileSync(join(root, ".mstarc"), "[config]\nproject_dir=process/projects\n");
      expect(resolveScaffoldDirs(root)).toEqual({
        harnessDir: join(root, ".mstar"),
        projectDir: join(root, "process", "projects"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .mstarc declaring harness_dir refuses the scaffold and names the line", async () => {
    const root = tmpRoot("path-scaffold-mstarc-retired-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.custom\n", "utf8");
      setArtifactStore(createFsStore(resolve(root, ".custom")));
      await expect(scaffoldHarness(root)).rejects.toThrow(HarnessRootRetiredError);
      await expect(scaffoldHarness(root)).rejects.toThrow(/harness_dir/);
      // why: Nothing was created at the retired location or at the fixed root.
      expect(existsSync(join(root, ".custom"))).toBe(false);
      expect(existsSync(join(root, ".mstar"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MSTAR_HARNESS_DIR does not redirect the scaffold target", async () => {
    const root = tmpRoot("path-scaffold-mstarc-env-");
    try {
      const custom = join(root, "env-harness");
      const previous = process.env[ENV_KEY];
      process.env[ENV_KEY] = custom;
      try {
        setArtifactStore(createFsStore(resolve(root, ".mstar")));
        const harnessDir = await scaffoldHarness(root);
        expect(harnessDir).toBe(join(root, ".mstar"));
        expect(existsSync(custom)).toBe(false);
      } finally {
        if (previous === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = previous;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an existing .mstarc is authoritative and never rewritten", async () => {
    const root = tmpRoot("path-scaffold-mstarc-present-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nadr_dir=docs/adr\n", "utf8");
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      await scaffoldHarness(root);
      expect(readFileSync(join(root, ".mstarc"), "utf8")).toBe("[config]\nadr_dir=docs/adr\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  // Bootstrap is greenfield: a legacy `{HARNESS_DIR}/adr/` that merely exists
  // must not be adopted as the declared target — the resolver would pick it
  // and the `.mstarc` would then point at a path a gitignored `.mstar/` cannot
  // carry into a commit, with the templates seeded into it.
  test("never adopts a populated .mstar/adr: declares and seeds .agents/adr instead", async () => {
    const root = tmpRoot("path-scaffold-legacy-adr-");
    try {
      const legacyAdr = join(root, ".mstar", "adr");
      mkdirSync(legacyAdr, { recursive: true });
      writeFileSync(join(legacyAdr, "0001-legacy.md"), "# ADR: legacy\n", "utf8");
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      await scaffoldHarness(root);

      const config = parseMstarc(readFileSync(join(root, ".mstarc"), "utf8"));
      expect(config.adrDir).toBe(".agents/adr");
      // The templates land in the declared dir, not in the legacy one.
      for (const bucket of ["proposed", "implemented"]) {
        expect(existsSync(join(root, ".agents", "adr", bucket, "TEMPLATE.md"))).toBe(true);
      }
      expect(existsSync(join(root, ".agents", "adr", "README.md"))).toBe(true);
      // The legacy tree is read-only for the scaffold: same entries, same bytes.
      expect(readdirSync(legacyAdr)).toEqual(["0001-legacy.md"]);
      expect(readFileSync(join(legacyAdr, "0001-legacy.md"), "utf8")).toBe("# ADR: legacy\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A declared corpus is authoritative: the scaffold seeds where the
  // repository already writes instead of creating a second tree beside it.
  test("seeds a declared adr_dir and never creates the .agents default", async () => {
    const root = tmpRoot("path-scaffold-declared-adr-");
    try {
      const authored = "[config]\nadr_dir=docs/adr\n";
      writeFileSync(join(root, ".mstarc"), authored, "utf8");
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      await scaffoldHarness(root);

      for (const bucket of ["proposed", "implemented"]) {
        expect(existsSync(join(root, "docs", "adr", bucket, "TEMPLATE.md"))).toBe(true);
      }
      expect(existsSync(join(root, "docs", "adr", "README.md"))).toBe(true);
      // The declared path is the only ADR tree the scaffold touches.
      expect(existsSync(join(root, ".agents", "adr"))).toBe(false);
      // The two undeclared corpora keep the greenfield default.
      expect(existsSync(join(root, ".agents", "knowledge"))).toBe(true);
      expect(existsSync(join(root, ".agents", "specs"))).toBe(true);
      // The author's declaration is authoritative and never rewritten.
      expect(readFileSync(join(root, ".mstarc"), "utf8")).toBe(authored);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("seeds the ADR tree: README, both templates and the four buckets", async () => {
    const root = tmpRoot("path-scaffold-adr-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      await scaffoldHarness(root);
      const adrDir = join(root, ".agents", "adr");
      expect(readdirSync(adrDir).sort()).toEqual(["README.md", "archived", "implemented", "proposed", "rejected"]);
      expect(existsSync(join(adrDir, "proposed", "TEMPLATE.md"))).toBe(true);
      expect(existsSync(join(adrDir, "implemented", "TEMPLATE.md"))).toBe(true);
      const readme = readFileSync(join(adrDir, "README.md"), "utf8");
      for (const bucket of ["proposed/", "implemented/", "rejected/", "archived/"]) {
        expect(readme).toContain(bucket);
      }
      // Class dirs arrive with the first record of that class.
      expect(readdirSync(join(adrDir, "proposed"))).toEqual(["TEMPLATE.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The embedded skeletons claim to be verbatim copies of this repository's
  // owning templates. The expected bytes come from those files at test time,
  // so an edit to one side alone names the sync duty it broke.
  test("scaffolded ADR templates equal their owning docs/adr/*/TEMPLATE.md", async () => {
    const root = tmpRoot("path-scaffold-adr-template-sync-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      await scaffoldHarness(root);
      const repoRoot = findRepoRoot();
      for (const bucket of ["proposed", "implemented"]) {
        expect(readFileSync(join(root, ".agents", "adr", bucket, "TEMPLATE.md"), "utf8")).toBe(
          readFileSync(join(repoRoot, "docs", "adr", bucket, "TEMPLATE.md"), "utf8"),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rerun creates nothing and rewrites nothing", async () => {
    const root = tmpRoot("path-scaffold-rerun-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      await scaffoldHarness(root);
      const mstarc = readFileSync(join(root, ".mstarc"), "utf8");
      const readme = readFileSync(join(root, ".agents", "adr", "README.md"), "utf8");
      await scaffoldHarness(root);
      expect(readFileSync(join(root, ".mstarc"), "utf8")).toBe(mstarc);
      expect(readFileSync(join(root, ".agents", "adr", "README.md"), "utf8")).toBe(readme);
      expect(readdirSync(join(root, ".agents", "adr")).sort()).toEqual([
        "README.md", "archived", "implemented", "proposed", "rejected",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prebuilds the _default project directory without creating a roadmap or register", async () => {
    const root = tmpRoot("path-scaffold-project-");
    try {
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      const harnessDir = await scaffoldHarness(root);
      const projectDir = join(harnessDir, "projects", "_default");
      expect(existsSync(projectDir)).toBe(true);
      expect(readdirSync(projectDir)).toEqual([]);
      expect(existsSync(join(projectDir, "roadmap.md"))).toBe(false);
      expect(existsSync(join(projectDir, "residuals.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defers _default catalog registration when the existing store is staged", async () => {
    const root = tmpRoot("path-scaffold-staged-store-");
    const context = { harnessDir: resolve(root, ".mstar") };
    try {
      mkdirSync(context.harnessDir, { recursive: true });
      const initialized = await initializeStore(context);
      initialized.close();
      const handle = await openStore(context, "write");
      handle.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
      handle.close();

      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      await scaffoldHarness(root);

      const staged = await openStore(context, "read");
      const defaultProject = staged.db
        .prepare("select id from catalog_entities where kind = 'project' and id = '_default'")
        .get();
      staged.close();
      expect(defaultProject).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a .mstarc harness_dir when resolving the scaffold target", async () => {
    const root = tmpRoot("path-scaffold-mstarc-harness-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.custom\n", "utf8");
      setArtifactStore(createFsStore(resolve(root, ".custom")));
      await expect(scaffoldHarness(root)).rejects.toThrow(HarnessRootRetiredError);
      expect(existsSync(join(root, ".custom"))).toBe(false);
      expect(existsSync(join(root, ".mstar"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  test("preserves historical scaffold-location content and legacy register without adopting them", async () => {
    const root = tmpRoot("path-scaffold-idem-project-");
    try {
      const historicalProjectDir = join(root, ".mstar", "projects", "_default");
      mkdirSync(historicalProjectDir, { recursive: true });
      const roadmapPath = join(historicalProjectDir, "roadmap.md");
      const registerPath = join(historicalProjectDir, "residuals.json");
      const customRoadmap = `---
project_id: _default
title: Historical Roadmap
status: active
created_at: 2026-08-01
---

## Direction

Custom direction.
`;
      const customRegister = '{\n  "entries": {}\n}\n';
      writeFileSync(roadmapPath, customRoadmap);
      writeFileSync(registerPath, customRegister);
      setArtifactStore(createFsStore(resolve(root, ".mstar")));
      await scaffoldHarness(root);
      await scaffoldHarness(root);
      // Bootstrap retains the author's direction and does not adopt the legacy register.
      expect(readFileSync(roadmapPath, "utf8")).toContain("Custom direction.");
      expect(readJson(registerPath)).toEqual(JSON.parse(customRegister));
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
        "# Morning Star harness (.mstar/)\nnode_modules\ndist/\n",
      );
      const result = validateGitignore(root);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("gitignore.missing-entries");
      expect(result.severity).toBe("medium");
      // Unknown kind — the diagnostic reports the default .mstar/ set, which
      // is the process root alone: tracked results live outside it.
      expect(result.message).toContain(".mstar/");
      expect(emitGitignoreSnippet("mstar").split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#")))
        .toEqual([".mstar/"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("harness root declaration", () => {
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

  test("declared-file validation retains authored directives and creates no files", () => {
    const root = tmpRoot("path-decl-readonly-");
    try {
      const authored = "# mine\r\nnode_modules\r\n.mstar/**\r\ndist/\r\n.mstar/**\r\n!.mstar/specs/**";
      writeFileSync(join(root, ".gitignore"), authored);
      const result = validateGitignore(root);
      expect(result.ok).toBe(true);
      expect(result.code).toBe("gitignore.author-declared");
      const retained = readFileSync(join(root, ".gitignore"), "utf8");
      expect(retained).toContain("# mine");
      expect(retained).toContain("node_modules");
      expect(retained).toContain("!.mstar/specs/**");
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
    const skillPath = join(repoRoot, "skills", "mstar-conventions", "references", "git-tracking-and-gitignore.md");
    expect(emitGitignoreSnippet("mstar")).toBe(gitignoreFence(skillPath, 0));
  });

  test("emitGitignoreSnippet(\"agents\") is byte-identical to the plan-conventions legacy .agents/ fence", () => {
    const skillPath = join(repoRoot, "skills", "mstar-conventions", "references", "git-tracking-and-gitignore.md");
    expect(emitGitignoreSnippet("agents")).toBe(gitignoreFence(skillPath, 1));
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

