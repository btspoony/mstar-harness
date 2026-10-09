import { describe, expect, test } from "bun:test";
import type { InvocationContext, JudgmentProvider } from "../src/index.js";
import { executeCommand, getJudgmentCommandDefinitions } from "../src/index.js";

const result = {
  schema: "mstar.judgment-cli/v1",
  contractRevision: "phase3a-native-20260924",
  status: "recorded",
  advice: null,
} as const;

function context(readInput: () => Promise<string> = async () => "injected pack"): InvocationContext {
  return {
    cwd: "/workspace",
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      readInput,
      async spawn() { throw new Error("unexpected process effect"); },
      async startDashboard() { throw new Error("unexpected dashboard effect"); },
      async openBrowser() { throw new Error("unexpected browser effect"); },
    },
  };
}

function definition(provider: JudgmentProvider) {
  return getJudgmentCommandDefinitions(provider)[0]!;
}

describe("judgment command family", () => {
  test("validates command input and reports malformed or incomplete input as usage", async () => {
    const ctx = context();

    const malformed = await executeCommand("judgment.review-advice", { file: 42, pilot: "pilot.json" }, ctx);
    const missingSource = await executeCommand("judgment.review-advice", { pilot: "pilot.json" }, ctx);
    const conflictingSources = await executeCommand("judgment.review-advice", { file: "pack.json", stdin: true, pilot: "pilot.json" }, ctx);

    expect(malformed).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(missingSource).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(conflictingSources).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
  });

  test("passes stdin through the invocation effects and provider fixture without reading process stdin", async () => {
    const inputReads: string[] = [];
    let received: unknown;
    const provider: JudgmentProvider = async (request) => {
      received = request.invocation;
      inputReads.push(await request.readInput());
      return result;
    };
    const envelope = await definition(provider).execute(
      { stdin: true, pilot: "pilot.json" },
      context(async () => "fixture-only stdin"),
    );

    expect(received).toEqual({
      cwd: "/workspace",
      workspace: "/workspace",
      input: { kind: "stdin" },
      pilotPath: "pilot.json",
    });
    expect(inputReads).toEqual(["fixture-only stdin"]);
    expect(envelope).toMatchObject({ status: "ok", data: result });
  });

  test("surfaces provider failure as an error envelope with its boundary", async () => {
    const envelope = await definition(async () => { throw new Error("fixture provider failure"); })
      .execute({ file: "pack.json", pilot: "pilot.json" }, context());

    expect(envelope).toMatchObject({
      status: "error",
      code: "judgment.provider-failed",
      exitCode: 1,
      details: { boundary: "fixture provider failure" },
    });
  });

  test("preserves invalid provider code, message, details, and recovery", async () => {
    const invalid = {
      ...result,
      status: "invalid" as const,
      code: "jev.pack-invalid",
      message: "Pack differs from the declared contract",
      details: { field: "pack.digest", observed: "mismatch" },
      recovery: "Regenerate the pack and retry review-advice.",
    };
    const envelope = await definition(async () => invalid)
      .execute({ file: "pack.json", pilot: "pilot.json" }, context());

    expect(envelope).toMatchObject({
      status: "error",
      code: "jev.pack-invalid",
      exitCode: 1,
      message: invalid.message,
      details: invalid.details,
      recovery: invalid.recovery,
    });
  });

  test("documents the active review-advice route instead of historical submit", () => {
    const command = definition(async () => result);
    expect(command.id).toBe("judgment.review-advice");
    expect(command.cli.options.find(({ key }) => key === "file")?.flags).toBe("--file <path>");
    expect(command.cli.options.find(({ key }) => key === "pilot")?.required).toBe(true);
  });
});
