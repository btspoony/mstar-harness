import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createFsStore, initializeStore, scaffoldHarness, setArtifactStore } from "@mstar-harness/engine";
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

  test("scaffold creates plan artifacts only in the declared output directory", async () => {
    const root = tempRoot();
    const findings = path.join(root, "findings.json");
    const outDir = path.join(root, "audit-2026-09-27");
    writeFileSync(findings, JSON.stringify([{ title: "Leaked credential", description: "Credential is exposed", priority: "P1", effort: "S", risk: "HIGH", category: "security", evidence: ["settings.ts:9"] }]));
    const result = await command("audit.scaffold").execute({ findings, dir: outDir, sha: "abc1234", date: "2026-09-27", repo: "fixture" }, context(root));
    expect(result.status).toBe("ok");
    expect(readFileSync(path.join(outDir, "001-leaked-credential.md"), "utf8")).toContain("Credential is exposed");
    expect(readFileSync(path.join(outDir, "README.md"), "utf8")).toContain("| 001 | Leaked credential |");
    expect(existsSync(path.join(root, "unrelated"))).toBe(false);
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
    expect(result.details).toMatchObject({ findings: expect.arrayContaining([
      expect.objectContaining({ kind: "lockfile-duplicate" }), expect.objectContaining({ kind: "action-unpinned", file: ".github/workflows/ci.yml" }), expect.objectContaining({ kind: "pull_request_target-head", file: ".github/workflows/ci.yml" }),
    ]) });
  });

  test("audit intent derives registration from the selected single-plan artifact", async () => {
    const root = tempRoot();
    const harness = path.join(root, ".mstar");
    mkdirSync(path.join(harness, "plans"), { recursive: true });
    setArtifactStore(createFsStore(harness));
    const store = await initializeStore({ harnessDir: path.join(harness, "plans") });
    store.close();
    await scaffoldHarness(root);
    const findings = path.join(root, "findings.json");
    const auditDir = path.join(root, "audit-2026-09-27");
    writeFileSync(findings, JSON.stringify([{ title: "Bounded finding", description: "A fixture finding", priority: "P2", effort: "S", risk: "LOW", category: "bug" }]));
    const scaffolded = await command("audit.scaffold").execute({ findings, dir: auditDir, sha: "abc1234", date: "2026-09-27" }, context(root));
    expect(scaffolded.status).toBe("ok");

    const promoted = await command("audit.promote").execute({ path: auditDir, deliveryKind: "verification/report-only", completionPolicy: "completion evidence is recorded", harness }, context(root));
    expect(promoted.status).toBe("ok");
    expect(existsSync(path.join(harness, "workflows", "audit-2026-09-27", "snapshot.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(harness, "status.json"), "utf8")).workflows.map((workflow: { id: string }) => workflow.id)).toContain("audit-2026-09-27");
    expect(existsSync(path.join(root, "unrelated"))).toBe(false);
  });

  test("promote refuses selections outside the declared audit plan directory", async () => {
    const root = tempRoot();
    const auditDir = path.join(root, "audit-2026-09-27");
    mkdirSync(auditDir);
    writeFileSync(path.join(auditDir, "README.md"), "# Audit\n");
    const result = await command("audit.promote").execute({ path: auditDir, plans: "001", deliveryKind: "verification/report-only", harness: path.join(root, ".mstar") }, context(root));
    expect(result.status).toBe("refused");
    expect(result.message).toContain("001");
    expect(existsSync(path.join(root, ".mstar", "workflows"))).toBe(false);
  });
  test("missing decision is preserved when an audit artifact contains multiple plans", async () => {
    const root = tempRoot();
    const findings = path.join(root, "findings.json");
    const auditDir = path.join(root, "audit-2026-09-27");
    writeFileSync(findings, JSON.stringify([
      { title: "First finding", description: "First fixture finding", priority: "P2", effort: "S", risk: "LOW", category: "bug" },
      { title: "Second finding", description: "Second fixture finding", priority: "P2", effort: "S", risk: "LOW", category: "bug" },
    ]));
    const scaffolded = await command("audit.scaffold").execute({ findings, dir: auditDir, sha: "abc1234", date: "2026-09-27" }, context(root));
    expect(scaffolded.status).toBe("ok");
    const result = await command("audit.promote").execute({
      path: auditDir, deliveryKind: "verification/report-only", completionPolicy: "completion evidence is recorded",
      harness: path.join(root, ".mstar"),
    }, context(root));
    expect(result).toMatchObject({ status: "usage", exitCode: 2 });
    expect(result.message).toContain("--plans is a required decision");
    expect(existsSync(path.join(root, ".mstar", "workflows"))).toBe(false);
  });
});
