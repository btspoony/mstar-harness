import { describe, expect, test } from "bun:test";
import { scanSource, normalizeSnippet, signatureFor } from "./lint-refusal-quality";

describe("refusal quality scanner", () => {
  test("finds missing cause codes and unreachable refusal-envelope recovery", () => {
    const source = `
      refusalEnvelope({ command: "x", status: "refused", exitCode: 1, message: "Cannot continue",
        recovery: "Run mstar execution restore-preview --path <path>" });
      refusalEnvelope({ command: "x", status: "refused", code: "MISSING_STATE", exitCode: 1,
        message: "Cannot continue", recovery: "Run mstar workflow --resume" });
    `;
    const findings = scanSource(source, "packages/engine/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    });
    expect(findings.map((finding) => finding.classification)).toEqual([
      "missing-cause-code", "unreachable-recovery",
    ]);
  });

  test("accepts a refusal envelope with a supported recovery", () => {
    const source = `refusalEnvelope({ command: "x", status: "refused", code: "MISSING_STATE", exitCode: 1, message: "Cannot continue", recovery: "Run mstar workflow --resume" });`;
    expect(scanSource(source, "packages/engine/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    })).toEqual([]);
  });

  test("ignores internal validators and accepts one-level structured refusals", () => {
    const source = `
      const code = "problem.missing";
      const recovery = "Run mstar workflow --resume";
      throw invalidInput("sessionId must be a string");
      out.push(violation(CODE_SCHEMA, "record must be an object"));
      throw new Error("internal invariant failed");
      refusalEnvelope({ command: "x", status: "refused", code, exitCode: 1, message: "Failure",
        ...(recovery === undefined ? {} : { recovery }) });
    `;
    expect(scanSource(source, "packages/engine/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    })).toEqual([]);
  });

  test("matches the longest nested command before its parent verb", () => {
    const source = `recoveryRefusal("unauthorized", "supply workflow recover-coordinator --attestation <file>");`;
    const findings = scanSource(source, "packages/engine/src/fixture.ts", {
      verbs: new Set(["workflow", "workflow recover-coordinator"]),
      flagsByVerb: new Map([
        ["workflow", new Set<string>()],
        ["workflow recover-coordinator", new Set(["--attestation"])],
      ]),
    });
    expect(findings).toEqual([]);
  });

  test("normalizes snippet whitespace for stable allowlist signatures", () => {
    expect(normalizeSnippet("  foo(  bar );  ")).toBe("foo( bar );");
    expect(signatureFor("missing-cause-code", "scripts/file.ts", "foo(  bar );"))
      .toBe(signatureFor("missing-cause-code", "scripts/file.ts", " foo( bar ); "));
  });
});
