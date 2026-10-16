import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setArtifactStore } from "@mstar-harness/engine";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAuditCommandDefinitions, getCommandDefinitions } from "../src/index.js";
import type { InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); setArtifactStore(undefined); });
function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mstar-audit-"));
  roots.push(root);
  return root;
}
function command(id: string) {
  const found = getAuditCommandDefinitions().find((definition) => definition.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}
function context(cwd: string): InvocationContext {
  return {
    cwd, controlRoot: null, versions: { engine: null, cli: null, plugin: null, host: null, platform: null }, signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn(request) {
        try {
          const stdout = execFileSync(request.argv[0]!, request.argv.slice(1), { cwd: request.cwd, env: { ...process.env, ...request.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], signal: request.signal });
          return { exitCode: 0, signal: null, stdout, stderr: "" };
        } catch (error) {
          const failure = error as NodeJS.ErrnoException & { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string; signal?: NodeJS.Signals | null };
          return { exitCode: failure.status ?? 1, signal: failure.signal ?? null, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? failure.message) };
        }
      },
      async startDashboard() { throw new Error("not available"); }, async openBrowser() { throw new Error("not available"); },
    },
  };
}
function gitInit(root: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
}

describe("audit command family", () => {

  test("scaffold writes the run report into the declared --dir override", async () => {
    const root = tempRoot();
    const findings = path.join(root, "findings.json");
    const outDir = path.join(root, "audit-2026-09-27");
    writeFileSync(findings, JSON.stringify([{ title: "Leaked credential", description: "Credential is exposed", priority: "P1", effort: "S", risk: "HIGH", category: "security", evidence: ["settings.ts:9"] }]));
    const result = await command("audit.scaffold").execute({ findings, dir: outDir, sha: "abc1234", date: "2026-09-27", repo: "fixture" }, context(root));
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({ outDir, file: path.join(outDir, "README.md"), date: "2026-09-27", level: "standard", round: 1 });
    expect(readFileSync(path.join(outDir, "README.md"), "utf8")).toContain("Credential is exposed");
    // The report index is the run's only artifact — no per-finding plan files.
    expect(readdirSync(outDir)).toEqual(["README.md"]);
    expect(existsSync(path.join(root, "unrelated"))).toBe(false);
  });

  test("--dir ignores --level/--round: they are neither validated nor applied", async () => {
    const root = tempRoot();
    const findings = path.join(root, "findings.json");
    const outDir = path.join(root, "pinned-run");
    writeFileSync(findings, JSON.stringify([{ title: "Bounded finding", description: "A fixture finding", priority: "P2", effort: "S", risk: "LOW", category: "bug" }]));
    const result = await command("audit.scaffold").execute({ findings, dir: outDir, level: "thorough", round: "0", date: "2026-09-27" }, context(root));
    expect(result).toMatchObject({ status: "ok", data: { outDir, level: "standard", round: 1 } });
  });

  test("scaffold defaults the run dir to {REVIEW_DIR}/<date>-codebase-<level>-<round>", async () => {
    const root = tempRoot();
    mkdirSync(path.join(root, ".mstar"), { recursive: true });
    const findings = path.join(root, "findings.json");
    writeFileSync(findings, JSON.stringify([{ title: "Bounded finding", description: "A fixture finding", priority: "P2", effort: "S", risk: "LOW", category: "bug" }]));
    const reviewsDir = path.join(root, ".mstar", "reviews");
    const runDir = path.join(reviewsDir, "2026-09-27-codebase-standard-1");
    const result = await command("audit.scaffold").execute({ findings, sha: "abc1234", date: "2026-09-27" }, context(root));
    expect(result).toMatchObject({ status: "ok", data: { outDir: runDir, file: path.join(runDir, "README.md"), date: "2026-09-27", level: "standard", round: 1 } });
    expect(readdirSync(runDir)).toEqual(["README.md"]);

    // Another level gets its own run dir; an explicit round reuses that exact dir.
    const deep = await command("audit.scaffold").execute({ findings, sha: "abc1234", date: "2026-09-27", level: "deep" }, context(root));
    expect(deep.data).toMatchObject({ outDir: path.join(reviewsDir, "2026-09-27-codebase-deep-1"), level: "deep", round: 1 });
    const reused = await command("audit.scaffold").execute({ findings, sha: "abc1234", date: "2026-09-27", round: "2" }, context(root));
    expect(reused.data).toMatchObject({ outDir: path.join(reviewsDir, "2026-09-27-codebase-standard-2"), round: 2 });

    // An --reviews-dir override moves the root; --level / --round stay validated input.
    const elsewhere = path.join(root, "elsewhere");
    const moved = await command("audit.scaffold").execute({ findings, sha: "abc1234", date: "2026-09-27", reviewsDir: elsewhere }, context(root));
    expect(moved.data).toMatchObject({ outDir: path.join(elsewhere, "2026-09-27-codebase-standard-1") });

    for (const bad of [{ level: "thorough" }, { round: "0" }, { round: "two" }]) {
      const refused = await command("audit.scaffold").execute({ findings, sha: "abc1234", ...bad }, context(root));
      expect({ input: bad, status: refused.status, exitCode: refused.exitCode }).toEqual({ input: bad, status: "usage", exitCode: 2 });
    }
  });

  test("promote is no longer a verb", () => {
    expect(getAuditCommandDefinitions().map(({ id }) => id)).toEqual(["audit.scaffold", "audit.secret-scan", "audit.supply-chain"]);
    expect(getCommandDefinitions().map(({ id }) => id)).not.toContain("audit.promote");
    expect(() => command("audit.promote")).toThrow("missing audit.promote");
  });

  test("secret scan reports the actual engine finding for a tracked fixture without disclosing its value", async () => {
    const root = tempRoot();
    gitInit(root);
    writeFileSync(path.join(root, "credentials.ts"), 'const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";\n');
    execFileSync("git", ["add", "credentials.ts"], { cwd: root });
    const result = await command("audit.secret-scan").execute({ path: root }, context(root));
    expect(result.details).toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ file: path.join(root, "credentials.ts"), line: 1 })]) });
    expect(JSON.stringify(result)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
  });

  test("supply-chain checks surface actual fixture lockfile findings", async () => {
    const root = tempRoot();
    writeFileSync(path.join(root, "package-lock.json"), "{}\n");
    writeFileSync(path.join(root, "bun.lock"), "{}\n");
    mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "on: pull_request_target\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@main\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n");
    const result = await command("audit.supply-chain").execute({ path: root }, context(root));
    expect(result.status).toBe("refused");
    expect(result).toMatchObject({ code: "audit.supply-chain.findings", exitCode: 1 });
    expect(result.message.split("\n")[0]).toMatch(/^\d+ supply-chain findings$/);
    expect(result.details).toMatchObject({ helpRoute: "mstar audit supply-chain --help" });
    expect(result.details).toMatchObject({ findings: expect.arrayContaining([
      expect.objectContaining({ kind: "lockfile-duplicate" }), expect.objectContaining({ kind: "action-unpinned", file: ".github/workflows/ci.yml" }), expect.objectContaining({ kind: "pull_request_target-head", file: ".github/workflows/ci.yml" }),
    ]) });
  });
});
