import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { probeStoreUpgradeState } from "@mstar-harness/engine";
import { getStoreCommandDefinitions } from "../src/index.js";
import type { CommandEnvelope, InvocationContext } from "../src/types.js";

const root = join(tmpdir(), `mstar-store-recovery-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });

const fixtureAttestation = {
  version: 1,
  attestedAt: "2026-09-21T00:00:00.000Z",
  operator: { actor: "fixture-operator", authorizationRef: "fixture" },
  consumers: [
    {
      entryId: "cli",
      kind: "cli",
      entrypoint: "/usr/local/bin/mstar",
      runtime: "bun",
      runtimeVersion: "1.4.0",
      version: "3.11.0",
      current: false,
      disposition: "upgraded",
    },
    {
      entryId: "coordinator",
      kind: "coordinator",
      entrypoint: "/Users/operator/.omp/plugin",
      runtime: "node",
      runtimeVersion: "24.18.0",
      version: "3.11.0",
      current: true,
      disposition: "reloaded",
    },
  ],
  stoppedSessions: [],
};

/**
 * Invokes `store upgrade` through its real command definition. The recovery
 * path runs before the confirmation prompt, and a control root without legacy
 * execution files completes without an interactive answer, so the fixture
 * needs no confirmation input.
 */
function invocationContext(cwd: string, answer: string): InvocationContext {
  return {
    cwd,
    controlRoot: root,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() {
        return answer;
      },
      async spawn() {
        return { exitCode: 1, signal: null, stdout: "", stderr: "" };
      },
      async startDashboard() {
        throw new Error("not available in this command family");
      },
      async openBrowser() {
        throw new Error("not available in this command family");
      },
      writeStderr() {},
    },
  };
}

async function runUpgrade(
  harness: string,
  cwd: string,
  answer = "no",
  inventory?: string,
  actor = "fixture-operator",
): Promise<CommandEnvelope> {
  const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
  if (definition === undefined) throw new Error("missing store.upgrade definition");
  const attestation = join(cwd, `attestation-${actor}.json`);
  writeFileSync(
    attestation,
    `${JSON.stringify({ ...fixtureAttestation, operator: { ...fixtureAttestation.operator, actor } })}\n`,
  );
  const parsed = definition.input.parse({
    harness,
    operator: "fixture-operator",
    attestation,
    ...(inventory === undefined ? {} : { inventory }),
  });
  return definition.execute(parsed, invocationContext(cwd, answer));
}

test("store upgrade archives a damaged store, completes, and reports the archive", async () => {
  const harnessDir = join(root, "damaged", ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const damaged = Buffer.from("this is not a sqlite database at all", "utf8");
  writeFileSync(join(harnessDir, "store.db"), damaged);

  const result = await runUpgrade(harnessDir, root);

  expect(result.status).toBe("ok");
  if (
    result.status !== "ok" ||
    result.data === null ||
    typeof result.data !== "object" ||
    !("archivedStore" in result.data) ||
    typeof result.data.archivedStore !== "string"
  ) {
    throw new Error(`expected a successful upgrade carrying an archive path, received ${JSON.stringify(result)}`);
  }
  const archivedStore = result.data.archivedStore;
  // The reported path must be the published archive for this root, and it must
  // actually hold the damaged bytes, unchanged.
  expect(archivedStore.startsWith(join(harnessDir, "archived", "store-upgrade"))).toBe(true);
  expect(readFileSync(join(archivedStore, "store.db"))).toEqual(damaged);
  // The control root must be left with a store the next command can use.
  const state = await probeStoreUpgradeState({ harnessDir });
  expect(state.verdict).not.toBe("blocked");
});

test("store upgrade restores the original store when the operator declines confirmation", async () => {
  const harnessDir = join(root, "declined", ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const damaged = Buffer.from("a damaged store that is not sqlite", "utf8");
  writeFileSync(join(harnessDir, "store.db"), damaged);
  // Legacy execution files route the flow through the confirmation prompt.
  writeFileSync(join(harnessDir, "status.json"), "{}\n");

  const result = await runUpgrade(harnessDir, root);

  expect(result.status).not.toBe("ok");
  // The rollback must put the original bytes back at their own path.
  expect(readFileSync(join(harnessDir, "store.db"))).toEqual(damaged);
});

test("store upgrade archives a damaged store and still migrates valid legacy sources", async () => {
  const harnessDir = join(root, "legacy", ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const damaged = Buffer.from("legacy root with a destroyed database", "utf8");
  writeFileSync(join(harnessDir, "store.db"), damaged);
  // A legacy execution corpus the migration can actually carry forward.
  const workflowId = "recovery-fixture-workflow";
  const workflowDir = join(harnessDir, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "status.json"),
    JSON.stringify({
      version: 2,
      updated_at: "2026-09-30",
      workflows: [{ id: workflowId, type: "plan", started_at: "2026-09-30", dir: `workflows/${workflowId}` }],
    }),
  );
  writeFileSync(
    join(workflowDir, "snapshot.json"),
    JSON.stringify({
      schema_version: 1,
      id: workflowId,
      type: "plan",
      status: "running",
      started_at: "2026-09-30",
      updated_at: "2026-09-30",
      delivery_kind: "development",
      project: "_default",
      branch: { source: "feature/recovery-fixture", target: "main" },
      plans: [{ id: `${workflowId}-plan`, title: "Recovery fixture", file: "plan.md", status: "Todo", metadata: {} }],
    }),
  );

  const result = await runUpgrade(harnessDir, root, "preserve for later review");

  if (
    result.status !== "ok" ||
    result.data === null ||
    typeof result.data !== "object" ||
    !("archivedStore" in result.data) ||
    typeof result.data.archivedStore !== "string"
  ) {
    throw new Error(`expected a successful upgrade carrying an archive path, received ${JSON.stringify(result)}`);
  }
  expect(readFileSync(join(result.data.archivedStore, "store.db"))).toEqual(damaged);
  // The migration must have carried the legacy sources into an active authority,
  // not merely replaced the database.
  const state = await probeStoreUpgradeState({ harnessDir });
  expect(state.executionAuthorityState).toBe("active");
});

test("store upgrade refuses to archive a damaged store under another operator's attestation", async () => {
  const harnessDir = join(root, "mismatch", ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const damaged = Buffer.from("a damaged store behind a mismatched attestation", "utf8");
  writeFileSync(join(harnessDir, "store.db"), damaged);

  const result = await runUpgrade(harnessDir, root, "preserve for later review", undefined, "someone-else");

  expect(result.code).toBe("store.attestation-invalid");
  // Nothing may be archived or displaced for an identity the operator cannot claim.
  expect(readFileSync(join(harnessDir, "store.db"))).toEqual(damaged);
  expect(existsSync(join(harnessDir, "archived"))).toBe(false);
});

test("store upgrade leaves the original in place when the archive cannot be published", async () => {
  const harnessDir = join(root, "unwritable", ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const damaged = Buffer.from("still not a sqlite database", "utf8");
  writeFileSync(join(harnessDir, "store.db"), damaged);
  // A regular file where the archive directory must go makes publication fail.
  writeFileSync(join(harnessDir, "archived"), "blocks the archive directory");

  const result = await runUpgrade(harnessDir, root);

  expect(result.status).not.toBe("ok");
  expect(readFileSync(join(harnessDir, "store.db"))).toEqual(damaged);
});
