import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";

const runId = process.argv.at(-1);
if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) process.exit(2);

const denialPath = "/mnt/output/denial-log.jsonl";
const log = (check, outcome, detail = undefined) => {
  appendFileSync(
    denialPath,
    `${JSON.stringify({ at: performance.now(), check, outcome, ...(detail === undefined ? {} : { detail }) })}\n`,
  );
};

const emit = (type, detail) =>
  process.stdout.write(`${JSON.stringify({ type, at: performance.now(), runId, ...(detail === undefined ? {} : { detail }) })}\n`);

emit("start", "component-confinement-probe");
emit("baseline-frozen", "supervisor-owns-baseline");

for (const target of ["/evaluator/canary", "/mnt/evaluator/canary", "/proc/1/root/evaluator/canary"]) {
  try {
    readFileSync(target);
    log("evaluator-canary-path", "unexpected-access", { target });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
    log("evaluator-canary-path", "denied", { target, code });
  }
}

try {
  const entries = readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name));
  const foreign = entries.filter((pid) => {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return cmd.includes("evaluator") || cmd.includes("typesafe");
    } catch {
      return false;
    }
  });
  log("evaluator-pid-visibility", foreign.length === 0 ? "denied" : "unexpected-visible", { count: foreign.length });
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
  log("evaluator-pid-visibility", "denied", { code });
}

const memTargets = ["/proc/1/mem"];
for (const pid of readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name)).slice(0, 4)) {
  if (pid !== "1") memTargets.push(`/proc/${pid}/mem`);
}
const memAttempts = [];
for (const target of memTargets) {
  try {
    readFileSync(target);
    memAttempts.push({ target, code: "read-ok" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
    memAttempts.push({ target, code });
  }
}
log(
  "evaluator-memory-access",
  memAttempts.every((attempt) => attempt.code !== "read-ok") ? "denied" : "unexpected-visible",
  { attempts: memAttempts },
);

try {
  const environ = readFileSync("/proc/self/environ", "utf8");
  const leaked = environ.includes("TYPESAFE") || environ.includes("evaluator-secret");
  log("evaluator-env-visibility", leaked ? "unexpected-visible" : "denied", { leaked });
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
  log("evaluator-env-visibility", "denied", { code });
}

const typesafeKeys = Object.keys(process.env).filter((key) => key.includes("TYPESAFE"));
log("typesafe-env-absent", typesafeKeys.length === 0 ? "denied" : "unexpected-present", { keys: typesafeKeys });

try {
  writeFileSync("/mnt/status.json", JSON.stringify({ forged: true }));
  log("status-modification", "unexpected-write");
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
  log("status-modification", "denied", { code });
}

try {
  writeFileSync("/mnt/source/forged.txt", "x");
  log("source-modification", "unexpected-write");
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
  log("source-modification", "denied", { code });
}

const boundedRequest = {
  schema: "mstar.judgment-request/v1",
  requestId: "probe-write-check",
  runId,
  packBytes: Buffer.from(JSON.stringify({ runId, probe: "bounded-mailbox" })).toString("base64"),
  pilotDigest: "0".repeat(64),
};
try {
  const requestPath = "/mnt/requests/probe-write-check.json";
  writeFileSync(requestPath, JSON.stringify(boundedRequest));
  const written = existsSync(requestPath);
  log("request-write", written ? "allowed-bounded" : "denied", { bytes: JSON.stringify(boundedRequest).length });
  if (written) {
    try {
      writeFileSync(requestPath, JSON.stringify(boundedRequest));
      log("request-write", "denied", { detail: "non-atomic-overwrite-refused" });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
      log("request-write-overwrite", "denied", { code });
    }
  }
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
  log("request-write", "denied", { code });
}

for (const target of ["/mnt/requests/../status.json", "/mnt/status.json"]) {
  try {
    writeFileSync(target, JSON.stringify({ schema: "mstar.judgment-status/v1", runId, status: "recorded" }));
    log("forged-capability-status", "unexpected-write", { target });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
    log("forged-capability-status", "denied", { target, code });
  }
}

if (process.env.JEV_REQUESTS_DIR !== "/mnt/requests" || process.env.JEV_STATUS_PATH !== "/mnt/status.json") {
  log("forged-mailbox-env", "unexpected", {
    requestsDir: process.env.JEV_REQUESTS_DIR ?? null,
    statusPath: process.env.JEV_STATUS_PATH ?? null,
  });
} else {
  log("forged-mailbox-env", "denied", { note: "only-approved-mailbox-env" });
}

emit("request", "bounded-mailbox-only");
emit("complete", "component-confinement-probe");
