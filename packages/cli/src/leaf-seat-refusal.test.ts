/**
 * The leaf marker's end-to-end seam through the REGISTERED CLI: argv →
 * commander → command adapter → `executeCommand` → family stamp → engine.
 *
 * `DSH_MSTAR_LEAF_SEAT=1` (what the dsh shell exports for a leaf seat) must make
 * a coordinator REGISTRATION verb refuse with the engine's own
 * `coordination.leaf-seat` refusal; without the marker the same argv passes the
 * identity boundary and registers. The leaf case fails when `withLeafSeat(...)`
 * is removed from the exercised family (`workflow.register` in
 * `packages/commands/src/families/workflow.ts`), so this pins the family-side
 * stamp the identity-resolution tests cannot.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { getCommandDefinitions, type InvocationContext } from "@mstar-harness/commands";
import { initializeStore } from "@mstar-harness/engine";
import { registerCliCommands } from "./command-adapter";

const MARKS = ["DSH_MSTAR_LEAF_SEAT", "MSTAR_LEAF_SEAT", "DSH_SESSION_ID", "MSTAR_HOST_SESSION_ID", "MSTAR_EXECUTION_IDENTITY"] as const;
const saved = new Map(MARKS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of MARKS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const PLAN_ID = "plan-leaf";
const PLAN_TITLE = "Leaf plan";

/**
 * The identity channels an invocation can read, cleared to a known state: the
 * marker state must be the test's own decision, never the shell's. A leaf shell
 * genuinely exports `DSH_MSTAR_LEAF_SEAT=1`, so a control that merely omits the
 * marker would inherit it and stop being a control.
 */
function resetIdentityChannels(): void {
  for (const key of ["DSH_MSTAR_LEAF_SEAT", "MSTAR_LEAF_SEAT", "DSH_SESSION_ID", "MSTAR_EXECUTION_IDENTITY"] as const) {
    delete process.env[key];
  }
}

/** One isolated, initialized control root with the plan document registration reads. */
async function fixture(): Promise<{ base: string; root: string }> {
  const base = mkdtempSync(join(tmpdir(), "mstar-cli-leaf-seat-"));
  const root = join(base, ".mstar");
  mkdirSync(join(root, "plans"), { recursive: true });
  // The registered document is the registration authority: its H1 title and the
  // `plan_id` header must be the ids the argv declares.
  writeFileSync(join(root, "plans", `${PLAN_ID}.md`), `# ${PLAN_TITLE}\n\n**plan_id:** ${PLAN_ID}\n`);
  (await initializeStore({ harnessDir: root })).close();
  return { base, root };
}

function invocation({ base, root }: { base: string; root: string }): InvocationContext {
  return {
    cwd: base,
    controlRoot: root,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() {
        return "";
      },
      async spawn() {
        throw new Error("unused");
      },
      async startDashboard() {
        throw new Error("unused");
      },
      async openBrowser() {
        throw new Error("unused");
      },
    },
  };
}

/** The shipped registration verb, spelled exactly as an operator's shell would. */
function registerArgv({ root }: { root: string }): string[] {
  return [
    "workflow", "register",
    "--workflow", "wf-leaf",
    "--plan-id", PLAN_ID,
    "--plan-title", PLAN_TITLE,
    "--plan-file", join(root, "plans", `${PLAN_ID}.md`),
    "--delivery-kind", "development",
    "--branch-base", "main",
    "--branch-work", "feature/wf-leaf",
    "--branch-target", "main",
    "--harness", root,
  ];
}

/** Run one argv through the registered CLI and return the envelope it printed. */
async function runRegisteredCli(argv: readonly string[], context: InvocationContext): Promise<Record<string, unknown>> {
  const program = new Command();
  program.name("mstar").exitOverride();
  registerCliCommands(program, getCommandDefinitions(), context);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  // The adapter's own writeEnvelope sets process.exitCode from the envelope.
  // Reset it to 0 after the run (never restore a captured value): bun test
  // exits 1 when a file leaves a non-zero exitCode behind even with zero
  // failed assertions, and a shard-mate file may have set one before this file
  // ran, so "restoring" it would re-import that stale value. The assertions
  // judge the envelope, not the process exit code.
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "mstar", ...argv], { from: "node" });
  } finally {
    console.log = log;
    process.exitCode = 0;
  }
  return JSON.parse(lines.join("")) as Record<string, unknown>;
}

describe("the shell leaf marker refuses a coordinator registration through the registered CLI", () => {
  test("workflow.register with DSH_MSTAR_LEAF_SEAT=1 ends in the engine's coordination.leaf-seat refusal", async () => {
    const fixtureRoot = await fixture();
    try {
      resetIdentityChannels();
      process.env.DSH_MSTAR_LEAF_SEAT = "1";
      process.env.MSTAR_HOST_SESSION_ID = "leaf-session";
      const envelope = await runRegisteredCli(registerArgv(fixtureRoot), invocation(fixtureRoot));
      expect({ status: envelope.status, code: envelope.code }).toEqual({ status: "refused", code: "coordination.leaf-seat" });
      // The engine's own refusal details, not a family-authored prose match.
      expect(envelope.details).toMatchObject({ leaf_seat: true });
    } finally {
      rmSync(fixtureRoot.base, { recursive: true, force: true });
    }
  });

  test("without the marker the same registration passes the identity boundary (negative control)", async () => {
    const fixtureRoot = await fixture();
    try {
      resetIdentityChannels();
      process.env.MSTAR_HOST_SESSION_ID = "coordinator-session";
      const envelope = await runRegisteredCli(registerArgv(fixtureRoot), invocation(fixtureRoot));
      expect(envelope.status).toBe("ok");
      expect(envelope.data).toMatchObject({ workflowId: "wf-leaf" });
    } finally {
      rmSync(fixtureRoot.base, { recursive: true, force: true });
    }
  });
});
