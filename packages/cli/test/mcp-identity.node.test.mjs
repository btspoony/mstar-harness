/**
 * T4 — issue #383 E2E integration regression: the omp injection contract, over
 * a REAL `mstar mcp` stdio server on a temp harness root with a real ACTIVE
 * execution store (Node; `.node.test.mjs` consumer guard conventions).
 *
 * ## What is real, and what the test supplies
 *
 * - THE BUILT CLI BUNDLE spawned as `mcp` — the exact stdio MCP server a host
 *   launches (`mstar mcp`), addressed with newline-delimited JSON-RPC from this
 *   process. The server receives NO ambient identity: `MSTAR_HOST_SESSION_ID`
 *   and `MSTAR_EXECUTION_IDENTITY` are stripped, so the ONLY session identity
 *   on the wire is the per-call `sessionId` parameter an omp host would inject.
 * - A temp Git workspace whose `.mstar` holds a REAL ACTIVE execution authority
 *   built by the engine's own producers over real `node:sqlite`.
 * - The chain: register (NO id — the NULL-creator contract) -> plan bind
 *   coordinator (sessionId=A, adopts; receipt reports A) -> plan prepare (A) ->
 *   plan-pm bind (A; the single omp session presents A for both roles) ->
 *   progress (A) -> lease verify (no sessionId — its schema declares none; the
 *   call stays untouched, no error). Per-role assertions come from the
 *   authority's own store: creator, coordinator session row, plan-pm session
 *   row and the execution lease holder all name the presenting session id.
 *
 * Not exercised here: the omp host process itself (the extension's injection
 * unit tests own the host-side rules); this file proves the SERVER side of the
 * contract the injector feeds.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { initializeExecutionAuthority, initializeStore, readExecutionAuthority } from "@mstar-harness/engine";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(TEST_DIR, "..");
const REPO = resolve(CLI_ROOT, "..", "..");
const CLI_ENTRY = join(CLI_ROOT, "dist", "mstar-harness.js");

assert.ok(existsSync(CLI_ENTRY), `built CLI bundle missing: ${CLI_ENTRY} (run the package build first)`);

const WORKFLOW_ID = "wf-t4-omp-identity";
const PLAN_ID = "20261004-t4-omp-plan";
const PLAN_TITLE = "T4 omp identity plan";
const NATIVE_ID = "omp-native-session-a";
const BRANCH = "feature/t4-omp-identity";

/** Ambient variables that would otherwise leak a real identity into the server. */
const STRIPPED_ENV = [
  "MSTAR_HARNESS_DIR",
  "MSTAR_CONTROL_ROOT",
  "SDD_DIR",
  "MSTAR_HOST_SESSION_ID",
  "MSTAR_EXECUTION_IDENTITY",
  "MSTAR_WRITE_GATE",
];

const roots = [];

after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A temp Git workspace whose `.mstar` holds a REAL ACTIVE execution authority. */
async function makeActiveWorkspace(label) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t4@test", "-c", "user.name=t4", "commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: root,
  });
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const store = await initializeStore({ harnessDir: harness });
  store.close();
  await initializeExecutionAuthority({ harnessDir: harness });
  return { root, harness };
}

