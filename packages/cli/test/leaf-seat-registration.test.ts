/**
 * The leaf marker's end-to-end seam: the shell marker resolves into the
 * `InvocationContext` the CLI builds, and a coordinator REGISTRATION verb run
 * through `executeCommand` then reaches the engine's own refusal. This is the
 * link `withLeafSeat` provides — deleting it from a registration family makes
 * the leaf case below stop refusing with `coordination.leaf-seat`.
 *
 * Deliberately not covered here: the commander argument-parsing path (the CLI
 * adapter's own tests cover option decoding) and a real execution authority
 * (the refusal happens before any store transaction opens, which is the
 * property this test pins).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand, type InvocationContext } from "@mstar-harness/commands";
import { resolveCliSessionIdentity } from "../src/command-adapter";

const MARKS = ["DSH_MSTAR_LEAF_SEAT", "MSTAR_LEAF_SEAT", "DSH_SESSION_ID", "MSTAR_HOST_SESSION_ID", "MSTAR_EXECUTION_IDENTITY"] as const;
const saved = new Map(MARKS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of MARKS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** An EMPTY control root: the leaf refusal must land before any store is read. */
function harnessFixture(): { root: string; cwd: string } {
  const base = mkdtempSync(join(tmpdir(), "mstar-leaf-seat-"));
  const root = join(base, ".mstar");
  mkdirSync(root);
  return { root, cwd: base };
}

function context(cwd: string, sessionId: string): InvocationContext {
  return {
    cwd,
    controlRoot: null,
    host: "dsh",
    sessionId,
    sessionIdSource: "env",
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      readInput: async () => "",
      spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
      startDashboard: async () => {
        throw new Error("unused");
      },
      openBrowser: async () => {
        throw new Error("unused");
      },
    },
  };
}

/** `plan.bind --execution` is the coordinator registration the leaf must never mint. */
async function bindThroughCli(cwd: string, harness: string) {
  process.env.MSTAR_HOST_SESSION_ID = "leaf-session";
  const identity = resolveCliSessionIdentity(undefined);
  const envelope = await executeCommand(
    "plan.bind",
    {
      execution: true,
      coordinator: true,
      workflow: "wf-leaf",
      harness,
      // A full token shape: the omission that skips the pre-bind authority read,
      // so the leaf refusal is the FIRST engine contact.
      expect: "exec-v1:workflow:unused",
    },
    { ...context(cwd, "leaf-session"), ...identity },
  );
  return { envelope, identity };
}

describe("the shell leaf marker reaches the engine refusal on a CLI registration verb", () => {
  test("DSH_MSTAR_LEAF_SEAT=1 refuses plan.bind with coordination.leaf-seat", async () => {
    const { root, cwd } = harnessFixture();
    try {
      process.env.DSH_MSTAR_LEAF_SEAT = "1";
      const { envelope, identity } = await bindThroughCli(cwd, root);
      expect(identity.leafSeat).toBe(true);
      expect({ status: envelope.status, code: envelope.code }).toEqual({ status: "refused", code: "coordination.leaf-seat" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MSTAR_LEAF_SEAT=1 (the omp prefix) refuses the same verb the same way", async () => {
    const { root, cwd } = harnessFixture();
    try {
      process.env.MSTAR_LEAF_SEAT = "1";
      const { envelope } = await bindThroughCli(cwd, root);
      expect(envelope.code).toBe("coordination.leaf-seat");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without a marker the same call is NOT refused by the leaf rule (the stamp is load-bearing)", async () => {
    const { root, cwd } = harnessFixture();
    try {
      const { envelope, identity } = await bindThroughCli(cwd, root);
      expect(identity.leafSeat).toBeUndefined();
      expect(envelope.code).not.toBe("coordination.leaf-seat");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
