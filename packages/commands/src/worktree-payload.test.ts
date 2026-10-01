import { describe, expect, test } from "bun:test";
import { executeCommand } from "./definitions.js";
import { getValidationCommandDefinitions } from "./families/validation.js";
import type { CommandDefinition, InvocationContext } from "./types.js";

function context(): InvocationContext {
  return {
    cwd: process.cwd(),
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      readInput: async () => "",
      spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
      startDashboard: async () => {
        throw new Error("unused in worktree payload tests");
      },
      openBrowser: async () => {
        throw new Error("unused in worktree payload tests");
      },
    },
  };
}

function worktreeCheckDefinition(): CommandDefinition {
  const definition = getValidationCommandDefinitions().find((entry) => entry.id === "worktree.check");
  if (definition === undefined) throw new Error("worktree.check definition not found");
  return definition;
}

function tracksDescriptor(): NonNullable<CommandDefinition["payloads"]>[string] {
  const descriptor = worktreeCheckDefinition().payloads?.tracks;
  if (descriptor === undefined) throw new Error("tracks payload descriptor not declared");
  return descriptor;
}

describe("worktree tracks payload", () => {
  test("tracks publishes a typed payload descriptor instead of an opaque string", () => {
    const definition = worktreeCheckDefinition();
    const descriptor = tracksDescriptor();
    expect(descriptor.schema.safeParse([{ worktreePath: "/tmp/wt", workingBranch: "feature/x" }]).success).toBe(true);
    // The published input schema IS the runtime contract: a typed array with
    // both required members, not an opaque placeholder that also admits strings.
    const inputSchema = definition.input.toJSONSchema() as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(inputSchema.properties.tracks).toMatchObject({ type: "array" });
    const items = inputSchema.properties.tracks.items as { required?: readonly string[] };
    expect(items.required).toEqual(expect.arrayContaining(["worktreePath", "workingBranch"]));
  });

  test("family validates tracks at the input boundary with indexed paths", async () => {
    // The string transport form is no longer advertised: the boundary refuses it.
    expect(worktreeCheckDefinition().input.safeParse({ l2: true, tracks: "[{bad" }).success).toBe(false);

    const missing = await executeCommand("worktree.check", { l2: true, tracks: [{ worktreePath: "/tmp/wt" }] }, context());
    expect(missing).toMatchObject({ status: "usage", exitCode: 2 });
    expect(missing.status === "usage" && missing.message.includes("tracks[0].workingBranch")).toBe(true);

    const wrongType = await executeCommand("worktree.check", { l2: true, tracks: [{ worktreePath: 7, workingBranch: "b" }] }, context());
    expect(wrongType).toMatchObject({ status: "usage", exitCode: 2 });
    expect(wrongType.status === "usage" && wrongType.message.includes("tracks[0].worktreePath")).toBe(true);

    const emptyString = await executeCommand("worktree.check", { l2: true, tracks: "" }, context());
    expect(emptyString).toMatchObject({ status: "usage", exitCode: 2 });

    const rawString = await executeCommand("worktree.check", { l2: true, tracks: "[{bad" }, context());
    expect(rawString).toMatchObject({ status: "usage", exitCode: 2 });
  });

  test("valid CLI JSON and MCP object arrays reach the same domain check", async () => {
    const descriptor = tracksDescriptor();
    const cliDecoded = JSON.parse('[{"worktreePath":"/tmp/wt","workingBranch":"feature/x"}]') as unknown;
    expect(descriptor.schema.safeParse(cliDecoded).success).toBe(true);
    expect(descriptor.schema.safeParse([{ worktreePath: "/tmp/wt", workingBranch: "feature/x" }]).success).toBe(true);

    const emptyTracks = await executeCommand("worktree.check", { l2: true, tracks: [] }, context());
    expect(emptyTracks).toMatchObject({ status: "refused", code: "worktree.l2.no-tracks", exitCode: 1 });

    const missingPath = `/tmp/mstar-wt-payload-missing-${process.pid}`;
    const gateRan = await executeCommand(
      "worktree.check",
      { l2: true, tracks: [{ worktreePath: missingPath, workingBranch: "feature/x" }] },
      context(),
    );
    expect(gateRan).toMatchObject({ status: "refused", code: "worktree.l2.track-missing", exitCode: 1 });
  });

  test("absent tracks and the L1 path keep their usage gates", async () => {
    const absent = await executeCommand("worktree.check", { l2: true }, context());
    expect(absent).toMatchObject({ status: "usage", exitCode: 2 });
    expect(absent.status === "usage" && absent.message.includes("--tracks")).toBe(true);

    const l1 = await executeCommand("worktree.check", {}, context());
    expect(l1).toMatchObject({ status: "usage", exitCode: 2 });
    expect(l1.status === "usage" && l1.message.includes("<plan-id>")).toBe(true);
  });

  test("track schema rejects wrong-typed members with indexed paths", () => {
    const descriptor = tracksDescriptor();
    const wrong = descriptor.schema.safeParse([{ worktreePath: 7, workingBranch: "feature/x" }]);
    if (wrong.success) throw new Error("expected wrong-typed track member to fail validation");
    expect(wrong.success).toBe(false);
    expect(wrong.error.issues[0]?.path).toEqual([0, "worktreePath"]);
  });
});
