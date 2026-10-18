import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const adapterUrl = new URL("../src/adapters/zcode.ts", import.meta.url).href;

/** A stub harness checkout plus a stub `git` keeps the run offline: init only registers the marketplace. */
function fixture(seed: string | undefined) {
  fs.mkdirSync(path.resolve(".tmp"), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(".tmp/zcode-init-ignore-"));
  const harness = path.join(root, ".mstar/harness");
  fs.mkdirSync(path.join(harness, ".zcode-plugin"), { recursive: true });
  fs.writeFileSync(path.join(harness, ".zcode-plugin/plugin.json"), "{}");
  fs.mkdirSync(path.join(harness, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin/git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  if (seed !== undefined) fs.writeFileSync(path.join(project, ".gitignore"), seed);
  return { root, project, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function runProjectInit(root: string) {
  // Dynamic import is required here: shared-install captures its HOME-derived
  // harness path at module load, which happens after the os.homedir override.
  const script = `import os from "node:os"; os.homedir = () => process.env.MSTAR_TEST_ROOT;
const { zcodeAdapter } = await import(${JSON.stringify(adapterUrl)});
try { console.log(JSON.stringify(zcodeAdapter.runInstallInit("project", false))); }
catch (e) { console.log(JSON.stringify({ failure: e.message })); }`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: { ...process.env, MSTAR_TEST_ROOT: root, MSTAR_CLI_PROJECT_ROOT: path.join(root, "project"), PATH: `${root}/bin:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

describe("zcode project init and .gitignore", () => {
  test("creates no .gitignore", () => {
    const f = fixture(undefined);
    try {
      expect(runProjectInit(f.root).failure).toBeUndefined();
      expect(fs.existsSync(path.join(f.project, ".gitignore"))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test("leaves an existing .gitignore byte-identical", () => {
    const seeded = "# user rules\nnode_modules\n";
    const f = fixture(seeded);
    try {
      expect(runProjectInit(f.root).failure).toBeUndefined();
      expect(fs.readFileSync(path.join(f.project, ".gitignore"), "utf8")).toBe(seeded);
    } finally {
      f.cleanup();
    }
  });
});
