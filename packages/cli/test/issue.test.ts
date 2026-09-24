/**
 * CLI `mstar issue` — subprocess tests against the built bundle (plan C4).
 *
 * Exercises Bun shebang launch and explicit Node invocation. Does not test
 * field forwarding or source strings.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compareVersions, initializeStore, MIN_BUN_VERSION, MIN_NODE_VERSION } from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(CLI_ROOT, "dist/mstar-harness.js");
const NODE_BIN = process.env.NODE_BIN ?? "node";
const NODE_VERSION = spawnSync(NODE_BIN, ["--version"], { encoding: "utf8" }).stdout.trim();
const BUN_VERSION = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim();


interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  argv: string[];
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runBundle(launcher: "bun-shebang" | "node", args: string[], cwd: string, extra: { nodeArgs?: string[] } = {}): RunResult {
  const argv = launcher === "node" ? [NODE_BIN, ...(extra.nodeArgs ?? []), BUNDLE, ...args] : [BUNDLE, ...args];
  const proc = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    env: cliEnv(),
    encoding: "utf8",
  });
  return { exitCode: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", argv };
}

function jsonOf(result: RunResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function capturePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "proj-a",
    title: "Unscoped finding",
    kind: "bug",
    severity: "high",
    impact: "users see a failure",
    acceptance: "failure no longer reproduces",
    sourceIdentity: "qc/review.md",
    rootCauseKey: "missing-null-check",
    acceptanceKey: "null-guard-present",
    occurrenceKey: "run-1",
    sourceKind: "qc",
    location: "packages/engine/src/store-db.ts:10",
    observedBehavior: "throws on empty path",
    evidence: ["stack: TypeError"],
    discoveredAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

async function makeHarness(): Promise<{ root: string; harness: string }> {
  const root = mkdtempSync(join(tmpdir(), "mstar-issue-cli-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  await initializeStore({ harnessDir: harness }).then((h) => h.close());
  return { root, harness };
}

/**
 * The canonical live-workflow authority the engine's own bind produces
 * (contract §4): the session envelope at
 * `workflows/<id>/sessions/plan-pm-<session-id>.json` plus that workflow's
 * coordination record pointing at it.
 */
function writeBoundEnvelope(harness: string, planId = "20260918-a"): string {
  const workflowId = "wf-issue";
  const sessionId = "11111111-1111-1111-1111-111111111111";
  const sessionPath = join(harness, "workflows", workflowId, "sessions", `plan-pm-${sessionId}.json`);
  writeJson(sessionPath, {
    schema_version: 1,
    role: "plan-pm",
    session_id: sessionId,
    workflow_id: workflowId,
    plan_id: planId,
    harness_root: harness,
  });
  writeJson(join(harness, "workflows", workflowId, "snapshot.json"), {
    schema_version: 1,
    id: workflowId,
    type: "iteration",
    status: "running",
    started_at: "2026-09-18T00:00:00Z",
    updated_at: "2026-09-18T00:00:00Z",
    plans: [
      {
        id: planId,
        plan_id: planId,
        title: `Plan ${planId}`,
        file: `.mstar/plans/${planId}.md`,
        status: "Todo",
        coordination: {
          revision: 1,
          session: { session_id: sessionId, session_file: sessionPath, bound_at: "2026-09-18T00:00:00Z" },
        },
      },
    ],
  });
  return sessionPath;
}

/** A caller-written envelope at an arbitrary path: parseable, never issued. */
function writeHandWrittenEnvelope(root: string, harness: string, planId = "20260918-a"): string {
  const path = join(root, "hand-written-session.json");
  writeJson(path, {
    schema_version: 1,
    role: "plan-pm",
    session_id: "22222222-2222-2222-2222-222222222222",
    workflow_id: "wf-issue",
    plan_id: planId,
    harness_root: harness,
  });
  return path;
}

