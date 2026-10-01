/** Command-owned CLI subprocess coverage; fixture and assertion contracts are preserved. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore } from "@mstar-harness/engine";
import { runCli, withTempDir } from "./harness";
import { cliEnvelope, violationCodes } from "./support/cli-assertions";

// ---------------------------------------------------------------------------
// mstar status validate — v2 root + workflow snapshot (audit-004 cutover)
// ---------------------------------------------------------------------------

/** Valid v2 root status.json (structure-only: no active workflows listed). */
const STATUS_V2_ROOT_OK = `{
  "version": 2,
  "updated_at": "2026-08-08",
  "workflows": []
}`;

/** v2 root listing a workflow whose snapshot is missing → fail-closed. */
const STATUS_V2_ROOT_MISSING_SNAPSHOT = `{
  "version": 2,
  "updated_at": "2026-08-08",
  "workflows": [{ "id": "wf-1", "type": "plan", "started_at": "2026-08-08", "dir": "workflows/wf-1" }]
}`;

/** v1-shaped root — hard cutover rejects it with the migrate hint. */
const STATUS_V1_ROOT = `{
  "version": 1,
  "updated_at": "2026-08-08",
  "plans": [],
  "residual_findings": {},
  "metadata": {}
}`;

/** Valid workflow snapshot (single plan row, no leases). */
function snapshotDoc(planRows: unknown[]): string {
  return JSON.stringify(
    {
      schema_version: 1,
      id: "wf-1",
      type: "plan",
      status: "running",
      started_at: "2026-08-08",
      updated_at: "2026-08-08",
      plans: planRows,
    },
    null,
    2,
  );
}

