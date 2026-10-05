import { describe, expect, test } from "bun:test";
import { refusalEnvelope } from "./envelope.js";

describe("refusal envelope contract", () => {
  test("formats rejected-input facts on the first line", () => {
    const envelope = refusalEnvelope({
      command: "workflow.register", status: "usage", code: "command.invalid-input", exitCode: 2,
      message: "invalid enum", rejected: { path: "--delivery-kind", expected: "pr | verification", received: "prx" },
      helpRoute: "mstar workflow register --help", recovery: "Choose a supported value.",
      diagnostics: [{ path: "deliveryKind", code: "invalid_value", message: "invalid enum" }],
    });
    if (envelope.status !== "usage") throw new Error("expected usage refusal");
    expect(envelope.message.split("\n")[0]).toBe("Rejected --delivery-kind: expected pr | verification; received prx");
    expect(envelope.details).toMatchObject({ helpRoute: "mstar workflow register --help", recovery: "Choose a supported value.", diagnostics: [{ path: "deliveryKind" }] });
    expect(envelope.exitCode).toBe(2);
  });

  test("keeps engine message verbatim and appends help and recovery", () => {
    const engineMessage = "Workflow is owned by the active authority.";
    const envelope = refusalEnvelope({
      command: "workflow.register", status: "refused", code: "execution.consumer-not-ready", exitCode: 1,
      message: engineMessage, helpRoute: "mstar workflow register --help", recovery: "Use the supported execution route.",
      diagnostics: [{ code: "execution.consumer-not-ready", message: engineMessage }],
    });
    if (envelope.status !== "refused") throw new Error("expected engine refusal");
    expect(envelope.message.split("\n")[0]).toBe(engineMessage);
    expect(envelope.message).toContain("Help: mstar workflow register --help");
    expect(envelope.message).toContain("Recovery: Use the supported execution route.");
    expect(envelope.details).toMatchObject({ helpRoute: "mstar workflow register --help", recovery: "Use the supported execution route." });
    expect(envelope.exitCode).toBe(1);
  });
});
