import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const adapterUrl = new URL("../src/adapters/codex.ts", import.meta.url).href;
const repoAgents = new URL("../../../codex/agents/", import.meta.url).pathname;
const names = fs.readdirSync(repoAgents).filter((name) => name.endsWith(".toml"));

function fixture() {
  fs.mkdirSync(path.resolve(".tmp"), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(".tmp/codex-agent-test-"));
  const source = path.join(root, ".mstar/harness");
  fs.mkdirSync(path.join(source, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(source, ".codex-plugin/plugin.json"), "{}");
  fs.cpSync(repoAgents, path.join(source, "codex/agents"), { recursive: true });
  fs.mkdirSync(path.join(source, "commands"));
  for (const name of ["iteration-start", "iteration-drive", "iteration-loop", "codebase-audit", "amazing-pr-review", "amazing-e2e-check"]) {
    fs.writeFileSync(path.join(source, "commands", `${name}.md`), "command");
  }
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin/codex"), '#!/bin/sh\nprintf \'%s\\n\' \'{"marketplaces":[{"name":"mstar-repo"}],"installed":[]}\'\n', { mode: 0o755 });
  fs.mkdirSync(path.join(root, "project"));
  return { root, source, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function run(root: string, scope: string, doctor = false, dry = false) {
  const script = `import os from "node:os"; os.homedir = () => process.env.MSTAR_TEST_ROOT;
const { codexAdapter } = await import(${JSON.stringify(adapterUrl)});
try { console.log(JSON.stringify(codexAdapter.${doctor ? "runInstallDoctor" : "runInstallInit"}(${JSON.stringify(scope)}, ${dry}))); }
catch (e) { console.log(JSON.stringify({failure: e.message})); }`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root, env: { ...process.env, MSTAR_TEST_ROOT: root, MSTAR_CLI_PROJECT_ROOT: path.join(root, "project"), PATH: `${root}/bin:${process.env.PATH}` },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}
function snapshot(root: string): string {
  return JSON.stringify(fs.readdirSync(root, { recursive: true }).sort().map((entry) => {
    const target = path.join(root, String(entry)); const stat = fs.lstatSync(target);
    return [entry, stat.isSymbolicLink() ? fs.readlinkSync(target) : stat.isFile() ? fs.readFileSync(target).toString("base64") : "dir", stat.mtimeMs];
  }));
}

describe("Codex regular agent installation", () => {
  for (const scope of ["global", "project"]) {
    test(`${scope}: fresh install is no-follow readable, idempotent, refresh preserves previous bytes`, () => {
      const f = fixture();
      try {
        const dest = path.join(f.root, scope === "project" ? "project" : "", ".codex/agents");
        expect(run(f.root, scope).failure).toBeUndefined();
        for (const name of names) {
          const target = path.join(dest, name);
          expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
          const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { expect(fs.readFileSync(fd)).toEqual(fs.readFileSync(path.join(f.source, "codex/agents", name))); }
          finally { fs.closeSync(fd); }
        }
        const before = snapshot(f.root);
        expect(run(f.root, scope).failure).toBeUndefined();
        expect(snapshot(f.root)).toBe(before);
        expect(run(f.root, scope, true).errors).toEqual([]);
        const target = path.join(dest, names[0]);
        fs.writeFileSync(target, "user customization");
        expect(run(f.root, scope, true).errors.join(" ")).toContain(`--scope ${scope}`);
        const dryBefore = snapshot(f.root);
        run(f.root, scope, false, true);
        expect(snapshot(f.root)).toBe(dryBefore);
        const update = run(f.root, scope);
        expect(update.notes.join(" ")).toContain("Backed up");
        expect(fs.readdirSync(dest).some((name) => name.endsWith(".bak") && fs.readFileSync(path.join(dest, name), "utf8") === "user customization")).toBe(true);
        if (scope === "project") {
          const project = path.join(f.root, "project");
          expect(Bun.spawnSync(["git", "init", "--quiet", project]).exitCode).toBe(0);
          const backup = fs.readdirSync(dest).find((name) => name.endsWith(".bak"))!;
          const ignored = Bun.spawnSync(["git", "check-ignore", "--no-index", path.join(dest, backup)], { cwd: project });
          expect(ignored.exitCode).toBe(0);
          const ignorePath = path.join(project, ".gitignore");
          fs.writeFileSync(ignorePath, fs.readFileSync(ignorePath, "utf8").replace(".codex/agents/*.toml.*.bak\n", ""));
          expect(run(f.root, scope, true).errors.join(" ")).toContain(".codex/agents/*.toml.*.bak");
          const missingIgnoreBefore = snapshot(f.root);
          expect(run(f.root, scope, false, true).failure).toBeUndefined();
          expect(snapshot(f.root)).toBe(missingIgnoreBefore);
          expect(run(f.root, scope).failure).toBeUndefined();
          const restored = snapshot(f.root);
          expect(run(f.root, scope).failure).toBeUndefined();
          expect(snapshot(f.root)).toBe(restored);
        }
        fs.appendFileSync(path.join(f.source, "codex/agents", names[0]), "\n# source update\n");
        expect(run(f.root, scope, true).errors.join(" ")).toContain("stale");
        expect(run(f.root, scope).failure).toBeUndefined();
        expect(run(f.root, scope, true).errors).toEqual([]);
      } finally { f.cleanup(); }
    });
    test(`${scope}: migrates expected legacy links, rejects unrelated and nonregular targets`, () => {
      const f = fixture();
      try {
        const dest = path.join(f.root, scope === "project" ? "project" : "", ".codex/agents");
        fs.mkdirSync(dest, { recursive: true });
        const target = path.join(dest, names[0]);
        const source = path.join(f.source, "codex/agents", names[0]);
        fs.symlinkSync(path.relative(dest, source), target);
        const linkedBefore = snapshot(f.root);
        expect(run(f.root, scope, false, true).failure).toBeUndefined();
        expect(snapshot(f.root)).toBe(linkedBefore);
        expect(run(f.root, scope, true).errors.join(" ")).toContain("symlink");
        expect(run(f.root, scope).failure).toBeUndefined();
        expect(fs.lstatSync(target).isFile()).toBe(true);
        expect(fs.readFileSync(target)).toEqual(fs.readFileSync(source));
        fs.unlinkSync(target);
        const unrelated = path.join(f.root, "unrelated"); fs.writeFileSync(unrelated, "keep");
        fs.symlinkSync(unrelated, target);
        expect(run(f.root, scope).failure).toContain("unrelated");
        expect(fs.readFileSync(unrelated, "utf8")).toBe("keep");
        fs.unlinkSync(target); fs.mkdirSync(target);
        expect(run(f.root, scope).failure).toContain("regular file");
        expect(run(f.root, scope, true).errors.join(" ")).toContain("regular file");
        fs.rmdirSync(target);
        expect(run(f.root, scope, true).errors.join(" ")).toContain("Missing");
      } finally { f.cleanup(); }
    });
  }
});
