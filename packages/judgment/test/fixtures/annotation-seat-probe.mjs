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
const seat = process.env.JEV_ANNOTATION_SEAT ?? "";
const shard = Number(process.env.JEV_ANNOTATION_SHARD ?? "0");
const sinkRoot = process.env.JEV_ANNOTATION_SINK ?? "";
const outputName = process.env.JEV_ANNOTATION_OUTPUT_NAME ?? "";
const inputsRoot = process.env.JEV_ANNOTATION_INPUTS ?? "/mnt/inputs";
const outputRoot = process.env.JEV_ANNOTATION_OUTPUT ?? "/mnt/output";
const denialPath = resolve(outputRoot, "denial-log.jsonl");

if (
  typeof sessionId !== "string" ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId) ||
  process.env.JEV_ANNOTATION_WORKER !== "1" ||
  !sinkRoot ||
  !outputName ||
  (seat !== "A" && seat !== "B") ||
  !Number.isInteger(shard) ||
  shard < 1 ||
  shard > 4
) {
  process.exit(2);
}

const log = (check, outcome, detail = undefined) => {
  appendFileSync(denialPath, `${JSON.stringify({ at: performance.now(), check, outcome, ...(detail === undefined ? {} : { detail }) })}
`);
};

const otherSeat = seat === "A" ? "B" : "A";
const otherShard = shard === 4 ? 1 : shard + 1;

try {
  const brief = readFileSync(resolve(inputsRoot, "annotation-brief.md"), "utf8");
  const shardView = readFileSync(resolve(inputsRoot, "shard-view.jsonl"), "utf8");
  const manifest = JSON.parse(readFileSync(resolve(inputsRoot, "seat-manifest.json"), "utf8"));
  const lineCount = shardView.split(/\r?\n/).filter((line) => line.length > 0).length;
  log("allowed-input-read", brief.length > 0 && lineCount > 0 && manifest.seat === seat && manifest.shard === shard ? "allowed" : "denied", {
    briefBytes: brief.length,
    shardViewLines: lineCount,
    seat,
    shard,
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
  { probe: "other-seat-view", target: `/seats/${otherSeat}/shard-${shard}.jsonl` },
  { probe: "other-shard-view", target: `/seats/${seat}/shard-${otherShard}.jsonl` },
  { probe: "crosswalk", target: "/supervisor-only/crosswalk.json" },
  { probe: "gold", target: "/gold/adjudicated.jsonl" },
  { probe: "sources", target: `/sources/shard-${shard}.jsonl` },
  { probe: "authoring", target: `/authoring/shard-${shard}-provenance.json` },
  { probe: "authoring-brief", target: "/authoring-brief.md" },
  { probe: "protocol", target: "/protocol.json" },
  { probe: "protocol-budget", target: "/budget.json" },
  { probe: "protocol-permission", target: "/permission.json" },
  { probe: "tuner", target: "/calibration/candidates.json" },
  { probe: "model-output", target: "/model-output/development.jsonl" },
  { probe: "evaluator", target: "/evaluator/canary" },
  { probe: "holdout", target: "/holdout-run.json" },
  { probe: "other-seat-annotation", target: `/annotations/${otherSeat}-${shard}.jsonl` },
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

try {
  createOnly(outputName, JSON.stringify({ sessionId, probe: "allowed-sink", path: outputName }) + "\n");
  log("sink-create-allowed", "allowed", { target: outputName });
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
  log("sink-create-allowed", "denied", { target: outputName, code });
}

const allowed = new Set([outputName]);
for (const relativePath of [`annotations/${otherSeat}-${shard}.jsonl`, "protocol.json", `seats/${otherSeat}/shard-${shard}.jsonl`]) {
  try {
    if (!allowed.has(relativePath)) throw Object.assign(new Error("sink-forbidden"), { code: "E_FORBIDDEN" });
    createOnly(relativePath, JSON.stringify({ forbidden: true }) + '\n');
    log("sink-create-denied", "unexpected-write", { target: relativePath });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
    log("sink-create-denied", "denied", { target: relativePath, code });
  }
}

try {
  openSync(resolve(sinkRoot, outputName), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  log("sink-overwrite-denied", "unexpected-write", { target: outputName });
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
  log("sink-overwrite-denied", "denied", { target: outputName, code });
}

if (!existsSync(resolve(sinkRoot, outputName))) process.exit(3);
process.stdout.write(`${JSON.stringify({ type: "complete", sessionId, seat, shard })}
`);