/** The header block the engine's Assignment parser accepts. */
function assignmentText(input) {
  return [
    `# Assignment — ${input.planId}`,
    "",
    `**Control harness root**: ${input.harness}`,
    `**Workflow id**: ${input.workflowId}`,
    `**Plan id**: ${input.planId}`,
    `**Plan Path**: ${input.planPath}`,
    `**Worktree Path**: ${input.worktreePath}`,
    `**Working branch**: ${input.branch}`,
    `**SDD dir**: ${input.sddDir}`,
    "**Execute as**: project-manager",
    "**Execution scope**: plan",
    "**Delegation**: allowed (plan-local subagents only)",
    "**Prepare gate**: go",
    "**QA gate**: mandatory",
    "**Findings cleanup**: allow-residual",
    "",
    "Body.",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------------ *
 * The MCP stdio client: newline-delimited JSON-RPC over the child's stdio
 * ------------------------------------------------------------------------ */

function startMcpServer(fixture) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_ENV.includes(key)) continue;
    env[key] = value;
  }
  env.MSTAR_HARNESS_DIR = fixture.harness;
  const child = spawn(process.execPath, [CLI_ENTRY, "mcp"], { cwd: fixture.root, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      const waiter = pending.shift();
      if (waiter !== undefined) waiter.resolve(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let nextId = 0;
  return {
    child,
    stderr: () => stderr,
    /** One JSON-RPC request; resolves with the matching response. */
    request(method, params) {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.push({ resolve: resolveRequest, reject: rejectRequest });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    async close() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

/** tools/call → the command envelope carried in structuredContent. */
async function callTool(server, name, args, label) {
  const response = await server.request("tools/call", { name, arguments: args });
  assert.equal(response.id !== undefined, true, `${label}: response carries an id`);
  const result = response.result;
  assert.ok(result !== undefined, `${label}: no result in response: ${JSON.stringify(response)}`);
  assert.equal(
    result.isError,
    false,
    `${label}: tool call errored\n${JSON.stringify(result.content?.[0]?.text ?? result)}\nstderr: ${server.stderr()}`,
  );
  const envelope = result.structuredContent;
  assert.equal(envelope.status, "ok", `${label}: command refused: ${JSON.stringify(envelope)}`);
  return envelope;
}

async function tokenOf(harness, selection) {
  const read = await readExecutionAuthority({ harnessDir: harness }, selection);
  return read.token;
}

/* ------------------------------------------------------------------------ *
 * The chain
 * ------------------------------------------------------------------------ */

test("T4: stdio MCP chain — no-id register, injected binds, per-role identity, non-capable tool untouched", { timeout: 120_000 }, async () => {
  const fixture = await makeActiveWorkspace("mstar-t4-mcp");
  const planPath = join(fixture.harness, "plans", `${PLAN_ID}.md`);
  const sddDir = join(fixture.harness, "sdd", PLAN_ID);
  const worktreePath = join(fixture.root, "wt-t4");
  const assignmentPath = join(sddDir, "assignment.md");
  writeText(planPath, `# ${PLAN_TITLE}\n\n**plan_id:** ${PLAN_ID}\n`);
  mkdirSync(worktreePath, { recursive: true });
  writeText(
    assignmentPath,
    assignmentText({ harness: fixture.harness, workflowId: WORKFLOW_ID, planId: PLAN_ID, planPath, worktreePath, branch: BRANCH, sddDir }),
  );
  const progressPath = join(fixture.root, "progress.json");
  const evidencePath = join(sddDir, "evidence.md");
  writeText(evidencePath, "# evidence\n");
  writeText(progressPath, `${JSON.stringify({ status: "InReview", summary: "t4 omp identity regression", evidence_paths: [evidencePath] })}\n`);

  const server = startMcpServer(fixture);
  try {
    // The MCP handshake, then the schema-level facts the injector relies on.
    const initialized = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t4-omp-identity", version: "0.0.0" },
    });
    assert.ok(initialized.result?.serverInfo?.name === "mstar-harness", "server initialize handshake");
    server.notify("notifications/initialized", {});
    const tools = await server.request("tools/list", {});
    const byName = new Map(tools.result.tools.map((tool) => [tool.name, tool]));
    for (const name of ["mstar_workflow_register", "mstar_plan_bind", "mstar_plan_prepare", "mstar_plan_progress", "mstar_lease_verify"]) {
      assert.ok(byName.has(name), `tools/list advertises ${name}`);
    }
    // sessionId-capable schemas declare the parameter; the non-capable one does not.
    for (const name of ["mstar_workflow_register", "mstar_plan_bind", "mstar_plan_prepare", "mstar_plan_progress"]) {
      assert.ok(
        Object.hasOwn(byName.get(name).inputSchema.properties ?? {}, "sessionId"),
        `${name} declares sessionId`,
      );
    }
    assert.equal(
      Object.hasOwn(byName.get("mstar_lease_verify").inputSchema.properties ?? {}, "sessionId"),
      false,
      "mstar_lease_verify declares no sessionId (non-capable tool)",
    );

    // --- register: NO sessionId anywhere on this call ------------------------
    const rootToken = await tokenOf(fixture.harness, {});
    const registered = await callTool(server, "mstar_workflow_register", {
      workflow: WORKFLOW_ID,
      planId: PLAN_ID,
      planTitle: PLAN_TITLE,
      planFile: `plans/${PLAN_ID}.md`,
      deliveryKind: "development",
      branchSource: BRANCH,
      branchTarget: "main",
      expect: rootToken,
      operation: "register-1",
      harness: fixture.harness,
    }, "workflow register");
    assert.equal(registered.data.workflowId, WORKFLOW_ID);
    // The authority's own creator column: NULL, not synthesized.
    assert.equal(creatorOf(fixture.harness, WORKFLOW_ID), null, "register without id writes a NULL creator");

    // --- coordinator bind: sessionId=A adopts the unowned workflow -----------
    const coordinatorToken = await tokenOf(fixture.harness, { workflowId: WORKFLOW_ID });
    const bound = await callTool(server, "mstar_plan_bind", {
      execution: true,
      workflow: WORKFLOW_ID,
      coordinator: true,
      expect: coordinatorToken,
      operation: "bind-coordinator",
      harness: fixture.harness,
      sessionId: NATIVE_ID,
    }, "plan bind coordinator");
    assert.equal(bound.data.data.role, "coordinator");
    assert.equal(bound.data.data.sessionId, NATIVE_ID, "the bind receipt reports the presenting native id");
    assert.equal(creatorOf(fixture.harness, WORKFLOW_ID), NATIVE_ID, "adoption records the binder as creator");

    // --- prepare: the coordinator states the plan it addresses ---------------
    const prePrepareToken = await tokenOf(fixture.harness, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
    const prepared = await callTool(server, "mstar_plan_prepare", {
      workflow: WORKFLOW_ID,
      coordinator: true,
      plan: PLAN_ID,
      assignment: assignmentPath,
      expect: prePrepareToken,
      operation: "prepare-1",
      harness: fixture.harness,
      sessionId: NATIVE_ID,
    }, "plan prepare");
    assert.equal(prepared.data.data.plan.id, PLAN_ID);
    assert.equal(prepared.data.data.coordination.prepared.prepared_by, NATIVE_ID);

    // --- plan-pm bind: the SAME native id presenting the plan-pm seat --------
    const postPrepareToken = await tokenOf(fixture.harness, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
    const planBound = await callTool(server, "mstar_plan_bind", {
      execution: true,
      workflow: WORKFLOW_ID,
      plan: PLAN_ID,
      expect: postPrepareToken,
      operation: "bind-plan-pm",
      harness: fixture.harness,
      sessionId: NATIVE_ID,
    }, "plan bind plan-pm");
    assert.equal(planBound.data.data.role, "plan-pm");
    assert.equal(planBound.data.data.planId, PLAN_ID);
    assert.equal(planBound.data.data.sessionId, NATIVE_ID, "the plan seat binds under the same native id");

    // --- progress: the plan-pm session advances its own row ------------------
    const progressToken = await tokenOf(fixture.harness, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
    const progressed = await callTool(server, "mstar_plan_progress", {
      workflow: WORKFLOW_ID,
      plan: PLAN_ID,
      file: progressPath,
      expect: progressToken,
      operation: "progress-1",
      harness: fixture.harness,
      sessionId: NATIVE_ID,
    }, "plan progress");
    assert.equal(progressed.data.data.plan.status, "InReview");

    // --- lease verify: schema declares no sessionId; call untouched ----------
    const verified = await callTool(server, "mstar_lease_verify", {
      workflow: WORKFLOW_ID,
      plan: PLAN_ID,
      harness: fixture.harness,
    }, "lease verify");
    assert.equal(verified.data.lease.holder, NATIVE_ID, "the execution lease is held by the native session id");

    // --- the authority's own per-role truth ----------------------------------
    const db = new DatabaseSync(join(fixture.harness, "store.db"), { readOnly: true });
    try {
      const coordinatorRow = db
        .prepare("select session_id, plan_id, state from execution_sessions where workflow_id = ? and role = 'coordinator'")
        .get(WORKFLOW_ID);
      assert.ok(coordinatorRow !== undefined, "coordinator session row exists");
      assert.equal(coordinatorRow.session_id, NATIVE_ID, "coordinator session row names the native id");
      assert.equal(coordinatorRow.plan_id, null, "coordinator session row carries no plan scope");
      assert.equal(coordinatorRow.state, "active");
      const planRow = db
        .prepare("select session_id, plan_id, state from execution_sessions where workflow_id = ? and role = 'plan-pm'")
        .get(WORKFLOW_ID);
      assert.ok(planRow !== undefined, "plan-pm session row exists");
      assert.equal(planRow.session_id, NATIVE_ID, "plan-pm session row names the native id");
      assert.equal(planRow.plan_id, PLAN_ID, "plan-pm session row carries the plan scope");
      assert.equal(planRow.state, "active");
      const lease = JSON.parse(
        db.prepare("select lease_json from execution_leases where workflow_id = ? and plan_id = ?").get(WORKFLOW_ID, PLAN_ID).lease_json,
      );
      assert.equal(lease.holder_session_id, NATIVE_ID, "execution_lease holder session");
      assert.equal(lease.holder_role, "plan-pm", "execution_lease holder role");
      assert.equal(lease.holder, NATIVE_ID, "execution_lease holder (snapshot projection spelling)");
    } finally {
      db.close();
    }
  } finally {
    await server.close();
  }
});

/** The workflow header's creator attribution, read straight from the store. */
function creatorOf(harness, workflowId) {
  const db = new DatabaseSync(join(harness, "store.db"), { readOnly: true });
  try {
    return db.prepare("select creator_session_id from execution_workflows where workflow_id = ?").get(workflowId)?.creator_session_id;
  } finally {
    db.close();
  }
}
