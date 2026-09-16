/**
 * CLI `mstar status workflow-close` — the post-merge lifecycle close verb.
 *
 * Thin wrapper over engine `closeWorkflow` + `unregisterWorkflow` (P2 T2):
 * terminal snapshot write under the snapshot lock FIRST, then the idempotent
 * v2 root unregister. Contract pinned here:
 * - exit 0: fresh close (snapshot `completed` + `ended_at`, root entry
 *   removed, root still validates) and the fully-closed retry (already-closed
 *   notice, neither file rewritten, original `ended_at` kept).
 * - exit 1 gate/IO refusals before any write: missing snapshot (no workflow
 *   dir side effect), dangling integration merge lease, unfinished plan row;
 *   an unregister failure AFTER the durable snapshot write reports a partial
 *   close and a fixed-root retry finishes the unregister without changing
 *   `ended_at`.
 * - exit 2 usage: missing `--workflow`, a relative `--session`.
 * - a coordinated snapshot closes only for its bound coordinator envelope
 *   (`--session <path>`, spec §C4): a missing/mismatched envelope refuses
 *   with `coordination.session-mismatch` before the unfinished-row gate.
 * - exit 1: a hostile workflow id is rejected up front by the shared
 *   `assertWorkflowId` guard (same convention as every other
 *   `--workflow <id>` verb).
 *
 * Every case runs the real CLI as a subprocess against a temp fixture
 * harness — no live workflow is ever touched.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const WORKFLOW_ID = "wf-close";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn env with ambient harness env vars pinned out: the CLI
 * resolves harness dirs from MSTAR_HARNESS_DIR / MSTAR_CONTROL_ROOT ahead
 * of probing, and SDD_DIR redirects default outfile paths — ambient values
 * would redirect every fixture spuriously.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runCli(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function closeArgs(harness: string, extra: string[] = []): string[] {
  return ["status", "workflow-close", "--workflow", WORKFLOW_ID, "--harness", harness, ...extra];
}

/**
 * Minimal valid running snapshot whose single plan row is fully Done, carrying
 * the COMPLETE registered delivery shape the close consults (contract
 * §1/§4c/§4d/§4f: delivery kind, delivery anchors, collected evidence).
 * Override a member to pin a refusal.
 */
function snapshotDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    status: "running",
    started_at: "2026-08-01",
    updated_at: "2026-08-19",
    delivery_kind: "development",
    branch: { source: "feature/plan-a", target: "main" },
    delivery: {
      compound: { outcome: "created" },
      pr: { repo: "btspoony/mstar-harness", head: "feature/plan-a", target: "main" },
      merge: { provider: "github", evidence: "PR #244 verified merged at 2c792c01" },
    },
    plans: [{ id: "plan-a", title: "Plan A", file: "plans/plan-a.md", status: "Done" }],
    ...overrides,
  };
}

/** Minimal v2 root doc with the given active entries. */
function rootDoc(workflows: unknown[] = []): Record<string, unknown> {
  return { version: 2, updated_at: "2026-08-19", workflows };
}

function rootEntry(): Record<string, unknown> {
  return { id: WORKFLOW_ID, type: "plan", started_at: "2026-08-01", dir: `workflows/${WORKFLOW_ID}` };
}

interface HarnessFixture {
  /** `null` — do not create the workflow snapshot (default: running snapshot). */
  snapshot?: Record<string, unknown> | null;
  /** `null` — do not write the root file (default: v2 root with the entry). */
  root?: Record<string, unknown> | null;
}

/** Temp harness with `workflows/<id>/snapshot.json` + `status.json` fixtures. */
function setupHarness(fn: (harness: string, paths: { snapshot: string; root: string }) => void, fixture: HarnessFixture = {}): void {
  const harness = mkdtempSync(join(tmpdir(), "mstar-workflow-close-"));
  try {
    const snapshot = join(harness, "workflows", WORKFLOW_ID, "snapshot.json");
    const root = join(harness, "status.json");
    if (fixture.snapshot !== null) {
      mkdirSync(join(harness, "workflows", WORKFLOW_ID), { recursive: true });
      writeFileSync(snapshot, JSON.stringify(fixture.snapshot ?? snapshotDoc(), null, 2));
    }
    if (fixture.root !== null) {
      writeFileSync(root, JSON.stringify(fixture.root ?? rootDoc([rootEntry()]), null, 2));
    }
    fn(harness, { snapshot, root });
  } finally {
    rmSync(harness, { recursive: true, force: true });
  }
}

