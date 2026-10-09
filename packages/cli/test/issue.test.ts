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

  test("schema output discloses required and conditional issue payload fields", () => {
    const schema = runBundle("bun-shebang", ["schema", "CaptureInput"], process.cwd());
    expect(schema.exitCode).toBe(0);
    const parsed = jsonOf(schema).data as { type: string; fields: Array<{ name: string; required: boolean; type: string }> };
    expect(parsed.type).toBe("CaptureInput");
    expect(parsed.fields).toContainEqual(expect.objectContaining({ name: "projectId", required: true, type: "string" }));
    const closureSchema = runBundle("bun-shebang", ["schema", "ClosureEvidence"], process.cwd());
    expect(closureSchema.exitCode).toBe(0);
    const closurePayload = jsonOf(closureSchema).data as {
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
    expect(closureFields.find((field) => field.name === "scope")).toMatchObject({
      required: false,
      requiredWhen: ["waive"],
    });
    const reopenSchema = runBundle("bun-shebang", ["schema", "IssueReopen"], process.cwd());
    expect(reopenSchema.exitCode).toBe(0);
    expect((jsonOf(reopenSchema).data as { fields: Array<{ name: string; required: boolean; nonblankWhenPresent?: boolean }> }).fields)
      .toContainEqual(expect.objectContaining({ name: "reason", required: true, nonblankWhenPresent: true }));
    const commandSchema = runBundle("bun-shebang", ["schema", "--command", "issue.reopen"], process.cwd());
    expect(commandSchema.exitCode).toBe(0);
    const descriptor = (jsonOf(commandSchema).data as { descriptor: { requirements: Array<Record<string, unknown>> } }).descriptor;
    expect(descriptor.requirements).toContainEqual(expect.objectContaining({
      name: "expect",
      tokenKind: "revision",
    }));
    const reopenHelp = runBundle("bun-shebang", ["issue", "reopen", "--help"], process.cwd());
    expect(`${reopenHelp.stdout}${reopenHelp.stderr}`).toContain("Exact current issue revision from `mstar issue");
  });


  test("reopen is terminal-only, CAS guarded, and preserves the prior closure note", async () => {
    const { root, harness } = await makeHarness();
    const captureFile = join(root, "capture.json");
    writeJson(captureFile, capturePayload());
    const added = runBundle("node", [
      "issue", "add", "--file", captureFile, "--operation-id", "reopen-seed",
      "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(added.exitCode).toBe(0);
    const created = jsonOf(added).data as { issueId: string; revision: number };

    const closeFile = join(root, "close.json");
    writeJson(closeFile, {
      reason: "acceptance verified",
      references: ["qa/reopen-run.md"],
      alignmentRef: "QA gate: Approve",
    });
    const closed = runBundle("node", [
      "issue", "close", "--id", created.issueId, "--disposition", "resolved", "--file", closeFile,
      "--expect", String(created.revision), "--operation-id", "reopen-close",
      "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(closed.exitCode).toBe(0);
    const closeReceipt = jsonOf(closed).data as { revision: number };

    const reopenFile = join(root, "reopen.json");
    writeJson(reopenFile, { reason: "new evidence requires investigation" });
    const args = [
      "issue", "reopen", "--id", created.issueId, "--file", reopenFile,
      "--expect", String(closeReceipt.revision), "--operation-id", "reopen-once",
      "--actor", "project-manager", "--harness", harness,
    ];
    const reopened = runBundle("node", args, root);
    expect(reopened.exitCode).toBe(0);
    expect(jsonOf(reopened).data).toMatchObject({ issueId: created.issueId, revision: closeReceipt.revision + 1, created: false });
    const replay = runBundle("node", args, root);
    expect(replay.exitCode).toBe(0);
    expect(jsonOf(replay).data).toEqual(jsonOf(reopened).data);

    const operationConflict = runBundle("node", [
      "issue", "reopen", "--id", created.issueId,
      "--payload", JSON.stringify({ reason: "different request on reserved key" }),
      "--expect", String(closeReceipt.revision), "--operation-id", "reopen-once",
      "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(operationConflict.exitCode).toBe(1);
    expect(jsonOf(operationConflict)).toMatchObject({ status: "refused", code: "store.operation-conflict" });
    expect(String(jsonOf(operationConflict).message)).toContain(
      "Recovery: Replay the original request that reserved this operation id unchanged to receive its recorded receipt, or run this operation with a fresh `--operation-id`.",
    );

    const closeIdConflict = runBundle("node", [
      "issue", "reopen", "--id", created.issueId,
      "--payload", JSON.stringify({ reason: "different command reserved the id" }),
      "--expect", String(closeReceipt.revision), "--operation-id", "reopen-close",
      "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(closeIdConflict.exitCode).toBe(1);
    expect(jsonOf(closeIdConflict)).toMatchObject({ status: "refused", code: "store.operation-conflict" });
    expect(String(jsonOf(closeIdConflict).message)).toContain(
      "Recovery: Replay the original request that reserved this operation id unchanged to receive its recorded receipt, or run this operation with a fresh `--operation-id`.",
    );

    const shown = runBundle("node", ["issue", "show", "--id", created.issueId, "--harness", harness], root);
    expect(shown.exitCode).toBe(0);
    const detail = jsonOf(shown).data as {
      disposition: string; closedAt: string | null; closureNote: string; revision: number;
      transitions: Array<{ fromDisposition: string; toDisposition: string; reason: string }>;
    };
    expect(detail).toMatchObject({
      disposition: "open",
      closedAt: null,
      closureNote: "acceptance verified",
      revision: closeReceipt.revision + 1,
    });
    expect(detail.transitions).toHaveLength(2);
    expect(detail.transitions[1]).toMatchObject({
      fromDisposition: "resolved",
      toDisposition: "open",
      reason: "new evidence requires investigation",
    });

    const openRefusal = runBundle("node", [
      "issue", "reopen", "--id", created.issueId, "--payload", JSON.stringify({ reason: "duplicate attempt" }),
      "--expect", String(detail.revision), "--operation-id", "reopen-open",
      "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(openRefusal.exitCode).toBe(1);
    expect(jsonOf(openRefusal)).toMatchObject({ status: "refused", code: "issue.invalid-disposition" });
    expect(String(jsonOf(openRefusal).message)).toContain("Only terminal→open is accepted; open cannot transition to open");
    expect(String(jsonOf(openRefusal).message)).toContain("Help: mstar issue reopen --help");
    expect(String(jsonOf(openRefusal).message)).toContain("Recovery: Run `mstar issue show --id I-000001`; only resolved|waived|duplicate|superseded issues can reopen, and open issues stay open.");

    const stale = runBundle("node", [
      "issue", "reopen", "--id", created.issueId, "--payload", JSON.stringify({ reason: "stale attempt" }),
      "--expect", String(closeReceipt.revision), "--operation-id", "reopen-stale",
      "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(stale.exitCode).toBe(1);
    expect(jsonOf(stale)).toMatchObject({ status: "refused", code: "issue.revision-conflict" });
    expect(String(jsonOf(stale).message)).toContain(
      "Recovery: Run `mstar issue show --id I-000001` against the same harness selection if one was supplied, then rerun the original command with `--expect <current-revision>` added or replacing the stale value, keeping `--operation-id`, `--actor`, and the original payload unchanged.",
    );
    const finalShow = runBundle("node", ["issue", "show", "--id", created.issueId, "--harness", harness], root);
    expect((jsonOf(finalShow).data as { revision: number }).revision).toBe(detail.revision);
  });
  test("unknown schema type is a usage refusal with available type names", () => {
    const result = runBundle("bun-shebang", ["schema", "HandofffEvidence"], process.cwd());
    expect(result.exitCode).toBe(2);
    const response = jsonOf(result);
    expect(response.status).toBe("usage");
    expect(String(response.message)).toContain("unknown payload type");
  });

  test("link creates a relation against an existing issue at the reviewed revision", async () => {
    const { root, harness } = await makeHarness();
    const firstFile = join(root, "issue.json");
    writeJson(firstFile, capturePayload());
    const created = runBundle("bun-shebang", [
      "issue", "add", "--file", firstFile, "--operation-id", "link-setup-1", "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(created.exitCode).toBe(0);
    expect((jsonOf(created).data as { issueId?: string }).issueId).toBe("I-000001");

    const secondFile = join(root, "second-issue.json");
    writeJson(secondFile, capturePayload({ rootCauseKey: "second-finding", occurrenceKey: "run-2" }));
    const second = runBundle("bun-shebang", [
      "issue", "add", "--file", secondFile, "--operation-id", "link-setup-2", "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(second.exitCode).toBe(0);
    expect((jsonOf(second).data as { issueId?: string }).issueId).toBe("I-000002");

    const shown = runBundle("bun-shebang", ["issue", "show", "--id", "I-000001", "--harness", harness], root);
    expect(shown.exitCode).toBe(0);
    const expectedRevision = String((jsonOf(shown).data as { revision: number }).revision);
    const file = join(root, "link.json");
    writeJson(file, { relation: "related", issueId: "I-000002" });
    const result = runBundle("bun-shebang", [
      "issue", "link", "--id", "I-000001", "--file", file, "--expect", expectedRevision,
      "--operation-id", "link-related", "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(result.exitCode).toBe(0);
    expect(jsonOf(result).status).toBe("ok");
    expect(jsonOf(result).data).toMatchObject({ revision: Number(expectedRevision) + 1 });
    const stale = runBundle("bun-shebang", [
      "issue", "link", "--id", "I-000001", "--file", file, "--expect", expectedRevision,
      "--operation-id", "link-stale-revision", "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(stale.exitCode).toBe(1);
    expect(jsonOf(stale)).toMatchObject({ status: "refused", code: "issue.revision-conflict" });
    expect(String(jsonOf(stale).message)).toContain(
      "Recovery: Run `mstar issue show --id I-000001` against the same harness selection if one was supplied, then rerun the original command with `--expect <current-revision>` added or replacing the stale value, keeping `--operation-id`, `--actor`, and the original payload unchanged.",
    );
    const replay = runBundle("bun-shebang", [
      "issue", "link", "--id", "I-000001", "--file", file, "--expect", expectedRevision,
      "--operation-id", "link-related", "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(replay.exitCode).toBe(0);
    expect(jsonOf(replay).data).toEqual(jsonOf(result).data);
    const afterStale = runBundle("bun-shebang", ["issue", "show", "--id", "I-000001", "--harness", harness], root);
    expect(afterStale.exitCode).toBe(0);
    expect(jsonOf(afterStale).data).toMatchObject({ revision: Number(expectedRevision) + 1 });
  });

  test("capture reports every missing payload field in one refusal", async () => {
    const { root } = await makeHarness();
    const file = join(root, "incomplete.json");
    writeJson(file, { title: "only supplied field" });
    const result = runBundle(
      "bun-shebang",
      ["issue", "add", "--file", file, "--operation-id", "capture-incomplete", "--actor", "project-manager"],
      root,
    );
    expect(result.exitCode).toBe(1);
    const body = jsonOf(result);
    expect(body.status).toBe("refused");
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
        ],
        root,
      );
      const launched = result.argv[0];
      expect(launched === BUNDLE || launched === NODE_BIN || (typeof launched === "string" && launched.endsWith("node"))).toBe(true);
      expect(result.argv.join(" ")).not.toMatch(/sqlite-transport|bun:sqlite/i);
      expect(result.exitCode).toBe(0);
      const body = jsonOf(result);
      expect(body.status).toBe("ok");
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
      "--id",
      issueId,
      "--file",
      occ,
      "--operation-id",
      "occ-2",
      "--actor",
      "project-manager",
      "--harness",
      harness,
    ], root);
    expect(second.exitCode).toBe(0);
    const shown = runBundle("bun-shebang", ["issue", "show", "--id", issueId, "--harness", harness], root);
    expect(shown.exitCode).toBe(0);
    const detail = jsonOf(shown).data as { occurrences: unknown[] };
    expect(detail.occurrences).toHaveLength(2);
  });

  test("closure requires valid evidence, and actor-only close resolves the issue", async () => {
    const { root, harness } = await makeHarness();
    const file = join(root, "cap.json");
    writeJson(file, capturePayload());
    const add = runBundle("node", [
      "issue", "add", "--file", file, "--operation-id", "cap-1", "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(add.exitCode).toBe(0);
    const created = jsonOf(add).data as { issueId: string; revision: number };
    const evidence = join(root, "close.json");
    writeJson(evidence, {
      reason: "acceptance met",
      references: ["qa/run.md"],
      alignmentRef: "QA gate: Approve — qa/run.md",
    });
    const noAuthority = join(root, "close-no-authority.json");
    writeJson(noAuthority, { reason: "acceptance met", references: ["qa/run.md"] });
    const incomplete = runBundle("node", [
      "issue", "close", "--id", created.issueId, "--file", noAuthority,
      "--expect", String(created.revision), "--operation-id", "close-no-authority",
      "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(incomplete.exitCode).toBe(1);
    expect(jsonOf(incomplete).status).toBe("refused");
    expect(String(jsonOf(incomplete).message)).toContain("alignmentRef");
    const unchanged = runBundle("node", ["issue", "show", "--id", created.issueId, "--harness", harness], root);
    expect(jsonOf(unchanged).data).toMatchObject({ disposition: "open", revision: created.revision });

    const ok = runBundle("node", [
      "issue", "close", "--id", created.issueId, "--file", evidence,
      "--expect", String(created.revision), "--operation-id", "close-actor-only",
      "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(ok.exitCode).toBe(0);
    expect(jsonOf(ok).status).toBe("ok");
    const after = runBundle("node", ["issue", "show", "--id", created.issueId, "--harness", harness], root);
    expect(jsonOf(after).data).toMatchObject({ disposition: "resolved" });
    const resolved = jsonOf(after).data as { transitions: Array<{ evidence: { alignmentRef: string } }> };
    expect(resolved.transitions[0]?.evidence.alignmentRef).toBe("QA gate: Approve — qa/run.md");
  });

  test("removed session and execution options are rejected as unknown options", async () => {
    const { root, harness } = await makeHarness();
    const file = join(root, "cap.json");
    writeJson(file, capturePayload());
    for (const option of ["--session", "--execution"]) {
      const result = runBundle("node", [
        "issue", "add", "--file", file, "--operation-id", `unknown-${option.slice(2)}`,
        "--actor", "project-manager", option, "unused", "--harness", harness,
      ], root);
      expect(result.exitCode).toBe(2);
      expect(jsonOf(result).code).toBe("command.invalid-input");
      expect(String(jsonOf(result).message)).toContain("unknown option");
    }
  });
  test("triage still enforces the capture-seat actor check", async () => {
    const { root, harness } = await makeHarness();
    const file = join(root, "cap.json");
    writeJson(file, capturePayload());
    const add = runBundle("node", [
      "issue", "add", "--file", file, "--operation-id", "actor-seat-seed",
      "--actor", "project-manager", "--harness", harness,
    ], root);
    expect(add.exitCode).toBe(0);
    const created = jsonOf(add).data as { issueId: string; revision: number };
    const triageFile = join(root, "triage.json");
    writeJson(triageFile, { reason: "reclassify", severity: "low" });
    const refused = runBundle("node", [
      "issue", "triage", "--id", created.issueId, "--file", triageFile,
      "--expect", String(created.revision), "--operation-id", "actor-seat-invalid",
      "--actor", "toString", "--harness", harness,
    ], root);
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused).code).toBe("issue.scope-refused");
    const shown = runBundle("node", ["issue", "show", "--id", created.issueId, "--harness", harness], root);
    expect(jsonOf(shown).data).toMatchObject({ severity: "high", revision: created.revision });
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
    ], root);
    expect(leaf.exitCode).toBe(1);
    expect(jsonOf(leaf).code).toBe("issue.scope-refused");
    const empty = runBundle("bun-shebang", ["issue", "list", "--harness", harness], root);
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
    ], root);
    expect(ok.exitCode).toBe(0);
    expect(jsonOf(ok).data).toMatchObject({ created: true, issueId: "I-000001" });
  });


  test("CLI envelope exit behavior: success 0, domain 1, usage 2", async () => {
    const { root, harness } = await makeHarness();
    const missing = runBundle("bun-shebang", ["issue", "show", "--id", "I-999999", "--harness", harness], root);
    expect(missing.exitCode).toBe(1);
    expect(jsonOf(missing).status).not.toBe("ok");
    const usage = runBundle("node", ["issue", "add", "--unknown-flag"], root);
    expect(usage.exitCode).toBe(2);
    expect(jsonOf(usage).status).not.toBe("ok");
    expect(jsonOf(usage).code).toBe("command.invalid-input");
  });

  test("invalid enum and argument handling", async () => {
    const { root, harness } = await makeHarness();
    const listed = runBundle("bun-shebang", ["issue", "list", "--kind", "not-a-kind", "--harness", harness], root);
    expect(listed.exitCode).toBe(2);
    expect(jsonOf(listed).code).toBe("command.invalid-input");
    const add = runBundle("node", ["issue", "add", "--harness", harness, "--actor", "project-manager", "--operation-id", "x"], root);
    expect(add.exitCode).toBe(2);
    expect(jsonOf(add)).toMatchObject({
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      details: {
        helpRoute: expect.any(String),
        recovery: expect.any(String),
        diagnostics: expect.arrayContaining([expect.objectContaining({ path: expect.any(String), code: expect.any(String) })]),
      },
    });
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
      ["issue", "list", "--harness", harness],
      root,
      { nodeArgs: ["--import", `file://${preload}`] },
    );
    expect(result.exitCode).toBe(1);
    const body = jsonOf(result);
    expect(body.status).not.toBe("ok");
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
      const result = runBundle("node", ["issue", "list", ...args, "--harness", harness], root);
      expect(result.exitCode).toBe(2);
      expect(jsonOf(result).status).not.toBe("ok");
      expect(jsonOf(result).code).toBe("command.invalid-input");
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
    ], root);
    expect(add.exitCode).toBe(0);
    const created = jsonOf(add).data as { issueId: string; revision: number };
    const triageFile = join(root, "triage.json");
    writeJson(triageFile, { reason: "tighten severity", severity: 123 });
    const result = runBundle("node", [
      "issue",
      "triage",
      "--id",
      created.issueId,
      "--file",
      triageFile,
      "--expect",
      String(created.revision),
      "--operation-id",
      "triage-bad",
      "--actor",
      "project-manager",
      "--harness",
      harness,
    ], root);
    expect(result.exitCode).toBe(1);
    expect(jsonOf(result).status).toBe("refused");
    const shown = runBundle("node", ["issue", "show", "--id", created.issueId, "--harness", harness], root);
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
      ["issue", "list", "--harness", harness],
      root,
      { nodeArgs: ["--import", `file://${preload}`] },
    );
    expect(result.exitCode).toBe(1);
    const body = jsonOf(result);
    expect(body.status).not.toBe("ok");
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