describe("mstar status validate — v2 root + workflow snapshot (hard cutover)", () => {
  test("valid v2 root → OK, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "status.json"), STATUS_V2_ROOT_OK);
      const result = runCli(["status", "validate", join(dir, "status.json")]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "status.ok").data?.path).toBe(join(dir, "status.json"));
      expect(result.stderr).toBe("");
    });
  });

  test("v2 root listing a workflow whose snapshot is missing → snapshot-missing, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "status.json"), STATUS_V2_ROOT_MISSING_SNAPSHOT);
      const result = runCli(["status", "validate", join(dir, "status.json")]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("status.workflow.snapshot-missing");
    });
  });

  test("v1 root fails closed with the migrate hint, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "status.json"), STATUS_V1_ROOT);
      const result = runCli(["status", "validate", join(dir, "status.json")]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("status.migration-required");
    });
  });

  test("workflow snapshot path validates with the snapshot validator, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const workflowDir = join(dir, "workflows", "wf-1");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(workflowDir, "snapshot.json"), snapshotDoc([]));
      const result = runCli(["status", "validate", join(workflowDir, "snapshot.json")]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "status.ok").data?.path).toBe(join(workflowDir, "snapshot.json"));
    });
  });

  test("invalid snapshot (bad lifecycle type) → workflow.snapshot.invalid-type, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const workflowDir = join(dir, "workflows", "wf-1");
      mkdirSync(workflowDir, { recursive: true });
      const doc = JSON.parse(snapshotDoc([])) as Record<string, unknown>;
      doc.type = "sprint";
      writeFileSync(join(workflowDir, "snapshot.json"), JSON.stringify(doc, null, 2));
      const result = runCli(["status", "validate", join(workflowDir, "snapshot.json")]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "workflow.snapshot.invalid-type").message).toContain("invalid-type");
    });
  });

  test("missing status file fails with exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["status", "validate", join(dir, "nope.json")]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "status.file-not-found").message).toContain("status file not found");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar status tech-debt / findings-cleanup — issue-store authority (G2b)
// ---------------------------------------------------------------------------

/** A CaptureInput payload for the unscoped `mstar issue add` entry. */
function captureInputOf(occurrenceKey: string, severity: string): Record<string, unknown> {
  return {
    projectId: "_default",
    title: `Finding ${occurrenceKey}`,
    kind: "bug",
    severity,
    impact: "an acceptance is not met",
    acceptance: "the finding is fixed and verified",
    sourceIdentity: `slice4/${occurrenceKey}`,
    rootCauseKey: "slice4-root-cause",
    acceptanceKey: "slice4-acceptance",
    occurrenceKey,
    sourceKind: "qc",
    location: "packages/cli/src/index.ts",
    observedBehavior: "observed by the slice-4 fixture",
    evidence: ["fixture evidence"],
    discoveredAt: "2026-09-18T00:00:00Z",
  };
}

/**
 * An ACTIVE issue store under `dir` holding one unscoped OPEN issue; returns
 * the DB-assigned issue id. `store init` is create-only for a genuinely empty
 * workspace, so it runs before any register-shaped file exists.
 */
function seedIssueStore(dir: string, severity = "high"): string {
  const init = runCli(["store", "init", "--harness", dir]);
  expect(init.exitCode).toBe(0);
  const payloadPath = join(dir, "capture.json");
  writeFileSync(payloadPath, JSON.stringify(captureInputOf("occ-1", severity)), "utf8");
  const added = runCli([
    "issue", "add", "--harness", dir, "--operation-id", "slice4-capture-1", "--actor", "project-manager",
    "--file", payloadPath,
  ]);
  expect(added.exitCode).toBe(0);
  const envelope = JSON.parse(added.stdout) as { data?: { issueId?: unknown } };
  const issueId = envelope.data?.issueId;
  if (typeof issueId !== "string") throw new Error(`issue add returned no id: ${added.stdout}`);
  return issueId;
}

describe("mstar status tech-debt — open-issue rollup over the issue store", () => {
  test("rolls up the store's OPEN issues by severity and project, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      seedIssueStore(dir);
      const result = runCli(["status", "tech-debt", "--harness", dir]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "status.ok").data).toMatchObject({
        total_open: 1,
        by_severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        by_project: { _default: 1 },
      });
    });
  });

  test("a missing store refuses instead of printing an empty rollup (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["status", "tech-debt", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "store.not-initialized").data).toBeUndefined();
    });
  });

  test("a staged store is not the authority: the rollup refuses (exit 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-slice4-staged-"));
    try {
      const handle = await initializeStore({ harnessDir: dir });
      handle.close();
      const write = await openStore({ harnessDir: dir }, "write");
      write.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
      write.close();
      // A read in THIS process first: a child's first read of a store the
      // runner just wrote intermittently fails to open (task-3 report §obs).
      const seal = await openStore({ harnessDir: dir }, "read");
      seal.close();

      const result = runCli(["status", "tech-debt", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "store.not-active").data).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mstar status findings-cleanup — issue-linkage gate over the issue store", () => {
  test("an OPEN issue that is not linked to the plan does not block it (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      seedIssueStore(dir, "critical");
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir, "--mode", "zero-residual"]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "status.ok").data).toMatchObject({ planId: "p1", violations: [] });
    });
  });
  test("a missing store fails closed instead of passing as no findings (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "store.not-initialized").data).toBeUndefined();
    });
  });
  test("invalid --mode is a usage error before store access (exit 2)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir, "--mode", "bogus"]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("zero-residual");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar status backlog-register / backlog-close — removed in G2b
// ---------------------------------------------------------------------------

describe("mstar status backlog-register / backlog-close — retired verbs name the replacement", () => {
  for (const [verb, replacement] of [
    ["backlog-register", "plan issue-add"],
    ["backlog-close", "plan issue-close"],
  ] as const) {
    test(`${verb}: refuses with the migration path and writes no register (exit 1)`, () => {
      withTempDir("mstar-slice4-cli-", (dir) => {
        const result = runCli(["status", verb], { cwd: dir });
        expect(cliEnvelope(result, "refused", "status.verb-retired").message).toContain(`mstar ${replacement}`);
        expect(existsSync(join(dir, "projects"))).toBe(false);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// mstar status archive-residuals — removed (audit-004 cutover, re-pointed G2b)
// ---------------------------------------------------------------------------

describe("mstar status archive-residuals — removed command names the replacement", () => {
  test("invocation errors and names the issue-store replacement (exit 1)", () => {
    const result = runCli(["status", "archive-residuals"]);
    expect(cliEnvelope(result, "refused", "status.verb-retired").message).toContain("mstar plan issue-close");
  });
});