describe("mstar issue CLI bundle", () => {
  test("records runtimes >= the issue-store floors (Node 24.18.0, Bun 1.4.0)", () => {
    // Evidence: subprocess launchers used below. Print so the report names them.
    console.log(`issue.test runtimes NODE_BIN=${NODE_BIN} node=${NODE_VERSION} bun=${BUN_VERSION}`);
    // The recorded floor metadata itself is pinned (store-db.ts §8).
    expect(MIN_NODE_VERSION).toBe("24.18.0");
    expect(MIN_BUN_VERSION).toBe("1.4.0");
    // The actual runtimes only promise >= the floor (package.json engines:
    // node >=24.18.0 / bun >=1.4.0) — an exact-equality pin fails on every
    // newer runtime, which is not a contract violation. A version-shaped
    // string is required first so a failed `--version` read cannot silently
    // compare as 0.
    expect(NODE_VERSION).toMatch(/^v?\d+\.\d+/);
    expect(BUN_VERSION).toMatch(/^\d+\.\d+/);
    expect(compareVersions(NODE_VERSION.replace(/^v/, ""), MIN_NODE_VERSION)).toBeGreaterThanOrEqual(0);
    expect(compareVersions(BUN_VERSION, MIN_BUN_VERSION)).toBeGreaterThanOrEqual(0);
  });

  test("built bundle exists with bun shebang", () => {
    expect(existsSync(BUNDLE)).toBe(true);
    chmodSync(BUNDLE, 0o755);
    expect(readFileSync(BUNDLE, "utf8").startsWith("#!/usr/bin/env bun")).toBe(true);
  });

  test("schema output and payload help describe the issue file contracts", () => {
    const schema = runBundle("bun-shebang", ["schema", "CaptureInput"], process.cwd());
    expect(schema.exitCode).toBe(0);
    const parsed = JSON.parse(schema.stdout) as { type: string; fields: Array<{ name: string; required: boolean; type: string }> };
    expect(parsed.type).toBe("CaptureInput");
    expect(parsed.fields).toContainEqual({ name: "projectId", required: true, type: "string", description: "Project identifier" });
    const closureSchema = runBundle("bun-shebang", ["schema", "ClosureEvidence"], process.cwd());
    expect(closureSchema.exitCode).toBe(0);
    const closurePayload = JSON.parse(closureSchema.stdout) as {
      fields: Array<{ name: string; required: boolean; requiredWhen?: string[] }>;
    };
    const closureFields = closurePayload.fields;
    expect(closureFields.find((field) => field.name === "references")).toMatchObject({
      required: false,
      requiredWhen: ["close"],
    });
    expect(closureFields.find((field) => field.name === "canonicalIssueId")).toMatchObject({
      required: false,
      requiredWhen: ["duplicate", "supersede"],
    });

    const handoffSchema = runBundle("bun-shebang", ["schema", "HandoffEvidence"], process.cwd());
    expect(handoffSchema.exitCode).toBe(0);
    const handoff = JSON.parse(handoffSchema.stdout) as { fields: Array<{ name: string; required: boolean }> };
    expect(handoff.fields).toContainEqual(expect.objectContaining({ name: "review_head", required: true }));

    for (const [verb, typeName] of [
      ["add", "CaptureInput"],
      ["occurrence", "OccurrenceInput"],
      ["triage", "IssueTriage"],
      ["close", "ClosureEvidence"],
      ["link", "IssueLink"],
    ]) {
      const help = runBundle("bun-shebang", ["issue", verb, "--help"], process.cwd());
      const normalizedHelp = help.stdout.replace(/\s+/g, " ");
      expect(normalizedHelp).toContain(typeName);
      expect(normalizedHelp).toContain(`mstar-harness schema ${typeName}`);
    }
    for (const [verb, typeName] of [
      ["progress", "PlanProgress"],
      ["issue-close", "ClosureEvidence"],
      ["handoff", "HandoffEvidence"],
    ]) {
      const help = runBundle("bun-shebang", ["plan", verb, "--help"], process.cwd());
      const normalizedHelp = help.stdout.replace(/\s+/g, " ");
      expect(normalizedHelp).toContain(typeName);
      expect(normalizedHelp).toContain(`mstar-harness schema ${typeName}`);
    }
  });

  test("closure payload validation follows disposition-specific engine requirements", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-issue-closure-conditions-"));
    roots.push(root);
    const file = join(root, "closure.json");
    writeJson(file, {});

    for (const [verb, required, unrelated] of [
      ["close", ["references", "alignmentRef"], ["scope", "canonicalIssueId"]],
      ["waive", ["scope", "alignmentRef"], ["references", "canonicalIssueId"]],
      ["duplicate", ["canonicalIssueId"], ["references", "alignmentRef", "scope"]],
      ["supersede", ["canonicalIssueId"], ["references", "alignmentRef", "scope"]],
    ] as const) {
      const result = runBundle("bun-shebang", ["issue", verb, "I-000001", "--file", file, "--json"], root);
      expect(result.exitCode).toBe(2);
      const body = jsonOf(result);
      expect(body).toMatchObject({ ok: false, code: "usage" });
      expect(String(body.message)).toContain("reason");
      for (const field of required) expect(String(body.message)).toContain(field);
      for (const field of unrelated) expect(String(body.message)).not.toContain(field);
    }
  });

  test("unknown schema type is a usage refusal with available type names", () => {
    const result = runBundle("bun-shebang", ["schema", "HandofffEvidence"], process.cwd());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown payload type");
    expect(result.stderr).toContain("HandoffEvidence");
    expect(result.stderr).not.toContain("Setup failed");
  });

  test("link validation reports invalid relation form and its missing pair field together", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-issue-link-pair-"));
    roots.push(root);
    const file = join(root, "link.json");
    writeJson(file, { relation: "related", kind: "ticket" });
    const result = runBundle("bun-shebang", ["issue", "link", "I-000001", "--file", file, "--json"], root);
    expect(result.exitCode).toBe(2);
    const body = jsonOf(result);
    expect(body).toMatchObject({ ok: false, code: "usage" });
    expect(String(body.message)).toContain("invalid provenance kind");
    expect(String(body.message)).toContain("issueId");
    expect(String(body.message)).toContain("target");
  });

  test("capture reports every missing payload field in one refusal", async () => {
    const { root } = await makeHarness();
    const file = join(root, "incomplete.json");
    writeJson(file, { title: "only supplied field" });
    const result = runBundle(
      "bun-shebang",
      ["issue", "add", "--file", file, "--operation-id", "capture-incomplete", "--actor", "project-manager", "--json"],
      root,
    );
    expect(result.exitCode).toBe(2);
    const body = jsonOf(result);
    expect(body).toMatchObject({ ok: false, code: "usage" });
    for (const field of [
      "projectId", "kind", "severity", "impact", "acceptance", "sourceIdentity", "rootCauseKey", "acceptanceKey",
      "occurrenceKey", "sourceKind", "location", "observedBehavior", "evidence", "discoveredAt",
    ]) {
      expect(body.message).toContain(field);
    }
  });

  test("unscoped capture with no plan, both launchers", async () => {
    for (const launcher of ["bun-shebang", "node"] as const) {
      const { root, harness } = await makeHarness();
      const file = join(root, "capture.json");
      writeJson(file, capturePayload());
      const result = runBundle(
        launcher,
        [
          "issue",
          "add",
          "--file",
          file,
          "--operation-id",
          "cap-1",
          "--actor",
          "project-manager",
          "--harness",
          harness,
          "--json",
        ],
        root,
      );
      const launched = result.argv[0];
      expect(launched === BUNDLE || launched === NODE_BIN || (typeof launched === "string" && launched.endsWith("node"))).toBe(true);
      expect(result.argv.join(" ")).not.toMatch(/sqlite-transport|bun:sqlite/i);
      expect(result.exitCode).toBe(0);
      const body = jsonOf(result);
      expect(body.ok).toBe(true);
      expect(typeof body.storeRevision).toBe("number");
      expect(body.data !== null && typeof body.data === "object" && "created" in body.data && body.data.created === true).toBe(true);
      expect(body.data !== null && typeof body.data === "object" && "issueId" in body.data && body.data.issueId === "I-000001").toBe(true);
    }
  });

  test("repeat occurrence appends on a distinct observation", async () => {
    const { root, harness } = await makeHarness();
    const first = join(root, "cap.json");
    writeJson(first, capturePayload());
    const add = runBundle("bun-shebang", [
      "issue",
      "add",
      "--file",
      first,
      "--operation-id",
      "cap-1",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(add.exitCode).toBe(0);
    const issueId = (jsonOf(add).data as { issueId: string }).issueId;
    const occ = join(root, "occ.json");
    writeJson(
      occ,
      capturePayload({
        occurrenceKey: "run-2",
        discoveredAt: "2026-09-18T11:00:00.000Z",
        observedBehavior: "still throws on empty path",
      }),
    );
    const second = runBundle("node", [
      "issue",
      "occurrence",
      issueId,
      "--file",
      occ,
      "--operation-id",
      "occ-2",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(second.exitCode).toBe(0);
    const shown = runBundle("bun-shebang", ["issue", "show", issueId, "--harness", harness, "--json"], root);
    expect(shown.exitCode).toBe(0);
    const detail = jsonOf(shown).data as { occurrences: unknown[] };
    expect(detail.occurrences).toHaveLength(2);
  });

  test("closure authorization and refusal", async () => {
    const { root, harness } = await makeHarness();
    const file = join(root, "cap.json");
    writeJson(file, capturePayload());
    const add = runBundle("node", [
      "issue",
      "add",
      "--file",
      file,
      "--operation-id",
      "cap-1",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(add.exitCode).toBe(0);
    const created = jsonOf(add).data as { issueId: string; revision: number };
    const evidence = join(root, "close.json");
    writeJson(evidence, {
      reason: "acceptance met",
      references: ["qa/run.md"],
      alignmentRef: "QA gate: Approve — qa/run.md",
    });
    const closeArgs = (operationId: string, actor: string, session?: string) => [
      "issue",
      "close",
      created.issueId,
      "--file",
      evidence,
      "--expect",
      String(created.revision),
      "--operation-id",
      operationId,
      "--actor",
      actor,
      ...(session === undefined ? [] : ["--session", session]),
      "--harness",
      harness,
      "--json",
    ];
    // A forged actor without the envelope: the envelope is required, not optional.
    const forged = runBundle("bun-shebang", closeArgs("close-forged", "project-manager"), root);
    expect(forged.exitCode).toBe(2);
    expect(jsonOf(forged).code).toBe("usage");
    const session = writeBoundEnvelope(harness);
    // A bound envelope that does not prove the claimed seat refuses at the domain boundary.
    const wrongSeat = runBundle("node", closeArgs("close-qa", "qa-engineer", session), root);
    expect(wrongSeat.exitCode).toBe(1);
    expect(jsonOf(wrongSeat).ok).toBe(false);
    expect(jsonOf(wrongSeat).code).toBe("issue.scope-refused");
    const absentSession = runBundle("node", closeArgs("close-absent", "project-manager", join(root, "no-such-session.json")), root);
    expect(absentSession.exitCode).toBe(1);
    expect(jsonOf(absentSession).code).toBe("issue.scope-refused");
    // A hand-written envelope with the right shape, role, plan and harness root,
    // at an arbitrary path, is not an issued authority.
    const handWritten = runBundle(
      "node",
      closeArgs("close-hand-written", "project-manager", writeHandWrittenEnvelope(root, harness)),
      root,
    );
    expect(handWritten.exitCode).toBe(1);
    expect(jsonOf(handWritten).code).toBe("issue.scope-refused");
    const refused = runBundle("bun-shebang", closeArgs("close-leaf", "fullstack-dev", session), root);
    expect(refused.exitCode).toBe(1);
    const refusal = jsonOf(refused);
    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("issue.scope-refused");
    // Acceptance evidence without the acceptance authority is not a closure.
    const noAuthority = join(root, "close-no-authority.json");
    writeJson(noAuthority, { reason: "acceptance met", references: ["qa/run.md"] });
    const incomplete = runBundle("node", [
      "issue",
      "close",
      created.issueId,
      "--file",
      noAuthority,
      "--expect",
      String(created.revision),
      "--operation-id",
      "close-no-authority",
      "--actor",
      "project-manager",
      "--session",
      session,
      "--harness",
      harness,
      "--json",
    ], root);
    expect(incomplete.exitCode).toBe(2);
    expect(jsonOf(incomplete).code).toBe("usage");
    expect(String(jsonOf(incomplete).message)).toContain("alignmentRef");
    const shown = runBundle("node", ["issue", "show", created.issueId, "--harness", harness, "--json"], root);
    expect(jsonOf(shown).data).toMatchObject({ disposition: "open", revision: created.revision });
    const ok = runBundle("node", closeArgs("close-pm", "project-manager", session), root);
    expect(ok.exitCode).toBe(0);
    expect(jsonOf(ok).ok).toBe(true);
    const after = runBundle("node", ["issue", "show", created.issueId, "--harness", harness, "--json"], root);
    expect(jsonOf(after).data).toMatchObject({ disposition: "resolved" });
    // Boundary cast: the CLI's JSON envelope, read for one fixture assertion.
    const resolved = jsonOf(after).data as { transitions: Array<{ evidence: { alignmentRef: string } }> };
    expect(resolved.transitions[0]?.evidence.alignmentRef).toBe("QA gate: Approve — qa/run.md");
  });

  test("leaf capture is refused while an unscoped permitted capture succeeds", async () => {
    const { root, harness } = await makeHarness();
    const file = join(root, "cap.json");
    writeJson(file, capturePayload());
    const leaf = runBundle("node", [
      "issue",
      "add",
      "--file",
      file,
      "--operation-id",
      "cap-leaf",
      "--actor",
      "qc-specialist",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(leaf.exitCode).toBe(1);
    expect(jsonOf(leaf).code).toBe("issue.scope-refused");
    const empty = runBundle("bun-shebang", ["issue", "list", "--harness", harness, "--json"], root);
    expect(jsonOf(empty).data).toMatchObject({ total: 0 });
    const ok = runBundle("bun-shebang", [
      "issue",
      "add",
      "--file",
      file,
      "--operation-id",
      "cap-pm",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(ok.exitCode).toBe(0);
    expect(jsonOf(ok).data).toMatchObject({ created: true, issueId: "I-000001" });
  });

  test("an inherited role name cannot triage despite a valid envelope", async () => {
    const { root, harness } = await makeHarness();
    const file = join(root, "cap.json");
    writeJson(file, capturePayload());
    const add = runBundle("node", [
      "issue",
      "add",
      "--file",
      file,
      "--operation-id",
      "cap-1",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    const created = jsonOf(add).data as { issueId: string; revision: number };
    const triageFile = join(root, "triage.json");
    writeJson(triageFile, { reason: "reclass", severity: "low" });
    const session = writeBoundEnvelope(harness);
    const result = runBundle("bun-shebang", [
      "issue",
      "triage",
      created.issueId,
      "--file",
      triageFile,
      "--expect",
      String(created.revision),
      "--operation-id",
      "triage-proto",
      "--actor",
      "toString",
      "--session",
      session,
      "--harness",
      harness,
      "--json",
    ], root);
    expect(result.exitCode).toBe(1);
    expect(jsonOf(result).code).toBe("issue.scope-refused");
    const shown = runBundle("node", ["issue", "show", created.issueId, "--harness", harness, "--json"], root);
    expect(jsonOf(shown).data).toMatchObject({ severity: "high", revision: created.revision });
  });

  test("JSON exit behavior: success 0, domain 1, usage 2", async () => {
    const { root, harness } = await makeHarness();
    const missing = runBundle("bun-shebang", ["issue", "show", "I-999999", "--harness", harness, "--json"], root);
    expect(missing.exitCode).toBe(1);
    expect(jsonOf(missing).ok).toBe(false);
    const usage = runBundle("node", ["issue", "add", "--json", "--unknown-flag"], root);
    expect(usage.exitCode).toBe(2);
    expect(jsonOf(usage).ok).toBe(false);
    expect(jsonOf(usage).code).toBe("usage");
  });

  test("invalid enum and argument handling", async () => {
    const { root, harness } = await makeHarness();
    const listed = runBundle("bun-shebang", ["issue", "list", "--kind", "not-a-kind", "--harness", harness, "--json"], root);
    expect(listed.exitCode).toBe(2);
    expect(jsonOf(listed).code).toBe("usage");
    const add = runBundle("node", ["issue", "add", "--harness", harness, "--json", "--actor", "project-manager", "--operation-id", "x"], root);
    expect(add.exitCode).toBe(2);
    expect(jsonOf(add).code).toBe("usage");
  });

  test("below-floor Node refuses with actionable upgrade guidance", async () => {
    const { root, harness } = await makeHarness();
    const preload = join(root, "below-floor.mjs");
    writeFileSync(
      preload,
      `Object.defineProperty(process, "versions", { value: { ...process.versions, node: "18.20.0" } });\n`,
    );
    const result = runBundle(
      "node",
      ["issue", "list", "--harness", harness, "--json"],
      root,
      { nodeArgs: ["--import", `file://${preload}`] },
    );
    expect(result.exitCode).toBe(1);
    const body = jsonOf(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("store.runtime-unsupported");
    expect(String(body.message)).toMatch(/24\.18\.0/);
    expect(String(body.message)).toMatch(/nodejs\.org|upgrade/i);
  });

  test("malformed numeric list filters refuse as usage before store access", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-issue-limit-"));
    roots.push(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    for (const args of [
      ["--limit", "1x"],
      ["--offset", "1x"],
      ["--limit", "0"],
    ] as const) {
      const result = runBundle("node", ["issue", "list", ...args, "--harness", harness, "--json"], root);
      expect(result.exitCode).toBe(2);
      expect(jsonOf(result).ok).toBe(false);
      expect(jsonOf(result).code).toBe("usage");
      expect(existsSync(join(harness, "store.db"))).toBe(false);
    }
  });

  test("wrong-typed optional triage field refuses usage and mutates nothing", async () => {
    const { root, harness } = await makeHarness();
    const file = join(root, "cap.json");
    writeJson(file, capturePayload());
    const add = runBundle("node", [
      "issue",
      "add",
      "--file",
      file,
      "--operation-id",
      "cap-1",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(add.exitCode).toBe(0);
    const created = jsonOf(add).data as { issueId: string; revision: number };
    const triageFile = join(root, "triage.json");
    writeJson(triageFile, { reason: "tighten severity", severity: 123 });
    const result = runBundle("node", [
      "issue",
      "triage",
      created.issueId,
      "--file",
      triageFile,
      "--expect",
      String(created.revision),
      "--operation-id",
      "triage-bad",
      "--actor",
      "project-manager",
      "--session",
      writeBoundEnvelope(harness),
      "--harness",
      harness,
      "--json",
    ], root);
    expect(result.exitCode).toBe(2);
    expect(jsonOf(result).code).toBe("usage");
    const shown = runBundle("node", ["issue", "show", created.issueId, "--harness", harness, "--json"], root);
    expect(shown.exitCode).toBe(0);
    expect((jsonOf(shown).data as { revision: number }).revision).toBe(created.revision);
  });

  test("missing native sqlite capability refuses with actionable guidance", async () => {
    const { root, harness } = await makeHarness();
    const preload = join(root, "no-sqlite.mjs");
    writeFileSync(
      preload,
      `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:sqlite") {
      return { shortCircuit: true, url: "data:text/javascript,export const DatabaseSync = undefined;" };
    }
    return nextResolve(specifier, context);
  },
});
`,
    );
    const result = runBundle(
      "node",
      ["issue", "list", "--harness", harness, "--json"],
      root,
      { nodeArgs: ["--import", `file://${preload}`] },
    );
    expect(result.exitCode).toBe(1);
    const body = jsonOf(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("store.runtime-unsupported");
    expect(String(body.message)).toMatch(/node:sqlite/);
    expect(String(body.message)).toMatch(/nodejs\.org|bun\.sh|upgrade/i);
  });


  test("unrelated --help does not open SQLite", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-issue-help-"));
    roots.push(root);
    for (const launcher of ["bun-shebang", "node"] as const) {
      const result = runBundle(launcher, ["path", "resolve", "--help"], root);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(root, "store.db"))).toBe(false);
      expect(existsSync(join(root, ".mstar", "store.db"))).toBe(false);
      expect(result.stdout + result.stderr).not.toMatch(/node:sqlite/);
    }
  });

  test("issue --help lists the frozen verb family without opening a store", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-issue-family-help-"));
    roots.push(root);
    const result = runBundle("bun-shebang", ["issue", "--help"], root);
    expect(result.exitCode).toBe(0);
    for (const verb of ["add", "list", "show", "occurrence", "triage", "close", "waive", "duplicate", "supersede", "link", "export"]) {
      expect(result.stdout).toContain(verb);
    }
    expect(existsSync(join(root, "store.db"))).toBe(false);
  });
});
