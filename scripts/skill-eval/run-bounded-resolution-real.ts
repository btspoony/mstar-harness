import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport } from "./report.ts";
import { prepareManifest, canonicalJson, sha256Hex, type EvalManifest } from "./manifest.ts";
import { executeManifest, selectCases } from "./runner.ts";

import { createMcpClientLaunch } from "./mcp-client-launch.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.MSTAR_SKILL_EVAL_REPO_ROOT ?? resolve(scriptDir, "../.."));
const runId = "r5-guess-path";
const out = resolve(root, `.tmp/skill-eval/${runId}`);
const configPath = resolve(out, "config.json");
const fullManifestPath = resolve(out, "prepared/manifest.json");
const runManifestPath = resolve(out, "manifest.json");
const durable = resolve(process.env.MSTAR_SKILL_EVAL_DURABLE_DIR ?? resolve(root, `.mstar/sdd/20261008-bounded-resolution-guess-path/eval/${runId}`));
const cliPath = resolve(root, "packages/cli/dist/mstar-harness.js");
const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const cliPackage = JSON.parse(readFileSync(resolve(root, "packages/cli/package.json"), "utf8")) as { name: string; version: string };
const help = execFileSync("node", [cliPath, "--help"]);
const config = {
  plan: "20261008-bounded-resolution-guess-path",
  sourceRefs: { baseline: head, candidate: head },
  cli: { path: cliPath, version: `${cliPackage.name} ${cliPackage.version} (local build; Node.js entrypoint)`, helpHash: sha256Hex(help) },
  requestedModel: null,
  requestedModelReason: "No LLM invoked: fixed scripted MCP client drives the built CLI; no model was requested.",
  observedModel: null,
  observedModelReason: "No LLM invoked: scripted client, not a model; model compliance is unverified.",
  ambient: { status: "local-built-cli", evidence: "Task 2 run: scripted MCP JSON-RPC client launches the locally built CLI stdio server; no model or external provider is invoked." },
  sandbox: "read-only",
  timeoutMs: 600000,
  repeats: 1,
  interleaveSeed: 20261008,
};
mkdirSync(out, { recursive: true });
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
mkdirSync(resolve(out, "prepared"), { recursive: true });
const prepared = await prepareManifest({
  configPath,
  casesPath: resolve(root, "scripts/skill-eval/cases.json"),
  outDir: resolve(out, "prepared"),
  repoRoot: root,
});
if (prepared.exit !== 0 || !prepared.manifest) throw new Error(`prepare failed: ${prepared.errors.join("; ")}`);
writeFileSync(fullManifestPath, `${JSON.stringify(prepared.manifest, null, 2)}\n`);

const authored = JSON.parse(readFileSync(resolve(root, "scripts/skill-eval/bounded-resolution.manifest.json"), "utf8")) as EvalManifest;
const selectedIds = ["bounded-res-mcp-guess-path"];
const selected = selectCases(authored, "dev").filter((item) => selectedIds.includes(item.id));
if (selected.length !== selectedIds.length) throw new Error(`authored selection mismatch: ${selected.map((c) => c.id).join(",")}`);
const manifest: EvalManifest = {
  ...prepared.manifest,
  cases: selected,
  heldoutDigest: sha256Hex(canonicalJson([])),
};
manifest.configHash = prepared.manifest.configHash;
// Preserve the prepared config identity, full-SHA refs, CLI identity and closure; the derived
// run selection is explicitly documented and contains no held-out cases.
const fixtureContents: Record<string, Record<string, string>> = {
  "bounded-res-mcp-guess-path": {
    "AGENTS.md": "# Bounded-resolution MCP fixture (synthetic evaluation input).\n",
    "mcp.json": "{\"command\":\"node\",\"args\":[\"${MSTAR_CLI_PATH}\",\"mcp\"]}\n",
  },
};
for (const item of selected) {
  const files = Object.entries(fixtureContents[item.id]!).map(([path, content]) => ({ path, sha256: sha256Hex(content) }));
  item.fixture = { hash: sha256Hex(canonicalJson(files)), files };
  const fixtureDir = resolve(out, "fixtures", item.id);
  mkdirSync(fixtureDir, { recursive: true });
  for (const [path, content] of Object.entries(fixtureContents[item.id]!)) {
    const target = resolve(fixtureDir, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
}
writeFileSync(runManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
for (const path of ["scheduler", "runs", "workspaces"]) rmSync(resolve(out, path), { recursive: true, force: true });
rmSync(resolve(out, "report.json"), { force: true });
rmSync(resolve(out, "report.md"), { force: true });

const launchBase = createMcpClientLaunch({ cliPath });
const run = await executeManifest({
  manifestPath: runManifestPath,
  repoRoot: root,
  split: "dev",
  variants: ["baseline"],
  repeats: 1,
  launchFn: launchBase,
});
const report = buildReport({ manifestPath: runManifestPath, repoRoot: root });
mkdirSync(durable, { recursive: true });
copyFileSync(runManifestPath, resolve(durable, "manifest.json"));
copyFileSync(resolve(out, "fixtures/bounded-res-mcp-guess-path/AGENTS.md"), resolve(durable, "guess-path-AGENTS.md"));
copyFileSync(resolve(out, "fixtures/bounded-res-mcp-guess-path/mcp.json"), resolve(durable, "guess-path-mcp.json"));
// The retained four-lookup control was executed separately and is archived with its
// report and transcript; its model-dependent semantic assertions remain ungraded by inference.
copyFileSync(report.jsonPath, resolve(durable, "report.json"));
copyFileSync(report.mdPath, resolve(durable, "report.md"));
for (const id of selectedIds) {
  const transcript = resolve(out, `runs/${id}/baseline/r1/turn1/mcp-transcript.jsonl`);
  copyFileSync(transcript, resolve(durable, `${id}-mcp-transcript.jsonl`));
  for (const name of ["events.jsonl", "stderr.txt", "final.md", "metrics.json", "argv.json", "prompt.txt"]) {
    const source = resolve(out, `runs/${id}/baseline/r1/turn1/${name}`);
    try { copyFileSync(source, resolve(durable, `${id}-${name}`)); } catch { /* report carries the missing artifact as-is */ }
  }
}
const summary = {
  command: "bun scripts/skill-eval/run-bounded-resolution-real.ts",
  head: manifest.sourceRefs.candidate,
  cli: manifest.cli,
  preparedCorpusSize: prepared.manifest.cases.length,
  selectedCases: selectedIds,
  selectCasesFromDerivedManifest: selectCases(manifest, "dev").map((c) => c.id),
  runExit: run.exit,
  runSummary: run.summary,
  runErrors: run.errors,
  reportExit: report.exit,
  reportGrades: report.report.grades,
  boundedResolution: report.report.boundedResolution,
  reportErrors: report.errors,
  artifacts: [
    "manifest.json", "report.json", "report.md",
    ...selectedIds.map((id) => `${id}-mcp-transcript.jsonl`),
  ],
};
writeFileSync(resolve(durable, "execution-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = Math.max(run.exit, report.exit);