describe("mstar status workflow-close", () => {
  test("fixture close writes the terminal snapshot and removes the root entry (exit 0)", () => {
    setupHarness((harness, { snapshot, root }) => {
      const result = runCli(closeArgs(harness, ["--ended-at", "2026-09-12"]));
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const doc = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(doc.status).toBe("completed");
      expect(doc.ended_at).toBe("2026-09-12");
      expect(doc.updated_at).toBe("2026-09-12");
      expect((doc.plans as Array<Record<string, unknown>>).every((row) => row.status === "Done")).toBe(true);

      const rootAfter = JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>;
      expect(rootAfter.workflows).toEqual([]);

      // Fresh close (not the already-closed notice).
      expect(result.stdout).toContain(`workflow-close: ${WORKFLOW_ID} closed (status completed, ended_at 2026-09-12)`);

      // Product contract: the unregistered root still validates (exit 0).
      const validate = runCli(["status", "validate", root]);
      expect(validate.exitCode).toBe(0);
    });
  });

  test("dangling integration merge lease refuses before write (exit 1, bytes unchanged)", () => {
    setupHarness(
      (harness, { snapshot, root }) => {
        const beforeSnapshot = readFileSync(snapshot, "utf8");
        const beforeRoot = readFileSync(root, "utf8");

        const result = runCli(closeArgs(harness, ["--ended-at", "2026-09-12"]));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("terminal-dangling-merge-lease");

        // Before-write refusal preserves bytes (snapshot AND root — the
        // unregister never runs when the close refuses).
        expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
        expect(readFileSync(root, "utf8")).toBe(beforeRoot);
      },
      {
        snapshot: snapshotDoc({
          integration_merge_lease: {
            holder: "pm",
            claimed_at: "2026-08-19",
            plan_id: "plan-a",
            source_branch: "feature/plan-a",
            target_branch: "main",
          },
        }),
      },
    );
  });

  test("unfinished plan row refuses before write (exit 1, bytes unchanged)", () => {
    setupHarness(
      (harness, { snapshot, root }) => {
        const beforeSnapshot = readFileSync(snapshot, "utf8");
        const beforeRoot = readFileSync(root, "utf8");

        const result = runCli(closeArgs(harness));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("every plan row must be Done");

        expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
        expect(readFileSync(root, "utf8")).toBe(beforeRoot);
      },
      {
        snapshot: snapshotDoc({
          plans: [{ id: "plan-a", title: "Plan A", file: "plans/plan-a.md", status: "InProgress" }],
        }),
      },
    );
  });

  test("missing snapshot refuses without side effects (exit 1)", () => {
    setupHarness(
      (harness, { snapshot }) => {
        const result = runCli(["status", "workflow-close", "--workflow", "wf-missing", "--harness", harness]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("workflow snapshot not found");
        // No snapshot, no dir side effect for the unknown id.
        expect(existsSync(snapshot)).toBe(false);
        expect(existsSync(join(harness, "workflows", "wf-missing"))).toBe(false);
      },
      { snapshot: null, root: null },
    );
  });

  test("fully closed retry rewrites nothing and keeps ended_at (exit 0, already closed)", () => {
    setupHarness(
      (harness, { snapshot, root }) => {
        const beforeSnapshot = readFileSync(snapshot, "utf8");
        const beforeRoot = readFileSync(root, "utf8");

        // No --ended-at: the default (today) must NOT reach the files.
        const result = runCli(closeArgs(harness));
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`workflow-close: ${WORKFLOW_ID} already closed`);

        // Neither file is rewritten — the original terminal timestamps stay.
        expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
        expect(readFileSync(root, "utf8")).toBe(beforeRoot);
        const doc = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
        expect(doc.ended_at).toBe("2026-09-01");
      },
      {
        snapshot: snapshotDoc({ status: "completed", updated_at: "2026-09-01", ended_at: "2026-09-01" }),
        root: rootDoc(),
      },
    );
  });

  test("unregister failure reports a partial close; the retry finishes it without changing ended_at", () => {
    setupHarness((harness, { snapshot, root }) => {
      // Round 1: a v1 root refuses the unregister — the snapshot close is
      // already durable, so the failure must surface as a partial close and
      // the root bytes must be preserved.
      const v1Root = JSON.stringify({ version: 1, updated_at: "2026-08-19", plans: [] }, null, 2);
      writeFileSync(root, v1Root);
      const partial = runCli(closeArgs(harness, ["--ended-at", "2026-09-12"]));
      expect(partial.exitCode).toBe(1);
      expect(partial.stderr).toContain("partial close");

      const afterPartial = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(afterPartial.status).toBe("completed");
      expect(afterPartial.ended_at).toBe("2026-09-12");
      expect(readFileSync(root, "utf8")).toBe(v1Root);

      // Round 2: the root is migrated (v2 + the stale entry); the retry only
      // finishes the unregister — a DIFFERENT --ended-at must not touch the
      // already-terminal snapshot.
      writeFileSync(root, JSON.stringify(rootDoc([rootEntry()]), null, 2));
      const retry = runCli(closeArgs(harness, ["--ended-at", "2026-09-20"]));
      expect(retry.exitCode).toBe(0);
      expect(retry.stdout).toContain(`workflow-close: ${WORKFLOW_ID} already closed`);
      expect(retry.stdout).toContain(`unregistered ${WORKFLOW_ID}`);

      const docAfter = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(docAfter.ended_at).toBe("2026-09-12");
      expect(docAfter.updated_at).toBe("2026-09-12");
      const rootAfter = JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>;
      expect(rootAfter.workflows).toEqual([]);
    });
  });

  test("missing --workflow is a usage error (exit 2)", () => {
    setupHarness((harness) => {
      const result = runCli(["status", "workflow-close", "--harness", harness]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage");
    });
  });

  test("hostile workflow id (path traversal) is rejected by the shared id guard (exit 1)", () => {
    setupHarness((harness) => {
      const result = runCli(["status", "workflow-close", "--workflow", "../escape", "--harness", harness]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid workflow id");
      // The guard fires before any I/O — no dir appears at the escaped path.
      expect(existsSync(join(harness, "escape"))).toBe(false);
    });
  });
});

/**
 * The close verb under the coordinated-writer cutover: a snapshot carrying the
 * `coordination` block must still be refused *before* any byte is written when
 * a pre-existing gate fails, and an uncoordinated close keeps its contract.
 * The coordinator-session transport for a coordinated close is an engine-side
 * seam (see the task report); these cases pin only what the CLI can guarantee
 * today — a refusal never mutates the snapshot or the root entry.
 */
describe("mstar status workflow-close — coordinated-writer boundary", () => {
  /** Snapshot whose row is done, with a well-formed coordinator binding. */
  function coordinatedSnapshotDoc(harness: string, rowStatus: string): Record<string, unknown> {
    return snapshotDoc({
      coordination: {
        coordinator: {
          session_id: "11111111-2222-3333-4444-555555555555",
          session_file: join(harness, "workflows", WORKFLOW_ID, "sessions", "coordinator.json"),
          bound_at: "2026-09-15T00:00:00Z",
        },
      },
      plans: [{ id: "plan-a", title: "Plan A", file: "plans/plan-a.md", status: rowStatus }],
    });
  }

  /** Write the coordinator envelope the snapshot binds to; return its path. */
  function writeCoordinatorSession(harness: string): string {
    const sessionsDir = join(harness, "workflows", WORKFLOW_ID, "sessions");
    const sessionPath = join(sessionsDir, "coordinator.json");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      sessionPath,
      JSON.stringify(
        {
          schema_version: 1,
          role: "coordinator",
          session_id: "11111111-2222-3333-4444-555555555555",
          workflow_id: WORKFLOW_ID,
          harness_root: harness,
        },
        null,
        2,
      ),
    );
    return sessionPath;
  }

  test("a coordinated snapshot closes for its bound coordinator session (exit 0)", () => {
    setupHarness((harness, { snapshot, root }) => {
      writeFileSync(snapshot, JSON.stringify(coordinatedSnapshotDoc(harness, "Done"), null, 2), "utf8");
      const sessionPath = writeCoordinatorSession(harness);

      const result = runCli(closeArgs(harness, ["--ended-at", "2026-09-12", "--session", sessionPath]));
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const doc = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(doc.status).toBe("completed");
      expect(doc.ended_at).toBe("2026-09-12");
      expect((JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>).workflows).toEqual([]);
    });
  });

  test("a coordinated snapshot without --session refuses even when every row is Done (exit 1, bytes + root intact)", () => {
    setupHarness((harness, { snapshot, root }) => {
      const fixture = coordinatedSnapshotDoc(harness, "Done");
      writeFileSync(snapshot, JSON.stringify(fixture, null, 2), "utf8");
      writeCoordinatorSession(harness);

      const result = runCli(closeArgs(harness));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("is coordinated");
      expect(result.stderr).toContain("--session <coordinator envelope>");
      // The row gate is not what refused this close: rows are Done.
      expect(result.stderr).not.toContain("every plan row must be Done");
      expect(readFileSync(snapshot, "utf8")).toBe(JSON.stringify(fixture, null, 2));
      const rootAfter = JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>;
      expect(rootAfter.workflows).toHaveLength(1);
    });
  });

  test("a coordinated snapshot with an unfinished row refuses before writing anything (bytes + root intact)", () => {
    setupHarness((harness, { snapshot, root }) => {
      const fixture = coordinatedSnapshotDoc(harness, "InReview");
      writeFileSync(snapshot, JSON.stringify(fixture, null, 2), "utf8");
      const sessionPath = writeCoordinatorSession(harness);

      const result = runCli(closeArgs(harness, ["--session", sessionPath]));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("every plan row must be Done");
      expect(readFileSync(snapshot, "utf8")).toBe(JSON.stringify(fixture, null, 2));
      const rootAfter = JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>;
      expect(rootAfter.workflows).toHaveLength(1);
    });
  });

  test("--session must be absolute: a relative path is a usage error before any read (exit 2)", () => {
    setupHarness((harness, { snapshot }) => {
      const fixture = coordinatedSnapshotDoc(harness, "Done");
      writeFileSync(snapshot, JSON.stringify(fixture, null, 2), "utf8");
      writeCoordinatorSession(harness);

      const result = runCli(closeArgs(harness, ["--session", "workflows/coordinator.json"]));
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--session must be an absolute path");
      expect(readFileSync(snapshot, "utf8")).toBe(JSON.stringify(fixture, null, 2));
    });
  });
});

/**
 * CLI `mstar iteration gate --phase 6` — the additive post-merge close
 * local-state gate form (P2 T4). Thin wrapper over engine
 * `evaluatePostMergeClose`: no `--compass` required (standalone plans have
 * none); exit 0 pass / 1 gate fail or error / 2 usage. The Phase 2–5
 * transition form (requires `--compass`) is pinned unchanged in the last
 * test. Every case runs the real CLI as a subprocess against a temp fixture
 * harness — no live workflow is ever touched.
 */
describe("mstar iteration gate --phase 6", () => {
  const gateArgs = (harness: string, workflow = WORKFLOW_ID): string[] =>
    ["iteration", "gate", "--phase", "6", "--workflow", workflow, "--harness", harness];

  test("closed + unregistered standalone plan passes without --compass (exit 0)", () => {
    setupHarness(
      (harness) => {
        const result = runCli(gateArgs(harness));
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("phase 6 (post-merge close): OK");
      },
      // Seam S3 (plan-workflow-lifecycle-contract §6 S3): the phase-6 gate
      // consults the registered delivery-kind evidence — the shared
      // `snapshotDoc()` fixture carries the complete development shape
      // (kind + delivery anchors + collected evidence).
      { snapshot: snapshotDoc({ status: "completed", ended_at: "2026-09-12", updated_at: "2026-09-12" }), root: rootDoc() },
    );
  });

  test("running snapshot (close not yet run) → exit 1 with PHASE6_NOT_TERMINAL", () => {
    setupHarness((harness) => {
      const result = runCli(gateArgs(harness));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("PHASE6_NOT_TERMINAL");
    });
  });

  test("root entry still registered → exit 1 with PHASE6_ROOT_ENTRY_PRESENT", () => {
    setupHarness(
      (harness) => {
        const result = runCli(gateArgs(harness));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("PHASE6_ROOT_ENTRY_PRESENT");
      },
      { snapshot: snapshotDoc({ status: "completed", ended_at: "2026-09-12", updated_at: "2026-09-12" }) },
    );
  });

  test("dangling integration merge lease → exit 1 with PHASE6_DANGLING_LEASE", () => {
    setupHarness(
      (harness) => {
        const result = runCli(gateArgs(harness));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("PHASE6_DANGLING_LEASE");
      },
      {
        snapshot: snapshotDoc({
          status: "completed",
          ended_at: "2026-09-12",
          updated_at: "2026-09-12",
          integration_merge_lease: {
            holder: "pm",
            claimed_at: "2026-08-19",
            plan_id: "plan-a",
            source_branch: "feature/plan-a",
            target_branch: "main",
          },
        }),
        root: rootDoc(),
      },
    );
  });

  test("missing snapshot file refuses (exit 1)", () => {
    setupHarness(
      (harness) => {
        const result = runCli(gateArgs(harness, "wf-missing"));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("workflow snapshot not found");
      },
      { snapshot: null, root: null },
    );
  });

  test("unsupported --phase value is a usage error (exit 2)", () => {
    setupHarness((harness) => {
      const result = runCli(["iteration", "gate", "--phase", "5", "--workflow", WORKFLOW_ID, "--harness", harness]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage");
    });
  });

  test("existing transition form is intact: --compass still required (exit 2 without it) and the evaluation still exits 0/1", () => {
    setupHarness(
      (harness) => {
        const compassPath = join(harness, "delivery-compass.md");
        writeFileSync(
          compassPath,
          "---\niteration_id: v9.9.9\nstart_date: 2026-08-01\nstatus: active\niteration_base_branch: main\ntarget_branch: main\nplans:\n  - plan-a\n---\n",
          "utf8",
        );
        // Running plan row → phase-2-execute verdict, gate passes (exit 0).
        const okRun = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--compass", compassPath, "--harness", harness]);
        expect(okRun.exitCode).toBe(0);
        expect(okRun.stdout).toContain("transition: phase-2-execute");

        // Phase 2–5 form without --compass → usage error (exit 2).
        const noCompass = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", harness]);
        expect(noCompass.exitCode).toBe(2);
        expect(noCompass.stderr).toContain("usage");
      },
      {
        snapshot: snapshotDoc({
          plans: [{ id: "plan-a", title: "Plan A", file: "plans/plan-a.md", status: "InProgress" }],
        }),
      },
    );
  });
});

/**
 * CLI `mstar workflow evidence` — the authorized delivery-evidence recording
 * verb (plan-workflow-lifecycle-contract §3/§4c/§4d/§4f, seam S3). Thin
 * wrapper over engine `recordWorkflowDelivery`: the payload JSON is merged
 * into the snapshot's `delivery` block under the snapshot lock, so evidence is
 * collected stage by stage and the close consultation can pass. Contract
 * pinned here:
 * - exit 0: recording the missing member lets the close succeed end to end,
 *   and re-recording identical evidence rewrites nothing.
 * - exit 1: a coordinated snapshot is written only for its own bound
 *   coordinator envelope (`--session`), and a partial/incoherent payload is
 *   refused by the engine with no byte change.
 * - exit 2: usage — a missing/relative/malformed `--file`.
 */
describe("mstar workflow evidence", () => {
  const evidenceArgs = (harness: string, payload: string, extra: string[] = []): string[] =>
    ["workflow", "evidence", "--workflow", WORKFLOW_ID, "--file", payload, "--harness", harness, ...extra];

  /** Write a delivery-evidence payload into the fixture harness; returns its absolute path. */
  function writePayload(harness: string, body: unknown): string {
    const payload = join(harness, "delivery-evidence.json");
    writeFileSync(payload, JSON.stringify(body), "utf8");
    return payload;
  }

  /** The shared fixture minus one member — the evidence the close must refuse on. */
  function withoutMember(member: string): Record<string, unknown> {
    const delivery = { ...(snapshotDoc().delivery as Record<string, unknown>) };
    delete delivery[member];
    return snapshotDoc({ delivery });
  }

  test("records the missing member, is idempotent, and unblocks the close (exit 0)", () => {
    setupHarness((harness, { snapshot, root }) => {
      writeFileSync(snapshot, JSON.stringify(withoutMember("merge"), null, 2), "utf8");
      const beforeSnapshot = readFileSync(snapshot, "utf8");
      const beforeRoot = readFileSync(root, "utf8");

      // The close refuses first — incomplete delivery, zero writes.
      const refused = runCli(closeArgs(harness, ["--ended-at", "2026-09-12"]));
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("PHASE6_DELIVERY_EVIDENCE_INCOMPLETE");
      expect(refused.stderr).toContain("delivery.merge");
      expect(refused.stderr).toContain("mstar workflow evidence");
      expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
      expect(readFileSync(root, "utf8")).toBe(beforeRoot);

      const payload = writePayload(harness, {
        merge: { provider: "github", evidence: "PR #244 verified merged at 2c792c01" },
      });
      const recorded = runCli(evidenceArgs(harness, payload, ["--at", "2026-09-12T01:00:00Z"]));
      expect(recorded.exitCode).toBe(0);
      expect(recorded.stderr).toBe("");
      expect(recorded.stdout).toContain(`workflow evidence: OK \u2014 ${WORKFLOW_ID} delivery evidence recorded`);

      // Idempotent re-recording: same evidence, no rewrite (byte-identical).
      const afterRecord = readFileSync(snapshot, "utf8");
      const again = runCli(evidenceArgs(harness, payload, ["--at", "2026-09-13T01:00:00Z"]));
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toContain("already carries this delivery evidence");
      expect(readFileSync(snapshot, "utf8")).toBe(afterRecord);

      // The close now completes and unregisters the root entry.
      const closed = runCli(closeArgs(harness, ["--ended-at", "2026-09-12"]));
      expect(closed.exitCode).toBe(0);
      const doc = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(doc.status).toBe("completed");
      expect(doc.ended_at).toBe("2026-09-12");
      // Fixture JSON read back from disk — the delivery block is a plain object.
      const delivery = doc.delivery as Record<string, unknown>;
      expect(delivery.merge).toEqual({
        provider: "github",
        evidence: "PR #244 verified merged at 2c792c01",
      });
      const rootAfter = JSON.parse(readFileSync(root, "utf8")) as { workflows: unknown[] };
      expect(rootAfter.workflows).toEqual([]);
    });
  });

  test("a coordinated workflow refuses without its bound coordinator envelope (exit 1, bytes unchanged)", () => {
    setupHarness((harness, { snapshot }) => {
      const sessionFile = join(harness, "workflows", WORKFLOW_ID, "sessions", "coordinator.json");
      mkdirSync(join(harness, "workflows", WORKFLOW_ID, "sessions"), { recursive: true });
      writeFileSync(sessionFile, JSON.stringify({ schema_version: 1, role: "coordinator", session_id: "s-1", workflow_id: WORKFLOW_ID, harness_root: harness }), "utf8");
      const coordinated = snapshotDoc({
        // No evidence collected yet — the recording seam is what fills it.
        delivery: undefined,
        coordination: { coordinator: { session_id: "s-1", session_file: sessionFile, bound_at: "2026-09-15T00:00:00Z" } },
      });
      writeFileSync(snapshot, JSON.stringify(coordinated, null, 2), "utf8");
      const payload = writePayload(harness, { compound: { outcome: "created" } });
      const before = readFileSync(snapshot, "utf8");

      const refused = runCli(evidenceArgs(harness, payload));
      expect(refused.exitCode).toBe(1);
      // The refusal names the authorization seam (the same one the close uses).
      expect(refused.stderr).toContain("is coordinated");
      expect(refused.stderr).toContain("--session <coordinator envelope>");
      expect(readFileSync(snapshot, "utf8")).toBe(before);

      const recorded = runCli(evidenceArgs(harness, payload, ["--session", sessionFile, "--at", "2026-09-12T01:00:00Z"]));
      expect(recorded.exitCode).toBe(0);
      const stored = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(stored.delivery).toEqual({ compound: { outcome: "created" } });
    });
  });

  test("usage refusals stay exit 2 and never touch the snapshot", () => {
    setupHarness((harness, { snapshot }) => {
      const before = readFileSync(snapshot, "utf8");
      // Missing --file.
      const missing = runCli(["workflow", "evidence", "--workflow", WORKFLOW_ID, "--harness", harness]);
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr).toContain("--file is required");
      // Relative --file.
      const relative = runCli(evidenceArgs(harness, "delivery-evidence.json"));
      expect(relative.exitCode).toBe(2);
      expect(relative.stderr).toContain("--file must be an absolute path");
      // Malformed JSON payload.
      const badPath = join(harness, "bad.json");
      writeFileSync(badPath, "{ not json", "utf8");
      const malformed = runCli(evidenceArgs(harness, badPath));
      expect(malformed.exitCode).toBe(1);
      expect(malformed.stderr).toContain("not valid JSON");
      // The two modes are exclusive, and the declared kind is an enum.
      const both = runCli([
        "workflow", "evidence", "--workflow", WORKFLOW_ID, "--file", badPath,
        "--declare-kind", "development", "--branch-source", "feature/a", "--branch-target", "main", "--harness", harness,
      ]);
      expect(both.exitCode).toBe(2);
      expect(both.stderr).toContain("not both");
      const unknownKind = runCli(["workflow", "evidence", "--workflow", WORKFLOW_ID, "--declare-kind", "wing-it", "--harness", harness]);
      expect(unknownKind.exitCode).toBe(2);
      expect(unknownKind.stderr).toContain("--declare-kind must be one of");
      expect(readFileSync(snapshot, "utf8")).toBe(before);
    });
  });

  test("--declare-kind: the one-time declaration unblocks the close end to end (kind never inferred, §1/§4a)", () => {
    setupHarness((harness, { snapshot, root }) => {
      // The audit-promotion / v1-lift shape: active, no kind, no anchors, no evidence.
      writeFileSync(snapshot, JSON.stringify(snapshotDoc({ delivery_kind: undefined, branch: undefined, delivery: undefined }), null, 2), "utf8");
      const beforeRoot = readFileSync(root, "utf8");

      // The close refuses: no declared kind (and it is never inferred).
      const refused = runCli(closeArgs(harness, ["--ended-at", "2026-09-12"]));
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("PHASE6_DELIVERY_KIND_UNREGISTERED");

      // An incoherent declaration is refused by the shared per-kind rule.
      const incoherent = runCli([
        "workflow", "evidence", "--workflow", WORKFLOW_ID, "--declare-kind", "development", "--branch-source", "feature/a", "--harness", harness,
      ]);
      expect(incoherent.exitCode).toBe(1);
      expect(incoherent.stderr).toContain("delivery source and target branches");

      const declared = runCli([
        "workflow", "evidence", "--workflow", WORKFLOW_ID,
        "--declare-kind", "development", "--branch-source", "feature/plan-a", "--branch-target", "main",
        "--at", "2026-09-12T01:00:00Z", "--harness", harness,
      ]);
      expect(declared.exitCode).toBe(0);
      expect(declared.stdout).toContain(`workflow evidence: OK \u2014 ${WORKFLOW_ID} delivery kind declared (development`);

      // One-time: a second declaration is refused, even with the same kind.
      const again = runCli([
        "workflow", "evidence", "--workflow", WORKFLOW_ID,
        "--declare-kind", "development", "--branch-source", "feature/plan-a", "--branch-target", "main", "--harness", harness,
      ]);
      expect(again.exitCode).toBe(1);
      expect(again.stderr).toContain("already declares");

      // Record the evidence, then close: the declaration, the anchors and every
      // member agree, so the close completes and the gate passes.
      const payload = writePayload(harness, {
        compound: { outcome: "created" },
        pr: { repo: "btspoony/mstar-harness", head: "feature/plan-a", target: "main" },
        merge: { provider: "github", evidence: "PR #244 verified merged at 2c792c01" },
      });
      expect(runCli(evidenceArgs(harness, payload)).exitCode).toBe(0);

      const closed = runCli(closeArgs(harness, ["--ended-at", "2026-09-12"]));
      expect(closed.exitCode).toBe(0);
      const stored = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(stored.status).toBe("completed");
      expect(stored.delivery_kind).toBe("development");
      const gate = runCli(["iteration", "gate", "--phase", "6", "--workflow", WORKFLOW_ID, "--harness", harness]);
      expect(gate.exitCode).toBe(0);
      expect(gate.stdout).toContain("phase 6 (post-merge close): OK");
      // The declaration never touched the root register (nothing was unregistered yet).
      expect(readFileSync(root, "utf8")).not.toBe(beforeRoot);
    });
  });
});
