import { describe, expect, test } from "bun:test";
import { commandEnvelopeSchema } from "../src/definitions.js";

describe("command outcome envelopes", () => {
  test("accepts structured success, refusal, usage, and error results", () => {
    expect(commandEnvelopeSchema.safeParse({ version: 1, command: "status.show", status: "ok", code: "status.ok", exitCode: 0, data: { state: "InProgress" } }).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse({ version: 1, command: "status.close", status: "refused", code: "status.transition-invalid", exitCode: 1, message: "Transition refused" }).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse({ version: 1, command: "status.show", status: "usage", code: "command.invalid-input", exitCode: 2, message: "Missing selector" }).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse({ version: 1, command: "sdd.exec", status: "error", code: "command.internal", exitCode: 1, message: "Execution failed" }).success).toBe(true);
  });

  test("preserves command-defined child exit codes including timeout, missing binary, and signal exits", () => {
    for (const exitCode of [3, 124, 127, 128, 130, 143]) {
      const result = commandEnvelopeSchema.safeParse({
        version: 1,
        command: "sdd.exec",
        status: "error",
        code: "command.child-failed",
        exitCode,
        message: "Child process failed",
        details: { stdout: "", stderr: "", signal: exitCode >= 128 ? "SIGINT" : null },
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.exitCode).toBe(exitCode);
    }
  });

  test("rejects malformed envelopes and invalid failure exit values", () => {
    expect(commandEnvelopeSchema.safeParse({ version: 1, command: "status.show", status: "ok", code: "status.ok", exitCode: 1, data: null }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({ version: 1, command: "status.close", status: "refused", code: "status.no", exitCode: 0, message: "No" }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({ version: 1, command: "status.show", status: "usage", code: "command.invalid-input", exitCode: 1, message: "Bad usage" }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({ version: 1, command: "status.show", status: "error", code: "command.bad", exitCode: 1.5, message: "Bad" }).success).toBe(false);
  });
});
