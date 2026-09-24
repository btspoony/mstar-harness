import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const sessionId = process.argv.at(-1);
const shard = Number(process.env.JEV_AUTHOR_SHARD ?? "0");
const sinkRoot = process.env.JEV_AUTHOR_SINK ?? "";
const sourcesName = process.env.JEV_AUTHOR_SOURCES ?? "";
const provenanceName = process.env.JEV_AUTHOR_PROVENANCE ?? "";
const inputsRoot = process.env.JEV_AUTHOR_INPUTS ?? "/mnt/inputs";
const outputRoot = process.env.JEV_AUTHOR_OUTPUT ?? "/mnt/output";
const denialPath = resolve(outputRoot, "denial-log.jsonl");

if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId) || process.env.JEV_AUTHOR_WORKER !== "1" || !sinkRoot || !Number.isInteger(shard) || shard < 1 || shard > 4) {
  process.exit(2);
}

const log = (check, outcome, detail = undefined) => {
  appendFileSync(denialPath, `${JSON.stringify({ at: performance.now(), check, outcome, ...(detail === undefined ? {} : { detail }) })}\n`);
};

const otherShard = shard === 4 ? 1 : shard + 1;

try {
  const brief = readFileSync(resolve(inputsRoot, "authoring-brief.md"), "utf8");
  const slotKeys = JSON.parse(readFileSync(resolve(inputsRoot, "slot-keys.json"), "utf8"));
  log("allowed-input-read", brief.includes("authoring") && slotKeys.shard === shard ? "allowed" : "denied", {
    briefBytes: brief.length,
    slotKeyCount: Array.isArray(slotKeys.keys) ? slotKeys.keys.length : 0,
  });
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
  log("allowed-input-read", "denied", { code });
}

const mailboxPresent = Boolean(process.env.JEV_REQUESTS_DIR || process.env.JEV_COMPONENT_WORKER === "1");
let networkReachable = false;
try {
  const response = await fetch("http://127.0.0.1:9", { signal: AbortSignal.timeout(250) });
  networkReachable = response.ok;
} catch {
  networkReachable = false;
}
log("network-shell-filesystem", mailboxPresent || networkReachable ? "unexpected-present" : "denied", {
  mailboxPresent,
  networkReachable,
});

const forbiddenTargets = [
  { probe: "other-shard", target: `/sources/shard-${otherShard}.jsonl` },
  { probe: "annotation", target: "/annotations/A-1.jsonl" },
  { probe: "gold", target: "/gold/adjudicated.jsonl" },
  { probe: "tuner", target: "/calibration/candidates.json" },
  { probe: "evaluator", target: "/evaluator/canary" },
  { probe: "protocol", target: "/protocol.json" },
  { probe: "holdout", target: "/holdout-run.json" },
];

for (const { probe, target } of forbiddenTargets) {
  try {
    readFileSync(target);
    log(`forbidden-read:${probe}`, "unexpected-access", { target });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
    log(`forbidden-read:${probe}`, "denied", { target, code });
  }
}

try {
  readdirSync("/mnt/evidence");
  log("forbidden-read:evidence-root-enumeration", "unexpected-access", { target: "/mnt/evidence" });
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
  log("forbidden-read:evidence-root-enumeration", "denied", { target: "/mnt/evidence", code });
}

function createOnly(relativePath, body) {
  const target = resolve(sinkRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, body);
  } finally {
    closeSync(fd);
  }
}

for (const relativePath of [sourcesName, provenanceName]) {
  try {
    createOnly(relativePath, `${JSON.stringify({ sessionId, probe: "allowed-sink", path: relativePath })}\n`);
    log("sink-create-allowed", "allowed", { target: relativePath });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
    log("sink-create-allowed", "denied", { target: relativePath, code });
  }
}

const allowed = new Set([sourcesName, provenanceName]);
for (const relativePath of [`sources/shard-${otherShard}.jsonl`, "protocol.json", "annotations/A-1.jsonl"]) {
  try {
    if (!allowed.has(relativePath)) throw Object.assign(new Error("sink-forbidden"), { code: "E_FORBIDDEN" });
    createOnly(relativePath, '{"forbidden":true}\n');
    log("sink-create-denied", "unexpected-write", { target: relativePath });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
    log("sink-create-denied", "denied", { target: relativePath, code });
  }
}

try {
  openSync(resolve(sinkRoot, sourcesName), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  log("sink-overwrite-denied", "unexpected-write", { target: sourcesName });
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
  log("sink-overwrite-denied", "denied", { target: sourcesName, code });
}

if (!existsSync(resolve(sinkRoot, sourcesName)) || !existsSync(resolve(sinkRoot, provenanceName))) process.exit(3);
process.stdout.write(`${JSON.stringify({ type: "complete", sessionId, shard })}\n`);
