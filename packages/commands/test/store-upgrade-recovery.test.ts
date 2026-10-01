import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
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
  stoppedSessions: [{ sessionId: "old-session", host: "omp", state: "stopped" }],
};

/**
 * Invokes `store upgrade` through its real command definition. The recovery
 * path runs before the confirmation prompt, and a control root without legacy
 * execution files completes without an interactive answer, so the fixture
 * needs no confirmation input.
 */
function invocationContext(cwd: string): InvocationContext {
  return {
    cwd,
    controlRoot: root,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() {
        return "no";
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

async function runUpgrade(harness: string, cwd: string): Promise<CommandEnvelope> {
  const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
  if (definition === undefined) throw new Error("missing store.upgrade definition");
  const attestation = join(cwd, "attestation.json");
  writeFileSync(attestation, `${JSON.stringify(fixtureAttestation)}\n`);
  const parsed = definition.input.parse({ harness, operator: "fixture-operator", attestation });
  return definition.execute(parsed, invocationContext(cwd));
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
  // The reported archive must actually hold the damaged bytes, unchanged.
  expect(readFileSync(join(archivedStore, "store.db"))).toEqual(damaged);
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
