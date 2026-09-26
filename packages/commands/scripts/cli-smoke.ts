import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCommandDefinitions } from "../src/index.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = resolve(root, "packages/cli/dist/mstar-harness.js");
const census = 122;

function run(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

const help = run(["--help"]);
if (help.status !== 0 || !help.stdout.includes("schema") || !help.stdout.includes("init")) {
  throw new Error(`built help failed: status=${help.status} stdout=${help.stdout} stderr=${help.stderr}`);
}

const schema = run(["schema", "CaptureInput"]);
const schemaEnvelope = JSON.parse(schema.stdout);
if (schema.status !== 0 || schemaEnvelope.status !== "ok" || schemaEnvelope.data?.type !== "CaptureInput") {
  throw new Error(`built schema failed: status=${schema.status} stdout=${schema.stdout} stderr=${schema.stderr}`);
}

const read = run(["host", "detect", "--signals", "question"]);
const readEnvelope = JSON.parse(read.stdout);
if (read.status !== 0 || readEnvelope.data?.host !== "opencode") {
  throw new Error(`built read failed: status=${read.status} stdout=${read.stdout} stderr=${read.stderr}`);
}

const refusal = run(["status", "archive-residuals"]);
const refusalEnvelope = JSON.parse(refusal.stdout);
if (refusal.status !== 1 || refusalEnvelope.status !== "refused" || refusalEnvelope.code !== "status.verb-retired") {
  throw new Error(`built refusal failed: status=${refusal.status} stdout=${refusal.stdout} stderr=${refusal.stderr}`);
}

const listed = run(["--help"]);
const ids = new Set<string>();
for (const line of listed.stdout.split("\n")) {
  const match = line.match(/^\s{2}([a-z][a-z0-9-]*)(?:\s|$)/);
  if (match?.[1] && match[1] !== "help") ids.add(match[1]);
}
if (!ids.has("schema") || !ids.has("init") || !ids.has("persist") || !ids.has("status")) {
  throw new Error(`built help did not list generated roots: ${[...ids].join(", ")}`);
}

if (getCommandDefinitions().length !== census || getCommandDefinitions().some((definition) => definition.id === "init" || definition.id === "report")) {
  throw new Error(`canonical census mismatch: ${getCommandDefinitions().length}`);
}

console.log(`cli-smoke: help, schema, read, refusal, and ${census} canonical IDs accounted for`);
