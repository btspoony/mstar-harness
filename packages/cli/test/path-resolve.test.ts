/**
 * CLI `mstar path resolve` — {HARNESS_DIR} + {SPECS_DIR} + {WORKFLOW_DIR} +
 * {PROJECT_DIR} resolution wrapper.
 *
 * Thin wrapper over engine `path.resolveHarnessDir` + `path.resolveSpecsDir`
 * + `path.resolveWorkflowDir` + `path.resolveProjectDir`
 * (plan-conventions § 路径符号 / § {HARNESS_DIR} 解析顺序 / § {SPECS_DIR} 解析;
 * compass ruling 4 — the v3 workflow/project dirs join the path-symbol SSOT):
 * - Exit 0 returns resolved directories in a structured CLI envelope.
 * - Refusal with guidance when no harness dir resolves from the start dir.
 * - Specs resolution is read-only: `mstar path resolve` never creates
 *   `{HARNESS_DIR}/specs/` as a side effect.
 *
 * Each case runs the real CLI as a subprocess against a temp fixture tree.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface PathEnvelope {
  command: string;
  status: "ok" | "refused" | "usage" | "error";
  code: string;
  message?: string;
  data?: {
    startDir: string;
    harnessDir: string;
    specsDir: string;
    workflowDir: string;
    projectDir: string;
  };
}

function envelope(result: RunResult): PathEnvelope {
  return JSON.parse(result.stdout) as PathEnvelope;
}

function data(result: RunResult): NonNullable<PathEnvelope["data"]> {
  const value = envelope(result).data;
  if (!value) throw new Error("expected path resolution data");
  return value;
}

/**
 * Spawn env with ambient MSTAR_HARNESS_DIR pinned out: the CLI
 * resolves harness dirs from that env var ahead of probing, so an ambient
 * value would redirect every fixture to the env dir and fail spuriously.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runResolve(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", "src/index.ts", "path", "resolve", ...args], {
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Empty temp root; `.mstar/` and specs content added per test. */
function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mstar-path-resolve-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Minimal valid git work tree (no `git init` subprocess): the engine's
 * default CLI boundary runs `git rev-parse --show-cdup`, which only needs a
 * valid `.git` layout (HEAD + config + objects/ + refs/) — no commits.
 * Mirrors the engine path.test.ts `gitInit` fixture.
 */
function gitInit(root: string): void {
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, ".git", "refs"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
}

describe("mstar path resolve — harness/specs dir resolution", () => {
  test(".mstar/ present → exit 0, prints harness + specs dirs", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(envelope(result)).toMatchObject({ command: "path.resolve", status: "ok" });
      expect(data(result).harnessDir).toBe(join(root, ".mstar"));
      expect(data(result).specsDir).toBe(join(root, ".mstar", "specs"));
    });
  });

  test("resolves upward from a nested start dir inside a git top-level (explicit [path] arg)", () => {
    withRoot((root) => {
      // Real git repo fixture: default boundary = git top-level of the start
      // dir, so a harness at the repo root resolves from a nested subdir.
      gitInit(root);
      mkdirSync(join(root, ".mstar"), { recursive: true });
      mkdirSync(join(root, "nested", "deep"), { recursive: true });
      const result = runResolve([join(root, "nested", "deep")]);
      expect(result.exitCode).toBe(0);
      expect(data(result).harnessDir).toBe(join(root, ".mstar"));
    });
  });

  test("harness only above the git top-level (global ~/.mstar collision) → exit 1", () => {
    withRoot((root) => {
      // `.mstar` sits one level ABOVE the git top-level (`root/proj`) — the
      // engine boundary must stop the probe at the repo root and never return
      // it (all-temp fixture; never touches the real ~/.mstar).
      gitInit(join(root, "proj"));
      mkdirSync(join(root, ".mstar"), { recursive: true });
      mkdirSync(join(root, "proj", "nested", "deep"), { recursive: true });
      const result = runResolve([join(root, "proj", "nested", "deep")]);
      expect(envelope(result).status).toBe("refused");
      expect(envelope(result).message).toContain("no harness dir");
    });
  });

  test("non-git start probes only itself — no walk-up to a parent harness", () => {
    withRoot((root) => {
      // Non-git temp tree: default boundary = the start dir itself, so a
      // harness one level up is never probed (deliberate tightening).
      mkdirSync(join(root, ".mstar"), { recursive: true });
      mkdirSync(join(root, "nested", "deep"), { recursive: true });
      const result = runResolve([join(root, "nested", "deep")]);
      expect(envelope(result).status).toBe("refused");
      expect(envelope(result).message).toContain("no harness dir");
    });
  });

  test("legacy .agents/ harness resolves when .mstar/ absent", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".agents", "specs"), { recursive: true });
      writeFileSync(join(root, ".agents", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(data(result).harnessDir).toBe(join(root, ".agents"));
    });
  });

  test("specs falls through to docs/specs when {HARNESS_DIR}/specs is empty (empty-dir-as-absent)", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true }); // empty
      mkdirSync(join(root, "docs", "specs"), { recursive: true });
      writeFileSync(join(root, "docs", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(data(result).harnessDir).toBe(join(root, ".mstar"));
      expect(data(result).specsDir).toBe(join(root, "docs", "specs"));
    });
  });

  test("no harness anywhere → exit 1 with bootstrap guidance on stderr", () => {
    withRoot((root) => {
      const result = runResolve([root]);
      expect(envelope(result).status).toBe("refused");
      expect(envelope(result).message).toContain("no harness dir");
    });
  });

  test("success returns structured harness, specs, workflow and project directories", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(data(result)).toEqual({
        startDir: root,
        harnessDir: join(root, ".mstar"),
        specsDir: join(root, ".mstar", "specs"),
        workflowDir: join(root, ".mstar", "workflows"),
        projectDir: join(root, ".mstar", "projects"),
      });
    });
  });

  test("workflow + project dirs resolve under the harness dir (compass ruling 4)", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(data(result).workflowDir).toBe(join(root, ".mstar", "workflows"));
      expect(data(result).projectDir).toBe(join(root, ".mstar", "projects"));
    });
  });

  test("no harness returns a refusal envelope with bootstrap guidance", () => {
    withRoot((root) => {
      const result = runResolve([root]);
      expect(result.exitCode).toBe(1);
      expect(envelope(result).status).toBe("refused");
    });
  });

  test("read-only: resolve never creates {HARNESS_DIR}/specs when every candidate is absent", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar"), { recursive: true });
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      // Engine default would create the fallback; the CLI opts out.
      expect(existsSync(join(root, ".mstar", "specs"))).toBe(false);
      expect(data(result).specsDir).toBe(join(root, ".mstar", "specs"));
    });
  });
});
