import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { retireCodexQaAgent } from "../src/adapters/codex-agent-files";

const adapterUrl = new URL("../src/adapters/codex.ts", import.meta.url).href;
const repoAgents = new URL("../../../codex/agents/", import.meta.url).pathname;
const names = fs.readdirSync(repoAgents).filter((name) => name.endsWith(".toml"));

const legacyQa = `name = "qa-engineer"
description = "Morning Star QA Engineer: test planning, automated tests, verification evidence, and acceptance validation."
developer_instructions = """
You are the Morning Star \`qa-engineer\` role.
This Codex custom agent file is a thin routing shell, not the full role prompt.

Mandatory first steps:
1. Load \`mstar-harness-core\`.
2. Load \`mstar-host\`; detect Codex and read \`references/codex.md\`.
3. Load \`mstar-roles\` and read \`references/qa-engineer.md\`.

Execute the assigned QA scope personally and return Completion Report v2 with reproducible evidence.
Do not spawn dev or QC roles unless the Assignment explicitly says \`Delegation: allowed (...)\`.
"""
`;

function fixture() {
  fs.mkdirSync(path.resolve(".tmp"), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(".tmp/codex-agent-test-"));
  const source = path.join(root, ".mstar/harness");
  fs.mkdirSync(source, { recursive: true });
  const initialized = Bun.spawnSync(["git", "-C", source, "init", "--quiet"], { stdout: "pipe", stderr: "pipe" });
  if (initialized.exitCode !== 0) throw new Error(`Could not initialize fake harness checkout: ${initialized.stderr.toString()}`);
  const committed = Bun.spawnSync(["git", "-C", source, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "seed"], { stdout: "pipe", stderr: "pipe" });
  if (committed.exitCode !== 0) throw new Error(`Could not seed fake harness HEAD: ${committed.stderr.toString()}`);
  const checkoutRoot = Bun.spawnSync(["git", "-C", source, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
  if (checkoutRoot.exitCode !== 0 || checkoutRoot.stdout.toString().trim() !== source) {
    throw new Error(`Fake harness checkout resolves to an unexpected repository: ${checkoutRoot.stdout.toString().trim()}`);
  }
  fs.mkdirSync(path.join(source, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(source, ".codex-plugin/plugin.json"), "{}");
  fs.cpSync(repoAgents, path.join(source, "codex/agents"), { recursive: true });
  fs.mkdirSync(path.join(source, "commands"));
  for (const name of ["iteration-start", "iteration-drive", "iteration-loop", "codebase-audit", "amazing-test-audit", "amazing-pr-review", "amazing-e2e-check"]) {
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
describe("Codex regular agent installation", () => {
  test("captures and restores a custom QA agent swapped in before retirement", () => {
    const f = fixture();
    const rename = fs.renameSync;
    try {
      const dest = path.join(f.root, "project/.codex/agents");
      fs.mkdirSync(dest, { recursive: true });
      const target = path.join(dest, "qa-engineer.toml");
      const replacement = path.join(dest, "custom.tmp");
      fs.writeFileSync(target, legacyQa);
      fs.writeFileSync(replacement, 'name = "custom-agent"\ndeveloper_instructions = "Keep my instructions"\n');
      fs.renameSync = ((source, destination) => {
        rename(replacement, target);
        return rename(source, destination);
      }) as typeof fs.renameSync;
      const notes = retireCodexQaAgent(target, false);
      expect(notes.join(" ")).toContain("restored");
      const backup = fs.readdirSync(dest).find((name) => name.startsWith("qa-engineer.toml.") && name.endsWith(".bak"));
      expect(backup).toBeDefined();
      for (const file of [target, path.join(dest, backup!)]) {
        const parsed = Bun.TOML.parse(fs.readFileSync(file, "utf8"));
        expect(parsed.name).toBe("custom-agent");
        expect(parsed.developer_instructions).toContain("Keep my instructions");
      }
    } finally {
      fs.renameSync = rename;
      f.cleanup();
    }
  });
  for (const scope of ["global", "project"]) {
    test(`${scope}: retires managed QA shell without losing instructions`, () => {
      const f = fixture();
      try {
        const dest = path.join(f.root, scope === "project" ? "project" : "", ".codex/agents");
        fs.mkdirSync(dest, { recursive: true });
        const target = path.join(dest, "qa-engineer.toml");
        const shell = scope === "global" ? legacyQa : legacyQa.replace(
          "test planning, automated tests, verification evidence, and acceptance validation.",
          "tiered L4 acceptance (DoD mapping, residual verify, report-only); dispatched when PM sets QA gate mandatory.",
        );
        fs.writeFileSync(target, shell);
        expect(run(f.root, scope, true).errors.join(" ")).toContain(`init --target codex --scope ${scope}`);
        expect(run(f.root, scope, false, true).notes.join(" ")).toContain("Would retire");
        expect(fs.existsSync(target)).toBe(true);
        const result = run(f.root, scope);
        expect(result.notes.join(" ")).toContain("Retired managed QA agent");
        expect(fs.existsSync(target)).toBe(false);
        const backup = fs.readdirSync(dest).find((name) => name.startsWith("qa-engineer.toml.") && name.endsWith(".bak"));
        expect(backup).toBeDefined();
        const parsed = Bun.TOML.parse(fs.readFileSync(path.join(dest, backup!), "utf8"));
        expect(parsed.name).toBe("qa-engineer");
        expect(String(parsed.developer_instructions)).toContain("references/qa-engineer.md");
        expect(run(f.root, scope).failure).toBeUndefined();
        expect(run(f.root, scope, true).errors.join(" ")).not.toContain("Retired managed QA agent");
      } finally { f.cleanup(); }
    });
    test(`${scope}: preserves unknown QA agents and unrelated symlink targets`, () => {
      const f = fixture();
      try {
        const dest = path.join(f.root, scope === "project" ? "project" : "", ".codex/agents");
        fs.mkdirSync(dest, { recursive: true });
        const target = path.join(dest, "qa-engineer.toml");
        fs.writeFileSync(target, `${legacyQa}\n# user customization\n`);
        expect(run(f.root, scope).notes.join(" ")).toContain("unknown ownership");
        expect(run(f.root, scope, true).errors.join(" ")).toContain("migrate");
        expect(fs.readFileSync(target, "utf8")).toContain("user customization");
        fs.unlinkSync(target);
        const unrelated = path.join(f.root, "other-agent.toml");
        fs.writeFileSync(unrelated, 'name = "user-agent"\n');
        fs.symlinkSync(unrelated, target);
        expect(run(f.root, scope).notes.join(" ")).toContain("unknown ownership");
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
        expect(Bun.TOML.parse(fs.readFileSync(unrelated, "utf8")).name).toBe("user-agent");
      } finally { f.cleanup(); }
    });
    test(`${scope}: fresh install is no-follow readable, idempotent, refresh preserves previous bytes`, () => {
      const f = fixture();
      try {
        const dest = path.join(f.root, scope === "project" ? "project" : "", ".codex/agents");
        expect(run(f.root, scope).failure).toBeUndefined();
        if (scope === "project") {
          // init is a pure install: it creates no .gitignore in the project.
          expect(fs.existsSync(path.join(f.root, "project", ".gitignore"))).toBe(false);
        }
        for (const name of names) {
          const target = path.join(dest, name);
          expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
          const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { expect(fs.readFileSync(fd).length).toBeGreaterThan(0); }
          finally { fs.closeSync(fd); }
        }
        expect(run(f.root, scope).failure).toBeUndefined();
        expect(run(f.root, scope, true).errors).toEqual([]);
        const target = path.join(dest, names[0]);
        fs.writeFileSync(target, "user customization");
        expect(run(f.root, scope, true).errors.join(" ")).toContain(`--scope ${scope}`);
        run(f.root, scope, false, true);
        const update = run(f.root, scope);
        expect(update.notes.join(" ")).toContain("Backed up");
        expect(fs.readdirSync(dest).some((name) => name.endsWith(".bak") && fs.readFileSync(path.join(dest, name), "utf8") === "user customization")).toBe(true);
        if (scope === "project") {
          // A re-run on a project that already has a .gitignore leaves its bytes untouched.
          const ignorePath = path.join(f.root, "project", ".gitignore");
          const seeded = "# user rules\nnode_modules\n";
          fs.writeFileSync(ignorePath, seeded);
          expect(run(f.root, scope).failure).toBeUndefined();
          expect(fs.readFileSync(ignorePath, "utf8")).toBe(seeded);
        }
        fs.appendFileSync(path.join(f.source, "codex/agents", names[0]), "\n# source update\n");
        expect(run(f.root, scope, true).errors.join(" ")).toContain("stale");
        expect(run(f.root, scope).failure).toBeUndefined();
        expect(run(f.root, scope, true).errors).toEqual([]);
      } finally { f.cleanup(); }
    });
    test(`${scope}: caps retained backups, install survives with and without prior backups`, () => {
      const f = fixture();
      try {
        const dest = path.join(f.root, scope === "project" ? "project" : "", ".codex/agents");
        const target = path.join(dest, names[0]);
        // Zero prior backups: a fresh install must succeed and write none.
        expect(run(f.root, scope).failure).toBeUndefined();
        expect(fs.readdirSync(dest).some((name) => name.endsWith(".bak"))).toBe(false);
        fs.writeFileSync(target, "user customization");
        const sentinel = `${names[0]}.release-notes.bak`;
        fs.writeFileSync(path.join(dest, sentinel), "release notes, keep me");
        const sentinelAge = new Date(Date.now() - 30 * 60_000);
        fs.utimesSync(path.join(dest, sentinel), sentinelAge, sentinelAge);
        for (let index = 0; index < 5; index += 1) {
          const seed = path.join(dest, `${names[0]}.00000000-0000-4000-8000-00000000000${index}.bak`);
          fs.writeFileSync(seed, `stale-${index}`);
          const when = new Date(Date.now() - (index + 1) * 60_000);
          fs.utimesSync(seed, when, when);
        }
        // Shapes like an installer backup but is not one: a symlink, and the oldest entry.
        const linkName = `${names[0]}.00000000-0000-4000-8000-000000000099.bak`;
        const linkTarget = path.join(f.root, "linked-user-file");
        fs.writeFileSync(linkTarget, "linked user data");
        fs.symlinkSync(linkTarget, path.join(dest, linkName));
        const linkAge = new Date(Date.now() - 60 * 60_000);
        fs.lutimesSync(path.join(dest, linkName), linkAge, linkAge);
        const install = run(f.root, scope);
        expect(install.failure).toBeUndefined();
        expect(install.notes.join(" ")).toContain("Backed up");
        expect(fs.readFileSync(target, "utf8")).not.toBe("user customization");
        // Newest three installer backups: the fresh one plus the two newest seeds.
        const entries = fs.readdirSync(dest);
        const installerBackups = entries.filter((name) => name.endsWith(".bak") && name !== sentinel && name !== linkName);
        expect(installerBackups).toHaveLength(3);
        expect(installerBackups.filter((name) => name.includes(".00000000-")).sort())
          .toEqual([`${names[0]}.00000000-0000-4000-8000-000000000000.bak`, `${names[0]}.00000000-0000-4000-8000-000000000001.bak`]);
        // Never deletion candidates: a differently suffixed user backup and a shaped symlink.
        expect(entries).toContain(sentinel);
        expect(fs.readFileSync(path.join(dest, sentinel), "utf8")).toBe("release notes, keep me");
        expect(fs.lstatSync(path.join(dest, linkName)).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(linkTarget, "utf8")).toBe("linked user data");
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
        expect(run(f.root, scope, false, true).failure).toBeUndefined();
        expect(run(f.root, scope, true).errors.join(" ")).toContain("symlink");
        expect(run(f.root, scope).failure).toBeUndefined();
        expect(fs.lstatSync(target).isFile()).toBe(true);
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
