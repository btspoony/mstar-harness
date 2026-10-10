#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@mstar-harness/opencode-v2";

type SmokeResult = {
  runtime: "node";
  nodeVersion: string;
  id: string;
  lifecycle: "effect";
  assets: { agent: true; command: true; skill: true; nestedReference: true };
  engines: { node: string; bun: string };
};

const NODE_PROBE = `
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const packageRoot = resolve(process.argv[1]);
const requireFile = (path, label) => {
  const file = join(packageRoot, path);
  if (!existsSync(file)) throw new Error("installed package is missing " + label + ": " + path);
};
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (manifest.name !== "@mstar-harness/opencode-v2") throw new Error("installed package name must be @mstar-harness/opencode-v2");
const engines = manifest.engines;
if (typeof engines?.node !== "string" || !engines.node || typeof engines.bun !== "string" || !engines.bun) {
  throw new Error("installed package is missing node and bun engines metadata");
}
requireFile("dist/mstar.js", "built plugin entry");
// The entry module is selected from the temporary installation's runtime path.
const pluginModule = await import(pathToFileURL(join(packageRoot, "dist/mstar.js")).href);
const plugin = pluginModule.default;
if (plugin?.id !== "morning-star-harness") throw new Error("installed entry plugin id must be morning-star-harness");
if (typeof plugin.effect !== "function") throw new Error("installed entry is missing the Effect lifecycle function");
requireFile("harness-agents/project-manager.md", "agent asset");
requireFile("harness-commands/iteration-start.md", "command asset");
requireFile("harness-skills/mstar-roles/SKILL.md", "skill asset");
requireFile("harness-skills/mstar-roles/references/project-manager.md", "nested reference asset");
process.stdout.write(JSON.stringify({
  runtime: "node",
  nodeVersion: process.version,
  id: plugin.id,
  lifecycle: "effect",
  assets: { agent: true, command: true, skill: true, nestedReference: true },
  engines: { node: engines.node, bun: engines.bun },
}));
`;

export async function inspectInstalledPackage(packageRoot: string): Promise<SmokeResult> {
  try {
    const output = execFileSync("node", ["--input-type=module", "-e", NODE_PROBE, packageRoot], {
      cwd: packageRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(output) as SmokeResult;
  } catch (error) {
    const childError = error as { stderr?: Buffer; message?: string };
    const stderr = childError.stderr?.toString("utf8").trim();
    throw new Error(stderr || childError.message || String(error));
  }
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? "no status"})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

export async function runSmoke(): Promise<void> {
  const receiptRoot = mkdtempSync(join(tmpdir(), "opencode-v2-package-smoke-"));
  let tarballName = "unknown";
  try {
    const packed = run("npm", ["pack", "--workspace", PACKAGE_NAME, "--pack-destination", receiptRoot, "--json"], REPO_ROOT);
    const [receipt] = JSON.parse(packed) as Array<{ filename?: string }>;
    if (!receipt?.filename) throw new Error("npm pack did not report a tarball filename");
    tarballName = receipt.filename;
    const tarballPath = join(receiptRoot, tarballName);
    const installRoot = join(receiptRoot, "install");
    run("npm", ["install", "--prefix", installRoot, "--no-save", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], REPO_ROOT);
    const installedPackage = join(installRoot, "node_modules", ...PACKAGE_NAME.split("/"));
    const result = await inspectInstalledPackage(installedPackage);
    console.log(`opencode-v2-smoke: OK — exercised packed artifact ${tarballName}`);
    console.log(`opencode-v2-smoke: OK — Node ${result.nodeVersion} imported ${result.id} Effect lifecycle; agent, command, skill, and nested reference resolved from installed package`);
    console.log(`opencode-v2-smoke: engines node=${result.engines.node} bun=${result.engines.bun}`);
    console.log(`opencode-v2-smoke: temp-dir receipt=${receiptRoot} (removed after run)`);
    console.log("opencode-v2-smoke: installed-host behavior unverified");
  } finally {
    rmSync(receiptRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runSmoke().catch((error: unknown) => {
    console.error(`opencode-v2-smoke: FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
